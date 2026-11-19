import { describe, expect, it } from "vitest";
import {
	adminScope,
	CadmusClient,
	isAuthError,
	newCommandId,
	ProtocolClient,
	useWorkerFixture,
	workerFetch,
} from "./helpers.js";

/**
 * Drives `@cadmus/contract/client` against the real worker. The socket is the
 * workerd upgrade (`SELF.fetch`), the same handshake `connectTestWs` uses.
 */

const sockets: WorkerBoundSocket[] = [];

class WorkerBoundSocket {
	static OPEN = 1;
	readyState = 0;
	url: string;
	private listeners: Record<string, Array<(ev: { data?: unknown }) => void>> =
		{};
	private raw: WebSocket | null = null;

	constructor(url: string) {
		this.url = url;
		sockets.push(this);
		const httpUrl = url.replace(/^ws/i, "http");
		void workerFetch(httpUrl, { headers: { Upgrade: "websocket" } })
			.then((res) => {
				if (res.status !== 101 || !res.webSocket) {
					this.fail();
					return;
				}
				this.raw = res.webSocket;
				this.raw.accept();
				this.raw.addEventListener("message", (ev) => {
					this.emit("message", { data: (ev as MessageEvent).data });
				});
				this.raw.addEventListener("close", () => {
					this.readyState = 3;
					this.emit("close", {});
				});
				this.raw.addEventListener("error", () => {
					this.emit("error", {});
				});
				this.readyState = WorkerBoundSocket.OPEN;
				this.emit("open", {});
			})
			.catch(() => {
				this.fail();
			});
	}

	addEventListener(type: string, listener: (ev: { data?: unknown }) => void) {
		const list = this.listeners[type] ?? [];
		list.push(listener);
		this.listeners[type] = list;
	}

	send(data: string) {
		if (this.dropSend) return;
		this.raw?.send(data);
	}

	close() {
		this.readyState = 3;
		try {
			this.raw?.close();
		} catch {
			// The worker may already have closed the pair.
		}
	}

	/** Close the server side so the client observes a socket close event. */
	serverClose() {
		this.readyState = 3;
		try {
			this.raw?.close();
		} catch {
			// Ignore.
		}
		this.emit("close", {});
	}

	inject(data: unknown) {
		this.emit("message", { data });
	}

	dropSend = false;

	private fail() {
		this.readyState = 3;
		this.emit("error", {});
		this.emit("close", {});
	}

	private emit(type: string, ev: { data?: unknown }) {
		for (const listener of this.listeners[type] ?? []) listener(ev);
	}
}

function clientFor(accountId: string, token: string) {
	return new CadmusClient({
		baseUrl: "http://example.com",
		token,
		userId: "web-user",
		accountId,
		familyId: "default",
		fetchImpl: workerFetch,
		webSocketImpl: WorkerBoundSocket as unknown as typeof WebSocket,
	});
}

async function waitFor(check: () => boolean, label: string) {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		if (check()) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`timed out waiting for ${label}`);
}

