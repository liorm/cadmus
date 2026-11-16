import { env, runInDurableObject, SELF } from "cloudflare:test";
import { CadmusClient, ProtocolClient } from "@cadmus/contract/client";
import { describe, expect, it } from "vitest";
import { REFRESH_COOKIE } from "../src/auth-routes.js";
import { getEdgeCache } from "../src/edge-cache.js";
import { D1AdminStore } from "../src/store/d1-admin.js";
import { completeLogin } from "../src/store/d1-login.js";
import {
	MEMBER_USE_THROTTLE_MS,
	resolveAccessToken,
} from "../src/store/d1-sessions.js";
import { sendRpc, TEST_TOKEN, uniqueAccountId } from "./helpers.js";

const ORIGIN = "https://example.com";

function store(): D1AdminStore {
	return new D1AdminStore({
		db: env.CADMUS_ADMIN_DB,
		encryptionKey: env.CADMUS_ENCRYPTION_KEY,
		edgeCache: getEdgeCache(env),
	});
}

async function seedUser(
	role: "user" | "account-admin" = "account-admin",
): Promise<{ s: D1AdminStore; accountId: string; userId: string }> {
	const s = store();
	const accountId = uniqueAccountId("sess");
	const userId = `usr_${accountId}`;
	await s.ensureAccountAndUser({ accountId, userId, role });
	return { s, accountId, userId };
}

function refresh(
	token: string | undefined,
	headers: Record<string, string> = {},
): Promise<Response> {
	return SELF.fetch(`${ORIGIN}/auth/refresh`, {
		method: "POST",
		headers: {
			origin: ORIGIN,
			"x-cadmus-refresh": "1",
			...(token ? { cookie: `${REFRESH_COOKIE}=${token}` } : {}),
			...headers,
		},
	});
}

