import type { Context } from "@earendil-works/chord";
import {
	type BinaryReader,
	type DirReader,
	type ExecutionEnv,
	ExecutionError,
	err,
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
	type WatchChange,
	type WatchTarget,
} from "@earendil-works/pi-durable/env";
import type { CadmusEnvDO, NamespaceCall } from "./env-do.js";
import type { OpError, OpResult, WatchEvent } from "./namespace.js";
import {
	OFFLINE_TOOLS_ENV,
	resolveHostPath,
	resolveWorkspacePath,
	WORKSPACE_ROOT,
} from "./pure.js";

export interface EnvDoStub {
	invoke(
		call: NamespaceCall,
		op: string,
		payload?: Record<string, unknown>,
	): Promise<OpResult<unknown>>;
	cancelExec(callId: string, call: NamespaceCall): Promise<void>;
	openWatch(
		call: NamespaceCall,
		targets: readonly WatchTarget[],
	): Promise<OpResult<string>>;
	watchEvents(call: NamespaceCall, watchId: string): ReadableStream<string>;
	takeWatchEvents(call: NamespaceCall, watchId: string): Promise<WatchEvent[]>;
	closeWatch(call: NamespaceCall, watchId: string): Promise<void>;
}

/**
 * Returned when the daemon row is disconnected. pi-durable resolves `env()`
 * before every tool, including memory and knowledge. Methods throw the offline
 * error, so a coding tool sends no wire frame and the other tools still run.
 */
export function createOfflineExecutionEnv(
	id: string,
	cwd: string,
): ExecutionEnv {
	const fail = (): never => {
		throw new Error(OFFLINE_TOOLS_ENV);
	};
	return new Proxy({ id, cwd } as ExecutionEnv, {
		get(target, prop, receiver) {
			if (
				prop === "id" ||
				prop === "cwd" ||
				prop === "then" ||
				typeof prop === "symbol"
			) {
				return Reflect.get(target, prop, receiver);
			}
			return fail;
		},
	});
}

export function createProxyExecutionEnv(options: {
	stub: EnvDoStub;
	id: string;
	call: NamespaceCall;
	cwd?: string;
	pathMode?: "workspace" | "host";
}): ExecutionEnv {
	const { stub, call } = options;
	const cwd = options.cwd ?? WORKSPACE_ROOT;
	const pathMode = options.pathMode ?? "workspace";
	const resolve = (input: string) =>
		pathMode === "host"
			? resolveHostPath(input, cwd)
			: resolveWorkspacePath(input, cwd);
	const env: ExecutionEnv = {
		id: options.id,
		cwd,
		absolutePath: (path) => Promise.resolve(pathResult(resolve(path))),
		joinPath: async (parts) => {
			let current = cwd;
			for (const part of parts) {
				current = part.startsWith("/") ? part : `${current}/${part}`;
			}
			return pathResult(resolve(current));
		},
		readTextFile: (path, context) =>
			callFile(stub, call, context, "readTextFile", { path }),
		readTextLines: (path, readOptions, context) =>
			callFile(stub, call, context, "readTextLines", {
				path,
				maxLines: readOptions?.maxLines,
			}),
		readBinaryFile: (path, context) =>
			callFile(stub, call, context, "readBinaryFile", { path }),
		openTextLineReader: async (path, context) => {
			const opened = await callFile<string>(
				stub,
				call,
				context,
				"openTextLineReader",
				{ path },
			);
			if (!opened.ok) return opened;
			const reader: TextLineReader = {
				readLine: async (readContext) => {
					if (readContext.abortSignal?.aborted) {
						return err(new FileError("aborted", "aborted"));
					}
					const line = await callFile<TextLine | null>(
						stub,
						call,
						readContext,
						"readLine",
						{ readerId: opened.value },
					);
					if (!line.ok) return line;
					return ok(line.value ?? undefined);
				},
				close: async () => {
					await stub.invoke(call, "closeReader", { readerId: opened.value });
				},
			};
			return ok(reader);
		},
		openBinaryReader: async (path, readOptions, context) => {
			const opened = await callFile<{ id: string; info: FileInfo }>(
				stub,
				call,
				context,
				"openBinaryReader",
				{ path, noFollow: readOptions?.noFollow === true },
			);
			if (!opened.ok) return opened;
			const readerId = opened.value.id;
			const reader: BinaryReader = {
				info: (readContext) =>
					callFile(stub, call, readContext, "binaryInfo", { readerId }),
				read: (offset, length, readContext) =>
					callFile(stub, call, readContext, "binaryRead", {
						readerId,
						offset,
						length,
					}),
				scanLines: (scan, readContext) =>
					callFile(stub, call, readContext, "binaryScan", {
						readerId,
						startLine: scan.startLine,
						endLine: scan.endLine,
					}),
				close: async () => {
					await stub.invoke(call, "closeReader", { readerId });
				},
			};
			return ok(reader);
		},
		writeFile: (path, content, context) =>
			callFile(stub, call, context, "writeFile", { path, content }),
		appendFile: (path, content, context) =>
			callFile(stub, call, context, "appendFile", { path, content }),
		truncateFile: (path, size, context) =>
			callFile(stub, call, context, "truncateFile", { path, size }),
		flushFile: (path, context) =>
			callFile(stub, call, context, "flushFile", { path }),
		renameFile: (sourcePath, destinationPath, context) =>
			callFile(stub, call, context, "renameFile", {
				source: sourcePath,
				dest: destinationPath,
			}),
		fileInfo: (path, context) =>
			callFile(stub, call, context, "fileInfo", { path }),
		listDir: (path, context) =>
			callFile(stub, call, context, "listDir", { path }),
		openDirReader: async (path, context) => {
			const opened = await callFile<string>(
				stub,
				call,
				context,
				"openDirReader",
				{
					path,
				},
			);
			if (!opened.ok) return opened;
			const reader: DirReader = {
				next: (maxEntries, readContext) =>
					callFile(stub, call, readContext, "dirNext", {
						readerId: opened.value,
						maxEntries,
					}),
				close: async () => {
					await stub.invoke(call, "closeReader", { readerId: opened.value });
				},
			};
			return ok(reader);
		},
		watch: (targets, onChange, context) =>
			watchProxy(stub, call, targets, onChange, context),
		canonicalPath: (path, context) =>
			callFile(stub, call, context, "canonicalPath", { path }),
		exists: (path, context) =>
			callFile(stub, call, context, "exists", { path }),
		createDir: (path, dirOptions, context) =>
			callFile(stub, call, context, "createDir", {
				path,
				recursive: dirOptions?.recursive === true,
			}),
		remove: (path, removeOptions, context) =>
			callFile(stub, call, context, "remove", {
				path,
				recursive: removeOptions?.recursive === true,
				force: removeOptions?.force === true,
			}),
		createTempDir: (prefix, context) =>
			callFile(stub, call, context, "createTempDir", { prefix }),
		createTempFile: (fileOptions, context) =>
			callFile(stub, call, context, "createTempFile", {
				prefix: fileOptions?.prefix,
				suffix: fileOptions?.suffix,
			}),
		exec: (command, execOptions, context) =>
			execProxy(stub, call, command, execOptions, context),
		cleanup: async () => {
			await stub.invoke(call, "cleanup", {});
		},
	};
	return env;
}

