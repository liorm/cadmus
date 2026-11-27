import type { Context } from "@earendil-works/chord/context";
import {
	type BinaryReader,
	type DirReader,
	type ExecutionEnv,
	ExecutionError,
	err,
	type FileChange,
	FileError,
	type FileErrorCode,
	type FileInfo,
	type FileWatcher,
	ok,
	type Result,
	type ShellExecOptions,
	type ShellExecResult,
	type TextLine,
	type TextLineReader,
} from "@earendil-works/pi-durable/env";
import {
	asBytes,
	decodeBinary,
	type ExecErrorCode,
	encodeBinary,
	transportFailure,
} from "./wire.js";
import { WireCaller, type WireCallResult } from "./wire-call.js";

export interface WireSocket {
	send(text: string): void;
	close(): void;
}

/**
 * ExecutionEnv whose methods are wire frames. Used by the Node conformance
 * proxy. The family proxy stays on Durable Object RPC; CadmusEnvDO speaks
 * the same frames through WireCaller.
 */
export function createWireExecutionEnv(options: {
	socket: WireSocket;
	id: string;
	cwd: string;
}): { env: ExecutionEnv; ingest(text: string): void; failAll(): void } {
	const caller = new WireCaller((text) => {
		try {
			options.socket.send(text);
			return true;
		} catch {
			return false;
		}
	});
	const generation = 1;

	const call = (
		method: string,
		args: unknown,
		extra?: {
			onOutput?: (event: {
				text: string;
				stream: "stdout" | "stderr";
				skipped?: {
					bytes: number;
					newlines: number;
					endsWithNewline: boolean;
				};
			}) => void;
			timeoutMs?: number;
		},
	) =>
		caller.call({
			method,
			args,
			generation,
			timeoutMs: extra?.timeoutMs,
			onOutput: extra?.onOutput,
		});

	const file = async <T>(
		method: string,
		args: unknown,
		context: Context,
	): Promise<Result<T, FileError>> => {
		if (context.abortSignal?.aborted) {
			return err(new FileError("aborted", "aborted"));
		}
		const result = await call(method, args, { timeoutMs: 30_000 });
		return asFile<T>(result);
	};

	const env: ExecutionEnv = {
		id: options.id,
		cwd: options.cwd,
		absolutePath: (path, context) => file("absolutePath", { path }, context),
		joinPath: (parts, context) => file("joinPath", { parts }, context),
		readTextFile: (path, context) => file("readTextFile", { path }, context),
		readTextLines: (path, readOptions, context) =>
			file("readTextLines", { path, maxLines: readOptions?.maxLines }, context),
		readBinaryFile: async (path, context) => {
			const result = await file<unknown>("readBinaryFile", { path }, context);
			if (!result.ok) return result;
			const value = decodeBinary(result.value);
			return ok(
				value instanceof Uint8Array ? value : (asBytes(value) as Uint8Array),
			);
		},
		openTextLineReader: async (path, context) => {
			const opened = await file<string>(
				"openTextLineReader",
				{ path },
				context,
			);
			if (!opened.ok) return opened;
			const readerId = opened.value;
			const reader: TextLineReader = {
				readLine: async (readContext) => {
					const line = await file<TextLine | null>(
						"readLine",
						{ readerId },
						readContext,
					);
					if (!line.ok) return line;
					return ok(line.value ?? undefined);
				},
				close: async () => {
					await caller.call({
						method: "closeReader",
						args: { readerId },
						generation,
					});
				},
			};
			return ok(reader);
		},
		openBinaryReader: async (path, readOptions, context) => {
			const opened = await file<{ id: string; info: FileInfo }>(
				"openBinaryReader",
				{ path, noFollow: readOptions?.noFollow === true },
				context,
			);
			if (!opened.ok) return opened;
			const readerId = opened.value.id;
			const reader: BinaryReader = {
				info: (readContext) => file("binaryInfo", { readerId }, readContext),
				read: async (offset, length, readContext) => {
					const chunk = await file<unknown>(
						"binaryRead",
						{ readerId, offset, length },
						readContext,
					);
					if (!chunk.ok) return chunk;
					const value = decodeBinary(chunk.value);
					if (value instanceof Uint8Array) return ok(value);
					if (typeof value === "string")
						return ok(new TextEncoder().encode(value));
					return ok(new Uint8Array());
				},
				scanLines: (scan, readContext) =>
					file(
						"binaryScan",
						{ readerId, startLine: scan.startLine, endLine: scan.endLine },
						readContext,
					),
				close: async () => {
					await caller.call({
						method: "closeReader",
						args: { readerId },
						generation,
					});
				},
			};
			return ok(reader);
		},
		writeFile: (path, content, context) =>
			file(
				"writeFile",
				{ path, content: encodeBinary(asBytes(content)) },
				context,
			),
		appendFile: (path, content, context) =>
			file(
				"appendFile",
				{ path, content: encodeBinary(asBytes(content)) },
				context,
			),
		truncateFile: (path, size, context) =>
			file("truncateFile", { path, size }, context),
		flushFile: (path, context) => file("flushFile", { path }, context),
		renameFile: (sourcePath, destinationPath, context) =>
			file(
				"renameFile",
				{ source: sourcePath, dest: destinationPath },
				context,
			),
		fileInfo: (path, context) => file("fileInfo", { path }, context),
		listDir: (path, context) => file("listDir", { path }, context),
		openDirReader: async (path, context) => {
			const opened = await file<string>("openDirReader", { path }, context);
			if (!opened.ok) return opened;
			const readerId = opened.value;
			const reader: DirReader = {
				next: (maxEntries, readContext) =>
					file("dirNext", { readerId, maxEntries }, readContext),
				close: async () => {
					await caller.call({
						method: "closeReader",
						args: { readerId },
						generation,
					});
				},
			};
			return ok(reader);
		},
		watch: async (targets, onChange, context) => {
			if (context.abortSignal?.aborted) {
				return err(new FileError("aborted", "aborted"));
			}
			const id = crypto.randomUUID();
			let mode: "native" | "polling" = "native";
			const opened = await caller.call({
				id,
				method: "watch",
				args: { targets },
				generation,
				onWatch: (change) => onChange(asWatchChange(change)),
			});
			if (!opened.ok) return asFile(opened);
			const value = opened.value as { mode?: string } | undefined;
			if (value?.mode === "polling") mode = "polling";
			caller.followWatch(id, (change) => onChange(asWatchChange(change)));
			const watcher: FileWatcher = {
				mode,
				stop: async () => {
					caller.unfollowWatch(id);
					await caller.call({
						method: "watch.close",
						args: { watchId: id },
						generation,
					});
				},
			};
			return ok(watcher);
		},
		canonicalPath: (path, context) => file("canonicalPath", { path }, context),
		exists: (path, context) => file("exists", { path }, context),
		createDir: (path, dirOptions, context) =>
			file(
				"createDir",
				{ path, recursive: dirOptions?.recursive === true },
				context,
			),
		remove: (path, removeOptions, context) =>
			file(
				"remove",
				{
					path,
					recursive: removeOptions?.recursive === true,
					force: removeOptions?.force === true,
				},
				context,
			),
		createTempDir: (prefix, context) =>
			file("createTempDir", { prefix }, context),
		createTempFile: (fileOptions, context) =>
			file(
				"createTempFile",
				{ prefix: fileOptions?.prefix, suffix: fileOptions?.suffix },
				context,
			),
		exec: async (command, execOptions, context) => {
			if (context.abortSignal?.aborted) {
				return err(new ExecutionError("aborted", "command aborted"));
			}
			const id = crypto.randomUUID();
			const onAbort = () => {
				void caller.call({
					method: "cancel",
					args: { callId: id },
					generation,
				});
			};
			context.abortSignal?.addEventListener("abort", onAbort);
			try {
				const result = await caller.call({
					id,
					method: "exec",
					args: execArgs(command, execOptions),
					generation,
					onOutput: (event) => {
						execOptions?.onOutput?.(event.text, context, {
							stream: event.stream,
							...(event.skipped ? { skipped: event.skipped } : {}),
						});
					},
				});
				if (!result.ok) {
					return err(
						new ExecutionError(
							(result.error.code as ExecErrorCode) || "unknown",
							result.error.message,
						),
					);
				}
				const value = (result.value ?? {}) as {
					exitCode?: number;
					spillPath?: string;
				};
				const execResult: ShellExecResult = {
					exitCode: value.exitCode ?? 0,
					...(value.spillPath ? { spillPath: value.spillPath } : {}),
				};
				return ok(execResult);
			} finally {
				context.abortSignal?.removeEventListener("abort", onAbort);
			}
		},
		cleanup: async () => {
			await caller.call({ method: "cleanup", args: {}, generation });
		},
	};

	return {
		env,
		ingest: (text) => {
			caller.ingest(text);
		},
		failAll: () => {
			caller.failGeneration(generation);
		},
	};
}

