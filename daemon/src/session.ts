import {
	BACKGROUND_CONTEXT,
	withAbortSignal,
} from "@earendil-works/chord/context";
import type {
	BinaryReader,
	DirReader,
	ExecutionEnv,
	FileWatcher,
	ShellExecOptions,
	TextLineReader,
	WatchChange,
	WatchTarget,
} from "@earendil-works/pi-durable/env";
import {
	asBytes,
	bytesToBase64,
	encodeWire,
	parseWireRequest,
} from "../../src/tools-env/wire.js";
import {
	type ConfineDetector,
	confinedExecArgv,
	confinePath,
} from "./confine.js";
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
	private disposed = false;

	constructor(
		private readonly env: ExecutionEnv,
		private readonly options: {
			cwd: string;
			ephemeralDir?: string;
			confineToWorkspace?: boolean;
			mechanism?: ConfineDetector;
		},
	) {
		this.release = retainCwd(options.cwd);
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
			void watcher.close(BACKGROUND_CONTEXT);
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
				this.aborts.get(callId)?.abort();
				this.send({ id, ok: true, value: null });
				return;
			}
			if (method === "cleanup") {
				await this.cleanup(record.deleteEphemeral === true);
				this.send({ id, ok: true, value: null });
				return;
			}
			if (method === "watch.close") {
				const watchId =
					typeof record.watchId === "string" ? record.watchId : "";
				const watcher = this.watches.get(watchId);
				this.watches.delete(watchId);
				if (watcher) await watcher.close(BACKGROUND_CONTEXT);
				this.send({ id, ok: true, value: null });
				return;
			}
			if (method === "closeReader") {
				const readerId =
					typeof record.readerId === "string" ? record.readerId : "";
				const reader = this.readers.get(readerId);
				this.readers.delete(readerId);
				if (reader) await reader.close();
				this.send({ id, ok: true, value: null });
				return;
			}
			await this.callEnv(id, method, record);
		} catch (error) {
			this.send({
				id,
				ok: false,
				error: {
					kind: method === "exec" ? "exec" : "file",
					code: "unknown",
					message:
						error instanceof Error ? error.message : "tools env call failed",
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
			this.reply(id, await env.absolutePath(usePath, context));
			return;
		}
		if (method === "joinPath") {
			const parts = Array.isArray(args.parts)
				? args.parts.filter((part): part is string => typeof part === "string")
				: [];
			this.reply(id, await env.joinPath(parts, context));
			return;
		}
		if (method === "readTextFile") {
			this.reply(id, await env.readTextFile(usePath, context));
			return;
		}
		if (method === "readTextLines") {
			this.reply(
				id,
				await env.readTextLines(
					usePath,
					{
						maxLines:
							typeof args.maxLines === "number" ? args.maxLines : undefined,
					},
					context,
				),
			);
			return;
		}
		if (method === "readBinaryFile") {
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
			const opened = await env.openBinaryReader(
				usePath,
				{ noFollow: args.noFollow === true },
				context,
			);
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
			const result =
				method === "writeFile"
					? await env.writeFile(usePath, content, context)
					: await env.appendFile(usePath, content, context);
			this.reply(id, result);
			return;
		}
		if (method === "truncateFile") {
			this.reply(
				id,
				await env.truncateFile(usePath, Number(args.size ?? 0), context),
			);
			return;
		}
		if (method === "flushFile") {
			this.reply(id, await env.flushFile(usePath, context));
			return;
		}
		if (method === "renameFile") {
			const source = typeof args.source === "string" ? args.source : "";
			const dest = typeof args.dest === "string" ? args.dest : "";
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
			this.reply(id, await env.fileInfo(usePath, context));
			return;
		}
		if (method === "listDir") {
			this.reply(id, await env.listDir(usePath, context));
			return;
		}
		if (method === "openDirReader") {
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
			this.reply(id, await env.canonicalPath(usePath, context));
			return;
		}
		if (method === "exists") {
			this.reply(id, await env.exists(usePath, context));
			return;
		}
		if (method === "createDir") {
			this.reply(
				id,
				await env.createDir(
					usePath,
					{ recursive: args.recursive === true },
					context,
				),
			);
			return;
		}
		if (method === "remove") {
			this.reply(
				id,
				await env.remove(
					usePath,
					{ recursive: args.recursive === true, force: args.force === true },
					context,
				),
			);
			return;
		}
		if (method === "createTempDir") {
			this.reply(
				id,
				await env.createTempDir(
					typeof args.prefix === "string" ? args.prefix : undefined,
					context,
				),
			);
			return;
		}
		if (method === "createTempFile") {
			this.reply(
				id,
				await env.createTempFile(
					{
						prefix: typeof args.prefix === "string" ? args.prefix : undefined,
						suffix: typeof args.suffix === "string" ? args.suffix : undefined,
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
			this.reply(id, await open.text.readLine(context));
			return;
		}
		if (method === "binaryInfo" && open.binary) {
			this.reply(id, await open.binary.info(context));
			return;
		}
		if (method === "binaryRead" && open.binary) {
			const result = await open.binary.read(
				Number(args.offset ?? 0),
				Number(args.length ?? 0),
				context,
			);
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
			this.reply(
				id,
				await open.binary.scanLines(
					{
						startLine: Number(args.startLine ?? 1),
						...(typeof args.endLine === "number"
							? { endLine: args.endLine }
							: {}),
					},
					context,
				),
			);
			return;
		}
		if (method === "dirNext" && open.dir) {
			this.reply(
				id,
				await open.dir.next(Number(args.maxEntries ?? 0), context),
			);
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
		if (this.options.confineToWorkspace) {
			for (const target of targets) {
				const checked = this.jail(target.path);
				if (!checked.ok) {
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

function encodeChange(change: WatchChange): unknown {
	if ("overflow" in change && change.overflow) return { overflow: true };
	if ("error" in change && change.error) {
		return {
			error: {
				code: change.error.code,
				message: change.error.message,
				...(change.error.path ? { path: change.error.path } : {}),
			},
		};
	}
	const paths =
		"paths" in change && Array.isArray(change.paths) ? change.paths : [];
	return { paths };
}
