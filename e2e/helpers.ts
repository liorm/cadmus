import { SELF } from "cloudflare:test";
import {
	CadmusClient,
	type CadmusClientOptions,
	isAuthError,
	newCommandId,
	ProtocolClient,
	type ProtocolClientOptions,
} from "@cadmus/contract/client";
import {
	API_ROUTES,
	encodePayloadQuery as encodeClientQuery,
	encodePayloadQuery,
} from "@cadmus/contract/routes";
import {
	ApiErrorEnvelopeSchema,
	BOT_METADATA_MAX_KEYS,
	BOT_METADATA_MAX_VALUE_LENGTH,
	commandCatalog,
	ERROR_CODES,
	ServerToClientSchema,
	SseEventSchema,
} from "@cadmus/contract/schemas";
import {
	CODE_EXECUTE_TOOL_NAME,
	CODING_TOOL_NAMES,
	DEFAULT_CADMUS_TOOL_NAMES,
	effectiveToolNames,
	isReadOnlyGroupTool,
	READONLY_GROUP_TOOL_NAMES,
	readOnlyGroupToolNames,
} from "@cadmus/contract/tools";
import type {
	AccountMember,
	AccountModelsListResult,
	AccountRecord,
	BotCreateResult,
	BotRecord,
	BotUpdateResult,
	ChatGetResult,
	ChatRecord,
	ChatStatusResult,
	CommandResultFrame,
	CommandType,
	CredentialSummary,
	FamilyRecord,
	HarvestNote,
	ModelInfo,
	OAuthFlowRecord,
	OAuthProviderInfo,
	RpcPayload,
	RpcResult,
	RpcType,
	ScheduleCreateResult,
	ScheduleRecord,
	ScheduleUpdateResult,
	ServerEvent,
	ServerFrame,
	TurnBlock,
} from "@cadmus/contract/types";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { afterAll, beforeAll } from "vitest";

export type {
	AccountMember,
	AccountModelsListResult,
	AccountRecord,
	BotCreateResult,
	BotRecord,
	BotUpdateResult,
	CadmusClientOptions,
	ChatGetResult,
	ChatRecord,
	ChatStatusResult,
	CommandResultFrame,
	CommandType,
	CredentialSummary,
	FamilyRecord,
	HarvestNote,
	ModelInfo,
	OAuthFlowRecord,
	OAuthProviderInfo,
	ProtocolClientOptions,
	RpcPayload,
	RpcResult,
	RpcType,
	ScheduleCreateResult,
	ScheduleRecord,
	ScheduleUpdateResult,
	ServerEvent,
	ServerFrame,
	TSchema,
	TurnBlock,
};
export {
	API_ROUTES,
	ApiErrorEnvelopeSchema,
	BOT_METADATA_MAX_KEYS,
	BOT_METADATA_MAX_VALUE_LENGTH,
	CadmusClient,
	CODE_EXECUTE_TOOL_NAME,
	CODING_TOOL_NAMES,
	commandCatalog,
	DEFAULT_CADMUS_TOOL_NAMES,
	ERROR_CODES,
	effectiveToolNames,
	encodeClientQuery,
	encodePayloadQuery,
	isAuthError,
	isReadOnlyGroupTool,
	newCommandId,
	ProtocolClient,
	READONLY_GROUP_TOOL_NAMES,
	readOnlyGroupToolNames,
	ServerToClientSchema,
	SseEventSchema,
};

/** Password for the vitest worker's CADMUS_DEV_PASSWORD_HASH (`dev-pass`). */
export const DEV_PASSWORD = "dev-pass";
/** Bootstrap super-admin email on the vitest worker. */
export const BOOTSTRAP_EMAIL = "boss@example.com";

const REFRESH_COOKIE = "__Secure-cadmus_refresh";
/** Dev-password login is refused unless the request host is local. */
const DEV_LOGIN_ORIGIN = "http://127.0.0.1";

export interface DevLogin {
	accessToken: string;
	/** `name=value` pair for the Cookie header. Empty when the response set none. */
	refreshCookie: string;
	email: string;
}

