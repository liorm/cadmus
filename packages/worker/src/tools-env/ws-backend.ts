import { getLogger } from "../log.js";
import type { OpResult, WatchEvent } from "./namespace.js";
import {
	asBytes,
	decodeBinary,
	encodeBinary,
	encodeWire,
	FILE_CALL_TIMEOUT_MS,
	HEARTBEAT_MS,
	TRANSPORT_DISCONNECTED,
} from "./wire.js";
import { WireCaller } from "./wire-call.js";

export interface ConnectionSnapshot {
	status: "connected" | "disconnected";
	generation?: number;
	connectedAt?: number;
	disconnectedAt?: number;
	lastError?: string;
}

type ConnectionRow = {
	env_id: string;
	status: "connected" | "disconnected";
	generation: number;
	connected_at: number | null;
	disconnected_at: number | null;
	last_error: string | null;
};

interface SocketAttachment {
	envId: string;
	generation: number;
}

const EXEC_METHODS = new Set(["exec"]);
const FILE_METHODS = new Set([
	"readTextFile",
	"readBinaryFile",
	"readTextLines",
	"openTextLineReader",
	"readLine",
	"openBinaryReader",
	"binaryInfo",
	"binaryRead",
	"binaryScan",
	"closeReader",
	"writeFile",
	"appendFile",
	"truncateFile",
	"flushFile",
	"renameFile",
	"fileInfo",
	"listDir",
	"openDirReader",
	"dirNext",
	"exists",
	"createDir",
	"remove",
	"canonicalPath",
	"createTempDir",
	"createTempFile",
	"absolutePath",
	"joinPath",
]);

/**
 * WebSocket backend for one daemon env DO.
 * Heartbeats use setTimeout and only run while calls are in flight.
 * Disconnect writes compare-and-swap on generation and only while the row is
 * still connected, so a close that follows heartbeat_timeout or secret_missing
 * cannot overwrite that last_error.
 */
export class WsRemoteBackend {
	private readonly caller: WireCaller;
	private inFlight = 0;
	private timer: ReturnType<typeof setTimeout> | null = null;
	private heartbeatId: string | null = null;
	private readonly watches = new Map<string, WatchEvent[]>();
	private envId = "";
	private schemaDone = false;

	constructor(
		private readonly sql: SqlStorage,
		private readonly sockets: () => WebSocket[],
		private readonly heartbeatMs = HEARTBEAT_MS,
	) {
		this.caller = new WireCaller((text) => this.sendRaw(text));
	}

	ensureSchema(): void {
		if (this.schemaDone) return;
		this.sql.exec(`
			CREATE TABLE IF NOT EXISTS cadmus_env_connection (
				env_id TEXT PRIMARY KEY,
				status TEXT NOT NULL,
				generation INTEGER NOT NULL,
				connected_at INTEGER,
				disconnected_at INTEGER,
				last_error TEXT
			);
		`);
		this.schemaDone = true;
	}

	getConnection(kind: "just-bash" | "local-daemon"): ConnectionSnapshot {
		if (kind !== "local-daemon") return { status: "connected" };
		const row = this.readRow();
		if (!row) return { status: "disconnected" };
		return snapshot(row);
	}

	/** One write. Returns the generation now stored on the row. */
	markConnected(envId: string): number {
		this.envId = envId;
		const now = Date.now();
		const existing = this.readRow();
		if (!existing) {
			this.sql.exec(
				`INSERT INTO cadmus_env_connection (
           env_id, status, generation, connected_at, disconnected_at, last_error
         ) VALUES (?, 'connected', 1, ?, NULL, NULL)`,
				envId,
				now,
			);
		} else {
			this.sql.exec(
				`UPDATE cadmus_env_connection
         SET status = 'connected',
             generation = generation + 1,
             connected_at = ?,
             disconnected_at = NULL,
             last_error = NULL
         WHERE env_id = ?`,
				now,
				existing.env_id,
			);
		}
		const row = this.readRow();
		const generation = row?.generation ?? 1;
		getLogger().child({ envId }).debug("tools env daemon accepted", {
			toolsEnvStatus: "connected",
			generation,
			providerKind: "ws-remote",
		});
		return generation;
	}