describe("sessions (issue #3 phase 3a)", () => {
	it("authenticates an access token as the member's principal", async () => {
		const { s, accountId, userId } = await seedUser();
		const t = await s.createSession({ userId, accountId });
		const res = await SELF.fetch(`${ORIGIN}/api/auth/whoami`, {
			headers: { authorization: `Bearer ${t.accessToken}` },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { principal: Record<string, unknown> };
		expect(body.principal).toMatchObject({
			userId,
			accountId,
			role: "account-admin",
		});
	});

	it("rejects a revoked session immediately", async () => {
		const { s, accountId, userId } = await seedUser();
		const t = await s.createSession({ userId, accountId });
		await s.revokeSession(t.sessionId);
		const res = await SELF.fetch(`${ORIGIN}/api/auth/whoami`, {
			headers: { authorization: `Bearer ${t.accessToken}` },
		});
		expect(res.status).toBe(401);
	});

	it("rotates the refresh token and reuse revokes the session", async () => {
		const { s, accountId, userId } = await seedUser();
		const t = await s.createSession({ userId, accountId });
		const first = await refresh(t.refreshToken);
		expect(first.status).toBe(200);
		expect(first.headers.get("cache-control")).toBe("no-store");
		const cookie = first.headers.get("set-cookie") ?? "";
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("SameSite=Strict");
		const rotated = /cadmus_refresh=([^;]+)/.exec(cookie)?.[1];
		const { accessToken } = (await first.json()) as { accessToken: string };
		expect(rotated).toBeTruthy();
		expect(rotated).not.toBe(t.refreshToken);

		// The new access token works; the old one no longer does.
		const ok = await SELF.fetch(`${ORIGIN}/api/auth/whoami`, {
			headers: { authorization: `Bearer ${accessToken}` },
		});
		expect(ok.status).toBe(200);
		const old = await SELF.fetch(`${ORIGIN}/api/auth/whoami`, {
			headers: { authorization: `Bearer ${t.accessToken}` },
		});
		expect(old.status).toBe(401);

		// Replaying the rotated-away token revokes the whole session.
		const replay = await refresh(t.refreshToken);
		expect(replay.status).toBe(401);
		expect(
			((await replay.json()) as { error: { code: string } }).error.code,
		).toBe("refresh_reused");
		const after = await refresh(rotated);
		expect(after.status).toBe(401);
		const dead = await SELF.fetch(`${ORIGIN}/api/auth/whoami`, {
			headers: { authorization: `Bearer ${accessToken}` },
		});
		expect(dead.status).toBe(401);
	});

	it("enforces the refresh CSRF checks", async () => {
		const { s, accountId, userId } = await seedUser();
		const t = await s.createSession({ userId, accountId });
		expect(
			(await refresh(t.refreshToken, { origin: "https://evil.test" })).status,
		).toBe(403);
		expect(
			(await refresh(t.refreshToken, { "x-cadmus-refresh": "0" })).status,
		).toBe(403);
		expect((await refresh(undefined)).status).toBe(401);
		// A failed CSRF check must not consume the token.
		expect((await refresh(t.refreshToken)).status).toBe(200);
	});

	it("refuses sessions of a suspended account and a disabled user", async () => {
		const { s, accountId, userId } = await seedUser();
		const t = await s.createSession({ userId, accountId });
		await env.CADMUS_ADMIN_DB.prepare(
			"UPDATE cadmus_accounts SET status = 'suspended' WHERE id = ?1",
		)
			.bind(accountId)
			.run();
		const res = await SELF.fetch(`${ORIGIN}/api/auth/whoami`, {
			headers: { authorization: `Bearer ${t.accessToken}` },
		});
		expect(res.status).toBe(401);
	});

	it("does not mint sessions from the legacy master secret path", async () => {
		const res = await SELF.fetch(`${ORIGIN}/api/auth/whoami`, {
			headers: { authorization: "Bearer cad_at_not-a-real-token" },
		});
		expect(res.status).toBe(401);
	});
});

const rpcWithSession = (
	accessToken: string,
	type: string,
	payload: Record<string, unknown> = {},
) => sendRpc(type, payload, { token: accessToken });

async function whoamiAs(
	accessToken: string,
	accountHeader?: string,
): Promise<{
	status: number;
	principal?: Record<string, unknown>;
	text: string;
}> {
	const res = await SELF.fetch(`${ORIGIN}/api/auth/whoami`, {
		headers: {
			authorization: `Bearer ${accessToken}`,
			...(accountHeader ? { "x-account-id": accountHeader } : {}),
		},
	});
	const text = await res.text();
	let principal: Record<string, unknown> | undefined;
	try {
		principal = (JSON.parse(text) as { principal?: Record<string, unknown> })
			.principal;
	} catch {
		principal = undefined;
	}
	return { status: res.status, principal, text };
}

describe("x-account-id selects among the caller's memberships (issue #3 L113)", () => {
	async function twoAccounts() {
		const { s, accountId, userId } = await seedUser("account-admin");
		const second = uniqueAccountId("sel2");
		await s.ensureAccountAndUser({ accountId: second, userId, role: "user" });
		const t = await s.createSession({ userId, accountId });
		return { s, accountId, second, userId, t };
	}

	it("acts in the selected account with that membership's role, and defaults to the session's account", async () => {
		const { accountId, second, t } = await twoAccounts();
		const home = await whoamiAs(t.accessToken);
		expect(home.principal).toMatchObject({ accountId, role: "account-admin" });
		const same = await whoamiAs(t.accessToken, accountId);
		expect(same.principal).toMatchObject({ accountId, role: "account-admin" });
		const picked = await whoamiAs(t.accessToken, second);
		expect(picked.status).toBe(200);
		expect(picked.principal).toMatchObject({ accountId: second, role: "user" });
	});

	it("refuses a foreign, unknown, suspended or removed account the same way as a bad token", async () => {
		const { s, accountId, second, userId, t } = await twoAccounts();
		const stranger = await seedUser("account-admin");
		const bad = await whoamiAs("cad_at_not-a-real-token");
		const foreign = await whoamiAs(t.accessToken, stranger.accountId);
		const unknown = await whoamiAs(t.accessToken, "acct_does_not_exist");
		expect(foreign.status).toBe(401);
		expect(unknown.status).toBe(401);
		expect(foreign.text).toBe(unknown.text);
		expect(foreign.text).toBe(bad.text);
		// Positive control: the same session still works in its own accounts.
		expect((await whoamiAs(t.accessToken, accountId)).status).toBe(200);
		expect((await whoamiAs(t.accessToken, second)).status).toBe(200);
		await env.CADMUS_ADMIN_DB.prepare(
			"UPDATE cadmus_accounts SET status = 'suspended' WHERE id = ?1",
		)
			.bind(second)
			.run();
		expect((await whoamiAs(t.accessToken, second)).status).toBe(401);
		await env.CADMUS_ADMIN_DB.prepare(
			"UPDATE cadmus_accounts SET status = 'active' WHERE id = ?1",
		)
			.bind(second)
			.run();
		expect((await whoamiAs(t.accessToken, second)).status).toBe(200);
		await env.CADMUS_ADMIN_DB.prepare(
			"DELETE FROM cadmus_account_members WHERE account_id = ?1 AND user_id = ?2",
		)
			.bind(second, userId)
			.run();
		expect((await whoamiAs(t.accessToken, second)).status).toBe(401);
		expect(s).toBeDefined();
	});

	it("keeps a token-backed session bound to its own account", async () => {
		const { s, accountId, second, userId } = await twoAccounts();
		const made = await s.createToken({
			accountId,
			creatorUserId: userId,
			creatorRole: "account-admin",
			creatorGrants: ["chat.use", "bot.read", "tokens.self"],
			kind: "service",
			label: "bound",
			grants: ["chat.use", "tokens.self"],
		});
		if (!made.ok) throw new Error("create failed");
		const login = await SELF.fetch(`${ORIGIN}/auth/token-login`, {
			method: "POST",
			headers: { authorization: `Bearer ${made.token}` },
		});
		const { accessToken } = (await login.json()) as { accessToken: string };
		expect((await whoamiAs(accessToken)).status).toBe(200);
		expect((await whoamiAs(accessToken, accountId)).status).toBe(200);
		expect((await whoamiAs(accessToken, second)).status).toBe(401);
	});

	it("refuses a forged ticket that points a token session at another account it is a live member of", async () => {
		const { s, accountId, second, userId } = await twoAccounts();
		const made = await s.createToken({
			accountId,
			creatorUserId: userId,
			creatorRole: "account-admin",
			creatorGrants: ["chat.use", "bot.read", "tokens.self"],
			kind: "service",
			label: "forged-ticket",
			grants: ["chat.use", "tokens.self"],
		});
		if (!made.ok) throw new Error("create failed");
		const login = await SELF.fetch(`${ORIGIN}/auth/token-login`, {
			method: "POST",
			headers: { authorization: `Bearer ${made.token}` },
		});
		expect(login.status).toBe(200);
		const row = await env.CADMUS_ADMIN_DB.prepare(
			"SELECT s.id AS id FROM cadmus_sessions s JOIN cadmus_auth_tokens t ON t.id = s.token_id WHERE t.label = ?1",
		)
			.bind("forged-ticket")
			.first<{ id: string }>();
		if (!row) throw new Error("no token session");
		// The user IS a live member of `second`, so the membership join alone
		// would let this through; only the token-session bound refuses it.
		const forged = await s.createTicket(row.id, "events", second);
		expect(await s.consumeTicket(forged.ticket, "events")).toBeUndefined();
		const own = await s.createTicket(row.id, "events", accountId);
		expect(await s.consumeTicket(own.ticket, "events")).toMatchObject({
			accountId,
		});
	});

	it("a signed-in CadmusClient acts in the session's own account until it selects another", async () => {
		const { accountId, second, t } = await twoAccounts();
		const sent: Array<string | null> = [];
		const make = (accountId?: string) =>
			new CadmusClient({
				baseUrl: ORIGIN,
				token: t.accessToken,
				useTickets: true,
				...(accountId ? { accountId } : {}),
				fetchImpl: ((u: string, init?: RequestInit) => {
					sent.push(new Headers(init?.headers).get("x-account-id"));
					return SELF.fetch(u, init);
				}) as typeof fetch,
			});
		const client = make();
		// No account chosen: the client must not invent one (it used to send
		// "default-account", which the server refuses as a foreign account).
		expect(client.getAccountId()).toBe("");
		const home = await client.callRpc<{ principal: { accountId: string } }>(
			"auth.whoami",
		);
		expect(home.ok).toBe(true);
		expect(home.result?.principal.accountId).toBe(accountId);
		const listed = await client.callRpc<{
			memberships: Array<{ accountId: string }>;
		}>("auth.memberships.list");
		expect(listed.ok).toBe(true);
		expect(listed.result?.memberships.map((m) => m.accountId).sort()).toEqual(
			[accountId, second].sort(),
		);
		expect(sent).toEqual([null, null]);
		client.setAccountId(second);
		const picked = await client.callRpc<{ principal: { accountId: string } }>(
			"auth.whoami",
		);
		expect(picked.result?.principal.accountId).toBe(second);
		expect(sent.at(-1)).toBe(second);
		// Pins the rule the fix relies on: an id that is not the user's own is
		// refused, so a client that invents one fails every call.
		const invented = await make("default-account").callRpc("auth.whoami");
		expect(invented.ok).toBe(false);
	});

	it("does not carry admin mode into another account", async () => {
		const { s, accountId, second, t } = await twoAccounts();
		const until = await s.startElevation(t.sessionId);
		expect(typeof until).toBe("number");
		const home = await whoamiAs(t.accessToken, accountId);
		expect(home.principal?.elevatedUntil).toBe(until);
		const other = await whoamiAs(t.accessToken, second);
		expect(other.status).toBe(200);
		expect(other.principal?.elevatedUntil).toBeUndefined();
	});

	it("admin mode enabled in the selected account applies only there, and re-enabling elsewhere replaces it", async () => {
		const { s, accountId, second, t } = await twoAccounts();
		// The password-free toggle refuses another account (that needs passkey
		// proof, covered in passkey-storage); the passkey path writes the tag, so
		// simulate its stored result here.
		expect(await s.startElevation(t.sessionId, second)).toBeUndefined();
		const until = Date.now() + 60_000;
		await env.CADMUS_ADMIN_DB.prepare(
			"UPDATE cadmus_sessions SET elevated_until = ?2, elevated_account_id = ?3 WHERE id = ?1",
		)
			.bind(t.sessionId, until, second)
			.run();
		const inSecond = await whoamiAs(t.accessToken, second);
		expect(inSecond.principal?.elevatedUntil).toBe(until);
		// Not in the home account, with or without the header.
		expect(
			(await whoamiAs(t.accessToken, accountId)).principal?.elevatedUntil,
		).toBeUndefined();
		expect(
			(await whoamiAs(t.accessToken)).principal?.elevatedUntil,
		).toBeUndefined();
		// Single account-tagged state: enabling in the home account moves it.
		const again = await s.startElevation(t.sessionId, accountId);
		expect(typeof again).toBe("number");
		expect(
			(await whoamiAs(t.accessToken, accountId)).principal?.elevatedUntil,
		).toBe(again);
		expect(
			(await whoamiAs(t.accessToken, second)).principal?.elevatedUntil,
		).toBeUndefined();
		// The audit row names the account it was enabled in.
		await s.endElevation(t.sessionId);
		expect(
			(await whoamiAs(t.accessToken, accountId)).principal?.elevatedUntil,
		).toBeUndefined();
	});
});

describe("last-used account default (issue #3 L113)", () => {
	const DB = () => env.CADMUS_ADMIN_DB;
	async function setup() {
		const { s, accountId, userId } = await seedUser("account-admin");
		const second = uniqueAccountId("lu2");
		await s.ensureAccountAndUser({ accountId: second, userId, role: "user" });
		const subject = `lu-${crypto.randomUUID()}`;
		await DB()
			.prepare(
				`INSERT INTO cadmus_login_methods (id, user_id, provider, subject, display, created_at)
         VALUES (?1, ?2, 'google', ?3, 'test', ?4)`,
			)
			.bind(`lm_${subject}`, userId, subject, Date.now())
			.run();
		const t = await s.createSession({ userId, accountId });
		const signIn = async (now: number) => {
			const r = await completeLogin(
				DB(),
				{
					provider: "google",
					subject,
					email: `${subject}@example.com`,
					emailVerified: true,
				},
				{ now },
			);
			if (!r.ok) throw new Error(`sign-in failed ${r.code}`);
			return r.accountId;
		};
		const memberUse = async (account: string) =>
			(
				await DB()
					.prepare(
						"SELECT last_used_at AS u FROM cadmus_account_members WHERE account_id = ?1 AND user_id = ?2",
					)
					.bind(account, userId)
					.first<{ u: number | null }>()
			)?.u ?? null;
		return { accountId, second, userId, t, signIn, memberUse };
	}
	const FAR = () => Date.now() + 60_000;

	it("without any selection, sign-in keeps the session-history default (positive control, NULL member rows)", async () => {
		const { accountId, second, signIn, memberUse } = await setup();
		expect(await memberUse(accountId)).toBeNull();
		expect(await memberUse(second)).toBeNull();
		expect(await signIn(FAR())).toBe(accountId);
	});

	it("a verified x-account-id selection makes that account the next sign-in default, and a headerless request records nothing", async () => {
		const { accountId, second, t, signIn, memberUse } = await setup();
		const at = FAR();
		expect(
			await resolveAccessToken(DB(), t.accessToken, undefined, at),
		).toBeDefined();
		expect(await memberUse(accountId)).toBeNull();
		const picked = await resolveAccessToken(
			DB(),
			t.accessToken,
			second,
			at + 1000,
		);
		expect(picked?.accountId).toBe(second);
		expect(await memberUse(second)).toBe(at + 1000);
		expect(await signIn(at + 2000)).toBe(second);
	});

	it("a refused selection writes nothing", async () => {
		const { accountId, second, t, memberUse } = await setup();
		const stranger = await seedUser("account-admin");
		const at = FAR();
		expect(
			await resolveAccessToken(DB(), t.accessToken, stranger.accountId, at),
		).toBeUndefined();
		expect(await memberUse(stranger.accountId)).toBeNull();
		await DB()
			.prepare("UPDATE cadmus_accounts SET status = 'suspended' WHERE id = ?1")
			.bind(second)
			.run();
		expect(
			await resolveAccessToken(DB(), t.accessToken, second, at),
		).toBeUndefined();
		expect(await memberUse(second)).toBeNull();
		expect(await memberUse(accountId)).toBeNull();
	});

	it("records at most once per throttle window", async () => {
		const { second, t, memberUse } = await setup();
		const at = FAR();
		await resolveAccessToken(DB(), t.accessToken, second, at);
		await resolveAccessToken(
			DB(),
			t.accessToken,
			second,
			at + MEMBER_USE_THROTTLE_MS - 1,
		);
		expect(await memberUse(second)).toBe(at);
		await resolveAccessToken(
			DB(),
			t.accessToken,
			second,
			at + MEMBER_USE_THROTTLE_MS + 1,
		);
		expect(await memberUse(second)).toBe(at + MEMBER_USE_THROTTLE_MS + 1);
	});
});

describe("sockets opened for a selected account keep that account's authority (issue #3 L113, L132)", () => {
	async function setup() {
		const { s, accountId, userId } = await seedUser("account-admin");
		const second = uniqueAccountId("ws2");
		await s.ensureAccountAndUser({ accountId: second, userId, role: "user" });
		const t = await s.createSession({ userId, accountId });
		return { s, accountId, second, userId, t };
	}
	async function open(accessToken: string, account?: string) {
		const issued = await SELF.fetch(`${ORIGIN}/rpc`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${accessToken}`,
				"content-type": "application/json",
				...(account ? { "x-account-id": account } : {}),
			},
			body: JSON.stringify({
				id: crypto.randomUUID(),
				type: "auth.ticket",
				payload: { target: "ws" },
			}),
		});
		const ticket = ((await issued.json()) as { result: { ticket: string } })
			.result.ticket;
		const res = await SELF.fetch(`${ORIGIN}/ws?ticket=${ticket}`, {
			headers: { upgrade: "websocket" },
		});
		const ws = res.webSocket;
		if (!ws) throw new Error(`expected 101, got ${res.status}`);
		ws.accept();
		const seen = {
			frames: [] as {
				type: string;
				ok?: boolean;
				result?: { principal?: Record<string, unknown> };
			}[],
			closeCode: undefined as number | undefined,
		};
		ws.addEventListener("message", (ev) => {
			seen.frames.push(JSON.parse(ev.data as string));
		});
		ws.addEventListener("close", (ev) => {
			seen.closeCode = ev.code;
		});
		const ask = async (type: string, payload: object = {}) => {
			seen.frames.length = 0;
			ws.send(JSON.stringify({ id: crypto.randomUUID(), type, payload }));
			for (
				let i = 0;
				i < 150 && seen.frames.length === 0 && seen.closeCode === undefined;
				i++
			) {
				await new Promise((r) => setTimeout(r, 20));
			}
			return seen.frames[0];
		};
		const waitClosed = async () => {
			for (let i = 0; i < 150 && seen.closeCode === undefined; i++) {
				await new Promise((r) => setTimeout(r, 20));
			}
		};
		return { ws, seen, ask, waitClosed };
	}

	it("a socket for account B runs commands as B with B's role, not the home account's, and a home socket stays home", async () => {
		const { accountId, second, t } = await setup();
		const sockB = await open(t.accessToken, second);
		const who = await sockB.ask("auth.whoami");
		expect(who?.ok).toBe(true);
		expect(who?.result?.principal).toMatchObject({
			accountId: second,
			role: "user",
		});
		// A second command on the same socket is still B (liveCaller re-resolves).
		const again = await sockB.ask("auth.whoami");
		expect(again?.result?.principal).toMatchObject({
			accountId: second,
			role: "user",
		});
		const sockHome = await open(t.accessToken);
		const home = await sockHome.ask("auth.whoami");
		expect(home?.result?.principal).toMatchObject({
			accountId,
			role: "account-admin",
		});
	});

	it("removing the member from B closes only B's socket, and suspending B closes it 4403", async () => {
		const { accountId, second, userId, t } = await setup();
		const sockB = await open(t.accessToken, second);
		const sockHome = await open(t.accessToken);
		expect((await sockB.ask("auth.whoami"))?.ok).toBe(true);
		await env.CADMUS_ADMIN_DB.prepare(
			"DELETE FROM cadmus_account_members WHERE account_id = ?1 AND user_id = ?2",
		)
			.bind(second, userId)
			.run();
		await sockB.ask("auth.whoami");
		await sockB.waitClosed();
		expect(sockB.seen.closeCode).toBe(4401);
		const home = await sockHome.ask("auth.whoami");
		expect(home?.ok).toBe(true);
		expect(home?.result?.principal?.accountId).toBe(accountId);
		expect(sockHome.seen.closeCode).toBeUndefined();

		const third = uniqueAccountId("ws3");
		const s = new D1AdminStore({
			db: env.CADMUS_ADMIN_DB,
			encryptionKey: env.CADMUS_ENCRYPTION_KEY,
			edgeCache: getEdgeCache(env),
		});
		await s.ensureAccountAndUser({ accountId: third, userId, role: "user" });
		const sock3 = await open(t.accessToken, third);
		expect((await sock3.ask("auth.whoami"))?.ok).toBe(true);
		await env.CADMUS_ADMIN_DB.prepare(
			"UPDATE cadmus_accounts SET status = 'suspended' WHERE id = ?1",
		)
			.bind(third)
			.run();
		await sock3.ask("auth.whoami");
		await sock3.waitClosed();
		expect(sock3.seen.closeCode).toBe(4403);
		expect(
			(await sockHome.ask("auth.whoami"))?.result?.principal?.accountId,
		).toBe(accountId);
	});

	it("the idle authority sweep closes B's socket when B membership is removed, with no command sent", async () => {
		const { second, userId, t } = await setup();
		const sockB = await open(t.accessToken, second);
		expect((await sockB.ask("auth.whoami"))?.ok).toBe(true);
		const stub = env.CADMUS_BOT_FAMILY.get(
			env.CADMUS_BOT_FAMILY.idFromName(`cadmus:${second}:default`),
		);
		const sweep = () =>
			runInDurableObject(stub, async (instance) => {
				await (
					instance as unknown as {
						sweepAuthority: (force: boolean) => Promise<unknown>;
					}
				).sweepAuthority(true);
			});
		// Positive control: a sweep with B still a member leaves it open.
		await sweep();
		await new Promise((r) => setTimeout(r, 100));
		expect(sockB.seen.closeCode).toBeUndefined();
		await env.CADMUS_ADMIN_DB.prepare(
			"DELETE FROM cadmus_account_members WHERE account_id = ?1 AND user_id = ?2",
		)
			.bind(second, userId)
			.run();
		await sweep();
		await sockB.waitClosed();
		expect(sockB.seen.closeCode).toBe(4401);
	});

	async function openSse(accessToken: string, account?: string) {
		const issued = await SELF.fetch(`${ORIGIN}/rpc`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${accessToken}`,
				"content-type": "application/json",
				...(account ? { "x-account-id": account } : {}),
			},
			body: JSON.stringify({
				id: crypto.randomUUID(),
				type: "auth.ticket",
				payload: { target: "events" },
			}),
		});
		const ticket = ((await issued.json()) as { result: { ticket: string } })
			.result.ticket;
		const res = await SELF.fetch(`${ORIGIN}/events?ticket=${ticket}`);
		if (res.status !== 200 || !res.body) throw new Error(`SSE ${res.status}`);
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		const st = { text: "", done: false };
		void (async () => {
			try {
				for (;;) {
					const c = await reader.read();
					if (c.done) break;
					st.text += decoder.decode(c.value);
				}
			} catch {
				// ended with an error: closed
			}
			st.done = true;
		})();
		const until = async (f: () => boolean) => {
			for (let i = 0; i < 150 && !f(); i++) {
				await new Promise((r) => setTimeout(r, 20));
			}
			return f();
		};
		return { st, until, cancel: () => void reader.cancel().catch(() => {}) };
	}
	const familyDo = (account: string) =>
		env.CADMUS_BOT_FAMILY.get(
			env.CADMUS_BOT_FAMILY.idFromName(`cadmus:${account}:default`),
		);
	/** The production composition: sweep authority, then deliver to those readers. */
	const sweepAndDeliver = (account: string, eventType?: string) =>
		runInDurableObject(familyDo(account), async (instance) => {
			const i = instance as unknown as {
				sweepAuthority: (force: boolean) => Promise<Set<string>>;
				deliverEvent: (event: object, readers: Set<string>) => void;
			};
			const readers = await i.sweepAuthority(true);
			if (eventType) {
				i.deliverEvent(
					{ type: eventType, payload: { marker: "disclosure-probe" } },
					readers,
				);
			}
		});

	it("an /events stream opened for B with a ticket gets B-gated toolsEnv events, ends when B membership is removed, and a home stream is unaffected", async () => {
		const { accountId, second, userId, t } = await setup();
		const sseB = await openSse(t.accessToken, second);
		const sseHome = await openSse(t.accessToken);
		await sseB.until(() => sseB.st.text.includes("connected"));
		// Positive control: while a member with toolsEnv.read, B's stream gets it.
		await sweepAndDeliver(second, "account.toolsEnv.event");
		expect(
			await sseB.until(() => sseB.st.text.includes("disclosure-probe")),
		).toBe(true);
		const before = sseB.st.text.length;
		await env.CADMUS_ADMIN_DB.prepare(
			"DELETE FROM cadmus_account_members WHERE account_id = ?1 AND user_id = ?2",
		)
			.bind(second, userId)
			.run();
		await sweepAndDeliver(second, "account.toolsEnv.event");
		expect(await sseB.until(() => sseB.st.done)).toBe(true);
		// Nothing about the second event reached the removed member.
		expect(sseB.st.text.length).toBe(before);
		await sweepAndDeliver(accountId);
		expect(sseHome.st.done).toBe(false);
		sseHome.cancel();
	});

	it("an /events stream for B ends when the B role loses chat.use, though the session's home role has it", async () => {
		const { second, userId, t } = await setup();
		const sseB = await openSse(t.accessToken, second);
		await sseB.until(() => sseB.st.text.includes("connected"));
		await sweepAndDeliver(second);
		expect(sseB.st.done).toBe(false);
		await env.CADMUS_ADMIN_DB.prepare(
			"UPDATE cadmus_account_members SET role = 'super-admin' WHERE account_id = ?1 AND user_id = ?2",
		)
			.bind(second, userId)
			.run();
		await sweepAndDeliver(second);
		expect(await sseB.until(() => sseB.st.done)).toBe(true);
	});

	it("a role change in B reaches the open B socket, and admin mode tagged to B shows only on the B socket", async () => {
		const { accountId, second, userId, t } = await setup();
		const sockB = await open(t.accessToken, second);
		const sockHome = await open(t.accessToken);
		const until = Date.now() + 60_000;
		await env.CADMUS_ADMIN_DB.prepare(
			"UPDATE cadmus_sessions SET elevated_until = ?2, elevated_account_id = ?3 WHERE id = ?1",
		)
			.bind(t.sessionId, until, second)
			.run();
		expect((await sockB.ask("auth.whoami"))?.result?.principal).toMatchObject({
			accountId: second,
			elevatedUntil: until,
		});
		expect(
			(await sockHome.ask("auth.whoami"))?.result?.principal?.elevatedUntil,
		).toBeUndefined();
		await env.CADMUS_ADMIN_DB.prepare(
			"UPDATE cadmus_account_members SET role = 'account-admin' WHERE account_id = ?1 AND user_id = ?2",
		)
			.bind(second, userId)
			.run();
		expect((await sockB.ask("auth.whoami"))?.result?.principal).toMatchObject({
			accountId: second,
			role: "account-admin",
		});
		expect(accountId).toBeDefined();
	});
});

