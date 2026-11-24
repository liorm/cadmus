import { describe, expect, it } from "vitest";
import {
	type ChatGetResult,
	callApi,
	elevateAccessToken,
	loginDevPassword,
	provisionInvitedMember,
	sendRpc,
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
		const member = await provisionInvitedMember({ role: "account-admin" });
		const frame = await callApi<WhoamiResult>(
			"auth.whoami",
			{},
			{ token: member.accessToken },
		);
		expect(frame.ok).toBe(true);
		expect(frame.result?.principal).toMatchObject({
			accountId: member.accountId,
			userId: member.userId,
			role: "account-admin",
		});
	});

	it("spoofed identity headers over /rpc never change the acting principal", async () => {
		const member = await provisionInvitedMember({ role: "account-admin" });
		const res = await workerFetch(`${WORKER_BASE_URL}/rpc`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${member.accessToken}`,
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
		// A foreign x-account-id is not a switch to that account.
		expect(res.status).toBe(401);
		expect(frame.ok).not.toBe(true);
		expect(JSON.stringify(frame)).not.toContain("mallory");
		const { "x-account-id": _account, ...withoutAccount } = SPOOF_HEADERS;
		void _account;
		const kept = await workerFetch(`${WORKER_BASE_URL}/rpc`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${member.accessToken}`,
				...withoutAccount,
			},
			body: JSON.stringify({ id: "w2", type: "auth.whoami" }),
		});
		const keptFrame = (await kept.json()) as {
			result?: WhoamiResult;
			ok: boolean;
		};
		expect(keptFrame.ok).toBe(true);
		expect(keptFrame.result?.principal).toMatchObject({
			accountId: member.accountId,
			userId: member.userId,
			role: "account-admin",
		});
	});

	it("a client-sent X-Cadmus-Principal or Caller-Role header never reaches the DO via /api", async () => {
		const member = await provisionInvitedMember({ role: "account-admin" });
		const headers: Record<string, string> = {
			Authorization: `Bearer ${member.accessToken}`,
			...SPOOF_HEADERS,
		};
		delete headers["x-user-id"];
		delete headers["x-account-id"];
		const res = await workerFetch(`${WORKER_BASE_URL}/api/auth/whoami`, {
			headers,
		});
		const body = (await res.json()) as { result?: WhoamiResult } & WhoamiResult;
		const principal = body.result?.principal ?? body.principal;
		expect(principal).toMatchObject({
			accountId: member.accountId,
			userId: member.userId,
		});
		expect(JSON.stringify(body)).not.toContain("mallory");
	});

	it("spoofed headers on a WebSocket upgrade never change the principal", async () => {
		const member = await provisionInvitedMember({ role: "account-admin" });
		const url = new URL(`${WORKER_BASE_URL}/ws`);
		const issued = await sendRpc<{ ticket: string }>(
			"auth.ticket",
			{ target: "ws" },
			{ token: member.accessToken },
		);
		url.searchParams.set("ticket", issued.frame.result?.ticket ?? "");
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
				accountId: member.accountId,
				userId: member.userId,
				role: "account-admin",
			});
		} finally {
			ws.close();
		}
	});

	it("records the authenticated author of a user message and returns it on re-read", async () => {
		const alice = await provisionInvitedMember({ role: "account-admin" });
		const boss = await loginDevPassword();
		await elevateAccessToken(boss.accessToken);
		const email = `bob-${crypto.randomUUID()}@example.com`;
		const invite = await sendRpc(
			"system.members.invite",
			{ accountId: alice.accountId, email, roles: ["user"] },
			{ token: boss.accessToken },
		);
		expect(invite.frame.ok).toBe(true);
		const bobLogin = await loginDevPassword(email);
		const bobWho = await sendRpc<{ principal: { userId?: string } }>(
			"auth.whoami",
			{},
			{ token: bobLogin.accessToken },
		);
		const bobId = bobWho.frame.result?.principal.userId;
		expect(bobId).toBeTruthy();
		const aliceOpts = { token: alice.accessToken };
		const bobOpts = { token: bobLogin.accessToken };
		await sendRpc(
			"bot.create",
			{ slug: "echo-bot", name: "Echo", model: "faux/echo" },
			aliceOpts,
		);

		const first = await sendRpc(
			"turn.submit",
			{ chatKey: "bot:echo-bot", text: "from alice" },
			aliceOpts,
		);
		expect(first.frame.ok).toBe(true);
		const second = await sendRpc(
			"turn.submit",
			{
				chatKey: "bot:echo-bot",
				text: "from bob",
				// A payload cannot name its own author.
				authorUserId: "alice",
			} as never,
			bobOpts,
		);
		expect(second.frame.ok).toBe(true);

		const reread = await sendRpc<ChatGetResult>(
			"chat.get",
			{ chatKey: "bot:echo-bot" },
			aliceOpts,
		);
		const users = (reread.frame.result?.messages ?? []).filter(
			(message) => message.role === "user",
		);
		expect(users.map((m) => [m.text, m.authorUserId])).toEqual([
			["from alice", alice.userId],
			["from bob", bobId],
		]);
	});

	it("rejects a raw shared secret and an account:user:secret bearer", async () => {
		const raw = `shared-${crypto.randomUUID()}`;
		const shaped = `acct-${crypto.randomUUID()}:user:${raw}`;
		for (const token of [raw, shaped]) {
			const denied = await sendRpc("auth.whoami", {}, { token });
			expect(denied.status).toBe(401);
			expect(denied.frame.ok).toBe(false);
		}
		const session = await loginDevPassword();
		const ok = await sendRpc("auth.whoami", {}, { token: session.accessToken });
		expect(ok.frame.ok).toBe(true);
	});
});
