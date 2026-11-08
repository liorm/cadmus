import { DurableObject } from "cloudflare:workers";
import { getLogger } from "../log.js";
import type { ConfinementPolicy } from "../protocol.js";
import { D1AdminStore, sha256Hex } from "../store/d1-admin.js";
import type { Env } from "../types.js";
import {
	type FsSnapshotRow,
	JustBashNamespace,
	type OpResult,
	type WatchEvent,
} from "./namespace.js";
import {
	daemonLockPaths,
	encodePairingToken,
	parseReportedWorkspace,
	writeOpLockPaths,
} from "./pure.js";
import {
	frameByteLength,
	MAX_FRAME_BYTES,
	mintDaemonBearerToken,
	resolveHeartbeatMs,
} from "./wire.js";
import { type ConnectionSnapshot, WsRemoteBackend } from "./ws-backend.js";

export interface NamespaceCall {
	storageFamilyId: string;
	scope: string;
	botId: string;
	chatKey: string;
	usageFamilyId: string;
	persist: boolean;
	/** Omitted calls stay on the just-bash backend. */
	backend?: "just-bash" | "ws-remote";
}

export interface UsageRow {
	grain: string;
	bucketStart: number;
	familyId: string;
	botId: string;
	chatKey: string;
	opKind: string;
	ops: number;
	bytesRead: number;
	bytesWritten: number;
	bashRuntimeMs: number;
	errors: number;
}

type OpKind = "read" | "write" | "exec" | "other";

const WRITE_OPS = new Set([
	"writeFile",
	"appendFile",
	"truncateFile",
	"renameFile",
	"createDir",
	"remove",
]);

/**
 * One account env. Just-bash namespaces and, for a daemon, one WebSocket live here.
 * Heartbeats are setTimeout on the WebSocket backend only. This class has no alarm.
 */