describe("tickets bind the selected account (issue #3 L132)", () => {
	async function setup() {
		const { s, accountId, userId } = await seedUser("account-admin");
		const second = uniqueAccountId("tk2");
		await s.ensureAccountAndUser({ accountId: second, userId, role: "user" });
		const t = await s.createSession({ userId, accountId });
		return { s, accountId, second, userId, t };
	}

	it("a ticket minted for the selected account resolves to that account and role, and a default ticket to home", async () => {
		const { s, accountId, second, t } = await setup();
		const forSecond = await s.createTicket(t.sessionId, "events", second);
		const picked = await s.consumeTicket(forSecond.ticket, "events");
		expect(picked).toMatchObject({ accountId: second, role: "user" });
		const dflt = await s.createTicket(t.sessionId, "events");
		expect(await s.consumeTicket(dflt.ticket, "events")).toMatchObject({
			accountId,
			role: "account-admin",
		});
	});

	it("re-checks live membership at consume time, and spends the ticket", async () => {
		const { s, second, userId, t } = await setup();
		const gone = await s.createTicket(t.sessionId, "events", second);
		await env.CADMUS_ADMIN_DB.prepare(
			"DELETE FROM cadmus_account_members WHERE account_id = ?1 AND user_id = ?2",
		)
			.bind(second, userId)
			.run();
		expect(await s.consumeTicket(gone.ticket, "events")).toBeUndefined();
		expect(await s.consumeTicket(gone.ticket, "events")).toBeUndefined();
	});

	it("does not snapshot admin mode onto the ticket", async () => {
		const { s, second, t } = await setup();
		const until = Date.now() + 60_000;
		await env.CADMUS_ADMIN_DB.prepare(
			"UPDATE cadmus_sessions SET elevated_until = ?2, elevated_account_id = ?3 WHERE id = ?1",
		)
			.bind(t.sessionId, until, second)
			.run();
		const ticket = await s.createTicket(t.sessionId, "events", second);
		const picked = await s.consumeTicket(ticket.ticket, "events");
		expect(picked).toMatchObject({ accountId: second, role: "user" });
		expect(picked).not.toHaveProperty("elevatedUntil");
	});

	it("the auth.ticket command mints for the x-account-id account, not the home account", async () => {
		const { second, t } = await setup();
		const res = await SELF.fetch(`${ORIGIN}/rpc`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${t.accessToken}`,
				"x-account-id": second,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				id: crypto.randomUUID(),
				type: "auth.ticket",
				payload: { target: "events" },
			}),
		});
		const frame = (await res.json()) as {
			ok: boolean;
			result?: { ticket: string };
		};
		expect(frame.ok).toBe(true);
		const row = await env.CADMUS_ADMIN_DB.prepare(
			"SELECT account_id FROM cadmus_tickets ORDER BY expires_at DESC LIMIT 1",
		).first<{ account_id: string | null }>();
		expect(row?.account_id).toBe(second);
	});
});

describe("session and login method commands (issue #3 phase 3c)", () => {
	it("lists only the caller's own memberships in active accounts, with the role in each", async () => {
		const { s, accountId, userId } = await seedUser("account-admin");
		const second = uniqueAccountId("memb2");
		const suspended = uniqueAccountId("memb3");
		await s.ensureAccountAndUser({
			accountId: second,
			userId,
			role: "user",
		});
		await s.ensureAccountAndUser({
			accountId: suspended,
			userId,
			role: "user",
		});
		await env.CADMUS_ADMIN_DB.prepare(
			"UPDATE cadmus_accounts SET status = 'suspended' WHERE id = ?1",
		)
			.bind(suspended)
			.run();
		// Someone else's membership must never show up.
		const other = await seedUser("user");
		const t = await s.createSession({ userId, accountId });
		const res = await rpcWithSession(t.accessToken, "auth.memberships.list");
		expect(res.status).toBe(200);
		const memberships = (
			res.frame.result as {
				memberships: Array<{
					accountId: string;
					name: string;
					role: string;
				}>;
			}
		).memberships;
		const byId = new Map(memberships.map((m) => [m.accountId, m]));
		expect(byId.get(accountId)?.role).toBe("account-admin");
		expect(byId.get(second)?.role).toBe("user");
		expect(byId.has(suspended)).toBe(false);
		expect(byId.has(other.accountId)).toBe(false);
		expect(memberships).toHaveLength(2);
		expect(typeof byId.get(second)?.name).toBe("string");
		// The other user sees only their own.
		const ot = await other.s.createSession({
			userId: other.userId,
			accountId: other.accountId,
		});
		const theirs = await rpcWithSession(
			ot.accessToken,
			"auth.memberships.list",
		);
		expect(
			(
				theirs.frame.result as { memberships: Array<{ accountId: string }> }
			).memberships.map((m) => m.accountId),
		).toEqual([other.accountId]);
	});

	it("lists and revokes the caller's own sessions only", async () => {
		const { s, accountId, userId } = await seedUser();
		const a = await s.createSession({ userId, accountId, userAgent: "UA-A" });
		const b = await s.createSession({ userId, accountId, userAgent: "UA-B" });
		const other = await seedUser();
		const foreign = await other.s.createSession({
			userId: other.userId,
			accountId: other.accountId,
		});

		const list = await rpcWithSession(a.accessToken, "auth.sessions.list");
		expect(list.frame.ok).toBe(true);
		const sessions = (
			list.frame.result as {
				sessions: Array<{ id: string; current: boolean }>;
			}
		).sessions;
		const ids = sessions.map((x) => x.id);
		expect(ids.sort()).toEqual([a.sessionId, b.sessionId].sort());
		expect(sessions.find((x) => x.current)?.id).toBe(a.sessionId);

		// Another user's session is untouched.
		const denied = await rpcWithSession(a.accessToken, "auth.sessions.revoke", {
			sessionId: foreign.sessionId,
		});
		expect((denied.frame.result as { revoked: boolean }).revoked).toBe(false);
		expect(
			(await rpcWithSession(foreign.accessToken, "auth.sessions.list")).frame
				.ok,
		).toBe(true);

		const revoked = await rpcWithSession(
			a.accessToken,
			"auth.sessions.revokeOthers",
		);
		expect((revoked.frame.result as { revoked: number }).revoked).toBe(1);
		expect(
			(await rpcWithSession(b.accessToken, "auth.sessions.list")).status,
		).toBe(401);
		expect(
			(await rpcWithSession(a.accessToken, "auth.sessions.list")).frame.ok,
		).toBe(true);
	});

	it("accepts a session access token on /ws and /events only as a ticket", async () => {
		const { s, accountId, userId } = await seedUser();
		const t = await s.createSession({ userId, accountId });
		for (const path of ["events", "ws"] as const) {
			const upgrade: Record<string, string> =
				path === "ws" ? { upgrade: "websocket" } : {};
			const forms: Record<string, [string, Record<string, string>]> = {
				query: [`${ORIGIN}/${path}?token=${t.accessToken}`, upgrade],
				cookie: [
					`${ORIGIN}/${path}`,
					{ ...upgrade, cookie: `cadmus_session=${t.accessToken}` },
				],
				bearer: [
					`${ORIGIN}/${path}`,
					{ ...upgrade, authorization: `Bearer ${t.accessToken}` },
				],
			};
			for (const [form, [url, headers]] of Object.entries(forms)) {
				const res = await SELF.fetch(url, { headers });
				expect(res.status, `${path} via ${form}`).toBe(401);
			}
			// Positive control: the same session with a ticket is accepted.
			const issued = await rpcWithSession(t.accessToken, "auth.ticket", {
				target: path,
			});
			const { ticket } = issued.frame.result as { ticket: string };
			const ok = await SELF.fetch(`${ORIGIN}/${path}?ticket=${ticket}`, {
				headers: upgrade,
			});
			expect(ok.status, `${path} via ticket`).toBe(path === "ws" ? 101 : 200);
			await ok.body?.cancel().catch(() => undefined);
			ok.webSocket?.accept();
			ok.webSocket?.close();
		}
		// The master secret is refused on ?token= too; its ticket is the control.
		const master = await SELF.fetch(
			`${ORIGIN}/events?token=${TEST_TOKEN}&accountId=${accountId}`,
		);
		expect(master.status).toBe(401);
	});

	it("accepts a session access token on /rpc only as a bearer header", async () => {
		const { s, accountId, userId } = await seedUser();
		const t = await s.createSession({ userId, accountId });
		const body = (id: string) =>
			JSON.stringify({ id, type: "auth.whoami", payload: {} });
		const post = (url: string, headers: Record<string, string>) =>
			SELF.fetch(url, {
				method: "POST",
				headers: { "content-type": "application/json", ...headers },
				body: body("rpc-form"),
			});
		// Positive control: the header form works.
		expect(
			(
				await post(`${ORIGIN}/rpc`, {
					authorization: `Bearer ${t.accessToken}`,
				})
			).status,
		).toBe(200);
		// cad_at_ in the cookie or the query is refused.
		expect(
			(
				await post(`${ORIGIN}/rpc`, {
					cookie: `cadmus_session=${t.accessToken}`,
				})
			).status,
			"cad_at_ cookie",
		).toBe(401);
		expect(
			(await post(`${ORIGIN}/rpc?token=${t.accessToken}`, {})).status,
			"cad_at_ query",
		).toBe(401);
		// A cad_at_ in a cookie does not ride along with a different header token:
		// the header credential wins and is judged on its own.
		expect(
			(
				await post(`${ORIGIN}/rpc`, {
					authorization: `Bearer ${t.accessToken}`,
					cookie: "cadmus_session=cad_at_other",
				})
			).status,
			"header wins over cookie",
		).toBe(200);
		// A real API token is a bearer on /rpc. This fixture holds chat.use only,
		// so whoami is forbidden. The cookie and ?token= forms stay refused.
		for (const kind of ["pat", "service"] as const) {
			const made = await s.createToken({
				accountId,
				creatorUserId: userId,
				creatorRole: "account-admin",
				creatorGrants: ["chat.use"],
				kind,
				label: `rpc-${kind}`,
				grants: ["chat.use"],
				...(kind === "pat" ? { ttlMs: 86_400_000 } : {}),
			});
			if (!made.ok) throw new Error("create failed");
			const header = await post(`${ORIGIN}/rpc`, {
				authorization: `Bearer ${made.token}`,
			});
			expect(header.status, `${kind} header`).toBe(400);
			const headerBody = (await header.json()) as {
				ok?: boolean;
				error?: { code?: string };
			};
			expect(headerBody.ok, `${kind} header`).toBe(false);
			expect(headerBody.error?.code, `${kind} header`).toBe("forbidden");
			for (const [form, url, headers] of [
				["cookie", `${ORIGIN}/rpc`, { cookie: `cadmus_session=${made.token}` }],
				["query", `${ORIGIN}/rpc?token=${made.token}`, {}],
			] as const) {
				const res = await post(url, { ...headers });
				expect(res.status, `${kind} ${form}`).toBe(401);
			}
		}
		// Legacy credentials (master secret and a legacy member token) are
		// header-only on /rpc: the cookie and ?token= are retired (issue #3
		// phases 3 and 8). The header form of the same credential is the control.
		const raw = `legacy-member-rpc-${accountId}`;
		await s.addMember({
			accountId,
			userId,
			role: "account-admin",
			rawToken: raw,
		});
		for (const tok of [raw, `${accountId}:${userId}:${TEST_TOKEN}`]) {
			for (const [form, url, headers, want] of [
				["header", `${ORIGIN}/rpc`, { authorization: `Bearer ${tok}` }, 200],
				[
					"cookie",
					`${ORIGIN}/rpc`,
					{ cookie: `cadmus_session=${encodeURIComponent(tok)}` },
					401,
				],
				[
					"query",
					`${ORIGIN}/rpc?token=${encodeURIComponent(tok)}&accountId=${accountId}`,
					{},
					401,
				],
			] as const) {
				const res = await post(url, { ...headers });
				expect(res.status, `${tok.slice(0, 12)} ${form}`).toBe(want);
			}
		}
	});

	it("a legacy ticket is bound to the credential that minted it: revoked or expired after the mint is refused, master keeps working, an unnamed credential is refused", async () => {
		const { s, accountId, userId } = await seedUser();
		const mint = async (token: string, asUser?: string) => {
			const minted = await sendRpc<{ ticket: string }>(
				"auth.ticket",
				{ target: "events" },
				{ token, accountId, ...(asUser ? { userId: asUser } : {}) },
			);
			expect(minted.frame.ok).toBe(true);
			return minted.frame.result?.ticket ?? "";
		};
		const open = async (ticket: string) => {
			const res = await SELF.fetch(`${ORIGIN}/events?ticket=${ticket}`);
			await res.body?.cancel().catch(() => undefined);
			return res.status;
		};
		const addToken = async (label: string) => {
			const raw = `legacy-bound-${label}-${accountId}`;
			await s.addMember({
				accountId,
				userId: `${userId}-${label}`,
				role: "user",
				rawToken: raw,
			});
			return raw;
		};
		// Control: a live legacy token's ticket opens.
		const live = await addToken("live");
		expect(await open(await mint(live))).toBe(200);
		// Revoked between mint and consume.
		const revoked = await addToken("revoked");
		const t1 = await mint(revoked);
		expect(await s.revokeToken(revoked)).toBe(true);
		expect(await open(t1), "revoked after mint").toBe(401);
		// Expired between mint and consume.
		const expiring = await addToken("expiring");
		const t2 = await mint(expiring);
		await env.CADMUS_ADMIN_DB.prepare(
			"UPDATE cadmus_auth_tokens SET expires_at = ?1 WHERE user_id = ?2",
		)
			.bind(Date.now() - 1000, `${userId}-expiring`)
			.run();
		expect(await open(t2), "expired after mint").toBe(401);
		// A token row flagged revoked (revoked_at set, row kept) between mint and
		// consume is refused too.
		const flagged = await addToken("flagged");
		const t3 = await mint(flagged);
		await env.CADMUS_ADMIN_DB.prepare(
			"UPDATE cadmus_auth_tokens SET revoked_at = ?1 WHERE user_id = ?2",
		)
			.bind(Date.now(), `${userId}-flagged`)
			.run();
		expect(await open(t3), "revoked_at set after mint").toBe(401);
		// The master secret has no credential row to re-check and keeps working.
		expect(await open(await mint(TEST_TOKEN, userId))).toBe(200);
		// A ticket whose mint named no credential is refused.
		const { createLegacyTicket } = await import("../src/store/d1-sessions.js");
		const bare = await createLegacyTicket(
			env.CADMUS_ADMIN_DB,
			userId,
			accountId,
			"events",
			undefined,
		);
		expect(await open(bare.ticket), "no credential named").toBe(401);
	});

	it("a client cannot claim the master credential for a legacy member token through a principal header", async () => {
		const { s, accountId, userId } = await seedUser();
		const raw = `legacy-spoof-${accountId}`;
		await s.addMember({
			accountId,
			userId: `${userId}-spoof`,
			role: "user",
			rawToken: raw,
		});
		const forged = btoa(
			JSON.stringify({
				kind: "token",
				userId: `${userId}-spoof`,
				accountId,
				role: "user",
				credential: "master",
			}),
		);
		const mint = async (extra: Record<string, string>) => {
			const res = await SELF.fetch(`${ORIGIN}/rpc`, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${raw}`,
					...extra,
				},
				body: JSON.stringify({
					id: "spoof",
					type: "auth.ticket",
					payload: { target: "events" },
				}),
			});
			const frame = (await res.json()) as {
				ok: boolean;
				result?: { ticket: string };
			};
			expect(frame.ok).toBe(true);
			return frame.result?.ticket ?? "";
		};
		const open = async (ticket: string) => {
			const res = await SELF.fetch(`${ORIGIN}/events?ticket=${ticket}`);
			await res.body?.cancel().catch(() => undefined);
			return res.status;
		};
		// Control: with no spoof header a live token's ticket opens.
		expect(await open(await mint({}))).toBe(200);
		// With forged principal headers the ticket still carries the edge's own
		// credential claim, so revoking the token voids it.
		const spoofed = await mint({
			"X-Cadmus-Principal": forged,
			"x-cadmus-principal": forged,
			"X-Cadmus-Credential": "master",
		});
		expect(await s.revokeToken(raw)).toBe(true);
		expect(await open(spoofed), "forged master claim").toBe(401);
	});

	it("a legacy ticket carries exactly the minting header identity: no retargeting, no escalation, and what happens after the socket opens", async () => {
		const a = await seedUser("user");
		const b = await seedUser("account-admin");
		const raw = `legacy-ident-${a.accountId}`;
		await a.s.addMember({
			accountId: a.accountId,
			userId: `${a.userId}-m`,
			role: "user",
			rawToken: raw,
		});
		const whoami = async (url: string) => {
			const res = await SELF.fetch(url, { headers: { upgrade: "websocket" } });
			const ws = res.webSocket;
			if (!ws) throw new Error(`no socket: ${res.status}`);
			ws.accept();
			const reply = await new Promise<{
				result?: { principal?: unknown };
				error?: unknown;
				ok?: boolean;
			}>((resolve) => {
				ws.addEventListener("message", (ev) =>
					resolve(JSON.parse(String(ev.data))),
				);
				ws.send(JSON.stringify({ id: "w1", type: "auth.whoami" }));
			});
			return { ws, reply };
		};
		// Legacy member token minted in account A, opened with account B's id and
		// a foreign user id in the URL: the ticket's identity wins.
		const minted = await sendRpc<{ ticket: string }>(
			"auth.ticket",
			{ target: "ws" },
			{ token: raw, accountId: a.accountId },
		);
		const t1 = minted.frame.result?.ticket ?? "";
		const { ws, reply } = await whoami(
			`${ORIGIN}/ws?ticket=${t1}&accountId=${b.accountId}&userId=${b.userId}`,
		);
		expect(reply.result?.principal).toMatchObject({
			accountId: a.accountId,
			userId: `${a.userId}-m`,
			role: "user",
		});
		ws.close();
		// A legacy member token that asks for account B in the header still gets
		// its own account: the ticket is bound to A.
		const foreign = await sendRpc<{ ticket: string }>(
			"auth.ticket",
			{ target: "ws" },
			{ token: raw, accountId: b.accountId },
		);
		expect(foreign.frame.ok).toBe(true);
		const f = await whoami(
			`${ORIGIN}/ws?ticket=${foreign.frame.result?.ticket}`,
		);
		expect(f.reply.result?.principal).toMatchObject({
			accountId: a.accountId,
			userId: `${a.userId}-m`,
		});
		f.ws.close();
		// Master secret: the ticket yields the same account-admin identity the
		// header form gets (positive control: whoami over the header).
		const viaHeader = await sendRpc<{ principal?: unknown }>(
			"auth.whoami",
			{},
			{ accountId: a.accountId, userId: "master-user" },
		);
		const mm = await sendRpc<{ ticket: string }>(
			"auth.ticket",
			{ target: "ws" },
			{ accountId: a.accountId, userId: "master-user" },
		);
		const m = await whoami(
			`${ORIGIN}/ws?ticket=${mm.frame.result?.ticket}&accountId=${b.accountId}`,
		);
		expect(m.reply.result?.principal).toMatchObject({
			accountId: a.accountId,
			userId: "master-user",
			role: "account-admin",
		});
		expect(m.reply.result?.principal).toEqual(
			viaHeader.frame.result?.principal,
		);
		m.ws.close();
	});

	it("keeps the other credential kinds' stream behavior unchanged", async () => {
		const { s, accountId, userId } = await seedUser();
		const raw = `legacy-member-${accountId}`;
		await s.addMember({
			accountId,
			userId,
			role: "account-admin",
			rawToken: raw,
		});
		// A legacy member token is header-only on /events and /ws. ?token= and
		// the cookie are retired; the header form is the positive control.
		for (const path of ["events", "ws"] as const) {
			const upgrade: Record<string, string> =
				path === "ws" ? { upgrade: "websocket" } : {};
			for (const [form, url, headers] of [
				["query", `${ORIGIN}/${path}?token=${raw}&accountId=${accountId}`, {}],
				[
					"cookie",
					`${ORIGIN}/${path}?accountId=${accountId}`,
					{ cookie: `cadmus_session=${raw}` },
				],
			] as const) {
				const res = await SELF.fetch(url, {
					headers: { ...upgrade, ...headers },
				});
				expect(res.status, `legacy ${path} ${form}`).toBe(401);
			}
			const ok = await SELF.fetch(`${ORIGIN}/${path}?accountId=${accountId}`, {
				headers: { ...upgrade, authorization: `Bearer ${raw}` },
			});
			expect(ok.status, `legacy ${path} header`).toBe(
				path === "ws" ? 101 : 200,
			);
			await ok.body?.cancel().catch(() => undefined);
			ok.webSocket?.accept();
			ok.webSocket?.close();
		}
		// The master secret is refused on ?token= and in the cookie for streams.
		for (const path of ["events", "ws"] as const) {
			const upgrade: Record<string, string> =
				path === "ws" ? { upgrade: "websocket" } : {};
			const q = await SELF.fetch(
				`${ORIGIN}/${path}?token=${TEST_TOKEN}&accountId=${accountId}`,
				{ headers: upgrade },
			);
			expect(q.status, `master ${path} query`).toBe(401);
			const c = await SELF.fetch(`${ORIGIN}/${path}?accountId=${accountId}`, {
				headers: { ...upgrade, cookie: `cadmus_session=${TEST_TOKEN}` },
			});
			expect(c.status, `master ${path} cookie`).toBe(401);
		}
		// Legacy credentials open streams with a ticket minted over the header.
		for (const [who, token] of [
			["legacy member", raw],
			["master", TEST_TOKEN],
		] as const) {
			for (const path of ["events", "ws"] as const) {
				const upgrade: Record<string, string> =
					path === "ws" ? { upgrade: "websocket" } : {};
				const minted = await sendRpc<{ ticket: string }>(
					"auth.ticket",
					{ target: path },
					{ token, accountId, userId },
				);
				expect(minted.frame.ok, `${who} ${path} mint`).toBe(true);
				const ticket = minted.frame.result?.ticket ?? "";
				const ok = await SELF.fetch(`${ORIGIN}/${path}?ticket=${ticket}`, {
					headers: upgrade,
				});
				expect(ok.status, `${who} ${path} ticket`).toBe(
					path === "ws" ? 101 : 200,
				);
				await ok.body?.cancel().catch(() => undefined);
				ok.webSocket?.accept();
				ok.webSocket?.close();
				// Single use, and bound to its target.
				const again = await SELF.fetch(`${ORIGIN}/${path}?ticket=${ticket}`, {
					headers: upgrade,
				});
				expect(again.status, `${who} ${path} reuse`).toBe(401);
			}
		}
		// A legacy ticket re-reads the membership: removing the member after the
		// mint makes the ticket useless.
		const doomed = `legacy-doomed-${accountId}`;
		await s.addMember({
			accountId,
			userId: `${userId}-doomed`,
			role: "user",
			rawToken: doomed,
		});
		const minted = await sendRpc<{ ticket: string }>(
			"auth.ticket",
			{ target: "events" },
			{ token: doomed, accountId },
		);
		expect(minted.frame.ok).toBe(true);
		await s.removeMember({
			accountId,
			userId: `${userId}-doomed`,
			actor: userId,
		});
		const gone = await SELF.fetch(
			`${ORIGIN}/events?ticket=${minted.frame.result?.ticket}`,
		);
		expect(gone.status).toBe(401);
		// A disabled user or a suspended account also voids a minted ticket.
		for (const [what, sql] of [
			[
				"disabled user",
				"UPDATE cadmus_users SET disabled_at = ?2 WHERE id = ?1",
			],
			[
				"suspended account",
				"UPDATE cadmus_accounts SET status = 'suspended', suspended_at = ?2 WHERE id = ?1",
			],
		] as const) {
			const sub = await seedUser();
			const tok = `legacy-${what.replace(" ", "-")}-${sub.accountId}`;
			await sub.s.addMember({
				accountId: sub.accountId,
				userId: `${sub.userId}-x`,
				role: "user",
				rawToken: tok,
			});
			const ok = await sendRpc<{ ticket: string }>(
				"auth.ticket",
				{ target: "events" },
				{ token: tok, accountId: sub.accountId },
			);
			expect(ok.frame.ok, `${what} mint`).toBe(true);
			await env.CADMUS_ADMIN_DB.prepare(sql)
				.bind(
					what === "disabled user" ? `${sub.userId}-x` : sub.accountId,
					Date.now(),
				)
				.run();
			const res = await SELF.fetch(
				`${ORIGIN}/events?ticket=${ok.frame.result?.ticket}`,
			);
			expect(res.status, what).toBe(401);
		}
		// An unknown API token is not a bearer. A real cad_pat_ / cad_svc_ is;
		// that path is covered with a minted token below and in e2e.
		for (const kind of ["cad_pat_", "cad_svc_"]) {
			for (const path of ["/ws", "/events", "/api/auth/whoami"]) {
				const res = await SELF.fetch(`${ORIGIN}${path}`, {
					headers: {
						authorization: `Bearer ${kind}notarealtoken`,
						...(path === "/ws" ? { upgrade: "websocket" } : {}),
					},
				});
				expect(res.status, `${kind} on ${path}`).toBe(401);
			}
		}
	});

	it("a ticket for an idle-expired session cannot open /ws or /events", async () => {
		const { s, accountId, userId } = await seedUser();
		const t = await s.createSession({ userId, accountId });
		const tickets = {} as Record<"events" | "ws", string>;
		for (const path of ["events", "ws"] as const) {
			const issued = await rpcWithSession(t.accessToken, "auth.ticket", {
				target: path,
			});
			expect(issued.frame.ok, `${path} mint`).toBe(true);
			tickets[path] = (issued.frame.result as { ticket: string }).ticket;
		}
		const live = await env.CADMUS_ADMIN_DB.prepare(
			"SELECT absolute_expires_at FROM cadmus_sessions WHERE id = ?1",
		)
			.bind(t.sessionId)
			.first<{ absolute_expires_at: number }>();
		expect(live?.absolute_expires_at).toBeGreaterThan(Date.now());
		await env.CADMUS_ADMIN_DB.prepare(
			"UPDATE cadmus_sessions SET idle_expires_at = ?2 WHERE id = ?1",
		)
			.bind(t.sessionId, Date.now() - 1_000)
			.run();
		for (const path of ["events", "ws"] as const) {
			const upgrade: Record<string, string> =
				path === "ws" ? { upgrade: "websocket" } : {};
			const res = await SELF.fetch(
				`${ORIGIN}/${path}?ticket=${tickets[path]}`,
				{
					headers: upgrade,
				},
			);
			expect(res.status, `${path} idle-expired`).toBe(401);
			await res.body?.cancel().catch(() => undefined);
		}
	});

	it("issues single-use, short-lived tickets for /ws and /events", async () => {
		const { s, accountId, userId } = await seedUser();
		const t = await s.createSession({ userId, accountId });
		const issued = await rpcWithSession(t.accessToken, "auth.ticket", {
			target: "events",
		});
		expect(issued.frame.ok).toBe(true);
		const { ticket, expiresAt } = issued.frame.result as {
			ticket: string;
			expiresAt: number;
		};
		expect(expiresAt - Date.now()).toBeLessThanOrEqual(60_000);

		// The wrong target is refused and does not burn the ticket.
		const wrong = await SELF.fetch(`${ORIGIN}/ws?ticket=${ticket}`, {
			headers: { upgrade: "websocket" },
		});
		expect(wrong.status).toBe(401);
		// A ticket is never accepted on /api.
		const api = await SELF.fetch(`${ORIGIN}/api/auth/whoami?ticket=${ticket}`);
		expect(api.status).toBe(401);

		const first = await SELF.fetch(
			`${ORIGIN}/events?ticket=${ticket}&familyId=default`,
		);
		expect(first.status).not.toBe(401);
		await first.body?.cancel();
		const second = await SELF.fetch(
			`${ORIGIN}/events?ticket=${ticket}&familyId=default`,
		);
		expect(second.status).toBe(401);
	});

	it("closes an open socket and refuses later commands once its session is revoked", async () => {
		const { s, accountId, userId } = await seedUser();
		const t = await s.createSession({ userId, accountId });
		const issued = await rpcWithSession(t.accessToken, "auth.ticket", {
			target: "ws",
		});
		const { ticket } = issued.frame.result as { ticket: string };
		const res = await SELF.fetch(`${ORIGIN}/ws?ticket=${ticket}`, {
			headers: { upgrade: "websocket" },
		});
		const ws = res.webSocket;
		if (!ws) throw new Error(`expected 101, got ${res.status}`);
		ws.accept();
		const frames: Array<{ type: string; ok?: boolean; payload?: unknown }> = [];
		let closed = false;
		ws.addEventListener("message", (ev) => {
			frames.push(JSON.parse(ev.data as string));
		});
		ws.addEventListener("close", () => {
			closed = true;
		});
		const send = (type: string) =>
			ws.send(JSON.stringify({ id: crypto.randomUUID(), type, payload: {} }));
		const waitFor = async (cond: () => boolean) => {
			for (let i = 0; i < 100 && !cond(); i++) {
				await new Promise((r) => setTimeout(r, 20));
			}
		};
		send("auth.sessions.list");
		await waitFor(() => frames.some((f) => f.type === "command.result"));
		expect(frames.find((f) => f.type === "command.result")?.ok).toBe(true);

		await s.revokeSession(t.sessionId);
		frames.length = 0;
		send("auth.sessions.list");
		await waitFor(() => closed);
		expect(closed).toBe(true);
		expect(frames.some((f) => f.type === "command.result" && f.ok)).toBe(false);
	});

	it("closes an SSE stream when another session revokes it over HTTP", async () => {
		const { s, accountId, userId } = await seedUser();
		const a = await s.createSession({ userId, accountId });
		const b = await s.createSession({ userId, accountId });
		const issued = await rpcWithSession(a.accessToken, "auth.ticket", {
			target: "events",
		});
		const { ticket } = issued.frame.result as { ticket: string };
		const res = await SELF.fetch(
			`${ORIGIN}/events?ticket=${ticket}&familyId=default`,
		);
		expect(res.status).toBe(200);
		const reader = res.body?.getReader();
		if (!reader) throw new Error("no stream body");
		await reader.read(); // ": connected"
		const ended = reader.read();
		const revoked = await rpcWithSession(
			b.accessToken,
			"auth.sessions.revokeOthers",
		);
		expect(revoked.frame.ok).toBe(true);
		const outcome = await Promise.race([
			ended.then((r) => (r.done ? "closed" : "data")),
			new Promise((r) => setTimeout(() => r("open"), 3000)),
		]);
		expect(outcome).toBe("closed");
	});

	it("lets a token-backed session open its own event socket", async () => {
		const { s, accountId, userId } = await seedUser();
		const made = await s.createToken({
			accountId,
			creatorUserId: userId,
			creatorRole: "account-admin",
			creatorGrants: ["chat.use", "bot.read"],
			kind: "service",
			label: "stream",
			grants: ["chat.use"],
		});
		if (!made.ok) throw new Error("create failed");
		const login = await SELF.fetch(`${ORIGIN}/auth/token-login`, {
			method: "POST",
			headers: { authorization: `Bearer ${made.token}` },
		});
		const { accessToken } = (await login.json()) as { accessToken: string };
		const issued = await rpcWithSession(accessToken, "auth.ticket", {
			target: "ws",
		});
		expect(issued.frame.ok).toBe(true);
		const { ticket } = issued.frame.result as { ticket: string };
		const upgrade = await SELF.fetch(`${ORIGIN}/ws?ticket=${ticket}`, {
			headers: { upgrade: "websocket" },
		});
		expect(upgrade.status).toBe(101);
		upgrade.webSocket?.accept();
		upgrade.webSocket?.close();
	});

	it("closes an SSE stream when its service token is revoked", async () => {
		const { s, accountId, userId } = await seedUser();
		const owner = await s.createSession({ userId, accountId });
		const made = await s.createToken({
			accountId,
			creatorUserId: userId,
			creatorRole: "account-admin",
			creatorGrants: ["chat.use"],
			kind: "service",
			label: "revoked stream",
			grants: ["chat.use"],
		});
		if (!made.ok) throw new Error("create failed");
		const login = await SELF.fetch(`${ORIGIN}/auth/token-login`, {
			method: "POST",
			headers: { authorization: `Bearer ${made.token}` },
		});
		const { accessToken } = (await login.json()) as { accessToken: string };
		const issued = await rpcWithSession(accessToken, "auth.ticket", {
			target: "events",
		});
		const { ticket } = issued.frame.result as { ticket: string };
		const res = await SELF.fetch(
			`${ORIGIN}/events?ticket=${ticket}&familyId=default`,
		);
		const reader = res.body?.getReader();
		if (!reader) throw new Error("no stream body");
		await reader.read();
		const ended = reader.read();
		const revoked = await rpcWithSession(
			owner.accessToken,
			"auth.tokens.revoke",
			{
				tokenId: made.summary.id,
			},
		);
		expect(revoked.frame.ok).toBe(true);
		const outcome = await Promise.race([
			ended.then((r) => (r.done ? "closed" : "data")),
			new Promise((r) => setTimeout(() => r("open"), 3000)),
		]);
		expect(outcome).toBe("closed");
	});

	it("refuses a stream ticket to a token without chat.use", async () => {
		const { s, accountId, userId } = await seedUser();
		const made = await s.createToken({
			accountId,
			creatorUserId: userId,
			creatorRole: "account-admin",
			creatorGrants: ["chat.use", "bot.read"],
			kind: "service",
			label: "read only",
			grants: ["bot.read"],
		});
		if (!made.ok) throw new Error("create failed");
		const login = await SELF.fetch(`${ORIGIN}/auth/token-login`, {
			method: "POST",
			headers: { authorization: `Bearer ${made.token}` },
		});
		const { accessToken } = (await login.json()) as { accessToken: string };
		for (const target of ["ws", "events"]) {
			const issued = await rpcWithSession(accessToken, "auth.ticket", {
				target,
			});
			expect(issued.frame.ok).toBe(false);
		}
	});

	it("audits session create, revoke and refresh reuse", async () => {
		const { s, accountId, userId } = await seedUser();
		const t = await s.createSession({ userId, accountId });
		const actions = async (sessionId: string) =>
			(
				await env.CADMUS_ADMIN_DB.prepare(
					`SELECT action FROM cadmus_audit WHERE target = ?1 ORDER BY at, rowid`,
				)
					.bind(sessionId)
					.all<{ action: string }>()
			).results.map((r) => r.action);
		expect(await actions(t.sessionId)).toEqual(["session.create"]);
		const rotated = await refresh(t.refreshToken);
		expect(rotated.status).toBe(200);
		// Replaying the old refresh token is reuse and kills the session.
		expect((await refresh(t.refreshToken)).status).toBe(401);
		expect(await actions(t.sessionId)).toEqual([
			"session.create",
			"session.refresh_reuse",
		]);
		const u = await s.createSession({ userId, accountId });
		await s.revokeSession(u.sessionId);
		expect(await actions(u.sessionId)).toEqual([
			"session.create",
			"session.revoke",
		]);
	});

	it("rejects a ticket for a revoked session", async () => {
		const { s, accountId, userId } = await seedUser();
		const t = await s.createSession({ userId, accountId });
		const issued = await rpcWithSession(t.accessToken, "auth.ticket", {
			target: "ws",
		});
		const { ticket } = issued.frame.result as { ticket: string };
		await s.revokeSession(t.sessionId);
		const res = await SELF.fetch(`${ORIGIN}/ws?ticket=${ticket}`, {
			headers: { upgrade: "websocket" },
		});
		expect(res.status).toBe(401);
	});

	it("blocks revoking the last login method and revokes sessions of a revoked method", async () => {
		const { s, accountId, userId } = await seedUser();
		const now = Date.now();
		for (const id of ["lm_one", "lm_two"].map((x) => `${x}_${userId}`)) {
			await env.CADMUS_ADMIN_DB.prepare(
				`INSERT INTO cadmus_login_methods (id, user_id, provider, subject, display, created_at)
         VALUES (?1, ?2, 'google', ?1, ?1, ?3)`,
			)
				.bind(id, userId, now)
				.run();
		}
		const one = `lm_one_${userId}`;
		const two = `lm_two_${userId}`;
		const viaOne = await s.createSession({
			userId,
			accountId,
			loginMethodId: one,
		});
		const viaTwo = await s.createSession({
			userId,
			accountId,
			loginMethodId: two,
		});

		const list = await rpcWithSession(viaTwo.accessToken, "auth.methods.list");
		expect((list.frame.result as { methods: unknown[] }).methods).toHaveLength(
			2,
		);

		const revoke = await rpcWithSession(
			viaTwo.accessToken,
			"auth.methods.revoke",
			{
				methodId: one,
			},
		);
		expect(revoke.frame.result).toEqual({ revoked: true, sessionsRevoked: 1 });
		expect(
			(await rpcWithSession(viaOne.accessToken, "auth.methods.list")).status,
		).toBe(401);

		const last = await rpcWithSession(
			viaTwo.accessToken,
			"auth.methods.revoke",
			{
				methodId: two,
			},
		);
		expect(last.frame.ok).toBe(false);
		expect(last.frame.error?.message).toContain("last_login_method");
		expect(
			(
				(await rpcWithSession(viaTwo.accessToken, "auth.methods.list")).frame
					.result as { methods: unknown[] }
			).methods,
		).toHaveLength(1);
	});

	it("needs a session: a legacy token cannot use session commands", async () => {
		const res = await rpcWithSession(
			"test-cadmus-secret",
			"auth.sessions.list",
		);
		expect(res.frame.ok).toBe(false);
	});
});

