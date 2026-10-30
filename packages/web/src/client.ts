import {
	type FetchFunction,
	ProtocolClient,
	type ProtocolClientOptions,
} from "@cadmus/contract/client";
import type {
	CommandName,
	CommandResultFrame,
	Payload,
	Result,
	ServerEvent,
} from "@cadmus/contract/types";

export type { FetchFunction };

export type ConnectionStatus = "connecting" | "connected" | "disconnected";

export interface CadmusClientOptions {
	baseUrl?: string;
	token?: string;
	userId?: string;
	accountId?: string;
	familyId?: string;
	fetchImpl?: typeof globalThis.fetch | FetchFunction;
}

/**
 * Web socket and credential layer over `@cadmus/contract/client`.
 * Status, reconnect, and listener sets stay here. REST and the socket
 * frame path live in the shared client.
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
			accountId: options.accountId ?? "default-account",
			familyId: options.familyId ?? "default",
			fetchImpl: options.fetchImpl,
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

	setToken(token: string): void {
		if (this.protocol.token !== token) {
			this.protocol.token = token;
			if (this.protocol.hasSocket()) this.connectWebSocket();
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

export type { ProtocolClientOptions };
