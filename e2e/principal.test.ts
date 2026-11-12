import { describe, expect, it } from "vitest";
import {
	type ChatGetResult,
	callApi,
	sendRpc,
	TEST_TOKEN,
	uniqueAccountId,
	useWorkerFixture,
	WORKER_BASE_URL,
	workerFetch,
} from "./helpers.js";

// Headers a hostile client might send to pose as someone else.
const SPOOF_HEADERS: Record<string, string> = {
	"x-user-id": "mallory",
	"x-account-id": "someone-elses-account",
	"X-Cadmus-Caller-Role": "owner",
	"X-Cadmus-Principal": btoa(
		JSON.stringify({
			kind: "user",
			userId: "mallory",
			accountId: "someone-elses-account",
			role: "account-admin",
		}),
	),
	"x-cadmus-user-id": "mallory",
};

interface WhoamiResult {
	principal: {
		kind: string;
		userId?: string;
		accountId: string;
		role: string;
	};
}

describe("Principal plumbing (issue #3 phase 1)", () => {
	useWorkerFixture();

	it("auth.whoami returns the principal the edge resolved", async () => {
		const accountId = uniqueAccountId("who");
		const frame = await callApi<WhoamiResult>(
			"auth.whoami",
			{},
			{ accountId, userId: "alice" },
		);
		expect(frame.ok).toBe(true);
		expect(frame.result?.principal).toMatchObject({
			accountId,
			userId: "alice",
			role: "account-admin",
		});
	});

	it("spoofed identity headers over /rpc never change the acting principal", async () => {
		const accountId = uniqueAccountId("spoof-rpc");
		const res = await workerFetch(`${WORKER_BASE_URL}/rpc`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${accountId}:alice:${TEST_TOKEN}`,
				"X-Cadmus-Family-Id": "default",
				...SPOOF_HEADERS,
				"x-user-id": "mallory",
			},
			body: JSON.stringify({ id: "w1", type: "auth.whoami" }),
		});
		const frame = (await res.json()) as {
			result?: WhoamiResult;
			ok: boolean;
		};
		expect(frame.ok).toBe(true);
		// The token names account and user. The x-user-id / x-account-id
		// headers are only a fallback for a bare master secret, so they must not
		// reach the DO as an identity: the principal is exactly the token's.
		expect(frame.result?.principal).toMatchObject({
			accountId,
			userId: "alice",
			role: "account-admin",
		});
		expect(JSON.stringify(frame)).not.toContain("someone-elses-account");
	});

	it("a client-sent X-Cadmus-Principal or Caller-Role header never reaches the DO via /api", async () => {
		const accountId = uniqueAccountId("spoof-api");
		const headers: Record<string, string> = {
			Authorization: `Bearer ${accountId}:alice:${TEST_TOKEN}`,
			...SPOOF_HEADERS,
		};
		delete headers["x-user-id"];
		delete headers["x-account-id"];
		const res = await workerFetch(`${WORKER_BASE_URL}/api/auth/whoami`, {
			headers,
		});
		const body = (await res.json()) as { result?: WhoamiResult } & WhoamiResult;
		const principal = body.result?.principal ?? body.principal;
		expect(principal).toMatchObject({ accountId, userId: "alice" });
		expect(JSON.stringify(body)).not.toContain("mallory");
	});

	it("spoofed headers on a WebSocket upgrade never change the principal", async () => {
		const accountId = uniqueAccountId("spoof-ws");
		const url = new URL(`${WORKER_BASE_URL}/ws`);
		url.searchParams.set("token", `${accountId}:alice:${TEST_TOKEN}`);
		const res = await workerFetch(url.toString(), {
			headers: { Upgrade: "websocket", ...SPOOF_HEADERS },
		});
		const ws = res.webSocket;
		expect(ws).toBeTruthy();
		if (!ws) return;
		ws.accept();
		try {
			const reply = await new Promise<{ result?: WhoamiResult }>((resolve) => {
				ws.addEventListener("message", (ev) => {
					resolve(JSON.parse(String(ev.data)));
				});
				ws.send(JSON.stringify({ id: "ws1", type: "auth.whoami" }));
			});
			expect(reply.result?.principal).toMatchObject({
				accountId,
				userId: "alice",
				role: "account-admin",
			});
		} finally {
			ws.close();
		}
	});

	it("records the authenticated author of a user message and returns it on re-read", async () => {
		const accountId = uniqueAccountId("author");
		const alice = { accountId, userId: "alice" };
		const bob = { accountId, userId: "bob" };
		await sendRpc(
			"bot.create",
			{ slug: "echo-bot", name: "Echo", model: "faux/echo" },
			alice,
		);
		await sendRpc("chat.create", { botId: "echo-bot", key: "shared" }, alice);

		const first = await sendRpc(
			"turn.submit",
			{ chatKey: "shared", text: "from alice" },
			alice,
		);
		expect(first.frame.ok).toBe(true);
		const second = await sendRpc(
			"turn.submit",
			{
				chatKey: "shared",
				text: "from bob",
				// A payload cannot name its own author.
				authorUserId: "alice",
			} as never,
			bob,
		);
		expect(second.frame.ok).toBe(true);

		const reread = await sendRpc<ChatGetResult>(
			"chat.get",
			{ chatKey: "shared" },
			alice,
		);
		const users = (reread.frame.result?.messages ?? []).filter(
			(message) => message.role === "user",
		);
		expect(users.map((m) => [m.text, m.authorUserId])).toEqual([
			["from alice", "alice"],
			["from bob", "bob"],
		]);
	});
});