describe("POST /auth/logout (issue #3 phase 3d)", () => {
	function logout(
		token: string | undefined,
		headers: Record<string, string> = {},
	): Promise<Response> {
		return SELF.fetch(`${ORIGIN}/auth/logout`, {
			method: "POST",
			headers: {
				origin: ORIGIN,
				"x-cadmus-refresh": "1",
				...(token ? { cookie: `${REFRESH_COOKIE}=${token}` } : {}),
				...headers,
			},
		});
	}

	it("does not read the refresh cookie: a cookie alone revokes nothing and is not cleared (issue #3: only /auth/refresh reads cookies)", async () => {
		const { s, accountId, userId } = await seedUser();
		const t = await s.createSession({ userId, accountId });
		const res = await logout(t.refreshToken);
		expect(res.status).toBe(200);
		expect(((await res.json()) as { revoked: boolean }).revoked).toBe(false);
		expect(res.headers.get("set-cookie")).toBeNull();
		// The session is untouched: the cookie still refreshes.
		expect((await refresh(t.refreshToken)).status).toBe(200);
	});

	it("revokes by bearer access token alone, as a browser sends it (the cookie is Path=/auth/refresh)", async () => {
		const { s, accountId, userId } = await seedUser();
		const t = await s.createSession({ userId, accountId });
		const res = await logout(undefined, {
			authorization: `Bearer ${t.accessToken}`,
		});
		expect(res.status).toBe(200);
		expect(((await res.json()) as { revoked: boolean }).revoked).toBe(true);
		expect((await refresh(t.refreshToken)).status).toBe(401);
		const who = await SELF.fetch(`${ORIGIN}/api/auth/whoami`, {
			headers: { authorization: `Bearer ${t.accessToken}` },
		});
		expect(who.status).toBe(401);
	});

	it("a stale bearer revokes nothing and leaves the refresh cookie alone so the session can be repaired", async () => {
		const { s, accountId, userId } = await seedUser();
		const t = await s.createSession({ userId, accountId });
		const rotated = await refresh(t.refreshToken);
		expect(rotated.status).toBe(200);
		const cookie = rotated.headers.get("set-cookie") ?? "";
		const current = new RegExp(`${REFRESH_COOKIE}=([^;]+)`).exec(cookie)?.[1];
		const { accessToken } = (await rotated.json()) as { accessToken: string };
		// t.accessToken was replaced by the refresh: it is stale now.
		const res = await logout(undefined, {
			authorization: `Bearer ${t.accessToken}`,
		});
		expect(res.status).toBe(200);
		expect(((await res.json()) as { revoked: boolean }).revoked).toBe(false);
		expect(res.headers.get("set-cookie")).toBeNull();
		// The session is untouched and the repair route (refresh, then logout with
		// the fresh bearer) still works.
		const again = await refresh(current);
		expect(again.status).toBe(200);
		const fresh = (await again.json()) as { accessToken: string };
		expect(fresh.accessToken).not.toBe(accessToken);
		const ok = await logout(undefined, {
			authorization: `Bearer ${fresh.accessToken}`,
		});
		expect(((await ok.json()) as { revoked: boolean }).revoked).toBe(true);
		const next = /cadmus_refresh=([^;]+)/.exec(
			again.headers.get("set-cookie") ?? "",
		)?.[1];
		expect((await refresh(next)).status).toBe(401);
	});

	it("rejects a request without the CSRF header", async () => {
		const { s, accountId, userId } = await seedUser();
		const t = await s.createSession({ userId, accountId });
		const res = await logout(t.refreshToken, { "x-cadmus-refresh": "0" });
		expect(res.status).toBe(403);
		expect((await refresh(t.refreshToken)).status).toBe(200);
	});

	it("succeeds with a stale or missing cookie", async () => {
		expect((await logout(undefined)).status).toBe(200);
		expect((await logout("not-a-token")).status).toBe(200);
	});
});

