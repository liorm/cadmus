import { env, SELF } from "cloudflare:test";
import { getEdgeCache } from "../src/edge-cache.js";
import { setupLogger } from "../src/log.js";
import type {
	AccountMember,
	CommandResultFrame,
	RpcPayload,
	RpcResult,
	RpcType,
	ServerEvent,
	ServerFrame,
} from "../src/protocol.js";
import { D1AdminStore } from "../src/store/d1-admin.js";

setupLogger({ type: "silent" });

export const TEST_TOKEN = "test-cadmus-secret";

/**
 * Test fixture: a member with a caller-chosen legacy bearer token, written
 * through the store. `account.members.add` no longer accepts a token over RPC
 * (issue #3), so legacy-token tests seed the row here instead.
 */
export async function addLegacyMember(input: {
	accountId: string;
	userId: string;
	name?: string;
	email?: string;
	role?: "user" | "account-admin";
	token: string;
}): Promise<AccountMember> {
	const store = new D1AdminStore({
		db: env.CADMUS_ADMIN_DB,
		encryptionKey: env.CADMUS_ENCRYPTION_KEY,
		edgeCache: getEdgeCache(env),
	});
	await store.ensureAccountAndUser({
		accountId: input.accountId,
		userId: input.userId,
		role: "user",
	});
	return store.addMember({
		accountId: input.accountId,
		userId: input.userId,
		name: input.name,
		email: input.email,
		roles: [input.role === "account-admin" ? "account-admin" : "user"],
		rawToken: input.token,
	});
}

/**
 * Fresh Cadmus account id. A Vitest worker reuses one workerd, so D1, KV,
 * Durable Object names, and isolate memo keys collide when tests reuse an id.
 */
export function uniqueAccountId(prefix = "acct"): string {
	return `${prefix}-${crypto.randomUUID()}`;
}

export interface RpcOptions {
	token?: string;
	cookie?: string;
	accountId?: string;
	userId?: string;
	familyId?: string;
}

export async function sendRpc<K extends RpcType>(
	type: K,
	payload?: RpcPayload<K>,
	options?: RpcOptions,
): Promise<{ status: number; frame: CommandResultFrame<RpcResult<K>> }>;
export async function sendRpc<T = unknown>(
	type: string,
	payload?: Record<string, unknown>,
	options?: RpcOptions,
): Promise<{ status: number; frame: CommandResultFrame<T> }>;
export async function sendRpc<T = unknown>(
	type: string,
	payload?: unknown,
	options: RpcOptions = {},
): Promise<{ status: number; frame: CommandResultFrame<T> }> {
	const id = `test-${crypto.randomUUID().slice(0, 8)}`;
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (options.token !== undefined) {
		if (options.token !== "") {
			headers.Authorization = `Bearer ${options.token}`;
		}
	} else if (!options.cookie) {
		headers.Authorization = `Bearer ${TEST_TOKEN}`;
	}
	if (options.cookie) {
		headers.Cookie = options.cookie;
	}
	if (options.accountId) {
		headers["x-account-id"] = options.accountId;
	}
	if (options.userId) {
		headers["x-user-id"] = options.userId;
	}
	if (options.familyId) {
		headers["X-Cadmus-Family-Id"] = options.familyId;
	}

	const res = await SELF.fetch("http://example.com/rpc", {
		method: "POST",
		headers,
		body: JSON.stringify({
			id,
			type,
			...(payload !== undefined ? { payload } : {}),
		}),
	});

	const data = (await res.json()) as ServerFrame;
	if (data.type === "protocol.error") {
		return {
			status: res.status,
			frame: {
				id,
				type: "command.result",
				command: type,
				ok: false,
				error: data.payload,
			},
		};
	}
	return {
		status: res.status,
		frame: data as CommandResultFrame<T>,
	};
}

/** Convenience wrapper around `sendRpc` for tests that only need the result frame. */
export async function rpc<K extends RpcType>(
	token: string,
	type: K,
	payload?: RpcPayload<K>,
	accountId?: string,
): Promise<CommandResultFrame<RpcResult<K>>>;
export async function rpc<T = Record<string, unknown>>(
	token: string,
	type: string,
	payload?: object,
	accountId?: string,
): Promise<CommandResultFrame<T>>;
export async function rpc<T = Record<string, unknown>>(
	token: string,
	type: string,
	payload: object = {},
	accountId?: string,
): Promise<CommandResultFrame<T>> {
	const { frame } = await sendRpc<T>(type, payload as Record<string, unknown>, {
		token,
		accountId,
	});
	return frame;
}

