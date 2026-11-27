import {
	BACKGROUND_CONTEXT,
	withAbortSignal,
} from "@earendil-works/chord/context";
import type {
	BinaryReader,
	DirReader,
	ExecutionEnv,
	FileChange,
	FileWatcher,
	ShellExecOptions,
	TextLineReader,
	WatchTarget,
} from "@earendil-works/pi-durable/env";
import {
	asBytes,
	bytesToBase64,
	encodeWire,
	parseWireRequest,
} from "../../worker/src/tools-env/wire.js";
import {
	type ConfineDetector,
	confinedExecArgv,
	confinePath,
} from "./confine.js";
import { type DaemonLogger, getDaemonLogger } from "./log.js";
import { deleteEphemeralDir, liveSessions, retainCwd } from "./workspace.js";

export interface SessionSocket {
	send(text: string): void;
	close(): void;
}

interface OpenReader {
	close(): Promise<void>;
	binary?: BinaryReader;
	text?: TextLineReader;
	dir?: DirReader;
}

/**
 * One accepted daemon socket. Closing it aborts execs, readers, and watches.
 * It does not delete `.cadmus-ephemeral`.
 */
export class DaemonSession {
	private socket: SessionSocket | undefined;
	private readonly release: () => void;
	private readonly aborts = new Map<string, AbortController>();
	private readonly readers = new Map<string, OpenReader>();
	private readonly watches = new Map<string, FileWatcher>();
	private readonly logger: DaemonLogger;
	private disposed = false;

	constructor(
		private readonly env: ExecutionEnv,
		private readonly options: {
			cwd: string;
			ephemeralDir?: string;
			confineToWorkspace?: boolean;
			mechanism?: ConfineDetector;
			logger?: DaemonLogger;
		},
	) {
		this.release = retainCwd(options.cwd);
		this.logger = options.logger ?? getDaemonLogger();
	}

	attach(socket: SessionSocket): void {
		this.socket = socket;
	}

