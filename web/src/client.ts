import { API_ROUTES, encodePayloadQuery } from "@cadmus/contract/routes";
import type {
	CommandName,
	CommandResultFrame,
	Payload,
	Result,
	ServerEvent,
	ServerToClient,
} from "@cadmus/contract/types";

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export type FetchFunction = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

export interface CadmusClientOptions {
	baseUrl?: string;
	token?: string;
	userId?: string;
	accountId?: string;
	familyId?: string;
	fetchImpl?: typeof globalThis.fetch | FetchFunction;
}

export class CadmusClient {
	private baseUrl: string;
	private token: string;
	private userId: string;
	private accountId: string;
	private familyId: string;
	private fetchImpl: FetchFunction;

	private ws?: WebSocket;
	private status: ConnectionStatus = "disconnected";
	private eventListeners = new Set<(event: ServerEvent) => void>();
	private statusListeners = new Set<(status: ConnectionStatus) => void>();

	constructor(options: CadmusClientOptions = {}) {
		this.baseUrl = options.baseUrl ?? "";
		this.token = options.token ?? "dev-cadmus-secret";
		this.userId = options.userId ?? "dev";
		this.accountId = options.accountId ?? "default-account";
		this.familyId = options.familyId ?? "default";
		this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
	}

	getBaseUrl(): string {
		return this.baseUrl;
	}

	setBaseUrl(baseUrl: string): void {
		if (this.baseUrl !== baseUrl) {
			this.baseUrl = baseUrl;
			if (this.ws) {
				this.connectWebSocket();
			}
		}
	}

	getToken(): string {
		return this.token;
	}

	setToken(token: string): void {
		if (this.token !== token) {
			this.token = token;
			if (this.ws) {
				this.connectWebSocket();
			}
		}
	}

	getUserId(): string {
		return this.userId;
	}

	setUserId(userId: string): void {
		if (this.userId !== userId) {
			this.userId = userId;
			if (this.ws) {
				this.connectWebSocket();
			}
		}
	}

	getAccountId(): string {
		return this.accountId;
	}

	setAccountId(accountId: string): void {
		if (this.accountId !== accountId) {
			this.accountId = accountId;
			if (this.ws) {
				this.connectWebSocket();
			}
		}
	}

	getFamilyId(): string {
		return this.familyId;
	}

	setFamilyId(familyId: string): void {
		if (this.familyId !== familyId) {
			this.familyId = familyId;
			if (this.ws) {
				this.connectWebSocket();
			}
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
		if (options.baseUrl !== undefined && options.baseUrl !== this.baseUrl) {
			this.baseUrl = options.baseUrl;
			reconnectNeeded = true;
		}
		if (options.token !== undefined && options.token !== this.token) {
			this.token = options.token;
			reconnectNeeded = true;
		}
		if (options.userId !== undefined && options.userId !== this.userId) {
			this.userId = options.userId;
			reconnectNeeded = true;
		}
		if (
			options.accountId !== undefined &&
			options.accountId !== this.accountId
		) {
			this.accountId = options.accountId;
			reconnectNeeded = true;
		}
		if (options.familyId !== undefined && options.familyId !== this.familyId) {
			this.familyId = options.familyId;
			reconnectNeeded = true;
		}
		if (options.fetchImpl !== undefined) {
			this.fetchImpl = options.fetchImpl;
		}
		if (reconnectNeeded && this.ws) {
			this.connectWebSocket();
		}
	}

	private buildHeaders(): Record<string, string> {
		// `/api` accepts this header only. Never put the token on the `/api` URL.
		return {
			Authorization: `Bearer ${this.token}`,
			"x-user-id": this.userId,
			"x-account-id": this.accountId,
			"X-Cadmus-Family-Id": this.familyId,
		};
	}

	// ─── REST request-response (`/api/*`) ─────────────────────────────────────
	//
	// `callRpc` keeps the CommandResultFrame return shape. The wire call is the
	// route from the generated contract table (readOnly → GET, otherwise POST).
	// `/ws` below stays event-only.
	//
	// Transport failures reject with the original error, matching the previous
	// `/rpc` client. Non-JSON bodies also reject, because that client used
	// `response.json()`. HTTP and protocol errors resolve as `{ ok: false }`.

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
		const id = `cmd-${crypto.randomUUID().slice(0, 8)}`;
		const route = routeFor(type);
		let url = joinBase(this.baseUrl, route.path);
		const headers = this.buildHeaders();
		const init: RequestInit = {
			method: route.method,
			headers,
		};
		if (route.method === "GET") {
			if (payload) {
				const query = encodePayloadQuery(
					payload as Record<string, unknown>,
				).toString();
				if (query.length > 0) url += `?${query}`;
			}
		} else {
			init.body = JSON.stringify(payload ?? {});
			headers["Content-Type"] = "application/json";
		}

		const res = await this.fetchImpl(url, init);
		return normalizeApiResponse<T>(res, id, type);
	}

	sendCommand = this.callRpc.bind(this);

	// ─── Event-Only WebSocket ──────────────────────────────────────────────────

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

	private getWsUrl(): string {
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
		wsUrl.searchParams.set("accountId", this.accountId);
		wsUrl.searchParams.set("userId", this.userId);
		wsUrl.searchParams.set("familyId", this.familyId);
		return wsUrl.toString();
	}

	connectWebSocket(): void {
		this.close();
		this.setStatus("connecting");

		try {
			const socket = new WebSocket(this.getWsUrl());
			this.ws = socket;

			socket.addEventListener("open", () => {
				if (this.ws === socket) {
					this.setStatus("connected");
				}
			});

			socket.addEventListener("message", (ev: MessageEvent) => {
				try {
					const raw =
						typeof ev.data === "string"
							? ev.data
							: new TextDecoder().decode(ev.data as ArrayBuffer);
					const frame = JSON.parse(raw) as ServerToClient;
					if (frame.type !== "command.result") {
						for (const listener of this.eventListeners) {
							listener(frame);
						}
					}
				} catch {
					// Ignore unparseable frames
				}
			});

			socket.addEventListener("error", () => {
				if (this.ws === socket) {
					this.setStatus("disconnected");
				}
			});

			socket.addEventListener("close", () => {
				if (this.ws === socket) {
					this.ws = undefined;
					this.setStatus("disconnected");
				}
			});
		} catch {
			this.setStatus("disconnected");
		}
	}

	connectEvents(): void {
		this.connectWebSocket();
	}

	close(): void {
		if (this.ws) {
			const socket = this.ws;
			this.ws = undefined;
			try {
				socket.close();
			} catch {
				// Ignore close errors
			}
			this.setStatus("disconnected");
		}
	}
}

function routeFor(type: string): { method: "GET" | "POST"; path: string } {
	if (Object.hasOwn(API_ROUTES, type)) {
		const route = API_ROUTES[type as keyof typeof API_ROUTES];
		return { method: route.method, path: route.path };
	}
	return { method: "POST", path: `/api/${type.replaceAll(".", "/")}` };
}

function joinBase(baseUrl: string, path: string): string {
	if (!baseUrl) return path;
	return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

/** Page origin when running in a browser. Absent in workers and non-DOM tests. */
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
 *
 * Success is the unwrapped result (HTTP 200). Failures are either
 * `{ error: { code, message } }` or an auth `protocol.error` frame.
 * Non-JSON bodies reject via `response.json()`, same as the previous `/rpc` client.
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
