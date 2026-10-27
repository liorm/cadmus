import { SELF } from "cloudflare:test";
import { setupLogger } from "../packages/worker/src/log.js";
import type {
	CommandResultFrame,
	RpcPayload,
	RpcResult,
	RpcType,
	ServerEvent,
	ServerFrame,
} from "../packages/worker/src/protocol.js";

setupLogger({ type: "silent" });

export const TEST_TOKEN = "test-cadmus-secret";

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
	url.searchParams.set("token", options.token ?? TEST_TOKEN);
	if (options.accountId) url.searchParams.set("accountId", options.accountId);
	if (options.familyId) url.searchParams.set("familyId", options.familyId);

	const res = await SELF.fetch(url.toString(), {
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
		close: () => {
			try {
				ws.close();
			} catch {
				// Ignore
			}
		},
	};
}
