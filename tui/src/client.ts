import type {
	ClientCommand,
	CommandResultFrame,
	RpcPayload,
	RpcResult,
	RpcType,
	ServerEvent,
	ServerFrame,
} from "../../src/protocol.js";

export interface CadmusTuiClientOptions {
	baseUrl: string;
	token: string;
	accountId?: string;
	familyId?: string;
	onEvent?: (event: ServerEvent) => void;
}

export class CadmusProtocolClient {
	private readonly baseUrl: string;
	private readonly token: string;
	private readonly accountId?: string;
	private familyId: string;
	private readonly onEvent?: (event: ServerEvent) => void;
	private ws?: WebSocket;
	private pending = new Map<
		string,
		{
			resolve: (frame: CommandResultFrame) => void;
			reject: (err: Error) => void;
		}
	>();

	constructor(options: CadmusTuiClientOptions) {
		this.baseUrl = options.baseUrl.replace(/\/+$/, "");
		this.token = options.token;
		this.accountId = options.accountId;
		this.familyId = options.familyId ?? "default";
		this.onEvent = options.onEvent;
	}

	getFamilyId(): string {
		return this.familyId;
	}

	setFamilyId(familyId: string): void {
		this.familyId = familyId;
	}

	private buildHeaders(): Record<string, string> {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.token}`,
			"Content-Type": "application/json",
			"X-Cadmus-Family-Id": this.familyId,
		};
		if (this.accountId) {
			headers["x-account-id"] = this.accountId;
		}
		return headers;
	}

	async connectWebSocket(): Promise<void> {
		const wsUrl = new URL(
			this.baseUrl.replace(/^http:/i, "ws:").replace(/^https:/i, "wss:") +
				"/ws",
		);
		wsUrl.searchParams.set("token", this.token);
		wsUrl.searchParams.set("familyId", this.familyId);
		if (this.accountId) {
			wsUrl.searchParams.set("accountId", this.accountId);
		}

		return new Promise<void>((resolve) => {
			try {
				const socket = new WebSocket(wsUrl.toString());
				socket.addEventListener("open", () => {
					this.ws = socket;
					resolve();
				});
				socket.addEventListener("message", (ev) => {
					try {
						const raw =
							typeof ev.data === "string"
								? ev.data
								: new TextDecoder().decode(ev.data as ArrayBuffer);
						const frame = JSON.parse(raw) as ServerFrame;
						if (frame.type === "command.result") {
							const waiter = this.pending.get(frame.id);
							if (waiter) {
								this.pending.delete(frame.id);
								waiter.resolve(frame);
							}
						} else {
							this.onEvent?.(frame);
						}
					} catch {
						// Ignore unparseable frames
					}
				});
				socket.addEventListener("error", () => {
					resolve();
				});
				socket.addEventListener("close", () => {
					if (this.ws === socket) {
						this.ws = undefined;
					}
				});
			} catch {
				resolve();
			}
		});
	}

	async sendCommand<K extends RpcType>(
		type: K,
		payload?: RpcPayload<K>,
	): Promise<CommandResultFrame<RpcResult<K>>>;
	async sendCommand<T = unknown>(
		type: string,
		payload?: Record<string, unknown>,
	): Promise<CommandResultFrame<T>>;
	async sendCommand<T = unknown>(
		type: string,
		payload?: Record<string, unknown>,
	): Promise<CommandResultFrame<T>> {
		const id = `cmd-${crypto.randomUUID().slice(0, 8)}`;
		const command = {
			id,
			type,
			...(payload !== undefined ? { payload } : {}),
		} as ClientCommand;

		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			return new Promise<CommandResultFrame<T>>((resolve, reject) => {
				this.pending.set(id, {
					resolve: resolve as (frame: CommandResultFrame) => void,
					reject,
				});
				this.ws?.send(JSON.stringify(command));
			});
		}

		const res = await fetch(`${this.baseUrl}/rpc`, {
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

	close(): void {
		try {
			this.ws?.close();
		} catch {
			// Ignore
		}
	}
}
