import { describe, expect, it } from "bun:test";
import { createClient } from "../src/client.js";

type WebSocketConstructor = new (url: string) => WebSocket;

class FakeSocket {
	static urls: string[] = [];
	constructor(url: string) {
		FakeSocket.urls.push(url);
	}
	addEventListener() {}
	close() {}
	send() {}
}

interface Call {
	url: string;
	auth: string | null;
}

/** `status` 200 mints a numbered ticket; any other status is a refusal. */
function setup(token: string, status = 200) {
	FakeSocket.urls = [];
	const calls: Call[] = [];
	let minted = 0;
	const fetchImpl = (async (url: string, init?: RequestInit) => {
		calls.push({
			url: String(url),
			auth: new Headers(init?.headers).get("authorization"),
		});
		if (status !== 200) {
			return new Response(
				JSON.stringify({
					type: "command.result",
					id: "x",
					ok: false,
					error: { code: "unauthorized", message: "expired" },
				}),
				{ status, headers: { "content-type": "application/json" } },
			);
		}
		minted += 1;
		return new Response(
			JSON.stringify({
				ticket: `cad_tk_fake${minted}`,
				expiresAt: Date.now() + 60_000,
			}),
			{ headers: { "content-type": "application/json" } },
		);
	}) as unknown as typeof fetch;
	const client = createClient(
		{ url: "http://localhost:8787", token, account: "acct" },
		{
			fetchImpl,
			webSocketImpl: FakeSocket as unknown as WebSocketConstructor,
		},
	);
	return { client, calls };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("cli client credential selection", () => {
	it("opens /ws with a ticket for a cad_at_ session token, never the token", async () => {
		const { client, calls } = setup("cad_at_session");
		expect(client.useTickets).toBe(true);
		void client.connect().catch(() => undefined);
		await settle();
		// The ticket call was really made, with the session token as bearer.
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toContain("/api/auth/ticket");
		expect(calls[0]?.auth).toBe("Bearer cad_at_session");
		const url = FakeSocket.urls[0] ?? "";
		expect(url).toContain("/ws?");
		expect(url).toContain("ticket=cad_tk_fake1");
		expect(url).not.toContain("token=");
		expect(url).not.toContain("cad_at_session");
		client.close();
	});

	it("mints a fresh ticket on every connect", async () => {
		const { client, calls } = setup("cad_at_session");
		void client.connect().catch(() => undefined);
		await settle();
		void client.connect().catch(() => undefined);
		await settle();
		expect(calls).toHaveLength(2);
		expect(FakeSocket.urls[0]).toContain("ticket=cad_tk_fake1");
		expect(FakeSocket.urls[1]).toContain("ticket=cad_tk_fake2");
		client.close();
	});

	it("rejects once, without retrying or opening a socket, when the session is expired", async () => {
		const { client, calls } = setup("cad_at_expired", 401);
		await expect(client.connect()).rejects.toThrow(
			"could not get a websocket ticket",
		);
		await settle();
		expect(calls).toHaveLength(1);
		expect(FakeSocket.urls).toHaveLength(0);
	});
});