	/**
	 * Confinement rejected before accept. A live socket is left alone.
	 * Otherwise last_error is set and generation is not bumped.
	 */
	noteConfinementUnavailable(envId: string): void {
		this.envId = envId;
		if (this.openSockets().length > 0) return;
		const now = Date.now();
		const existing = this.readRow();
		if (!existing) {
			this.sql.exec(
				`INSERT INTO cadmus_env_connection (
           env_id, status, generation, connected_at, disconnected_at, last_error
         ) VALUES (?, 'disconnected', 0, NULL, ?, 'confinement_unavailable')`,
				envId,
				now,
			);
			return;
		}
		if (existing.status === "connected") return;
		this.sql.exec(
			`UPDATE cadmus_env_connection
       SET disconnected_at = ?, last_error = 'confinement_unavailable'
       WHERE env_id = ? AND generation = ?`,
			now,
			existing.env_id,
			existing.generation,
		);
	}

	supersede(current: WebSocket, generation: number): void {
		for (const socket of this.sockets()) {
			if (socket === current) continue;
			const attachment = readAttachment(socket);
			try {
				socket.close(1000, "Superseded");
			} catch {
				// Already closed.
			}
			if (attachment) this.caller.failGeneration(attachment.generation);
		}
		void generation;
	}

	onMessage(
		ws: WebSocket,
		text: string,
	): "ok" | "too-large" | "client-command" {
		const parsed = this.caller.ingest(text);
		if (parsed.action === "too-large") return "too-large";
		if (parsed.action === "client-command") return "client-command";
		if (parsed.action === "invalid") {
			getLogger()
				.child({ envId: this.envId })
				.debug("tools env daemon frame dropped", { providerKind: "ws-remote" });
			return "ok";
		}
		if (
			parsed.action === "result" &&
			parsed.frame.ok &&
			parsed.frame.id === this.heartbeatId
		) {
			this.heartbeatId = null;
			this.clearTimer();
			if (this.inFlight > 0) this.arm();
		}
		void ws;
		return "ok";
	}

	onSocketClosed(ws: WebSocket, lastError: string): void {
		const attachment = readAttachment(ws);
		if (!attachment) return;
		this.caller.failGeneration(attachment.generation);
		const updated = this.casDisconnect(attachment.generation, lastError);
		if (updated === 0) {
			getLogger()
				.child({ envId: attachment.envId })
				.debug("tools env disconnect lost the generation race", {
					generation: attachment.generation,
					providerKind: "ws-remote",
				});
			return;
		}
		this.stopHeartbeat();
		getLogger()
			.child({ envId: attachment.envId })
			.warn("tools env daemon socket closed", {
				toolsEnvStatus: "disconnected",
				generation: attachment.generation,
				lastError,
				providerKind: "ws-remote",
			});
	}

	async invoke(
		op: string,
		payload: Record<string, unknown>,
	): Promise<OpResult<unknown>> {
		const socket = this.currentSocket();
		if (!socket) {
			this.casDisconnect(this.readRow()?.generation, "socket_closed");
			return transportOp(op);
		}
		const attachment = readAttachment(socket);
		const generation = attachment?.generation ?? 0;
		this.enter();
		const started = Date.now();
		try {
			if (op === "exec") {
				return await this.exec(payload, generation, started);
			}
			const args = wireArgs(op, payload);
			const timeoutMs = FILE_METHODS.has(op) ? FILE_CALL_TIMEOUT_MS : undefined;
			const id =
				typeof payload.callId === "string" ? payload.callId : undefined;
			const result = await this.caller.call({
				id,
				method: op,
				args,
				generation,
				timeoutMs,
			});
			if (!result.ok && result.error.message === TRANSPORT_DISCONNECTED) {
				this.failTransport(generation);
			}
			return toOp(op, result.ok, result.ok ? result.value : result.error);
		} finally {
			this.leave();
			void started;
		}
	}