/**
 * Every credential opens /ws and /events with a single-use ticket minted over
 * the header-authenticated `auth.ticket` call; `?token=` is retired.
 */
export async function streamAuthParams(
	target: "ws" | "events",
	options: RpcOptions,
): Promise<Record<string, string>> {
	const issued = await sendRpc("auth.ticket", { target }, options);
	const ticket = (issued.frame.result as { ticket?: string } | undefined)
		?.ticket;
	if (!issued.frame.ok || !ticket) {
		throw new Error(`could not mint a ${target} ticket`);
	}
	return { ticket };
}

export async function connectTestWs(options: RpcOptions = {}): Promise<{
	ws: WebSocket;
	events: ServerEvent[];
	send: {
		<K extends RpcType>(
			type: K,
			payload?: RpcPayload<K>,
		): Promise<CommandResultFrame<RpcResult<K>>>;
		<T = unknown>(
			type: string,
			payload?: Record<string, unknown>,
		): Promise<CommandResultFrame<T>>;
	};
	close: () => void;
}> {
	const url = new URL("http://example.com/ws");
	const headers: Record<string, string> = { Upgrade: "websocket" };
	for (const [k, v] of Object.entries(await streamAuthParams("ws", options))) {
		url.searchParams.set(k, v);
	}
	if (options.accountId) url.searchParams.set("accountId", options.accountId);
	if (options.familyId) url.searchParams.set("familyId", options.familyId);

	const res = await SELF.fetch(url.toString(), { headers });
	const ws = res.webSocket;
	if (!ws) {
		throw new Error(`Expected WebSocket 101 upgrade, got status ${res.status}`);
	}
	ws.accept();

	const events: ServerEvent[] = [];
	const pending = new Map<string, (frame: CommandResultFrame) => void>();

	ws.addEventListener("message", (ev) => {
		const raw =
			typeof ev.data === "string"
				? ev.data
				: new TextDecoder().decode(ev.data as ArrayBuffer);
		const frame = JSON.parse(raw) as ServerFrame;
		if (frame.type === "command.result") {
			const resolve = pending.get(frame.id);
			if (resolve) {
				pending.delete(frame.id);
				resolve(frame);
			}
		} else {
			events.push(frame);
		}
	});

	return {
		ws,
		events,
		send: <T = unknown>(type: string, payload?: Record<string, unknown>) => {
			const id = `ws-${crypto.randomUUID().slice(0, 8)}`;
			return new Promise<CommandResultFrame<T>>((resolve) => {
				pending.set(id, resolve as (frame: CommandResultFrame) => void);
				ws.send(
					JSON.stringify({
						id,
						type,
						...(payload !== undefined ? { payload } : {}),
					}),
				);
			});
		},
		close: () => ws.close(),
	};
}

export interface DaemonRequest {
	id: string;
	method: string;
	args: Record<string, unknown>;
}

export interface UpgradeResult {
	status: number;
	body: string;
	peer?: ScriptedDaemon;
}

interface StoredFile {
	bytes: Uint8Array;
	mtimeMs: number;
}

/**
 * In-process daemon peer over /tools-env/ws.
 */
export class ScriptedDaemon {
	readonly requests: DaemonRequest[] = [];
	readonly heartbeats: DaemonRequest[] = [];
	ignoreHeartbeat = false;
	jailRoot?: string;
	closeCode = 0;
	closeReason = "";
	readonly closed: Promise<void>;
	onFrame?: (request: DaemonRequest) => Promise<"default" | "manual">;
	private readonly ws: WebSocket;
	private readonly files = new Map<string, StoredFile>();
	private readonly links = new Map<string, string>();
	private readonly readers = new Map<string, Uint8Array>();
	private resolveClosed: () => void = () => {};

	private constructor(ws: WebSocket) {
		this.ws = ws;
		this.closed = new Promise((resolve) => {
			this.resolveClosed = resolve;
		});
		ws.addEventListener("message", (event) => {
			const text =
				typeof event.data === "string"
					? event.data
					: new TextDecoder().decode(event.data as ArrayBuffer);
			void this.onText(text);
		});
		ws.addEventListener("close", (event) => {
			this.closeCode = event.code;
			this.closeReason = event.reason;
			this.resolveClosed();
		});
	}