	handleText(text: string): void {
		const parsed = parseWireRequest(text);
		if (parsed.action !== "request") return;
		void this.dispatch(
			parsed.request.id,
			parsed.request.method,
			parsed.request.args,
		);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const controller of this.aborts.values()) controller.abort();
		this.aborts.clear();
		for (const watcher of this.watches.values()) {
			void watcher.stop(BACKGROUND_CONTEXT);
		}
		this.watches.clear();
		for (const reader of this.readers.values()) void reader.close();
		this.readers.clear();
		void this.env.cleanup(BACKGROUND_CONTEXT);
		this.release();
	}

	private send(value: unknown): void {
		try {
			this.socket?.send(encodeWire(value));
		} catch {
			// The peer is already gone.
		}
	}

	private contextFor(id: string) {
		const controller = new AbortController();
		this.aborts.set(id, controller);
		return withAbortSignal(controller.signal, BACKGROUND_CONTEXT);
	}

	private finish(id: string): void {
		this.aborts.delete(id);
	}

	private mechanism(): "bwrap" | "sandbox-exec" | undefined {
		if (!this.options.confineToWorkspace || !this.options.mechanism)
			return undefined;
		if (this.options.mechanism.bwrap) return "bwrap";
		if (this.options.mechanism.sandboxExec) return "sandbox-exec";
		return undefined;
	}

	private jail(
		path: string,
	):
		| { ok: true; path: string }
		| { ok: false; error: { code: string; message: string; path?: string } } {
		if (!this.options.confineToWorkspace) return { ok: true, path };
		const checked = confinePath(this.options.cwd, path);
		if (!checked.ok) {
			return {
				ok: false,
				error: {
					code: checked.error.code,
					message: checked.error.message,
					path: checked.error.path,
				},
			};
		}
		return { ok: true, path: checked.path };
	}

	private async dispatch(
		id: string,
		method: string,
		args: unknown,
	): Promise<void> {
		const record =
			args && typeof args === "object" ? (args as Record<string, unknown>) : {};
		try {
			if (method === "heartbeat") {
				this.send({ id, ok: true, value: null });
				return;
			}
			if (method === "cancel") {
				const callId = typeof record.callId === "string" ? record.callId : "";
				this.logger.info("cancel", { callId });
				this.aborts.get(callId)?.abort();
				this.send({ id, ok: true, value: null });
				return;
			}
			if (method === "cleanup") {
				const deleteEphemeral = record.deleteEphemeral === true;
				this.logger.info("cleanup", { deleteEphemeral });
				await this.cleanup(deleteEphemeral);
				this.send({ id, ok: true, value: null });
				return;
			}
			if (method === "watch.close") {
				const watchId =
					typeof record.watchId === "string" ? record.watchId : "";
				this.logger.info("watch.close", { watchId });
				const watcher = this.watches.get(watchId);
				this.watches.delete(watchId);
				if (watcher) await watcher.stop(BACKGROUND_CONTEXT);
				this.send({ id, ok: true, value: null });
				return;
			}
			if (method === "closeReader") {
				const readerId =
					typeof record.readerId === "string" ? record.readerId : "";
				this.logger.info("closeReader", { readerId });
				const reader = this.readers.get(readerId);
				this.readers.delete(readerId);
				if (reader) await reader.close();
				this.send({ id, ok: true, value: null });
				return;
			}
			await this.callEnv(id, method, record);
		} catch (error) {
			const message =
				error instanceof Error ? error.message : "tools env call failed";
			this.logger.error(`${method} failed`, { error: message });
			this.send({
				id,
				ok: false,
				error: {
					kind: method === "exec" ? "exec" : "file",
					code: "unknown",
					message,
				},
			});
		} finally {
			this.finish(id);
		}
	}

	private async cleanup(deleteEphemeral: boolean): Promise<void> {
		await this.env.cleanup(BACKGROUND_CONTEXT);
		const dir = this.options.ephemeralDir;
		if (!deleteEphemeral || !dir) return;
		if (liveSessions(this.options.cwd) > 1) return;
		await deleteEphemeralDir(dir);
	}

	private async callEnv(
		id: string,
		method: string,
		args: Record<string, unknown>,
	): Promise<void> {
		const context = this.contextFor(id);
		const path = typeof args.path === "string" ? args.path : "";
		const jailed = path ? this.jail(path) : { ok: true as const, path: "" };
		if (!jailed.ok) {
			this.send({ id, ok: false, error: { kind: "file", ...jailed.error } });
			return;
		}
		const usePath = path ? jailed.path : path;
		if (method === "exec") {
			await this.exec(id, args, context);
			return;
		}
		if (method === "watch") {
			await this.watch(id, args, context);
			return;
		}
		if (
			method === "readLine" ||
			method === "binaryInfo" ||
			method === "binaryRead" ||
			method === "binaryScan" ||
			method === "dirNext"
		) {
			await this.readExisting(id, method, args, context);
			return;
		}
		const env = this.env;
		if (method === "absolutePath") {
			this.logger.info("path.absolute", { path: usePath });
			this.reply(id, await env.absolutePath(usePath, context));
			return;
		}
		if (method === "joinPath") {
			const parts = Array.isArray(args.parts)
				? args.parts.filter((part): part is string => typeof part === "string")
				: [];
			this.logger.info("path.join", { parts });
			this.reply(id, await env.joinPath(parts, context));
			return;
		}
		if (method === "readTextFile") {
			this.logger.info("file.readText", { path: usePath });
			this.reply(id, await env.readTextFile(usePath, context));
			return;
		}
		if (method === "readTextLines") {
			const maxLines =
				typeof args.maxLines === "number" ? args.maxLines : undefined;
			this.logger.info("file.readLines", { path: usePath, maxLines });
			this.reply(
				id,
				await env.readTextLines(
					usePath,
					{
						maxLines,
					},
					context,
				),
			);
			return;
		}
		if (method === "readBinaryFile") {
			this.logger.info("file.readBinary", { path: usePath });
			const result = await env.readBinaryFile(usePath, context);
			if (!result.ok) {
				this.reply(id, result);
				return;
			}
			this.send({
				id,
				ok: true,
				value: { base64: bytesToBase64(result.value) },
			});
			return;
		}
		if (method === "openTextLineReader") {
			this.logger.info("reader.openText", { path: usePath });
			const opened = await env.openTextLineReader(usePath, context);
			if (!opened.ok) {
				this.reply(id, opened);
				return;
			}
			const readerId = crypto.randomUUID();
			this.readers.set(readerId, {
				text: opened.value,
				close: () => opened.value.close(BACKGROUND_CONTEXT),
			});
			this.send({ id, ok: true, value: readerId });
			return;
		}
		if (method === "openBinaryReader") {
			const noFollow = args.noFollow === true;
			this.logger.info("reader.openBinary", { path: usePath, noFollow });
			const opened = await env.openBinaryReader(usePath, { noFollow }, context);
			if (!opened.ok) {
				this.reply(id, opened);
				return;
			}
			const readerId = crypto.randomUUID();
			const info = await opened.value.info(context);
			this.readers.set(readerId, {
				binary: opened.value,
				close: () => opened.value.close(BACKGROUND_CONTEXT),
			});
			this.send({
				id,
				ok: true,
				value: { id: readerId, info: info.ok ? info.value : null },
			});
			return;
		}
		if (method === "writeFile" || method === "appendFile") {
			const content = asBytes(args.content);
			const byteLength =
				typeof content === "string"
					? Buffer.byteLength(content)
					: content.byteLength;
			this.logger.info(method === "writeFile" ? "file.write" : "file.append", {
				path: usePath,
				bytes: byteLength,
			});
			const result =
				method === "writeFile"
					? await env.writeFile(usePath, content, context)
					: await env.appendFile(usePath, content, context);
			this.reply(id, result);
			return;
		}
		if (method === "truncateFile") {
			const size = Number(args.size ?? 0);
			this.logger.info("file.truncate", { path: usePath, size });
			this.reply(id, await env.truncateFile(usePath, size, context));
			return;
		}
		if (method === "flushFile") {
			this.logger.info("file.flush", { path: usePath });
			this.reply(id, await env.flushFile(usePath, context));
			return;
		}
		if (method === "renameFile") {
			const source = typeof args.source === "string" ? args.source : "";
			const dest = typeof args.dest === "string" ? args.dest : "";
			this.logger.info("file.rename", { from: source, to: dest });
			const jailedSource = this.jail(source);
			const jailedDest = this.jail(dest);
			if (!jailedSource.ok) {
				this.send({
					id,
					ok: false,
					error: { kind: "file", ...jailedSource.error },
				});
				return;
			}
			if (!jailedDest.ok) {
				this.send({
					id,
					ok: false,
					error: { kind: "file", ...jailedDest.error },
				});
				return;
			}
			this.reply(
				id,
				await env.renameFile(jailedSource.path, jailedDest.path, context),
			);
			return;
		}
		if (method === "fileInfo") {
			this.logger.info("file.stat", { path: usePath });
			this.reply(id, await env.fileInfo(usePath, context));
			return;
		}
		if (method === "listDir") {
			this.logger.info("dir.list", { path: usePath });
			this.reply(id, await env.listDir(usePath, context));
			return;
		}
		if (method === "openDirReader") {
			this.logger.info("reader.openDir", { path: usePath });
			const opened = await env.openDirReader(usePath, context);
			if (!opened.ok) {
				this.reply(id, opened);
				return;
			}
			const readerId = crypto.randomUUID();
			this.readers.set(readerId, {
				dir: opened.value,
				close: () => opened.value.close(BACKGROUND_CONTEXT),
			});
			this.send({ id, ok: true, value: readerId });
			return;
		}
		if (method === "canonicalPath") {
			this.logger.info("path.canonical", { path: usePath });
			this.reply(id, await env.canonicalPath(usePath, context));
			return;
		}
		if (method === "exists") {
			this.logger.info("file.exists", { path: usePath });
			this.reply(id, await env.exists(usePath, context));
			return;
		}
		if (method === "createDir") {
			const recursive = args.recursive === true;
			this.logger.info("dir.create", { path: usePath, recursive });
			this.reply(id, await env.createDir(usePath, { recursive }, context));
			return;
		}
		if (method === "remove") {
			const recursive = args.recursive === true;
			const force = args.force === true;
			this.logger.info("file.remove", { path: usePath, recursive, force });
			this.reply(id, await env.remove(usePath, { recursive, force }, context));
			return;
		}
		if (method === "createTempDir") {
			const prefix = typeof args.prefix === "string" ? args.prefix : undefined;
			this.logger.info("dir.createTemp", { prefix });
			this.reply(id, await env.createTempDir(prefix, context));
			return;
		}
		if (method === "createTempFile") {
			const prefix = typeof args.prefix === "string" ? args.prefix : undefined;
			const suffix = typeof args.suffix === "string" ? args.suffix : undefined;
			this.logger.info("file.createTemp", { prefix, suffix });
			this.reply(
				id,
				await env.createTempFile(
					{
						prefix,
						suffix,
					},
					context,
				),
			);
			return;
		}
		this.send({
			id,
			ok: false,
			error: {
				kind: "file",
				code: "not_supported",
				message: `unknown op ${method}`,
			},
		});
	}

	private async readExisting(
		id: string,
		method: string,
		args: Record<string, unknown>,
		context: ReturnType<DaemonSession["contextFor"]>,
	): Promise<void> {
		const readerId = typeof args.readerId === "string" ? args.readerId : "";
		const open = this.readers.get(readerId);
		if (!open) {
			this.send({
				id,
				ok: false,
				error: { kind: "file", code: "invalid", message: "reader is closed" },
			});
			return;
		}
		if (method === "readLine" && open.text) {
			this.logger.debug("reader.readLine", { readerId });
			this.reply(id, await open.text.readLine(context));
			return;
		}
		if (method === "binaryInfo" && open.binary) {
			this.logger.debug("reader.binaryInfo", { readerId });
			this.reply(id, await open.binary.info(context));
			return;
		}
		if (method === "binaryRead" && open.binary) {
			const offset = Number(args.offset ?? 0);
			const length = Number(args.length ?? 0);
			this.logger.debug("reader.binaryRead", { readerId, offset, length });
			const result = await open.binary.read(offset, length, context);
			if (!result.ok) {
				this.reply(id, result);
				return;
			}
			this.send({
				id,
				ok: true,
				value: { base64: bytesToBase64(result.value) },
			});
			return;
		}
		if (method === "binaryScan" && open.binary) {
			const startLine = Number(args.startLine ?? 1);
			const endLine =
				typeof args.endLine === "number" ? args.endLine : undefined;
			this.logger.debug("reader.binaryScan", { readerId, startLine, endLine });
			this.reply(
				id,
				await open.binary.scanLines(
					{
						startLine,
						...(typeof endLine === "number" ? { endLine } : {}),
					},
					context,
				),
			);
			return;
		}
		if (method === "dirNext" && open.dir) {
			const maxEntries = Number(args.maxEntries ?? 0);
			this.logger.debug("reader.dirNext", { readerId, maxEntries });
			this.reply(id, await open.dir.next(maxEntries, context));
			return;
		}
		this.send({
			id,
			ok: false,
			error: { kind: "file", code: "invalid", message: "reader kind mismatch" },
		});
	}

	private async exec(
		id: string,
		args: Record<string, unknown>,
		context: ReturnType<DaemonSession["contextFor"]>,
	): Promise<void> {
		const command = args.command as string | string[];
		const commandStr = Array.isArray(command)
			? command.join(" ")
			: String(command);
		const mechanism = this.mechanism();
		const wrapped = mechanism
			? confinedExecArgv({
					mechanism,
					workspace: this.options.cwd,
					command,
				})
			: command;
		// sandbox-exec does not force --chdir. A cwd outside the workspace
		// falls back to the workspace so the child cannot start there.
		let cwd = this.options.cwd;
		if (typeof args.cwd === "string") {
			if (this.options.confineToWorkspace) {
				const jailed = this.jail(args.cwd);
				cwd = jailed.ok ? jailed.path : this.options.cwd;
			} else {
				cwd = args.cwd;
			}
		}
		this.logger.info("exec.start", {
			command: commandStr,
			cwd,
			mechanism,
		});
		const options: ShellExecOptions = {
			cwd,
			env:
				args.env && typeof args.env === "object"
					? (args.env as Record<string, string>)
					: undefined,
			inheritEnv: args.inheritEnv !== false,
			...(typeof args.timeout === "number" ? { timeout: args.timeout } : {}),
			onOutput: (text, _context, info) => {
				const frame: Record<string, unknown> = {
					id,
					event: "output",
					text,
					stream: info.stream,
				};
				if (info.skipped) frame.skipped = info.skipped;
				this.send(frame);
			},
		};
		const result = await this.env.exec(wrapped, options, context);
		if (!result.ok) {
			this.logger.warn("exec.failed", {
				command: commandStr,
				code: result.error.code,
				error: result.error.message,
			});
			this.send({
				id,
				ok: false,
				error: {
					kind: "exec",
					code: result.error.code,
					message: result.error.message,
					...(result.error.spillPath
						? { spillPath: result.error.spillPath }
						: {}),
				},
			});
			return;
		}
		this.logger.info("exec.finish", {
			command: commandStr,
			exitCode: result.value.exitCode,
		});
		this.send({
			id,
			ok: true,
			value: {
				exitCode: result.value.exitCode,
				...(result.value.spillPath
					? { spillPath: result.value.spillPath }
					: {}),
			},
		});
	}

	private async watch(
		id: string,
		args: Record<string, unknown>,
		context: ReturnType<DaemonSession["contextFor"]>,
	): Promise<void> {
		const targets = Array.isArray(args.targets)
			? (args.targets as WatchTarget[])
			: [];
		const targetPaths = targets.map((t) => t.path);
		this.logger.info("watch.start", { paths: targetPaths });
		if (this.options.confineToWorkspace) {
			for (const target of targets) {
				const checked = this.jail(target.path);
				if (!checked.ok) {
					this.logger.warn("watch.rejected", {
						path: target.path,
						error: checked.error.message,
					});
					this.send({
						id,
						ok: false,
						error: { kind: "file", ...checked.error },
					});
					return;
				}
				target.path = checked.path;
			}
		}
		const opened = await this.env.watch(
			targets,
			(change) => {
				this.send({ id, event: "watch", change: encodeChange(change) });
			},
			context,
		);
		if (!opened.ok) {
			this.logger.warn("watch.failed", { error: opened.error.message });
			this.reply(id, opened);
			return;
		}
		this.watches.set(id, opened.value);
		this.send({ id, ok: true, value: { mode: opened.value.mode } });
	}

	private reply(
		id: string,
		result:
			| { ok: true; value?: unknown }
			| { ok: false; error: { code: string; message: string; path?: string } },
	): void {
		if (result.ok) {
			this.send({ id, ok: true, value: jsonValue(result.value) });
			return;
		}
		this.logger.warn("op.error", {
			code: result.error.code,
			message: result.error.message,
			path: result.error.path,
		});
		this.send({
			id,
			ok: false,
			error: {
				kind: "file",
				code: result.error.code,
				message: result.error.message,
				...(result.error.path ? { path: result.error.path } : {}),
			},
		});
	}
}

function jsonValue(value: unknown): unknown {
	if (value instanceof Uint8Array) return { base64: bytesToBase64(value) };
	return value === undefined ? null : value;
}

function encodeChange(change: FileChange): unknown {
	if (change.kind === "overflow") return { overflow: true };
	if (change.kind === "failed") {
		return {
			error: {
				code: change.error.code,
				message: change.error.message,
				...(change.error.path ? { path: change.error.path } : {}),
			},
		};
	}
	return { paths: change.paths };
}