	async openWatch(
		targets: readonly Record<string, unknown>[],
	): Promise<OpResult<string>> {
		const socket = this.currentSocket();
		if (!socket) return transportOp("watch");
		const generation = readAttachment(socket)?.generation ?? 0;
		const id = crypto.randomUUID();
		const buffer: WatchEvent[] = [];
		this.watches.set(id, buffer);
		this.caller.followWatch(id, (change) => {
			buffer.push(asWatchEvent(change));
		});
		this.enter();
		try {
			const result = await this.caller.call({
				id,
				method: "watch",
				args: { targets },
				generation,
				timeoutMs: FILE_CALL_TIMEOUT_MS,
			});
			if (!result.ok) {
				this.watches.delete(id);
				this.caller.unfollowWatch(id);
				if (result.error.message === TRANSPORT_DISCONNECTED) {
					this.failTransport(generation);
				}
				return {
					ok: false,
					error: {
						code: result.error.code,
						message: result.error.message,
						path: result.error.path,
					},
				};
			}
			return { ok: true, value: id };
		} finally {
			this.leave();
		}
	}

	takeWatchEvents(watchId: string): WatchEvent[] {
		const buffer = this.watches.get(watchId);
		if (!buffer) return [];
		const events = buffer.splice(0, buffer.length);
		return events;
	}

	async closeWatch(watchId: string): Promise<void> {
		this.watches.delete(watchId);
		this.caller.unfollowWatch(watchId);
		const socket = this.currentSocket();
		if (!socket) return;
		const generation = readAttachment(socket)?.generation ?? 0;
		await this.caller.call({
			method: "watch.close",
			args: { watchId },
			generation,
			timeoutMs: FILE_CALL_TIMEOUT_MS,
		});
	}

	cancel(callId: string): void {
		const socket = this.currentSocket();
		if (!socket) return;
		const generation = readAttachment(socket)?.generation ?? 0;
		void this.caller.call({
			method: "cancel",
			args: { callId },
			generation,
		});
	}

	async revoke(): Promise<void> {
		const row = this.readRow();
		const socket = this.currentSocket();
		const generation = readAttachment(socket)?.generation ?? row?.generation;
		if (generation !== undefined) {
			this.casDisconnect(generation, "secret_missing");
		}
		this.caller.failGeneration(generation ?? -1);
		this.stopHeartbeat();
		if (socket) {
			try {
				socket.close(1008, "Pairing secret revoked");
			} catch {
				// Already closed.
			}
		}
	}

	async closeForConfig(input: { deleteEphemeral: boolean }): Promise<void> {
		const socket = this.currentSocket();
		const generation =
			readAttachment(socket)?.generation ?? this.readRow()?.generation;
		if (socket && generation !== undefined) {
			this.enter();
			try {
				await this.caller.call({
					method: "cleanup",
					args: { deleteEphemeral: input.deleteEphemeral },
					generation,
					timeoutMs: FILE_CALL_TIMEOUT_MS,
				});
			} finally {
				this.leave();
			}
			try {
				socket.close(1000, "Env closed");
			} catch {
				// Already closed.
			}
		}
		if (generation !== undefined) {
			this.casDisconnect(generation, "socket_closed");
		}
		this.caller.failGeneration(generation ?? -1);
		this.stopHeartbeat();
	}

	async readAlarm(
		getAlarm: () => Promise<number | null>,
	): Promise<number | null> {
		return getAlarm();
	}