describe("CadmusClient against the worker", () => {
	useWorkerFixture();

	it("calls REST, reports auth errors, and updates config without a socket", async () => {
		const { accountId, token } = await adminScope();
		const client = clientFor(accountId, token);
		expect(client.getBaseUrl()).toBe("http://example.com");
		expect(client.getToken()).toBe(token);
		expect(client.getUserId()).toBe("web-user");
		expect(client.getAccountId()).toBe(accountId);
		expect(client.getFamilyId()).toBe("default");
		expect(client.getStatus()).toBe("disconnected");

		client.setToken(token);
		client.setBaseUrl("http://example.com");
		client.setUserId("web-user");
		client.setAccountId(accountId);
		client.setFamilyId("default");

		const created = await client.call("bot.create", {
			slug: "scribe",
			name: "Scribe",
			model: "faux/echo",
		});
		expect(created.bot.id).toBe("scribe");

		const listed = await client.callRpc("bot.list");
		expect(listed.ok).toBe(true);
		expect(listed.result?.bots.some((bot) => bot.id === "scribe")).toBe(true);

		const denied = clientFor(accountId, "not-the-secret");
		const frame = await denied.callRpc("bot.list");
		expect(frame.ok).toBe(false);
		expect(isAuthError(frame.error?.code)).toBe(true);
		expect(isAuthError("header_required")).toBe(true);
		expect(isAuthError("query_token_not_allowed")).toBe(true);
		expect(isAuthError(undefined)).toBe(false);
		expect(isAuthError("not_found")).toBe(false);
		await expect(denied.call("bot.list")).rejects.toThrow();

		const protocol = new ProtocolClient({
			baseUrl: "http://example.com",
			token: token,
			accountId,
			familyId: "default",
			timeoutMs: 15_000,
			fetchImpl: workerFetch,
		});
		const unknown = await protocol.callRpc("not.a.command", { n: 1 });
		expect(unknown.ok).toBe(false);

		const original = crypto.randomUUID;
		Object.defineProperty(crypto, "randomUUID", {
			configurable: true,
			writable: true,
			value: undefined,
		});
		try {
			expect(typeof crypto.randomUUID).not.toBe("function");
			expect(newCommandId()).toMatch(/^cmd-[0-9a-f]{8}$/);
		} finally {
			Object.defineProperty(crypto, "randomUUID", {
				configurable: true,
				writable: true,
				value: original,
			});
		}

		const statuses: string[] = [];
		const stopStatus = client.onStatusChange((status) => {
			statuses.push(status);
		});
		client.updateConfig({
			baseUrl: "http://example.com",
			token: token,
			userId: "web-user",
			accountId,
			familyId: "default",
			fetchImpl: workerFetch,
		});
		client.setToken("cadmus-next-token", { reconnect: false });
		expect(client.getToken()).toBe("cadmus-next-token");
		client.setToken(token, { reconnect: false });
		client.close();
		expect(client.getStatus()).toBe("disconnected");
		stopStatus();
		expect(statuses).toEqual([]);
	});

	it("opens /ws, receives events, and covers socket failure paths", async () => {
		const { accountId, token } = await adminScope();
		sockets.length = 0;
		const client = clientFor(accountId, token);
		await client.call("bot.create", {
			slug: "speaker",
			name: "Speaker",
			model: "faux/echo",
		});
		await client.call("chat.create", { botId: "speaker", key: "main" });

		const statuses: string[] = [];
		const events: string[] = [];
		client.onStatusChange((status) => {
			statuses.push(status);
		});
		const unsubscribe = client.subscribe((event) => {
			events.push(event.type);
		});
		const unsubscribeAlias = client.subscribeEvents((event) => {
			events.push(`alias:${event.type}`);
		});

		client.connectWebSocket();
		await waitFor(() => client.getStatus() === "connected", "connected");
		expect(statuses).toContain("connecting");
		expect(statuses).toContain("connected");

		await client.call("turn.submit", { chatKey: "main", text: "Hello" });
		await waitFor(() => events.length > 0, "a websocket event");

		const protocol = new ProtocolClient({
			baseUrl: "http://example.com",
			token: token,
			userId: "web-user",
			accountId,
			familyId: "default",
			fetchImpl: workerFetch,
			webSocketImpl: WorkerBoundSocket as unknown as typeof WebSocket,
		});
		await protocol.connect({
			onEvent: (event) => {
				events.push(`protocol:${event.type}`);
			},
		});
		const bots = await protocol.sendOverSocket<{ bots: { id: string }[] }>(
			"bot.list",
		);
		expect(bots.ok).toBe(true);
		expect(bots.result?.bots.some((bot) => bot.id === "speaker")).toBe(true);

		const live = sockets.at(-1);
		expect(live).toBeDefined();
		live?.inject("not-json{");
		live?.inject(
			new TextEncoder().encode(
				JSON.stringify({
					type: "turn.assistant",
					payload: { text: "from-bytes" },
				}),
			).buffer,
		);
		live?.inject(
			JSON.stringify({
				type: "command.result",
				id: "nobody",
				command: "bot.list",
				ok: true,
				result: {},
			}),
		);
		await waitFor(
			() => events.some((type) => type.startsWith("protocol:")),
			"injected event",
		);

		if (!live) throw new Error("socket was not opened");
		live.dropSend = true;
		await expect(protocol.sendOverSocket("bot.list", {}, 40)).rejects.toThrow(
			/timed out/,
		);
		const dropped = protocol.sendOverSocket("bot.list");
		protocol.close();
		await expect(dropped).rejects.toThrow(/websocket closed/);
		await expect(protocol.sendOverSocket("bot.list")).rejects.toThrow(
			/not open/,
		);

		client.setBaseUrl("http://example.com");
		client.setToken(token);
		client.setUserId("other-user");
		expect(client.getUserId()).toBe("other-user");
		client.setAccountId(accountId);
		client.setFamilyId("default");
		client.updateConfig({
			userId: "web-user",
			token: token,
			baseUrl: "http://example.com",
			accountId,
			familyId: "default",
		});
		await waitFor(() => client.getStatus() === "connected", "reconnected");

		client.connectEvents();
		await waitFor(() => client.getStatus() === "connected", "connectEvents");

		const current = sockets.at(-1);
		current?.serverClose();
		await waitFor(() => client.getStatus() === "disconnected", "server close");
		client.close();
		expect(client.getStatus()).toBe("disconnected");
		unsubscribe();
		unsubscribeAlias();

		const bad = new ProtocolClient({
			baseUrl: "http://example.com",
			token: "not-the-secret",
			accountId,
			fetchImpl: workerFetch,
			webSocketImpl: WorkerBoundSocket as unknown as typeof WebSocket,
		});
		await expect(bad.connect()).rejects.toThrow(/ticket/);

		const urls: string[] = [];
		class RecordingSocket extends WorkerBoundSocket {
			constructor(url: string) {
				super(url);
				urls.push(url);
			}
		}
		const relative = new ProtocolClient({
			baseUrl: "/cadmus",
			token: token,
			accountId,
			useTickets: false,
			fetchImpl: workerFetch,
			webSocketImpl: RecordingSocket as unknown as typeof WebSocket,
		});
		await expect(relative.connect()).rejects.toThrow();
		expect(urls.at(-1)).toContain("localhost:8787/cadmus/ws");

		const empty = new ProtocolClient({
			baseUrl: "",
			token: token,
			accountId,
			useTickets: false,
			fetchImpl: workerFetch,
			webSocketImpl: RecordingSocket as unknown as typeof WebSocket,
		});
		await expect(empty.connect()).rejects.toThrow();
		expect(urls.at(-1)).toContain("localhost:8787/ws");

		const https = new ProtocolClient({
			baseUrl: "https://example.com",
			token: token,
			accountId,
			useTickets: false,
			fetchImpl: workerFetch,
			webSocketImpl: RecordingSocket as unknown as typeof WebSocket,
		});
		await expect(https.connect()).rejects.toThrow();
		expect(urls.at(-1)).toContain("wss://example.com/ws");

		const racing = new ProtocolClient({
			baseUrl: "http://example.com",
			token: token,
			accountId,
			familyId: "default",
			fetchImpl: workerFetch,
			webSocketImpl: RecordingSocket as unknown as typeof WebSocket,
		});
		try {
			const first = racing.connect();
			await racing.connect();
			void first;
		} finally {
			racing.close();
		}

		const previousLocation = (globalThis as { location?: { origin?: string } })
			.location;
		Object.defineProperty(globalThis, "location", {
			configurable: true,
			value: { origin: "http://example.com" },
		});
		try {
			const rooted = new ProtocolClient({
				baseUrl: "/cadmus",
				token: token,
				accountId,
				familyId: "default",
				useTickets: false,
				fetchImpl: workerFetch,
				webSocketImpl: RecordingSocket as unknown as typeof WebSocket,
			});
			await expect(rooted.connect()).rejects.toThrow();
			expect(urls.at(-1)).toContain("example.com/cadmus/ws");

			Object.defineProperty(globalThis, "location", {
				configurable: true,
				value: { origin: "null" },
			});
			const nullOrigin = new ProtocolClient({
				baseUrl: "",
				token: token,
				accountId,
				useTickets: false,
				fetchImpl: workerFetch,
				webSocketImpl: RecordingSocket as unknown as typeof WebSocket,
			});
			await expect(nullOrigin.connect()).rejects.toThrow();
			expect(urls.at(-1)).toContain("localhost:8787/ws");
		} finally {
			if (previousLocation === undefined) {
				delete (globalThis as { location?: unknown }).location;
			} else {
				Object.defineProperty(globalThis, "location", {
					configurable: true,
					value: previousLocation,
				});
			}
		}
	}, 60_000);
});