export class CadmusEnvDO extends DurableObject<Env> {
	private readonly namespaces = new Map<string, JustBashNamespace>();
	private readonly loading = new Map<string, Promise<JustBashNamespace>>();
	private readonly tails = new Map<string, Promise<unknown>>();
	private readonly ws: WsRemoteBackend;
	private inFlight = 0;
	private schemaReady: Promise<void>;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.ws = new WsRemoteBackend(
			ctx.storage.sql,
			() => ctx.getWebSockets("tools-env-daemon"),
			resolveHeartbeatMs(env.CADMUS_HEARTBEAT_MS),
		);
		this.schemaReady = ctx.blockConcurrencyWhile(async () => {
			this.ensureSchema();
		});
	}

	private ensureSchema(): void {
		this.ctx.storage.sql.exec(`
			CREATE TABLE IF NOT EXISTS cadmus_tools_env_fs (
				family_id TEXT NOT NULL,
				scope TEXT NOT NULL,
				bot_id TEXT NOT NULL,
				path TEXT NOT NULL,
				kind TEXT NOT NULL,
				content BLOB,
				PRIMARY KEY (family_id, scope, path)
			);
			CREATE INDEX IF NOT EXISTS idx_cadmus_tools_env_fs_bot
				ON cadmus_tools_env_fs (family_id, bot_id);
			CREATE TABLE IF NOT EXISTS cadmus_env_usage (
				grain TEXT NOT NULL,
				bucket_start INTEGER NOT NULL,
				family_id TEXT NOT NULL,
				bot_id TEXT NOT NULL,
				chat_key TEXT NOT NULL,
				op_kind TEXT NOT NULL,
				ops INTEGER NOT NULL,
				bytes_read INTEGER NOT NULL,
				bytes_written INTEGER NOT NULL,
				bash_runtime_ms INTEGER NOT NULL,
				errors INTEGER NOT NULL,
				PRIMARY KEY (grain, bucket_start, family_id, bot_id, chat_key, op_kind)
			);
		`);
	}

	async listStorageTables(): Promise<string[]> {
		await this.schemaReady;
		return this.ctx.storage.sql
			.exec<{ name: string }>(
				`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
			)
			.toArray()
			.map((row) => row.name);
	}

	async getConnection(
		kind: "just-bash" | "local-daemon" = "just-bash",
	): Promise<ConnectionSnapshot> {
		await this.schemaReady;
		return this.ws.getConnection(kind);
	}

	async readAlarm(): Promise<number | null> {
		await this.schemaReady;
		const alarm = await this.ctx.storage.getAlarm();
		return alarm ?? null;
	}

	async createPairing(input: {
		accountId: string;
		envId: string;
		persist: boolean;
		confineToWorkspace: boolean;
		confinementPolicy?: ConfinementPolicy;
		url: string;
		wsUrl: string;
	}): Promise<{ pairingToken: string; expiresAt: number; command: string }> {
		await this.schemaReady;
		const nonce = crypto.randomUUID();
		const secretBytes = crypto.getRandomValues(new Uint8Array(32));
		const secret = Array.from(secretBytes)
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
		const secretHash = await sha256Hex(secret);
		const expiresAt = Date.now() + 15 * 60 * 1000;
		const pending = {
			nonce,
			secretHash,
			expiresAt,
			accountId: input.accountId,
			envId: input.envId,
			persist: input.persist,
			confineToWorkspace: input.confineToWorkspace,
			confinementPolicy: input.confinementPolicy,
			url: input.url,
			wsUrl: input.wsUrl,
		};
		await this.ctx.storage.put("pending_pairing", pending);
		await this.ctx.storage.setAlarm(expiresAt);
		const requireConfinement =
			input.confinementPolicy === "required" ||
			(input.confinementPolicy === undefined && input.confineToWorkspace);
		const pairingToken = encodePairingToken({
			v: 1,
			accountId: input.accountId,
			envId: input.envId,
			url: input.url,
			wsUrl: input.wsUrl,
			persist: input.persist,
			confine: requireConfinement,
			nonce,
			exp: expiresAt,
			secret,
		});
		return {
			pairingToken,
			expiresAt,
			command: `cadmus-daemon pair ${pairingToken}`,
		};
	}

	override async alarm(): Promise<void> {
		await this.schemaReady;
		const pending = await this.ctx.storage.get<{ expiresAt: number }>(
			"pending_pairing",
		);
		if (pending && Date.now() >= pending.expiresAt) {
			await this.ctx.storage.delete("pending_pairing");
		}
	}

	async redeemPairing(input: {
		nonce: string;
		secret: string;
		name?: string;
	}): Promise<
		| {
				ok: true;
				token: string;
				envId: string;
				url: string;
				wsUrl: string;
				persist: boolean;
				confineToWorkspace: boolean;
				name?: string;
		  }
		| {
				ok: false;
				error: { code: string; message: string };
		  }
	> {
		await this.schemaReady;
		const pending = await this.ctx.storage.get<{
			nonce: string;
			secretHash: string;
			expiresAt: number;
			accountId: string;
			envId: string;
			persist: boolean;
			confineToWorkspace: boolean;
			url: string;
			wsUrl: string;
		}>("pending_pairing");
		if (!pending || Date.now() >= pending.expiresAt) {
			return {
				ok: false,
				error: {
					code: "pairing_expired_or_invalid",
					message: "Pairing token is invalid or has expired",
				},
			};
		}
		if (pending.nonce !== input.nonce) {
			return {
				ok: false,
				error: {
					code: "pairing_expired_or_invalid",
					message: "Pairing token nonce mismatch",
				},
			};
		}
		const inputHash = await sha256Hex(input.secret);
		if (inputHash !== pending.secretHash) {
			return {
				ok: false,
				error: {
					code: "pairing_expired_or_invalid",
					message: "Pairing secret mismatch",
				},
			};
		}
		await this.ctx.storage.delete("pending_pairing");
		try {
			await this.ctx.storage.deleteAlarm();
		} catch {
			// ignore
		}

		const adminStore = this.getAdminStore();
		const existingDef = await adminStore.getToolsEnv(
			pending.accountId,
			pending.envId,
		);
		const label = input.name?.trim() || existingDef?.label || undefined;
		const token = mintDaemonBearerToken();
		const tokenHash = await sha256Hex(token);
		await adminStore.assignToolsEnvDaemonToken(
			pending.accountId,
			pending.envId,
			tokenHash,
			label,
		);

		await this.fanOutCatalog(pending.accountId);

		return {
			ok: true,
			token,
			envId: pending.envId,
			url: pending.url,
			wsUrl: pending.wsUrl,
			persist: pending.persist,
			confineToWorkspace: pending.confineToWorkspace,
			name: label,
		};
	}

	async deregister(accountId: string, envId: string): Promise<void> {
		await this.schemaReady;
		await this.ws.revoke();
		await this.getAdminStore().clearToolsEnvDaemonToken(accountId, envId);
		await this.fanOutCatalog(accountId);
	}

	private getAdminStore(): D1AdminStore {
		return new D1AdminStore({
			db: this.env.CADMUS_ADMIN_DB,
			encryptionKey: this.env.CADMUS_ENCRYPTION_KEY,
			defaultTimezone: this.env.CADMUS_DEFAULT_TIMEZONE ?? "UTC",
			defaultHarvestDelayMs: Number(this.env.CADMUS_HARVEST_DELAY_MS ?? 60_000),
		});
	}

	private async fanOutCatalog(accountId: string): Promise<void> {
		const adminStore = this.getAdminStore();
		try {
			const families = await adminStore.listFamilies(accountId);
			await Promise.allSettled(
				families.map(async (family) => {
					try {
						const doId = this.env.CADMUS_BOT_FAMILY.idFromName(family.doName);
						const stub = this.env.CADMUS_BOT_FAMILY.get(doId);
						if (typeof stub.invalidateToolsEnvCatalog === "function") {
							await stub.invalidateToolsEnvCatalog({
								previousDefaultEnvId: null,
								nextDefaultEnvId: null,
							});
						}
					} catch {
						// ignore
					}
				}),
			);
		} catch {
			// ignore
		}
	}

	async closeForConfig(input: { deleteEphemeral: boolean }): Promise<void> {
		await this.schemaReady;
		await this.ws.closeForConfig(input);
	}

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname !== "/tools-env/ws") {
			return Response.json({ error: "Not found" }, { status: 404 });
		}
		await this.schemaReady;
		const envId = url.searchParams.get("envId")?.trim() ?? "";
		const accountId = request.headers.get("X-Cadmus-Account-Id") ?? "";
		const tokenHash = request.headers.get("X-Cadmus-Daemon-Token-Hash") ?? "";
		const capabilities = request.headers.get("X-Cadmus-Env-Capabilities") ?? "";
		const definition = await this.loadDefinition(accountId, envId);
		if (definition?.kind !== "local-daemon") {
			return new Response("unknown env", { status: 404 });
		}
		if (!tokenHash || definition.tokenHash !== tokenHash) {
			return new Response("token mismatch", { status: 403 });
		}
		const confined = capabilities
			.split(",")
			.some((part) => part.trim() === "confinement");
		const policy =
			definition.confinementPolicy ??
			(definition.confineToWorkspace ? "required" : "disabled");
		if (policy === "required" && !confined) {
			const message =
				"Environment requires confinement, but daemon connected with confinement disabled (or lacks bwrap/sandbox-exec)";
			this.ws.noteConfinementUnavailable(envId, "confinement_unavailable");
			return new Response(
				JSON.stringify({
					error: {
						code: "confinement_required",
						message,
					},
				}),
				{
					status: 409,
					headers: { "Content-Type": "application/json; charset=utf-8" },
				},
			);
		}
		const workspacePath = parseReportedWorkspace(
			request.headers.get("X-Cadmus-Workspace"),
		);
		if (!workspacePath) {
			return new Response("workspace_required", { status: 400 });
		}
		const effectiveConfined = policy !== "disabled" && confined;
		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];
		const generation = this.ws.markConnected(
			envId,
			workspacePath,
			effectiveConfined,
		);
		this.ctx.acceptWebSocket(server, ["tools-env-daemon"]);
		server.serializeAttachment({
			envId,
			generation,
			confined: effectiveConfined,
		});
		this.ws.supersede(server, generation);
		return new Response(null, { status: 101, webSocket: client });
	}

	override async webSocketMessage(
		ws: WebSocket,
		message: string | ArrayBuffer,
	): Promise<void> {
		const text =
			typeof message === "string" ? message : new TextDecoder().decode(message);
		if (
			text.length > MAX_FRAME_BYTES ||
			frameByteLength(text) > MAX_FRAME_BYTES
		) {
			try {
				ws.close(1009, "message too large");
			} catch {
				// Already closed.
			}
			return;
		}
		const action = this.ws.onMessage(ws, text);
		if (action === "too-large") {
			try {
				ws.close(1009, "message too large");
			} catch {
				// Already closed.
			}
			return;
		}
		if (action === "client-command") {
			try {
				ws.close(1008, "protocol command rejected");
			} catch {
				// Already closed.
			}
		}
	}

	override async webSocketClose(
		ws: WebSocket,
		code: number,
		_reason: string,
	): Promise<void> {
		this.ws.onSocketClosed(ws, "socket_closed");
		void code;
	}

	override async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
		this.ws.onSocketClosed(ws, "socket_closed");
		try {
			ws.close(1011, "socket error");
		} catch {
			// Already closed.
		}
	}

	checkOpLimits(): { allowed: true } {
		return { allowed: true };
	}

	async invoke(
		call: NamespaceCall,
		op: string,
		payload: Record<string, unknown> = {},
	): Promise<OpResult<unknown>> {
		await this.schemaReady;
		if (call.backend === "ws-remote") {
			return this.invokeRemote(call, op, payload);
		}
		const limits = this.checkOpLimits();
		if (!limits.allowed) {
			return {
				ok: false,
				error: { code: "invalid", message: "op rejected by checkOpLimits" },
			};
		}
		this.inFlight += 1;
		const started = Date.now();
		try {
			const paths = writeOpLockPaths(op, payload);
			const run = async (): Promise<OpResult<unknown>> => {
				const ns = await this.loadNamespace(call);
				return this.dispatch(ns, call, op, payload);
			};
			const result =
				paths.length > 0 ? await this.withPaths(call, paths, run) : await run();
			this.account(call, op, result, payload, Date.now() - started);
			return result;
		} catch (error) {
			getLogger().warn("tools env op failed", {
				envOp: op,
				error,
			});
			const failed: OpResult<unknown> = {
				ok: false,
				error: {
					code: "unknown",
					message: error instanceof Error ? error.message : String(error),
				},
			};
			this.account(call, op, failed, payload, Date.now() - started);
			return failed;
		} finally {
			this.inFlight -= 1;
		}
	}

	async cancelExec(callId: string, call: NamespaceCall): Promise<void> {
		await this.schemaReady;
		if (call.backend === "ws-remote") {
			this.ws.cancel(callId);
			return;
		}
		const ns = this.namespaces.get(nsKey(call));
		ns?.cancelExec(callId);
	}

	async openWatch(
		call: NamespaceCall,
		targets: readonly {
			path: string;
			recursive?: boolean;
			exclude?: { hidden?: boolean; names?: readonly string[] };
		}[],
	): Promise<OpResult<string>> {
		await this.schemaReady;
		if (call.backend === "ws-remote") {
			const opened = await this.ws.openWatch(targets);
			this.account(call, "watch", opened, {}, 0);
			return opened;
		}
		this.inFlight += 1;
		try {
			const limits = this.checkOpLimits();
			if (!limits.allowed) {
				return { ok: false, error: { code: "invalid", message: "rejected" } };
			}
			const ns = await this.loadNamespace(call);
			const opened = ns.openWatch(targets);
			this.account(call, "watch", opened, {}, 0);
			return opened;
		} finally {
			this.inFlight -= 1;
		}
	}

	watchEvents(call: NamespaceCall, watchId: string): ReadableStream<string> {
		const key = nsKey(call);
		let unsubscribe: (() => void) | undefined;
		return new ReadableStream<string>({
			start: (controller) => {
				const ns = this.namespaces.get(key);
				if (!ns) {
					controller.close();
					return;
				}
				const listener = (event: WatchEvent) => {
					try {
						controller.enqueue(`${JSON.stringify(event)}\n`);
					} catch {
						// The client stopped reading.
					}
				};
				const buffered = ns.subscribeWatch(watchId, listener);
				for (const event of buffered) {
					controller.enqueue(`${JSON.stringify(event)}\n`);
				}
				unsubscribe = () => ns.closeWatch(watchId);
			},
			cancel: () => {
				unsubscribe?.();
			},
		});
	}

	async takeWatchEvents(
		call: NamespaceCall,
		watchId: string,
	): Promise<WatchEvent[]> {
		await this.schemaReady;
		if (call.backend === "ws-remote") return this.ws.takeWatchEvents(watchId);
		const ns = this.namespaces.get(nsKey(call));
		if (!ns) return [];
		await ns.pollNow();
		return ns.drainWatch(watchId);
	}

	async closeWatch(call: NamespaceCall, watchId: string): Promise<void> {
		await this.schemaReady;
		if (call.backend === "ws-remote") {
			await this.ws.closeWatch(watchId);
			return;
		}
		this.namespaces.get(nsKey(call))?.closeWatch(watchId);
	}

	/**
	 * Drop the store the new mode does not use.
	 * `persist: false` deletes SQLite rows. `persist: true` drops the memory map.
	 * A sharedWorkspace flip drops every namespace in both stores.
	 */
	async applyConfig(config: {
		persist: boolean;
		dropSqlite: boolean;
		dropMemory: boolean;
	}): Promise<void> {
		await this.schemaReady;
		if (config.dropSqlite) {
			this.ctx.storage.sql.exec(`DELETE FROM cadmus_tools_env_fs`);
		}
		if (config.dropMemory || config.dropSqlite) {
			for (const ns of this.namespaces.values()) ns.abortAll();
			this.namespaces.clear();
		}
		getLogger().info("tools env config applied", {
			persist: config.persist,
			dropSqlite: config.dropSqlite,
			dropMemory: config.dropMemory,
		});
	}

	async deleteNamespace(storageFamilyId: string, scope: string): Promise<void> {
		await this.schemaReady;
		this.ctx.storage.sql.exec(
			`DELETE FROM cadmus_tools_env_fs WHERE family_id = ? AND scope = ?`,
			storageFamilyId,
			scope,
		);
		this.namespaces.delete(`${storageFamilyId}\n${scope}`);
	}

	async deleteNamespacesForBot(
		familyId: string,
		botId: string,
		shared: boolean,
		chatKeys: readonly string[] = [],
	): Promise<void> {
		await this.schemaReady;
		const famFilter = shared
			? `(family_id = ? OR family_id = '')`
			: `family_id = ?`;
		this.ctx.storage.sql.exec(
			`DELETE FROM cadmus_tools_env_fs WHERE bot_id = ? AND ${famFilter}`,
			botId,
			familyId,
		);
		const famPrefix = shared ? "" : familyId;
		const targets = new Set([
			`${famPrefix}\nbot:${botId}`,
			...chatKeys.map((key) => `${famPrefix}\nchat:${key}`),
		]);
		for (const [key, ns] of [...this.namespaces.entries()]) {
			const fam = nsFamilyId(key);
			const familyMatch = shared
				? fam === "" || fam === familyId
				: fam === familyId;
			if (!familyMatch) continue;
			if (ns.botId !== botId && !targets.has(key)) continue;
			ns.abortAll();
			this.namespaces.delete(key);
			this.loading.delete(key);
		}
	}

	async wipeEnv(): Promise<void> {
		await this.schemaReady;
		this.ctx.storage.sql.exec(`DELETE FROM cadmus_tools_env_fs`);
		this.ctx.storage.sql.exec(`DELETE FROM cadmus_env_usage`);
		for (const ns of this.namespaces.values()) ns.abortAll();
		this.namespaces.clear();
	}

	async dropCachedNamespaces(): Promise<void> {
		await this.schemaReady;
		this.namespaces.clear();
	}

	async readUsage(): Promise<UsageRow[]> {
		await this.schemaReady;
		const rows = this.ctx.storage.sql
			.exec<{
				grain: string;
				bucket_start: number;
				family_id: string;
				bot_id: string;
				chat_key: string;
				op_kind: string;
				ops: number;
				bytes_read: number;
				bytes_written: number;
				bash_runtime_ms: number;
				errors: number;
			}>(
				`SELECT grain, bucket_start, family_id, bot_id, chat_key, op_kind, ops, bytes_read, bytes_written, bash_runtime_ms, errors
         FROM cadmus_env_usage`,
			)
			.toArray();
		return rows.map((row) => ({
			grain: row.grain,
			bucketStart: Number(row.bucket_start),
			familyId: row.family_id,
			botId: row.bot_id,
			chatKey: row.chat_key,
			opKind: row.op_kind,
			ops: Number(row.ops),
			bytesRead: Number(row.bytes_read),
			bytesWritten: Number(row.bytes_written),
			bashRuntimeMs: Number(row.bash_runtime_ms),
			errors: Number(row.errors),
		}));
	}

	async namespaceBytes(
		storageFamilyId: string,
		scope: string,
	): Promise<number> {
		await this.schemaReady;
		const cached = this.namespaces.get(`${storageFamilyId}\n${scope}`);
		if (cached) return cached.countedBytes();
		const rows = this.ctx.storage.sql
			.exec<{ total: number }>(
				`SELECT COALESCE(SUM(LENGTH(content)), 0) AS total
         FROM cadmus_tools_env_fs
         WHERE family_id = ? AND scope = ? AND kind = 'file'`,
				storageFamilyId,
				scope,
			)
			.toArray();
		return Number(rows[0]?.total ?? 0);
	}

	private async loadNamespace(call: NamespaceCall): Promise<JustBashNamespace> {
		const key = nsKey(call);
		const existing = this.namespaces.get(key);
		if (existing) {
			existing.persist = call.persist;
			existing.botId = call.botId;
			return existing;
		}
		const pending = this.loading.get(key);
		if (pending) return pending;
		const created = this.buildNamespace(call);
		this.loading.set(key, created);
		try {
			return await created;
		} finally {
			if (this.loading.get(key) === created) this.loading.delete(key);
		}
	}

	private async buildNamespace(
		call: NamespaceCall,
	): Promise<JustBashNamespace> {
		const key = nsKey(call);
		const rows = call.persist ? this.loadRows(call) : [];
		const ns = await JustBashNamespace.create({
			persist: call.persist,
			botId: call.botId,
			rows,
			onPersist: (row) => this.persistRow(call, row),
		});
		ns.setMutateHandler((paths) => ns.emitMutation(paths));
		this.namespaces.set(key, ns);
		return ns;
	}

	private loadRows(call: NamespaceCall): FsSnapshotRow[] {
		const rows = this.ctx.storage.sql
			.exec<{ path: string; kind: string; content: ArrayBuffer | null }>(
				`SELECT path, kind, content FROM cadmus_tools_env_fs
         WHERE family_id = ? AND scope = ?
         ORDER BY length(path) ASC, path ASC`,
				call.storageFamilyId,
				call.scope,
			)
			.toArray();
		return rows.map((row) => ({
			path: row.path,
			kind: row.kind === "symlink" || row.kind === "dir" ? row.kind : "file",
			content: row.content ? new Uint8Array(row.content) : null,
		}));
	}

	private persistRow(
		call: NamespaceCall,
		row: FsSnapshotRow | { path: string; deleted: true },
	): void {
		try {
			if ("deleted" in row) {
				this.ctx.storage.sql.exec(
					`DELETE FROM cadmus_tools_env_fs
           WHERE family_id = ? AND scope = ? AND (path = ? OR path LIKE ?)`,
					call.storageFamilyId,
					call.scope,
					row.path,
					`${row.path}/%`,
				);
				return;
			}
			this.ctx.storage.sql.exec(
				`INSERT INTO cadmus_tools_env_fs (family_id, scope, bot_id, path, kind, content)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(family_id, scope, path) DO UPDATE SET
           bot_id = excluded.bot_id,
           kind = excluded.kind,
           content = excluded.content`,
				call.storageFamilyId,
				call.scope,
				call.botId,
				row.path,
				row.kind,
				row.content,
			);
		} catch (error) {
			getLogger().warn("tools env persist failed", { error });
		}
	}

	private async dispatch(
		ns: JustBashNamespace,
		call: NamespaceCall,
		op: string,
		payload: Record<string, unknown>,
	): Promise<OpResult<unknown>> {
		switch (op) {
			case "absolutePath":
				return ns.absolutePath(String(payload.path ?? ""));
			case "joinPath":
				return ns.joinPath((payload.parts as string[]) ?? []);
			case "readTextFile":
				return ns.readTextFile(String(payload.path ?? ""));
			case "readBinaryFile":
				return ns.readBinaryFile(String(payload.path ?? ""));
			case "readTextLines":
				return ns.readTextLines(
					String(payload.path ?? ""),
					payload.maxLines as number | undefined,
				);
			case "openTextLineReader":
				return ns.openTextLineReader(String(payload.path ?? ""));
			case "readLine":
				return ns.readLine(String(payload.readerId ?? ""));
			case "openBinaryReader":
				return ns.openBinaryReader(
					String(payload.path ?? ""),
					payload.noFollow === true,
				);
			case "binaryInfo":
				return ns.binaryInfo(String(payload.readerId ?? ""));
			case "binaryRead":
				return ns.binaryRead(
					String(payload.readerId ?? ""),
					Number(payload.offset ?? 0),
					Number(payload.length ?? 0),
				);
			case "binaryScan":
				return ns.binaryScan(
					String(payload.readerId ?? ""),
					Number(payload.startLine ?? 0),
					payload.endLine === undefined ? undefined : Number(payload.endLine),
				);
			case "closeReader":
				ns.closeReader(String(payload.readerId ?? ""));
				return { ok: true, value: null };
			case "writeFile":
				return ns.writeFile(
					String(payload.path ?? ""),
					payload.content as string | Uint8Array,
				);
			case "appendFile":
				return ns.appendFile(
					String(payload.path ?? ""),
					payload.content as string | Uint8Array,
				);
			case "truncateFile":
				return ns.truncateFile(
					String(payload.path ?? ""),
					Number(payload.size ?? 0),
				);
			case "flushFile":
				return { ok: true, value: null };
			case "renameFile":
				return ns.renameFile(
					String(payload.source ?? ""),
					String(payload.dest ?? ""),
				);
			case "fileInfo":
				return ns.fileInfo(String(payload.path ?? ""));
			case "listDir":
				return ns.listDir(String(payload.path ?? ""));
			case "openDirReader":
				return ns.openDirReader(String(payload.path ?? ""));
			case "dirNext":
				return ns.dirNext(
					String(payload.readerId ?? ""),
					Number(payload.maxEntries ?? 0),
				);
			case "exists":
				return ns.exists(String(payload.path ?? ""));
			case "createDir":
				return ns.createDir(
					String(payload.path ?? ""),
					payload.recursive === true,
				);
			case "remove":
				return ns.remove(String(payload.path ?? ""), {
					recursive: payload.recursive === true,
					force: payload.force === true,
				});
			case "canonicalPath":
				return ns.canonicalPath(String(payload.path ?? ""));
			case "createTempDir":
				return ns.createTempDir(
					payload.prefix === undefined ? undefined : String(payload.prefix),
				);
			case "createTempFile":
				return ns.createTempFile({
					prefix:
						payload.prefix === undefined ? undefined : String(payload.prefix),
					suffix:
						payload.suffix === undefined ? undefined : String(payload.suffix),
				});
			case "exec":
				return ns.exec({
					callId: String(payload.callId ?? crypto.randomUUID()),
					command: payload.command as string | string[],
					cwd: payload.cwd === undefined ? undefined : String(payload.cwd),
					timeoutSeconds:
						payload.timeoutSeconds === undefined
							? undefined
							: Number(payload.timeoutSeconds),
					env: payload.env as Record<string, string> | undefined,
				});
			case "cleanup":
				if (!call.persist) {
					ns.abortAll();
					this.namespaces.delete(nsKey(call));
				} else {
					ns.abortAll();
				}
				return { ok: true, value: null };
			default:
				return {
					ok: false,
					error: { code: "not_supported", message: `unknown op ${op}` },
				};
		}
	}

	private async invokeRemote(
		call: NamespaceCall,
		op: string,
		payload: Record<string, unknown>,
	): Promise<OpResult<unknown>> {
		const limits = this.checkOpLimits();
		if (!limits.allowed) {
			return {
				ok: false,
				error: { code: "invalid", message: "op rejected by checkOpLimits" },
			};
		}
		const started = Date.now();
		try {
			const paths = daemonLockPaths(op, payload);
			const result =
				paths.length > 0
					? await this.withDaemonPaths(paths, () => this.ws.invoke(op, payload))
					: await this.ws.invoke(op, payload);
			this.account(call, op, result, payload, Date.now() - started);
			return result;
		} catch (error) {
			getLogger().warn("tools env daemon op failed", { envOp: op, error });
			const failed: OpResult<unknown> = {
				ok: false,
				error: {
					code: op === "exec" ? "shell_unavailable" : "unknown",
					message: "tools-env transport: env disconnected",
				},
			};
			this.account(call, op, failed, payload, Date.now() - started);
			return failed;
		}
	}

	private async loadDefinition(
		accountId: string,
		envId: string,
	): Promise<
		| {
				kind: string;
				tokenHash: string | null;
				confineToWorkspace: boolean;
				confinementPolicy?: ConfinementPolicy;
		  }
		| undefined
	> {
		if (!accountId || !envId) return undefined;
		const row = await this.env.CADMUS_ADMIN_DB.prepare(
			`SELECT kind, daemon_token_hash, confine_to_workspace, confinement_policy
       FROM cadmus_tools_envs
       WHERE account_id = ?1 AND env_id = ?2`,
		)
			.bind(accountId, envId)
			.first<{
				kind: string;
				daemon_token_hash: string | null;
				confine_to_workspace: number;
				confinement_policy: string | null;
			}>();
		if (!row) return undefined;
		const confinementPolicy =
			(row.confinement_policy as ConfinementPolicy) ??
			(row.confine_to_workspace !== 0 ? "required" : "disabled");
		return {
			kind: row.kind,
			tokenHash: row.daemon_token_hash,
			confineToWorkspace: row.confine_to_workspace !== 0,
			confinementPolicy,
		};
	}

	private async withDaemonPaths<T>(
		paths: string[],
		fn: () => Promise<T>,
	): Promise<T> {
		const keys = [...new Set(paths.map((path) => `daemon\n${path}`))].sort();
		return this.withKeys(keys, fn);
	}

	private async withPaths<T>(
		call: NamespaceCall,
		paths: string[],
		fn: () => Promise<T>,
	): Promise<T> {
		const keys = [
			...new Set(paths.map((path) => `${nsKey(call)}\n${path}`)),
		].sort();
		return this.withKeys(keys, fn);
	}

	private async withKeys<T>(keys: string[], fn: () => Promise<T>): Promise<T> {
		const prev = Promise.all(
			keys.map((key) => this.tails.get(key) ?? Promise.resolve()),
		);
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		for (const key of keys) this.tails.set(key, gate);
		await prev;
		try {
			return await fn();
		} finally {
			release();
			for (const key of keys) {
				if (this.tails.get(key) === gate) this.tails.delete(key);
			}
		}
	}

	private account(
		call: NamespaceCall,
		op: string,
		result: OpResult<unknown>,
		payload: Record<string, unknown>,
		runtimeMs: number,
	): void {
		const kind = opKind(op);
		let errors = result.ok ? 0 : 1;
		if (!result.ok && result.error.code === "not_found" && op === "exists") {
			errors = 0;
		}
		try {
			const now = Date.now();
			const bytes = bytesFor(op, result);
			const bytesWritten =
				result.ok && (op === "writeFile" || op === "appendFile")
					? contentSize(payload.content)
					: bytes.written;
			const bytesRead = bytes.read;
			let bashRuntime = 0;
			if (kind === "exec" && result.ok) {
				const value = result.value as { runtimeMs?: number };
				bashRuntime =
					typeof value?.runtimeMs === "number" ? value.runtimeMs : runtimeMs;
			}
			for (const grain of ["hour", "day"] as const) {
				const bucket = bucketStart(now, grain);
				this.ctx.storage.sql.exec(
					`INSERT INTO cadmus_env_usage (
             grain, bucket_start, family_id, bot_id, chat_key, op_kind,
             ops, bytes_read, bytes_written, bash_runtime_ms, errors
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(grain, bucket_start, family_id, bot_id, chat_key, op_kind) DO UPDATE SET
             ops = ops + excluded.ops,
             bytes_read = bytes_read + excluded.bytes_read,
             bytes_written = bytes_written + excluded.bytes_written,
             bash_runtime_ms = bash_runtime_ms + excluded.bash_runtime_ms,
             errors = errors + excluded.errors`,
					grain,
					bucket,
					call.usageFamilyId,
					call.botId,
					call.chatKey,
					kind,
					1,
					bytesRead,
					bytesWritten,
					bashRuntime,
					errors,
				);
			}
		} catch (error) {
			getLogger().warn("tools env usage counter failed", { error });
		}
	}
}

function nsKey(call: NamespaceCall): string {
	return `${call.storageFamilyId}\n${call.scope}`;
}

function nsFamilyId(key: string): string {
	const idx = key.indexOf("\n");
	return idx === -1 ? key : key.slice(0, idx);
}

function opKind(op: string): OpKind {
	if (WRITE_OPS.has(op)) return "write";
	if (op === "exec") return "exec";
	if (
		op === "watch" ||
		op === "cleanup" ||
		op === "closeReader" ||
		op === "flushFile"
	) {
		return "other";
	}
	return "read";
}

function contentSize(content: unknown): number {
	if (typeof content === "string")
		return new TextEncoder().encode(content).byteLength;
	if (content instanceof Uint8Array) return content.byteLength;
	if (content instanceof ArrayBuffer) return content.byteLength;
	return 0;
}

function bytesFor(
	op: string,
	result: OpResult<unknown>,
): { read: number; written: number } {
	if (!result.ok || result.value == null) return { read: 0, written: 0 };
	if (op === "readBinaryFile" && result.value instanceof Uint8Array) {
		return { read: result.value.byteLength, written: 0 };
	}
	if (op === "readTextFile" && typeof result.value === "string") {
		return {
			read: new TextEncoder().encode(result.value).byteLength,
			written: 0,
		};
	}
	if (op === "binaryRead" && result.value instanceof Uint8Array) {
		return { read: result.value.byteLength, written: 0 };
	}
	return { read: 0, written: 0 };
}

function bucketStart(now: number, grain: "hour" | "day"): number {
	const date = new Date(now);
	if (grain === "hour") {
		return Date.UTC(
			date.getUTCFullYear(),
			date.getUTCMonth(),
			date.getUTCDate(),
			date.getUTCHours(),
		);
	}
	return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}
