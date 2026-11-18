/**
 * Dependency-free protocol transport shared by the web UI and the CLI.
 * REST `/api` calls, WebSocket connect, command-id correlation, error
 * normalization, and optional timeouts. `fetch` and `WebSocket` are injectable.
 */
import {
	API_ROUTES,
	type ApiCommandName,
	encodePayloadQuery,
} from "../generated/routes.js";
import type {
	CommandName,
	CommandResultFrame,
	Payload,
	Result,
	ServerEvent,
	ServerToClient,
} from "./types.js";

export type FetchFunction = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

export type WebSocketConstructor = new (url: string) => WebSocket;

export interface ProtocolClientOptions {
	baseUrl?: string;
	token?: string;
	userId?: string;
	accountId?: string;
	familyId?: string;
	fetchImpl?: FetchFunction;
	webSocketImpl?: WebSocketConstructor;
	/** Abort a REST call or a WebSocket command after this many milliseconds. */
	timeoutMs?: number;
	/**
	 * Open `/ws` with a single-use `auth.ticket` minted over the header-backed
	 * RPC, so the credential never rides in the URL. Default true; the worker
	 * refuses `?token=` on `/ws`.
	 */
	useTickets?: boolean;
}

export interface SocketHooks {
	onEvent?: (event: ServerEvent) => void;
	onOpen?: () => void;
	onError?: () => void;
	onClose?: () => void;
}

const AUTH_CODES = new Set([
	"unauthorized",
	"header_required",
	"query_token_not_allowed",
]);

export function isAuthError(code: string | undefined): boolean {
	return code !== undefined && AUTH_CODES.has(code);
}

/** `crypto.randomUUID` is missing on insecure origins (plain HTTP by IP). */
export function newCommandId(): string {
	if (typeof crypto.randomUUID === "function") {
		return `cmd-${crypto.randomUUID().slice(0, 8)}`;
	}
	const bytes = new Uint8Array(4);
	crypto.getRandomValues(bytes);
	let hex = "";
	for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
	return `cmd-${hex}`;
}

export function routeFor(type: string): {
	method: "GET" | "POST";
	path: string;
} {
	if (Object.hasOwn(API_ROUTES, type)) {
		const route = API_ROUTES[type as ApiCommandName];
		return { method: route.method, path: route.path };
	}
	return { method: "POST", path: `/api/${type.replaceAll(".", "/")}` };
}

