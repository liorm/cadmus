import type {
	ClientCommand,
	CommandResultFrame,
	RpcPayload,
	RpcResult,
	RpcType,
	ServerEvent,
	ServerFrame,
} from "../../src/protocol.js";

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
		return {
			Authorization: `Bearer ${this.token}`,
			"Content-Type": "application/json",
			"x-user-id": this.userId,
			"x-account-id": this.accountId,
			"X-Cadmus-Family-Id": this.familyId,
		};
	}

	// ─── True Request-Response RPC ─────────────────────────────────────────────

	async callRpc<K extends RpcType>(
		type: K,
		payload?: RpcPayload<K>,
	): Promise<CommandResultFrame<RpcResult<K>>>;
	async callRpc<T = unknown>(
		type: string,
		payload?: Record<string, unknown>,
	): Promise<CommandResultFrame<T>>;
	async callRpc<T = unknown>(
		type: string,
		payload?: Record<string, unknown>,
	): Promise<CommandResultFrame<T>> {
		const id = `cmd-${crypto.randomUUID().slice(0, 8)}`;
		const command: ClientCommand = {
			id,
			type,
			...(payload !== undefined ? { payload } : {}),
		} as ClientCommand;

		const rpcPath = this.baseUrl
			? `${this.baseUrl.replace(/\/+$/, "")}/rpc`
			: "/rpc";

		const res = await this.fetchImpl(rpcPath, {
			method: "POST",
			headers: this.buildHeaders(),
			body: JSON.stringify(command),
		});

		const data = (await res.json()) as ServerFrame;
		if (data.type === "protocol.error") {
			return {
				id,
				type: "command.result",
				command: type,
				ok: false,
				error: data.payload,
			};
		}

		return data as CommandResultFrame<T>;
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
		if (this.baseUrl) {
			if (
				this.baseUrl.startsWith("http://") ||
				this.baseUrl.startsWith("https://")
			) {
				origin = this.baseUrl;
			} else if (typeof window !== "undefined" && window.location?.origin) {
				origin = new URL(this.baseUrl, window.location.origin).toString();
			} else {
				origin = `http://localhost:8787${this.baseUrl.startsWith("/") ? "" : "/"}${this.baseUrl}`;
			}
		} else if (typeof window !== "undefined" && window.location?.origin) {
			origin = window.location.origin;
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
					const frame = JSON.parse(raw) as ServerFrame;
					if (frame.type !== "command.result") {
						for (const listener of this.eventListeners) {
							listener(frame as ServerEvent);
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
