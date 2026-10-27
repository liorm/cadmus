import {
	API_ROUTES,
	encodePayloadQuery,
	routeForCommand,
} from "@cadmus/contract/routes";
import type {
	ClientToServer,
	CommandName,
	CommandResultFrame,
	Payload,
	Result,
	ServerEvent,
	ServerToClient,
} from "@cadmus/contract/types";

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
						const frame = JSON.parse(raw) as ServerToClient;
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

	async call<C extends CommandName>(
		command: C,
		payload?: Payload<C>,
	): Promise<Result<C>> {
		const frame = await this.sendCommand(command, payload);
		if (!frame.ok) {
			throw new Error(frame.error?.message ?? `${command} failed`);
		}
		return frame.result as Result<C>;
	}

	async sendCommand<C extends CommandName>(
		type: C,
		payload?: Payload<C>,
	): Promise<CommandResultFrame<Result<C>>>;
	async sendCommand<T = unknown>(
		type: string,
		payload?: Record<string, unknown>,
	): Promise<CommandResultFrame<T>>;
	async sendCommand<T = unknown>(
		type: string,
		payload?: Record<string, unknown>,
	): Promise<CommandResultFrame<T>> {
		const id = `cmd-${crypto.randomUUID().slice(0, 8)}`;
		const command: ClientToServer = {
			id,
			type,
			...(payload !== undefined ? { payload } : {}),
		} as ClientToServer;

		if (this.ws && this.ws.readyState === WebSocket.OPEN) {
			return new Promise<CommandResultFrame<T>>((resolve, reject) => {
				this.pending.set(id, {
					resolve: resolve as (frame: CommandResultFrame) => void,
					reject,
				});
				this.ws?.send(JSON.stringify(command));
			});
		}

		return this.sendOverRest<T>(id, type, payload);
	}

	private async sendOverRest<T>(
		id: string,
		type: string,
		payload?: Record<string, unknown>,
	): Promise<CommandResultFrame<T>> {
		const known = Object.hasOwn(API_ROUTES, type)
			? routeForCommand(type as CommandName)
			: undefined;
		const method = known?.method ?? "POST";
		const path = known?.path ?? `/api/${type.replaceAll(".", "/")}`;
		let url = `${this.baseUrl}${path}`;
		const headers = this.buildHeaders();
		const init: RequestInit = { method, headers };
		if (method === "GET") {
			delete headers["Content-Type"];
			if (payload) {
				const query = encodePayloadQuery(payload).toString();
				if (query.length > 0) url += `?${query}`;
			}
		} else {
			init.body = JSON.stringify(payload ?? {});
		}
		const res = await fetch(url, init);
		const data: unknown = await res.json();
		if (isRecord(data) && data.type === "protocol.error") {
			const errorPayload = isRecord(data.payload) ? data.payload : {};
			return {
				id,
				type: "command.result",
				command: type,
				ok: false,
				error: {
					code:
						typeof errorPayload.code === "string"
							? errorPayload.code
							: "protocol_error",
					message:
						typeof errorPayload.message === "string"
							? errorPayload.message
							: "Protocol error",
				},
			};
		}
		if (!res.ok) {
			const error = isRecord(data) && isRecord(data.error) ? data.error : {};
			return {
				id,
				type: "command.result",
				command: type,
				ok: false,
				error: {
					code: typeof error.code === "string" ? error.code : "command_failed",
					message:
						typeof error.message === "string"
							? error.message
							: `HTTP ${res.status}`,
				},
			};
		}
		return {
			id,
			type: "command.result",
			command: type,
			ok: true,
			result: data as T,
		};
	}

	close(): void {
		try {
			this.ws?.close();
		} catch {
			// Ignore
		}
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