	static async upgrade(input: {
		token: string;
		envId: string;
		capabilities?: string;
		workspace?: string;
		headers?: Record<string, string>;
		websocket?: boolean;
	}): Promise<UpgradeResult> {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${input.token}`,
			"X-Cadmus-Workspace": input.workspace ?? "/home/dev/workspace",
			...(input.headers ?? {}),
		};
		if (input.websocket !== false) headers.Upgrade = "websocket";
		if (input.capabilities) {
			headers["X-Cadmus-Env-Capabilities"] = input.capabilities;
		}
		const res = await SELF.fetch(
			`http://example.com/tools-env/ws?envId=${encodeURIComponent(input.envId)}`,
			{ method: "GET", headers },
		);
		if (res.status === 101 && res.webSocket) {
			res.webSocket.accept();
			return {
				status: res.status,
				body: "",
				peer: new ScriptedDaemon(res.webSocket),
			};
		}
		const body = await res.text().catch(() => "");
		return { status: res.status, body };
	}

	seed(path: string, text: string): void {
		this.files.set(path, {
			bytes: new TextEncoder().encode(text),
			mtimeMs: 1_700_000_000_000,
		});
	}

	link(path: string, target: string): void {
		this.links.set(path, target);
	}

	send(frame: unknown): void {
		if (this.ws.readyState !== WebSocket.OPEN) return;
		try {
			this.ws.send(typeof frame === "string" ? frame : JSON.stringify(frame));
		} catch {
			// The DO already closed the socket.
		}
	}

	close(): void {
		try {
			this.ws.close();
		} catch {
			// Already closed.
		}
	}

	private async onText(text: string): Promise<void> {
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			return;
		}
		if (!parsed || typeof parsed !== "object") return;
		const record = parsed as Record<string, unknown>;
		if (typeof record.id !== "string" || typeof record.method !== "string")
			return;
		const request: DaemonRequest = {
			id: record.id,
			method: record.method,
			args:
				record.args && typeof record.args === "object"
					? (record.args as Record<string, unknown>)
					: {},
		};
		if (request.method === "heartbeat") {
			this.heartbeats.push(request);
			if (!this.ignoreHeartbeat) this.send({ id: request.id, ok: true });
			return;
		}
		this.requests.push(request);
		if (this.onFrame) {
			const action = await this.onFrame(request);
			if (action === "manual") return;
		}
		this.defaultReply(request);
	}

	private defaultReply(request: DaemonRequest): void {
		const path = typeof request.args.path === "string" ? request.args.path : "";
		if (
			this.denied(path) ||
			this.denied(stringArg(request.args.source)) ||
			this.denied(stringArg(request.args.dest))
		) {
			this.fileError(request, "permission_denied", "permission_denied", path);
			return;
		}
		if (request.method === "exec") {
			this.send({
				id: request.id,
				event: "output",
				text: "ok\n",
				stream: "stdout",
			});
			this.send({ id: request.id, ok: true, value: { exitCode: 0 } });
			return;
		}
		if (
			request.method === "cleanup" ||
			request.method === "cancel" ||
			request.method === "closeReader" ||
			request.method === "watch.close"
		) {
			if (request.method === "closeReader") {
				this.readers.delete(stringArg(request.args.readerId));
			}
			this.send({ id: request.id, ok: true, value: null });
			return;
		}
		if (request.method === "writeFile" || request.method === "appendFile") {
			const next = toBytes(request.args.content);
			const previous = this.files.get(path)?.bytes ?? new Uint8Array();
			const bytes =
				request.method === "appendFile" ? concat(previous, next) : next;
			this.files.set(path, { bytes, mtimeMs: 1_700_000_000_000 });
			this.send({ id: request.id, ok: true, value: null });
			return;
		}
		if (request.method === "fileInfo" || request.method === "exists") {
			const file = this.files.get(path);
			if (request.method === "exists") {
				this.send({
					id: request.id,
					ok: true,
					value: Boolean(file) || this.links.has(path),
				});
				return;
			}
			if (!file) {
				this.fileError(request, "not_found", "not found", path);
				return;
			}
			this.send({ id: request.id, ok: true, value: info(path, file) });
			return;
		}
		if (request.method === "readTextFile") {
			const file = this.files.get(path);
			if (!file) {
				this.fileError(request, "not_found", "not found", path);
				return;
			}
			this.send({
				id: request.id,
				ok: true,
				value: new TextDecoder().decode(file.bytes),
			});
			return;
		}
		if (request.method === "openBinaryReader") {
			const file = this.files.get(path);
			if (!file) {
				this.fileError(request, "not_found", "not found", path);
				return;
			}
			const readerId = crypto.randomUUID();
			this.readers.set(readerId, file.bytes);
			this.send({
				id: request.id,
				ok: true,
				value: { id: readerId, info: info(path, file) },
			});
			return;
		}
		if (request.method === "binaryInfo") {
			const bytes = this.readers.get(stringArg(request.args.readerId));
			if (!bytes) {
				this.fileError(request, "not_found", "reader is closed");
				return;
			}
			this.send({
				id: request.id,
				ok: true,
				value: info(path || "file", { bytes, mtimeMs: 1_700_000_000_000 }),
			});
			return;
		}
		if (request.method === "binaryScan") {
			const bytes = this.readers.get(stringArg(request.args.readerId));
			if (!bytes) {
				this.fileError(request, "invalid", "reader is closed");
				return;
			}
			const startLine = Number(request.args.startLine ?? 0);
			const endLine =
				typeof request.args.endLine === "number"
					? request.args.endLine
					: undefined;
			if (!Number.isInteger(startLine) || startLine < 0) {
				this.fileError(request, "invalid", "invalid scan");
				return;
			}
			this.send({
				id: request.id,
				ok: true,
				value: scanBytes(bytes, startLine, endLine),
			});
			return;
		}
		if (request.method === "binaryRead") {
			const bytes = this.readers.get(stringArg(request.args.readerId));
			if (!bytes) {
				this.fileError(request, "not_found", "reader is closed");
				return;
			}
			const offset = Number(request.args.offset ?? 0);
			const length = Number(request.args.length ?? bytes.byteLength);
			this.send({
				id: request.id,
				ok: true,
				value: { base64: toBase64(bytes.subarray(offset, offset + length)) },
			});
			return;
		}
		if (request.method === "listDir") {
			if (this.denied(path)) {
				this.fileError(request, "permission_denied", "permission_denied", path);
				return;
			}
			this.send({ id: request.id, ok: true, value: [] });
			return;
		}
		this.send({ id: request.id, ok: true, value: null });
	}

	private denied(path: string): boolean {
		if (!path || !this.jailRoot) return false;
		const link = this.links.get(path);
		if (link && !this.inside(link)) return true;
		return !this.inside(path);
	}

	private inside(path: string): boolean {
		const root = this.jailRoot ?? "";
		if (!root) return true;
		return (
			path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`)
		);
	}

	private fileError(
		request: DaemonRequest,
		code: string,
		message: string,
		path?: string,
	): void {
		this.send({
			id: request.id,
			ok: false,
			error: {
				kind: "file",
				code,
				message,
				...(path ? { path } : {}),
			},
		});
	}
}

function stringArg(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function info(path: string, file: StoredFile) {
	const name = path.slice(path.lastIndexOf("/") + 1);
	return {
		name,
		path,
		kind: "file" as const,
		size: file.bytes.byteLength,
		mtimeMs: file.mtimeMs,
	};
}

function toBytes(content: unknown): Uint8Array {
	if (typeof content === "string") return new TextEncoder().encode(content);
	if (content instanceof Uint8Array) return content;
	if (content && typeof content === "object" && "base64" in content) {
		const binary = atob(String((content as { base64: string }).base64));
		const bytes = new Uint8Array(binary.length);
		for (let index = 0; index < binary.length; index += 1) {
			bytes[index] = binary.charCodeAt(index);
		}
		return bytes;
	}
	return new Uint8Array();
}

function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function scanBytes(
	bytes: Uint8Array,
	startLine: number,
	endLine: number | undefined,
): {
	newlines: number;
	start: number;
	end: number;
	firstLineEnd: number;
	lastLineStart: number;
	selectedBytes: number;
	firstLineBytes: number;
} {
	const breaks: number[] = [];
	for (let index = 0; index < bytes.length; index += 1) {
		if (bytes[index] === 0x0a) breaks.push(index);
	}
	const lineCount = breaks.length + 1;
	const startOf = (line: number): number => {
		if (line <= 0) return 0;
		if (line >= lineCount) return bytes.length;
		return (breaks[line - 1] ?? bytes.length) + 1;
	};
	const contentEnd = (line: number): number => {
		if (line < 0) return 0;
		if (line >= lineCount) return bytes.length;
		return breaks[line] ?? bytes.length;
	};
	const selectionEnd = endLine === undefined ? lineCount : endLine;
	const start = startOf(Math.min(startLine, lineCount));
	const last = Math.min(selectionEnd, lineCount) - 1;
	const end = last < startLine ? start : contentEnd(last);
	const firstLineEnd =
		startLine >= lineCount ? bytes.length : contentEnd(startLine);
	const lastLineStart = last < startLine ? start : startOf(last);
	return {
		newlines: breaks.length,
		start,
		end,
		firstLineEnd,
		lastLineStart,
		selectedBytes: Math.max(0, end - start),
		firstLineBytes: Math.max(0, firstLineEnd - start),
	};
}

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
	const out = new Uint8Array(left.byteLength + right.byteLength);
	out.set(left, 0);
	out.set(right, left.byteLength);
	return out;
}