function execArgs(
	command: string | readonly string[],
	options: ShellExecOptions | undefined,
): Record<string, unknown> {
	return {
		command,
		cwd: options?.cwd,
		env: options?.env,
		inheritEnv: options?.inheritEnv,
		timeout: options?.timeout,
		spill: options?.spill,
		window: options?.window,
	};
}

function asFile<T>(result: WireCallResult): Result<T, FileError> {
	if (result.ok) return ok(result.value as T);
	if (result.error.kind === "exec") {
		return err(
			new FileError("unknown", result.error.message, result.error.path),
		);
	}
	return err(
		new FileError(
			(result.error.code || "unknown") as FileErrorCode,
			result.error.message,
			result.error.path,
		),
	);
}

function asWatchChange(change: unknown): FileChange {
	if (!change || typeof change !== "object")
		return { kind: "paths", paths: [] };
	const record = change as Record<string, unknown>;
	if (record.kind === "overflow" || record.overflow === true) {
		return { kind: "overflow" };
	}
	if (record.error && typeof record.error === "object") {
		const error = record.error as {
			code?: string;
			message?: string;
			path?: string;
		};
		return {
			kind: "failed",
			error: new FileError(
				(error.code || "unknown") as FileErrorCode,
				error.message ?? "watch error",
				error.path,
			),
		};
	}
	if (Array.isArray(record.paths)) {
		return {
			kind: "paths",
			paths: record.paths.filter((path) => typeof path === "string"),
		};
	}
	return { kind: "paths", paths: [] };
}

export function transportFile(): WireCallResult {
	return { ok: false, error: transportFailure("read") };
}