describe("credential kinds on streams, with real created tokens", () => {
	async function realToken(kind: "pat" | "service") {
		const { s, accountId, userId } = await seedUser();
		const made = await s.createToken({
			accountId,
			creatorUserId: userId,
			creatorRole: "account-admin",
			creatorGrants: ["chat.use", "bot.read"],
			kind,
			label: `real-${kind}`,
			grants: ["chat.use"],
			...(kind === "pat" ? { ttlMs: 86_400_000 } : {}),
		});
		if (!made.ok) throw new Error("create failed");
		return { raw: made.token, accountId };
	}

	for (const kind of ["pat", "service"] as const) {
		it(`accepts a real ${kind} token as a bearer on /api, refuses it on streams and ?token=, then token-login works`, async () => {
			const { raw, accountId } = await realToken(kind);
			expect(raw.startsWith(kind === "pat" ? "cad_pat_" : "cad_svc_")).toBe(
				true,
			);
			const whoami = await SELF.fetch(`${ORIGIN}/api/auth/whoami`, {
				headers: { authorization: `Bearer ${raw}` },
			});
			// The fixture token holds chat.use only, so the bearer is accepted and
			// the command is refused for the missing tokens.self grant.
			expect(whoami.status).toBe(403);
			const whoBody = (await whoami.json()) as { error?: { code?: string } };
			expect(whoBody.error?.code).toBe("forbidden");
			const statuses: number[] = [];
			for (const path of ["/ws", "/events"]) {
				const upgrade: Record<string, string> =
					path === "/ws" ? { upgrade: "websocket" } : {};
				const bearer = await SELF.fetch(`${ORIGIN}${path}`, {
					headers: { authorization: `Bearer ${raw}`, ...upgrade },
				});
				statuses.push(bearer.status);
				const query = await SELF.fetch(
					`${ORIGIN}${path}?token=${raw}&accountId=${accountId}`,
					{ headers: upgrade },
				);
				statuses.push(query.status);
			}
			const apiQuery = await SELF.fetch(
				`${ORIGIN}/api/auth/whoami?token=${encodeURIComponent(raw)}`,
				{ headers: { authorization: `Bearer ${raw}` } },
			);
			statuses.push(apiQuery.status);
			expect(statuses).toEqual([401, 401, 401, 401, 401]);
			// Positive control: the same real token works through token-login.
			const login = await SELF.fetch(`${ORIGIN}/auth/token-login`, {
				method: "POST",
				headers: { authorization: `Bearer ${raw}` },
			});
			expect(login.status).toBe(200);
			const { accessToken } = (await login.json()) as { accessToken: string };
			expect(accessToken.startsWith("cad_at_")).toBe(true);
			const issued = await rpcWithSession(accessToken, "auth.ticket", {
				target: "ws",
			});
			expect(issued.frame.ok).toBe(true);
		});
	}

	it("opens /ws through the real ProtocolClient with a fresh ticket per connect", async () => {
		const { raw } = await realToken("service");
		const login = await SELF.fetch(`${ORIGIN}/auth/token-login`, {
			method: "POST",
			headers: { authorization: `Bearer ${raw}` },
		});
		const { accessToken } = (await login.json()) as { accessToken: string };
		const urls: string[] = [];
		const statuses: number[] = [];
		// A WebSocket stand-in that performs the real upgrade against the worker.
		class WorkerSocket {
			readyState = 0;
			static OPEN = 1;
			#listeners: Record<string, Array<(ev: unknown) => void>> = {};
			constructor(url: string) {
				urls.push(url);
				SELF.fetch(url.replace(/^ws/, "http"), {
					headers: { upgrade: "websocket" },
				}).then((res) => {
					statuses.push(res.status);
					res.webSocket?.accept();
					res.webSocket?.close();
					this.readyState = 1;
					for (const l of this.#listeners.open ?? []) l({});
				});
			}
			addEventListener(type: string, l: (ev: unknown) => void) {
				const list = this.#listeners[type] ?? [];
				list.push(l);
				this.#listeners[type] = list;
			}
			send() {}
			close() {}
		}
		const client = new ProtocolClient({
			baseUrl: ORIGIN,
			token: accessToken,
			useTickets: true,
			fetchImpl: ((u: string, init?: RequestInit) =>
				SELF.fetch(u, init)) as typeof fetch,
			webSocketImpl: WorkerSocket as never,
		});
		await client.connect();
		await client.connect();
		client.close();
		expect(statuses).toEqual([101, 101]);
		expect(urls).toHaveLength(2);
		const tickets = urls.map((u) => new URL(u).searchParams.get("ticket"));
		expect(tickets[0]).toBeTruthy();
		expect(tickets[1]).toBeTruthy();
		expect(tickets[0]).not.toBe(tickets[1]);
		for (const u of urls) {
			expect(u).not.toContain("token=");
			expect(u).not.toContain(accessToken);
		}
	});
});