	private async exec(
		payload: Record<string, unknown>,
		generation: number,
		started: number,
	): Promise<OpResult<unknown>> {
		let stdout = "";
		let stderr = "";
		const id =
			typeof payload.callId === "string" ? payload.callId : crypto.randomUUID();
		const result = await this.caller.call({
			id,
			method: "exec",
			generation,
			args: {
				command: payload.command,
				cwd: payload.cwd,
				env: payload.env,
				inheritEnv: payload.inheritEnv,
				timeout: payload.timeoutSeconds,
				spill: payload.spill,
				window: payload.window,
			},
			onOutput: (event) => {
				if (event.stream === "stderr") stderr += event.text;
				else stdout += event.text;
			},
		});
		if (!result.ok) {
			if (result.error.message === TRANSPORT_DISCONNECTED) {
				this.failTransport(generation);
			}
			return {
				ok: false,
				error: {
					code: result.error.code,
					message: result.error.message,
					path: result.error.path,
				},
			};
		}
		const value = (result.value ?? {}) as {
			exitCode?: number;
			spillPath?: string;
		};
		return {
			ok: true,
			value: {
				exitCode: value.exitCode ?? 0,
				stdout,
				stderr,
				runtimeMs: Date.now() - started,
				...(value.spillPath ? { spillPath: value.spillPath } : {}),
			},
		};
	}

	private enter(): void {
		const previous = this.inFlight;
		this.inFlight += 1;
		if (previous === 0) this.arm();
	}

	private leave(): void {
		this.inFlight = Math.max(0, this.inFlight - 1);
		if (this.inFlight === 0) this.stopHeartbeat();
	}

	private arm(): void {
		if (this.timer !== null || this.inFlight <= 0) return;
		this.timer = setTimeout(() => this.tick(), this.heartbeatMs);
	}

	private tick(): void {
		this.timer = null;
		if (this.inFlight <= 0) return;
		if (this.heartbeatId) {
			this.onHeartbeatMiss();
			return;
		}
		const id = crypto.randomUUID();
		this.heartbeatId = id;
		const sent = this.sendRaw(encodeWire({ id, method: "heartbeat" }));
		if (!sent) {
			this.onHeartbeatMiss();
			return;
		}
		this.arm();
	}

	private onHeartbeatMiss(): void {
		const generation = readAttachment(this.currentSocket())?.generation;
		this.heartbeatId = null;
		this.clearTimer();
		if (generation !== undefined) {
			this.caller.failGeneration(generation);
			const updated = this.casDisconnect(generation, "heartbeat_timeout");
			if (updated > 0) this.closeCurrent(1001, "heartbeat timeout");
		}
		this.inFlight = 0;
		getLogger()
			.child({ envId: this.envId })
			.warn("tools env heartbeat timeout", {
				toolsEnvStatus: "disconnected",
				generation,
				lastError: "heartbeat_timeout",
				providerKind: "ws-remote",
				inFlight: 0,
			});
	}

	private stopHeartbeat(): void {
		this.clearTimer();
		this.heartbeatId = null;
	}

	private clearTimer(): void {
		if (this.timer !== null) clearTimeout(this.timer);
		this.timer = null;
	}

	private sendRaw(text: string): boolean {
		const socket = this.currentSocket();
		if (!socket || socket.readyState !== WebSocket.OPEN) return false;
		try {
			socket.send(text);
			return true;
		} catch {
			return false;
		}
	}

	/** A stale generation must not close the socket a newer accept already owns. */
	private failTransport(generation: number): void {
		const updated = this.casDisconnect(generation, "socket_closed");
		if (updated === 0) return;
		this.closeCurrent(1001, "transport timeout");
	}

	private closeCurrent(code: number, reason: string): void {
		const socket = this.currentSocket();
		if (!socket) return;
		try {
			socket.close(code, reason);
		} catch {
			// Already closed.
		}
	}

	private currentSocket(): WebSocket | undefined {
		const open = this.openSockets();
		if (open.length === 0) return undefined;
		let best: WebSocket | undefined;
		let generation = -1;
		for (const socket of open) {
			const attached = readAttachment(socket);
			const value = attached?.generation ?? -1;
			if (value >= generation) {
				generation = value;
				best = socket;
			}
		}
		return best;
	}

	private openSockets(): WebSocket[] {
		return this.sockets().filter(
			(socket) => socket.readyState === WebSocket.OPEN,
		);
	}