export function stubFromEnvDo(stub: DurableObjectStub<CadmusEnvDO>): EnvDoStub {
	return stub;
}

function pathResult(resolved: {
	ok: boolean;
	path?: string;
	message?: string;
}): Result<string, FileError> {
	if (resolved.ok && resolved.path) return ok(resolved.path);
	return err(new FileError("invalid", resolved.message ?? "invalid path"));
}

async function callFile<T>(
	stub: EnvDoStub,
	call: NamespaceCall,
	context: Context,
	op: string,
	payload: Record<string, unknown>,
): Promise<Result<T, FileError>> {
	if (context.abortSignal?.aborted) {
		return err(new FileError("aborted", "aborted"));
	}
	const result = await stub.invoke(call, op, payload);
	return asFile(result as OpResult<T>);
}

function asFile<T>(result: OpResult<T>): Result<T, FileError> {
	if (result.ok) return ok(result.value);
	const code = (result.error.code || "unknown") as FileErrorCode;
	return err(new FileError(code, result.error.message, result.error.path));
}

async function execProxy(
	stub: EnvDoStub,
	call: NamespaceCall,
	command: string | readonly string[],
	execOptions: ShellExecOptions | undefined,
	context: Context,
): Promise<Result<ShellExecResult, ExecutionError>> {
	if (context.abortSignal?.aborted) {
		return err(new ExecutionError("aborted", "command aborted"));
	}
	const callId = crypto.randomUUID();
	const onAbort = () => {
		void stub.cancelExec(callId, call);
	};
	context.abortSignal?.addEventListener("abort", onAbort);
	try {
		const result = await stub.invoke(call, "exec", {
			callId,
			command,
			cwd: execOptions?.cwd,
			timeoutSeconds: execOptions?.timeout,
			env: execOptions?.env,
		});
		if (!result.ok) {
			const error = (result as { error: OpError }).error;
			return err(
				new ExecutionError(
					(error.code as "aborted") || "unknown",
					error.message,
				),
			);
		}
		const value = result.value as {
			exitCode: number;
			stdout: string;
			stderr: string;
		};
		if (value.stdout) {
			execOptions?.onOutput?.(value.stdout, context, { stream: "stdout" });
		}
		if (value.stderr) {
			execOptions?.onOutput?.(value.stderr, context, { stream: "stderr" });
		}
		return ok({ exitCode: value.exitCode });
	} finally {
		context.abortSignal?.removeEventListener("abort", onAbort);
	}
}

async function watchProxy(
	stub: EnvDoStub,
	call: NamespaceCall,
	targets: readonly WatchTarget[],
	onChange: (change: WatchChange) => void,
	context: Context,
): Promise<Result<FileWatcher, FileError>> {
	if (context.abortSignal?.aborted) {
		return err(new FileError("aborted", "aborted"));
	}
	const opened = await stub.openWatch(call, targets);
	if (!opened.ok) return asFile(opened);
	const watchId = opened.value;
	let stopped = false;
	const deliver = (event: WatchEvent) => {
		if (stopped) return;
		if ("error" in event && !("paths" in event) && !("overflow" in event)) {
			onChange({
				error: new FileError(
					event.error.code as FileErrorCode,
					event.error.message,
					event.error.path,
				),
			});
			return;
		}
		onChange(event as WatchChange);
	};
	// Durable Object RPC does not reliably deliver a live ReadableStream across
	// isolates. The env DO polls and buffers; this side drains that buffer.
	const pump = (async () => {
		while (!stopped) {
			const events = await stub.takeWatchEvents(call, watchId);
			for (const event of events) deliver(event);
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	})();
	const watcher: FileWatcher = {
		mode: "polling",
		close: async () => {
			if (stopped) return;
			stopped = true;
			await stub.closeWatch(call, watchId);
			await pump.catch(() => undefined);
		},
	};
	return ok(watcher);
}