export function joinBase(baseUrl: string, path: string): string {
	if (!baseUrl) return path;
	return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

export class ProtocolClient {
	baseUrl: string;
	token: string;
	userId?: string;
	accountId?: string;
	familyId?: string;
	fetchImpl: FetchFunction;
	webSocketImpl: WebSocketConstructor;
	timeoutMs?: number;

	private ws?: WebSocket;
	private connectGeneration = 0;
	private hooks: SocketHooks = {};
	private pending = new Map<
		string,
		{
			resolve: (frame: CommandResultFrame) => void;
			reject: (error: Error) => void;
			timer?: ReturnType<typeof setTimeout>;
		}
	>();

	constructor(options: ProtocolClientOptions = {}) {
		this.baseUrl = options.baseUrl ?? "";
		this.token = options.token ?? "";
		this.userId = options.userId;
		this.accountId = options.accountId;
		this.familyId = options.familyId;
		this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
		this.webSocketImpl = options.webSocketImpl ?? WebSocket;
		this.timeoutMs = options.timeoutMs;
		this.useTickets = options.useTickets ?? true;
	}

	useTickets: boolean;

	hasSocket(): boolean {
		return this.ws !== undefined;
	}

	buildHeaders(): Record<string, string> {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.token}`,
		};
		if (this.userId) headers["x-user-id"] = this.userId;
		if (this.accountId) headers["x-account-id"] = this.accountId;
		if (this.familyId) headers["X-Cadmus-Family-Id"] = this.familyId;
		return headers;
	}

	/**
	 * Page-relative and absolute base URLs. `/ws` carries a single-use ticket.
	 * The bearer is never placed on `/ws` or `/api`.
	 */
	webSocketUrl(ticket?: string): string {
		let origin: string;
		const pageOrigin = browserOrigin();
		if (this.baseUrl) {
			if (
				this.baseUrl.startsWith("http://") ||
				this.baseUrl.startsWith("https://")
			) {
				origin = this.baseUrl;
			} else if (pageOrigin) {
				origin = new URL(this.baseUrl, pageOrigin).toString();
			} else {
				origin = `http://localhost:8787${this.baseUrl.startsWith("/") ? "" : "/"}${this.baseUrl}`;
			}
		} else if (pageOrigin) {
			origin = pageOrigin;
		} else {
			origin = "http://localhost:8787";
		}
		const wsBase = origin
			.replace(/^http:/i, "ws:")
			.replace(/^https:/i, "wss:")
			.replace(/\/+$/, "");
		const wsUrl = new URL(`${wsBase}/ws`);
		if (ticket) wsUrl.searchParams.set("ticket", ticket);
		if (this.accountId) wsUrl.searchParams.set("accountId", this.accountId);
		if (this.userId) wsUrl.searchParams.set("userId", this.userId);
		if (this.familyId) wsUrl.searchParams.set("familyId", this.familyId);
		return wsUrl.toString();
	}

	async callRpc<T = unknown>(
		type: string,
		payload?: Record<string, unknown>,
	): Promise<CommandResultFrame<T>> {
		const id = newCommandId();
		const route = routeFor(type);
		let url = joinBase(this.baseUrl, route.path);
		const headers = this.buildHeaders();
		const init: RequestInit = { method: route.method, headers };
		if (this.timeoutMs !== undefined) {
			init.signal = AbortSignal.timeout(this.timeoutMs);
		}
		if (route.method === "GET") {
			if (payload) {
				const query = encodePayloadQuery(payload).toString();
				if (query.length > 0) url += `?${query}`;
			}
		} else {
			init.body = JSON.stringify(payload ?? {});
			headers["Content-Type"] = "application/json";
		}
		const res = await this.fetchImpl(url, init);
		return normalizeApiResponse<T>(res, id, type);
	}

	/**
	 * Open `/ws`. Resolves when the socket is open. A failure rejects `ready`
	 * and also notifies `onError` / `onClose` so a UI can update status
	 * without awaiting.
	 */
	connect(hooks: SocketHooks = {}): Promise<void> {
		this.close();
		this.hooks = hooks;
		let resolveOpen: () => void = () => {};
		let rejectOpen: (error: Error) => void = () => {};
		const opened = new Promise<void>((resolve, reject) => {
			resolveOpen = resolve;
			rejectOpen = reject;
		});
		// Callers that only use status hooks must not see an unhandled rejection.
		opened.catch(() => {});
		const generation = ++this.connectGeneration;
		const start = async () => {
			let ticket: string | undefined;
			if (this.useTickets) {
				const issued = await this.callRpc<{ ticket: string }>("auth.ticket", {
					target: "ws",
				});
				if (!issued.ok || !issued.result?.ticket) {
					throw new Error("could not get a websocket ticket");
				}
				ticket = issued.result.ticket;
			}
			// A newer connect() or a close() superseded this attempt.
			if (generation !== this.connectGeneration) return;
			const socket = new this.webSocketImpl(this.webSocketUrl(ticket));
			this.ws = socket;
			socket.addEventListener("open", () => {
				if (this.ws !== socket) return;
				this.hooks.onOpen?.();
				resolveOpen();
			});
			socket.addEventListener("message", (ev: MessageEvent) => {
				if (this.ws !== socket) return;
				this.handleMessage(ev);
			});
			socket.addEventListener("error", () => {
				if (this.ws !== socket) return;
				this.hooks.onError?.();
				rejectOpen(new Error("websocket error"));
			});
			socket.addEventListener("close", () => {
				if (this.ws !== socket) return;
				this.ws = undefined;
				this.rejectPending(new Error("websocket closed"));
				this.hooks.onClose?.();
				rejectOpen(new Error("websocket closed"));
			});
		};
		start().catch((error) => {
			if (generation !== this.connectGeneration) return;
			this.ws = undefined;
			this.hooks.onError?.();
			const reason = error instanceof Error ? error : new Error(String(error));
			rejectOpen(reason);
		});
		return opened;
	}

	async sendOverSocket<T = unknown>(
		type: string,
		payload?: Record<string, unknown>,
		timeoutMs?: number,
	): Promise<CommandResultFrame<T>> {
		const socket = this.ws;
		const openState = (this.webSocketImpl as { OPEN?: number }).OPEN ?? 1;
		if (!socket || socket.readyState !== openState) {
			throw new Error("websocket is not open");
		}
		const id = newCommandId();
		const command = {
			id,
			type,
			...(payload !== undefined ? { payload } : {}),
		};
		return new Promise<CommandResultFrame<T>>((resolve, reject) => {
			const timer =
				timeoutMs !== undefined
					? setTimeout(() => {
							this.pending.delete(id);
							reject(new Error(`timed out after ${timeoutMs}ms`));
						}, timeoutMs)
					: undefined;
			this.pending.set(id, {
				resolve: resolve as (frame: CommandResultFrame) => void,
				reject,
				timer,
			});
			socket.send(JSON.stringify(command));
		});
	}

	close(): void {
		this.connectGeneration++;
		const socket = this.ws;
		this.ws = undefined;
		this.rejectPending(new Error("websocket closed"));
		if (!socket) return;
		try {
			socket.close();
		} catch {
			// Ignore close errors.
		}
		this.hooks.onClose?.();
	}

	private rejectPending(error: Error): void {
		for (const waiter of this.pending.values()) {
			if (waiter.timer) clearTimeout(waiter.timer);
			waiter.reject(error);
		}
		this.pending.clear();
	}

	private handleMessage(ev: MessageEvent): void {
		try {
			const raw =
				typeof ev.data === "string"
					? ev.data
					: new TextDecoder().decode(ev.data as ArrayBuffer);
			const frame = JSON.parse(raw) as ServerToClient;
			if (frame.type === "command.result") {
				const waiter = this.pending.get(frame.id);
				if (waiter) {
					this.pending.delete(frame.id);
					if (waiter.timer) clearTimeout(waiter.timer);
					waiter.resolve(frame);
				}
				return;
			}
			this.hooks.onEvent?.(frame);
		} catch {
			// Ignore unparseable frames.
		}
	}
}