export function setCookieLines(res: Response): string[] {
	if (typeof res.headers.getSetCookie === "function") {
		return res.headers.getSetCookie();
	}
	const single = res.headers.get("set-cookie");
	return single ? [single] : [];
}

export function cookiePair(lines: string[], name: string): string {
	for (const line of lines) {
		const pair = line.split(";")[0]?.trim() ?? "";
		if (pair.startsWith(`${name}=`)) return pair;
	}
	return "";
}

/**
 * POST /api/auth/login/devPassword. The bootstrap claim can lose a race
 * (`not_invited`) until the winner's login method exists, so that code retries.
 */
export async function loginDevPassword(
	email = BOOTSTRAP_EMAIL,
	chooseRole = false,
): Promise<DevLogin> {
	let last = "";
	for (let attempt = 0; attempt < 6; attempt++) {
		const res = await workerFetch(
			`${DEV_LOGIN_ORIGIN}/api/auth/login/devPassword`,
			{
				method: "POST",
				headers: {
					Origin: DEV_LOGIN_ORIGIN,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					id: "dev-password",
					type: "auth.login.devPassword",
					payload: {
						email,
						password: DEV_PASSWORD,
						...(chooseRole ? { chooseRole: true } : {}),
					},
				}),
			},
		);
		const text = await res.text();
		if (res.ok) {
			const body = JSON.parse(text) as { accessToken?: string };
			if (!body.accessToken) {
				throw new Error(`dev-password login missing access token: ${text}`);
			}
			return {
				accessToken: body.accessToken,
				refreshCookie: cookiePair(setCookieLines(res), REFRESH_COOKIE),
				email,
			};
		}
		last = `${res.status} ${text}`;
		const retry =
			text.includes("not_invited") || res.status === 429 || res.status >= 500;
		if (retry && attempt < 5) continue;
		break;
	}
	throw new Error(`dev-password login failed for ${email}: ${last}`);
}

export async function elevateAccessToken(accessToken: string): Promise<void> {
	const elevated = await sendRpc("auth.elevate", {}, { token: accessToken });
	if (!elevated.frame.ok) {
		throw new Error(`auth.elevate failed: ${JSON.stringify(elevated.frame)}`);
	}
}

/**
 * Super-admin creates a tenant and invites `email`. The invite is accepted by
 * signing that email in. Returns the invited member's session.
 */
export async function provisionInvitedMember(input: {
	role: "user" | "account-admin";
	email?: string;
	name?: string;
}): Promise<{
	accountId: string;
	accountName: string;
	email: string;
	accessToken: string;
	userId: string;
}> {
	const boss = await loginDevPassword();
	await elevateAccessToken(boss.accessToken);
	const accountName = input.name ?? `Tenant ${crypto.randomUUID().slice(0, 8)}`;
	const created = await sendRpc<{ account: { id: string; name: string } }>(
		"system.accounts.create",
		{
			name: accountName,
			ownerEmail: `owner-${crypto.randomUUID()}@example.com`,
		},
		{ token: boss.accessToken },
	);
	if (!created.frame.ok || !created.frame.result) {
		throw new Error(
			`system.accounts.create failed: ${JSON.stringify(created.frame)}`,
		);
	}
	const accountId = created.frame.result.account.id;
	const email = (
		input.email ?? `${input.role}-${crypto.randomUUID()}@example.com`
	).toLowerCase();
	const invite = await sendRpc(
		"system.members.invite",
		{ accountId, email, roles: [input.role] },
		{ token: boss.accessToken },
	);
	if (!invite.frame.ok) {
		throw new Error(
			`system.members.invite failed: ${JSON.stringify(invite.frame)}`,
		);
	}
	const session = await loginDevPassword(email);
	const who = await sendRpc<{
		principal: { userId?: string; role?: string; accountId?: string };
	}>("auth.whoami", {}, { token: session.accessToken });
	if (!who.frame.ok || !who.frame.result?.principal.userId) {
		throw new Error(`auth.whoami failed: ${JSON.stringify(who.frame)}`);
	}
	return {
		accountId,
		accountName,
		email,
		accessToken: session.accessToken,
		userId: who.frame.result.principal.userId,
	};
}