	private casDisconnect(
		generation: number | undefined,
		lastError: string,
	): number {
		if (generation === undefined) return 0;
		const row = this.readRow();
		if (!row) return 0;
		const cursor = this.sql.exec(
			`UPDATE cadmus_env_connection
       SET status = 'disconnected',
           disconnected_at = ?,
           last_error = ?
       WHERE env_id = ? AND generation = ? AND status = 'connected'`,
			Date.now(),
			lastError,
			row.env_id,
			generation,
		);
		cursor.toArray();
		return cursor.rowsWritten ?? 0;
	}

	private readRow(): ConnectionRow | undefined {
		this.ensureSchema();
		const rows = this.sql
			.exec<ConnectionRow>(
				`SELECT env_id, status, generation, connected_at, disconnected_at, last_error
         FROM cadmus_env_connection
         LIMIT 1`,
			)
			.toArray();
		const row = rows[0];
		if (!row) return undefined;
		return {
			env_id: row.env_id,
			status: row.status === "connected" ? "connected" : "disconnected",
			generation: Number(row.generation),
			connected_at: row.connected_at === null ? null : Number(row.connected_at),
			disconnected_at:
				row.disconnected_at === null ? null : Number(row.disconnected_at),
			last_error: row.last_error,
		};
	}
}

function snapshot(row: ConnectionRow): ConnectionSnapshot {
	return {
		status: row.status,
		generation: row.generation,
		...(row.connected_at !== null ? { connectedAt: row.connected_at } : {}),
		...(row.disconnected_at !== null
			? { disconnectedAt: row.disconnected_at }
			: {}),
		...(row.last_error ? { lastError: row.last_error } : {}),
	};
}

function readAttachment(
	ws: WebSocket | undefined,
): SocketAttachment | undefined {
	if (!ws) return undefined;
	try {
		const value = ws.deserializeAttachment() as SocketAttachment | null;
		if (!value || typeof value.generation !== "number") return undefined;
		return value;
	} catch {
		return undefined;
	}
}

function transportOp<T>(op: string): OpResult<T> {
	const exec = EXEC_METHODS.has(op);
	return {
		ok: false,
		error: {
			code: exec ? "shell_unavailable" : "unknown",
			message: TRANSPORT_DISCONNECTED,
		},
	};
}

function toOp(
	op: string,
	okResult: boolean,
	value: unknown,
): OpResult<unknown> {
	if (!okResult) {
		const error = value as { code?: string; message?: string; path?: string };
		return {
			ok: false,
			error: {
				code: error.code ?? "unknown",
				message: error.message ?? "tools env call failed",
				path: error.path,
			},
		};
	}
	if (op === "binaryRead" || op === "readBinaryFile") {
		const decoded = decodeBinary(value);
		if (decoded instanceof Uint8Array) return { ok: true, value: decoded };
		if (typeof decoded === "string") {
			return { ok: true, value: new TextEncoder().encode(decoded) };
		}
		return { ok: true, value: new Uint8Array() };
	}
	return { ok: true, value: value ?? null };
}

function wireArgs(op: string, payload: Record<string, unknown>): unknown {
	if (op === "writeFile" || op === "appendFile") {
		return {
			path: payload.path,
			content: encodeBinary(asBytes(payload.content)),
		};
	}
	if (op === "renameFile") {
		return { source: payload.source, dest: payload.dest };
	}
	return payload;
}

function asWatchEvent(change: unknown): WatchEvent {
	if (!change || typeof change !== "object") return { paths: [] };
	const record = change as Record<string, unknown>;
	if (record.overflow === true) return { overflow: true };
	if (record.error && typeof record.error === "object") {
		const error = record.error as {
			code?: string;
			message?: string;
			path?: string;
		};
		return {
			error: {
				code: error.code ?? "unknown",
				message: error.message ?? "watch error",
				path: error.path,
			},
		};
	}
	if (Array.isArray(record.paths)) {
		return {
			paths: record.paths.filter(
				(path): path is string => typeof path === "string",
			),
		};
	}
	return { paths: [] };
}