function browserOrigin(): string | undefined {
	const origin = (globalThis as { location?: { origin?: string } }).location
		?.origin;
	if (!origin || origin === "null") return undefined;
	return origin;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failedFrame<T>(
	id: string,
	command: string,
	code: string,
	message: string,
): CommandResultFrame<T> {
	return {
		id,
		type: "command.result",
		command,
		ok: false,
		error: { code, message },
	};
}

/**
 * Turn an `/api/*` response into the `CommandResultFrame` callers already use.
 * Success is the unwrapped result. Failures are `{ error: { code, message } }`
 * or an auth `protocol.error` frame. Non-JSON bodies reject via `response.json()`.
 */
async function normalizeApiResponse<T>(
	response: Response,
	id: string,
	command: string,
): Promise<CommandResultFrame<T>> {
	const parsed: unknown = await response.json();
	if (isRecord(parsed) && parsed.type === "protocol.error") {
		const payload = isRecord(parsed.payload) ? parsed.payload : {};
		return failedFrame(
			id,
			command,
			typeof payload.code === "string" ? payload.code : "protocol_error",
			typeof payload.message === "string" ? payload.message : "Protocol error",
		);
	}
	if (!response.ok) {
		const error =
			isRecord(parsed) && isRecord(parsed.error) ? parsed.error : {};
		return failedFrame(
			id,
			command,
			typeof error.code === "string" ? error.code : "command_failed",
			typeof error.message === "string"
				? error.message
				: `HTTP ${response.status}`,
		);
	}
	return {
		id,
		type: "command.result",
		command,
		ok: true,
		result: parsed as T,
	};
}

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export interface CadmusClientOptions {
	baseUrl?: string;
	token?: string;
	userId?: string;
	accountId?: string;
	familyId?: string;
	fetchImpl?: typeof globalThis.fetch | FetchFunction;
	/**
	 * Socket constructor. Browsers use the global `WebSocket`. Hosts that
	 * cannot open a raw socket (the workerd test runner) inject one.
	 */
	webSocketImpl?: WebSocketConstructor;
	/** A signed-in client: it never invents an account id (see the constructor). */
	useTickets?: boolean;
}

/**
 * Socket and credential layer over `ProtocolClient`.
 * Status, reconnect generation, and listener sets live here.
 * REST and the socket frame path stay on `ProtocolClient`.
 */
export class CadmusClient {
	private readonly protocol: ProtocolClient;
	private status: ConnectionStatus = "disconnected";
	private eventListeners = new Set<(event: ServerEvent) => void>();
	private statusListeners = new Set<(status: ConnectionStatus) => void>();
	private socketGeneration = 0;

	constructor(options: CadmusClientOptions = {}) {
		this.protocol = new ProtocolClient({
			baseUrl: options.baseUrl ?? "",
			token: options.token ?? "dev-cadmus-secret",
			userId: options.userId ?? "dev",
			// A ticket (signed-in) client never invents an account: the server reads
			// an account id as a membership selection and refuses one the user is not
			// in, so with no choice the session acts in its own account.
			accountId: options.useTickets
				? options.accountId
				: (options.accountId ?? "default-account"),
			familyId: options.familyId ?? "default",
			fetchImpl: options.fetchImpl,
			webSocketImpl: options.webSocketImpl,
			// The socket always opens with a header-minted ticket; the worker
			// refuses ?token=. `options.useTickets` only decides the account default.
			useTickets: true,
		});
	}

	getBaseUrl(): string {
		return this.protocol.baseUrl;
	}

	setBaseUrl(baseUrl: string): void {
		if (this.protocol.baseUrl !== baseUrl) {
			this.protocol.baseUrl = baseUrl;
			if (this.protocol.hasSocket()) this.connectWebSocket();
		}
	}

	getToken(): string {
		return this.protocol.token;
	}

	setToken(token: string, options: { reconnect?: boolean } = {}): void {
		if (this.protocol.token !== token) {
			this.protocol.token = token;
			if (options.reconnect !== false && this.protocol.hasSocket()) {
				this.connectWebSocket();
			}
		}
	}

	getUserId(): string {
		return this.protocol.userId ?? "";
	}

	setUserId(userId: string): void {
		if (this.protocol.userId !== userId) {
			this.protocol.userId = userId;
			if (this.protocol.hasSocket()) this.connectWebSocket();
		}
	}

	getAccountId(): string {
		return this.protocol.accountId ?? "";
	}

	setAccountId(accountId: string): void {
		if (this.protocol.accountId !== accountId) {
			this.protocol.accountId = accountId;
			if (this.protocol.hasSocket()) this.connectWebSocket();
		}
	}

	getFamilyId(): string {
		return this.protocol.familyId ?? "";
	}

	setFamilyId(familyId: string): void {
		if (this.protocol.familyId !== familyId) {
			this.protocol.familyId = familyId;
			if (this.protocol.hasSocket()) this.connectWebSocket();
		}
	}

	getStatus(): ConnectionStatus {
		return this.status;
	}

	updateConfig(
		options: Partial<
			Pick<
				CadmusClientOptions,
				"baseUrl" | "token" | "userId" | "accountId" | "familyId" | "fetchImpl"
			>
		>,
	): void {
		let reconnectNeeded = false;
		if (
			options.baseUrl !== undefined &&
			options.baseUrl !== this.protocol.baseUrl
		) {
			this.protocol.baseUrl = options.baseUrl;
			reconnectNeeded = true;
		}
		if (options.token !== undefined && options.token !== this.protocol.token) {
			this.protocol.token = options.token;
			reconnectNeeded = true;
		}
		if (
			options.userId !== undefined &&
			options.userId !== this.protocol.userId
		) {
			this.protocol.userId = options.userId;
			reconnectNeeded = true;
		}
		if (
			options.accountId !== undefined &&
			options.accountId !== this.protocol.accountId
		) {
			this.protocol.accountId = options.accountId;
			reconnectNeeded = true;
		}
		if (
			options.familyId !== undefined &&
			options.familyId !== this.protocol.familyId
		) {
			this.protocol.familyId = options.familyId;
			reconnectNeeded = true;
		}
		if (options.fetchImpl !== undefined) {
			this.protocol.fetchImpl = options.fetchImpl;
		}
		if (reconnectNeeded && this.protocol.hasSocket()) this.connectWebSocket();
	}

	async call<C extends CommandName>(
		command: C,
		payload?: Payload<C>,
	): Promise<Result<C>> {
		const frame = await this.callRpc(command, payload);
		if (!frame.ok) {
			const message = frame.error?.message ?? `${command} failed`;
			throw new Error(message);
		}
		return frame.result as Result<C>;
	}

	async callRpc<C extends CommandName>(
		type: C,
		payload?: Payload<C>,
	): Promise<CommandResultFrame<Result<C>>>;
	async callRpc<T = unknown>(
		type: string,
		payload?: Record<string, unknown>,
	): Promise<CommandResultFrame<T>>;
	async callRpc<T = unknown>(
		type: string,
		payload?: Record<string, unknown>,
	): Promise<CommandResultFrame<T>> {
		return this.protocol.callRpc<T>(
			type,
			payload as Record<string, unknown> | undefined,
		);
	}

	sendCommand = this.callRpc.bind(this);

	subscribe(listener: (event: ServerEvent) => void): () => void {
		this.eventListeners.add(listener);
		return () => {
			this.eventListeners.delete(listener);
		};
	}

	subscribeEvents(listener: (event: ServerEvent) => void): () => void {
		return this.subscribe(listener);
	}

	onStatusChange(listener: (status: ConnectionStatus) => void): () => void {
		this.statusListeners.add(listener);
		return () => {
			this.statusListeners.delete(listener);
		};
	}

	private setStatus(status: ConnectionStatus): void {
		if (this.status === status) return;
		this.status = status;
		for (const listener of this.statusListeners) {
			listener(status);
		}
	}

	connectWebSocket(): void {
		const generation = ++this.socketGeneration;
		this.setStatus("connecting");
		const ready = this.protocol.connect({
			onOpen: () => {
				if (this.socketGeneration === generation) this.setStatus("connected");
			},
			onEvent: (event) => {
				if (this.socketGeneration !== generation) return;
				for (const listener of this.eventListeners) listener(event);
			},
			onError: () => {
				if (this.socketGeneration === generation)
					this.setStatus("disconnected");
			},
			onClose: () => {
				if (this.socketGeneration === generation)
					this.setStatus("disconnected");
			},
		});
		ready.catch(() => {
			// Status hooks already recorded the failure.
		});
	}

	connectEvents(): void {
		this.connectWebSocket();
	}

	close(): void {
		if (!this.protocol.hasSocket()) return;
		this.socketGeneration += 1;
		this.protocol.close();
		this.setStatus("disconnected");
	}
}