/**
 * Elevated account-admin session. Replaces the removed shared-secret bearer
 * for tests that used to pass only an account id.
 */
export async function adminScope(familyId = "default"): Promise<
	RpcOptions & {
		token: string;
		accountId: string;
		userId: string;
		familyId: string;
		accessToken: string;
	}
> {
	const admin = await provisionInvitedMember({ role: "account-admin" });
	await elevateAccessToken(admin.accessToken);
	return {
		token: admin.accessToken,
		accessToken: admin.accessToken,
		accountId: admin.accountId,
		userId: admin.userId,
		familyId,
	};
}

/**
 * Invite a member onto an existing account and return their in-memory
 * dev-password access token (`cad_at_`). A `user` role is the narrow session.
 */
export async function addMemberBearer(input: {
	accountId: string;
	role?: "user" | "account-admin";
}): Promise<{ userId: string; email: string; token: string }> {
	const boss = await loginDevPassword();
	await elevateAccessToken(boss.accessToken);
	const email = `member-${crypto.randomUUID()}@example.com`;
	const role = input.role ?? "user";
	const invite = await sendRpc(
		"system.members.invite",
		{ accountId: input.accountId, email, role },
		{ token: boss.accessToken },
	);
	if (!invite.frame.ok) {
		throw new Error(
			`system.members.invite failed: ${JSON.stringify(invite.frame)}`,
		);
	}
	const session = await loginDevPassword(email);
	const who = await sendRpc<{ principal: { userId?: string } }>(
		"auth.whoami",
		{},
		{ token: session.accessToken },
	);
	if (!who.frame.ok || !who.frame.result?.principal.userId) {
		throw new Error(`auth.whoami failed: ${JSON.stringify(who.frame)}`);
	}
	return {
		userId: who.frame.result.principal.userId,
		email,
		token: session.accessToken,
	};
}

export const WORKER_BASE_URL = "http://example.com";

let fixtureRunning = false;
const activeSockets = new Set<{ close: () => void }>();

function assertWorkerRunning(): void {
	if (!fixtureRunning) {
		throw new Error(
			"Worker fixture is not running. Call useWorkerFixture() inside describe().",
		);
	}
}

export async function startWorkerFixture(): Promise<void> {
	fixtureRunning = true;
	const res = await SELF.fetch(`${WORKER_BASE_URL}/health`);
	if (!res.ok) {
		fixtureRunning = false;
		throw new Error(`Worker failed health check on start: HTTP ${res.status}`);
	}
}

export async function stopWorkerFixture(): Promise<void> {
	for (const handle of [...activeSockets]) {
		try {
			handle.close();
		} catch {
			// Ignore close errors during teardown.
		}
	}
	activeSockets.clear();
	fixtureRunning = false;
}

export interface WorkerFixture {
	start: () => Promise<void>;
	stop: () => Promise<void>;
	isRunning: () => boolean;
	fetch: typeof workerFetch;
	sendRpc: typeof sendRpc;
	callApi: typeof callApi;
	connectWs: typeof connectTestWs;
	createClient: typeof createContractClient;
}

/**
 * Registers `beforeAll` / `afterAll` lifecycle hooks to start and stop the
 * Worker fixture for an E2E test suite.
 */
export function useWorkerFixture(): WorkerFixture {
	beforeAll(async () => {
		await startWorkerFixture();
	});
	afterAll(async () => {
		await stopWorkerFixture();
	});
	return {
		start: startWorkerFixture,
		stop: stopWorkerFixture,
		isRunning: () => fixtureRunning,
		fetch: workerFetch,
		sendRpc,
		callApi,
		connectWs: connectTestWs,
		createClient: createContractClient,
	};
}

