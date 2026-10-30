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
	CommandResultFrame,
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
	}

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
	 * Page-relative and absolute base URLs. The token is a query parameter,
	 * matching `/ws` (it is never placed on `/api`).
	 */
	webSocketUrl(): string {
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
		wsUrl.searchParams.set("token", this.token);
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
		try {
			const socket = new this.webSocketImpl(this.webSocketUrl());
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
		} catch (error) {
			this.ws = undefined;
			this.hooks.onError?.();
			const reason = error instanceof Error ? error : new Error(String(error));
			rejectOpen(reason);
		}
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