export async function workerFetch(
	input: RequestInfo | URL,
	init?: RequestInit,
): Promise<Response> {
	assertWorkerRunning();
	if (typeof input === "string" && input.startsWith("/")) {
		return SELF.fetch(`${WORKER_BASE_URL}${input}`, init);
	}
	return SELF.fetch(input, init);
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

export function createContractClient(options: RpcOptions = {}): ProtocolClient {
	return new ProtocolClient({
		baseUrl: WORKER_BASE_URL,
		token: options.token ?? "",
		accountId: options.accountId,
		userId: options.userId,
		familyId: options.familyId,
		fetchImpl: (input, init) => workerFetch(input, init),
	});
}

export async function callApi<K extends RpcType>(
	type: K,
	payload?: RpcPayload<K>,
	options?: RpcOptions,
): Promise<CommandResultFrame<RpcResult<K>>>;
export async function callApi<T = unknown>(
	type: string,
	payload?: Record<string, unknown>,
	options?: RpcOptions,
): Promise<CommandResultFrame<T>>;
export async function callApi<T = unknown>(
	type: string,
	payload?: Record<string, unknown>,
	options: RpcOptions = {},
): Promise<CommandResultFrame<T>> {
	const client = createContractClient(options);
	return client.callRpc<T>(type, payload);
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

	const res = await workerFetch(`${WORKER_BASE_URL}/rpc`, {
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
	const url = new URL(`${WORKER_BASE_URL}/ws`);
	// ?token= is retired: the socket opens with a ticket minted over the header.
	const issued = await sendRpc<{ ticket: string }>(
		"auth.ticket",
		{ target: "ws" },
		options,
	);
	if (!issued.frame.ok || !issued.frame.result?.ticket) {
		throw new Error(`could not mint a ws ticket: ${issued.status}`);
	}
	url.searchParams.set("ticket", issued.frame.result.ticket);
	if (options.accountId) url.searchParams.set("accountId", options.accountId);
	if (options.familyId) url.searchParams.set("familyId", options.familyId);

	const res = await workerFetch(url.toString(), {
		headers: {
			Upgrade: "websocket",
		},
	});
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

	const handle = {
		close: () => {
			activeSockets.delete(handle);
			try {
				ws.close();
			} catch {
				// Ignore
			}
		},
	};
	activeSockets.add(handle);

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
		close: handle.close,
	};
}

export function assertMatchesSchema(
	schema: TSchema,
	value: unknown,
	label: string,
): void {
	if (!Value.Check(schema, value)) {
		const errors = [...Value.Errors(schema, value)]
			.slice(0, 6)
			.map((error) => `${error.instancePath || "/"} ${error.message}`)
			.join("; ");
		throw new Error(
			`${label} does not match the contract: ${errors || "no schema errors"} body=${JSON.stringify(value).slice(0, 600)}`,
		);
	}
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
 * In-process daemon WebSocket peer over `/tools-env/ws`.
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
	private readonly socketHandle: { close: () => void };

	private constructor(ws: WebSocket) {
		this.ws = ws;
		this.closed = new Promise((resolve) => {
			this.resolveClosed = resolve;
		});
		this.socketHandle = { close: () => this.close() };
		activeSockets.add(this.socketHandle);
		ws.addEventListener("message", (event) => {
			const text =
				typeof event.data === "string"
					? event.data
					: new TextDecoder().decode(event.data as ArrayBuffer);
			void this.onText(text);
		});
		ws.addEventListener("close", (event) => {
			activeSockets.delete(this.socketHandle);
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
		const res = await workerFetch(
			`${WORKER_BASE_URL}/tools-env/ws?envId=${encodeURIComponent(input.envId)}`,
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
		activeSockets.delete(this.socketHandle);
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

function concat(left: Uint8Array, right: Uint8Array): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(left.length + right.length);
	out.set(left, 0);
	out.set(right, left.length);
	return out;
}

/**
 * Client stand-in for a platform authenticator. Builds WebAuthn JSON that
 * `@simplewebauthn/server` verifies. It does not stub the verifier.
 * The vitest relying party is `https://example.com` (`CADMUS_PUBLIC_URL`).
 */
const PASSKEY_RP_ID = "example.com";
const PASSKEY_ORIGIN = "https://example.com";

function concatAll(parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
	let length = 0;
	for (const part of parts) length += part.length;
	const out = new Uint8Array(length);
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

function cborHead(major: number, value: number): Uint8Array {
	if (value < 24) return Uint8Array.of((major << 5) | value);
	if (value < 256) return Uint8Array.of((major << 5) | 24, value);
	return Uint8Array.of((major << 5) | 25, value >> 8, value & 0xff);
}

function cborText(value: string): Uint8Array {
	const bytes = new TextEncoder().encode(value);
	return concat(cborHead(3, bytes.length), bytes);
}

function cborBytes(bytes: Uint8Array): Uint8Array {
	return concat(cborHead(2, bytes.length), bytes);
}

function cborMap(pairs: Array<[Uint8Array, Uint8Array]>): Uint8Array {
	const parts: Uint8Array[] = [cborHead(5, pairs.length)];
	for (const [key, value] of pairs) parts.push(key, value);
	return concatAll(parts);
}

function coseEs256(x: Uint8Array, y: Uint8Array): Uint8Array {
	const u = (n: number) => cborHead(0, n);
	const neg = (n: number) => cborHead(1, n);
	return cborMap([
		[u(1), u(2)],
		[u(3), neg(6)],
		[neg(0), u(1)],
		[neg(1), cborBytes(x)],
		[neg(2), cborBytes(y)],
	]);
}

function b64urlToBytes(text: string): Uint8Array {
	const padded = text.replace(/-/g, "+").replace(/_/g, "/");
	const bin = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
	return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function derInteger(part: Uint8Array): Uint8Array {
	let start = 0;
	while (
		start < part.length - 1 &&
		part[start] === 0 &&
		(part[start + 1] & 0x80) === 0
	) {
		start += 1;
	}
	const value = part.subarray(start);
	const pad = (value[0] & 0x80) !== 0;
	const body = pad ? concat(Uint8Array.of(0), value) : value;
	return concat(Uint8Array.of(0x02, body.length), body);
}

/** WebAuthn ECDSA signatures are DER, not WebCrypto's raw r||s. */
function derEcdsa(raw: Uint8Array): Uint8Array {
	const body = concat(
		derInteger(raw.subarray(0, 32)),
		derInteger(raw.subarray(32)),
	);
	return concat(Uint8Array.of(0x30, body.length), body);
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return new Uint8Array(digest);
}

function authData(input: {
	rpIdHash: Uint8Array;
	flags: number;
	counter: number;
	credentialId?: Uint8Array;
	coseKey?: Uint8Array;
}): Uint8Array {
	const counter = new Uint8Array(4);
	new DataView(counter.buffer).setUint32(0, input.counter);
	const parts = [input.rpIdHash, Uint8Array.of(input.flags), counter];
	if (input.credentialId && input.coseKey) {
		const len = new Uint8Array(2);
		new DataView(len.buffer).setUint16(0, input.credentialId.length);
		parts.push(new Uint8Array(16), len, input.credentialId, input.coseKey);
	}
	return concatAll(parts);
}

export interface PasskeyRegistrationJson {
	id: string;
	rawId: string;
	type: "public-key";
	response: {
		clientDataJSON: string;
		attestationObject: string;
		transports: string[];
	};
	clientExtensionResults: Record<string, never>;
	authenticatorAttachment: "platform";
}

export interface PasskeyAssertionJson {
	id: string;
	rawId: string;
	type: "public-key";
	response: {
		clientDataJSON: string;
		authenticatorData: string;
		signature: string;
		userHandle?: string;
	};
	clientExtensionResults: Record<string, never>;
	authenticatorAttachment: "platform";
}

/** One ES256 credential. `signCount` starts at 0 and advances on each assertion. */
export class TestPasskey {
	readonly id: string;
	readonly #idBytes: Uint8Array;
	readonly #keys: CryptoKeyPair;
	readonly #cose: Uint8Array;
	#counter = 0;

	private constructor(
		idBytes: Uint8Array,
		keys: CryptoKeyPair,
		cose: Uint8Array,
	) {
		this.#idBytes = idBytes;
		this.id = bytesToB64url(idBytes);
		this.#keys = keys;
		this.#cose = cose;
	}

	static async create(): Promise<TestPasskey> {
		const keys = (await crypto.subtle.generateKey(
			{ name: "ECDSA", namedCurve: "P-256" },
			true,
			["sign", "verify"],
		)) as CryptoKeyPair;
		const jwk = (await crypto.subtle.exportKey("jwk", keys.publicKey)) as {
			x: string;
			y: string;
		};
		return new TestPasskey(
			crypto.getRandomValues(new Uint8Array(16)),
			keys,
			coseEs256(b64urlToBytes(jwk.x), b64urlToBytes(jwk.y)),
		);
	}

	/** `fmt: "none"`, user presence and verification set. */
	async registration(input: {
		challenge: string;
		/** Replaces the challenge inside clientData. The credential id stays valid. */
		challengeOverride?: string;
		/** Defaults to the configured origin `https://example.com`. */
		origin?: string;
		/** Clear UV so the server's user-verification requirement fails. */
		userVerified?: boolean;
		/**
		 * JSON `id` / `rawId`. Defaults to the id inside authenticator data.
		 * A different value still verifies as `fmt: "none"` and then fails the
		 * app's credential-id check.
		 */
		reportedId?: string;
	}): Promise<PasskeyRegistrationJson> {
		const client = clientData(
			"webauthn.create",
			input.challengeOverride ?? input.challenge,
			input.origin ?? PASSKEY_ORIGIN,
		);
		const verified = input.userVerified !== false;
		const flags = 0x01 | (verified ? 0x04 : 0) | 0x40;
		const data = authData({
			rpIdHash: await sha256(new TextEncoder().encode(PASSKEY_RP_ID)),
			flags,
			counter: 0,
			credentialId: this.#idBytes,
			coseKey: this.#cose,
		});
		const attestation = cborMap([
			[cborText("fmt"), cborText("none")],
			[cborText("attStmt"), cborMap([])],
			[cborText("authData"), cborBytes(data)],
		]);
		const reported = input.reportedId ?? this.id;
		return {
			id: reported,
			rawId: reported,
			type: "public-key",
			response: {
				clientDataJSON: bytesToB64url(client),
				attestationObject: bytesToB64url(attestation),
				transports: ["internal"],
			},
			clientExtensionResults: {},
			authenticatorAttachment: "platform",
		};
	}

	/**
	 * Signs `authenticatorData || SHA-256(clientDataJSON)` and advances the counter.
	 * Pass `key` to produce a structurally valid signature from a different key.
	 */
	async assertion(input: {
		challenge: string;
		userHandle: string | undefined;
		challengeOverride?: string;
		origin?: string;
		rawId?: string;
		key?: CryptoKeyPair;
		userVerified?: boolean;
	}): Promise<PasskeyAssertionJson> {
		this.#counter += 1;
		const client = clientData(
			"webauthn.get",
			input.challengeOverride ?? input.challenge,
			input.origin ?? PASSKEY_ORIGIN,
		);
		const verified = input.userVerified !== false;
		const data = authData({
			rpIdHash: await sha256(new TextEncoder().encode(PASSKEY_RP_ID)),
			flags: 0x01 | (verified ? 0x04 : 0),
			counter: this.#counter,
		});
		const clientHash = await sha256(client);
		const signingKey = input.key?.privateKey ?? this.#keys.privateKey;
		const raw = new Uint8Array(
			await crypto.subtle.sign(
				{ name: "ECDSA", hash: "SHA-256" },
				signingKey,
				concat(data, clientHash),
			),
		);
		return {
			id: this.id,
			rawId: input.rawId ?? this.id,
			type: "public-key",
			response: {
				clientDataJSON: bytesToB64url(client),
				authenticatorData: bytesToB64url(data),
				signature: bytesToB64url(derEcdsa(raw)),
				...(input.userHandle === undefined
					? {}
					: { userHandle: input.userHandle }),
			},
			clientExtensionResults: {},
			authenticatorAttachment: "platform",
		};
	}
}

function clientData(
	type: string,
	challenge: string,
	origin: string,
): Uint8Array {
	return new TextEncoder().encode(
		JSON.stringify({ type, challenge, origin, crossOrigin: false }),
	);
}

function bytesToB64url(bytes: Uint8Array): string {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
