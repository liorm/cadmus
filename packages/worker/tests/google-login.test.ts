import { env, SELF } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	GOOGLE_JWKS_URL,
	GOOGLE_TOKEN_URL,
	TXN_COOKIE,
} from "../src/auth/google.js";
import { LOCKOUT_MAX_FAILURES, lockoutClear } from "../src/auth-limiter.js";
import { handleAuthRoute } from "../src/auth-routes.js";
import { toBase64Url } from "../src/base64url.js";
import { getEdgeCache } from "../src/edge-cache.js";
import { D1AdminStore } from "../src/store/d1-admin.js";
import { acceptInvite, completeLogin } from "../src/store/d1-login.js";
import { insertPrimaryUserStatements } from "../src/store/user-emails.js";

const ORIGIN = "https://example.com";
const CLIENT_ID = "test-google-client.apps.googleusercontent.com";
const BOOTSTRAP = "boss@example.com";
const KID = "test-key-1";

let privateKey: CryptoKey;
let publicJwk: JsonWebKey;
const originalFetch = globalThis.fetch;
let nextIdToken = "";
let tokenCalls: URLSearchParams[] = [];

function enc(value: unknown): string {
	return toBase64Url(JSON.stringify(value));
}

async function signIdToken(claims: Record<string, unknown>): Promise<string> {
	const head = enc({ alg: "RS256", kid: KID, typ: "JWT" });
	const body = enc(claims);
	const sig = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		privateKey,
		new TextEncoder().encode(`${head}.${body}`),
	);
	return `${head}.${body}.${toBase64Url(new Uint8Array(sig))}`;
}

beforeAll(async () => {
	const pair = (await crypto.subtle.generateKey(
		{
			name: "RSASSA-PKCS1-v1_5",
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: "SHA-256",
		},
		true,
		["sign", "verify"],
	)) as CryptoKeyPair;
	privateKey = pair.privateKey;
	publicJwk = (await crypto.subtle.exportKey(
		"jwk",
		pair.publicKey,
	)) as JsonWebKey;
});

beforeEach(async () => {
	tokenCalls = [];
	await store().initialize();
	await env.CADMUS_ADMIN_DB.prepare("DELETE FROM cadmus_bootstrap").run();
	globalThis.fetch = async (input, init) => {
		const url =
			typeof input === "string"
				? input
				: input instanceof URL
					? input.toString()
					: input.url;
		if (url === GOOGLE_TOKEN_URL) {
			tokenCalls.push(new URLSearchParams(String(init?.body ?? "")));
			return Response.json({ id_token: nextIdToken });
		}
		if (url === GOOGLE_JWKS_URL) {
			return Response.json({
				keys: [{ ...publicJwk, kid: KID, alg: "RS256" }],
			});
		}
		return originalFetch(input, init);
	};
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function uniqueSub(): string {
	return `g-${crypto.randomUUID()}`;
}

interface Started {
	state: string;
	nonce: string;
	txnCookie: string;
	location: URL;
}

async function startLogin(fresh = false): Promise<Started> {
	const res = await SELF.fetch(
		`${ORIGIN}/api/auth/login/google/start${fresh ? "?fresh=1" : ""}`,
		{
			redirect: "manual",
		},
	);
	expect(res.status).toBe(302);
	expect(res.headers.get("cache-control")).toBe("no-store");
	const location = new URL(res.headers.get("location") ?? "");
	const cookie = res.headers.get("set-cookie") ?? "";
	return {
		state: location.searchParams.get("state") ?? "",
		nonce: location.searchParams.get("nonce") ?? "",
		txnCookie: /(__Secure-cadmus_txn=[^;]+)/.exec(cookie)?.[1] ?? "",
		location,
	};
}

interface Outcome {
	status: number;
	location: string;
	cookies: string;
}

async function signIn(options: {
	sub: string;
	email: string;
	emailVerified?: boolean;
	nonce?: (real: string) => string;
	aud?: string;
	expOffsetSec?: number;
	state?: (real: string) => string;
	fresh?: boolean;
	/** Seconds relative to now for the auth_time claim; "none" omits it, "string" sends a string. */
	authTime?: number | "none" | "string" | "float";
}): Promise<Outcome> {
	const started = await startLogin(options.fresh);
	const at = options.authTime;
	const authClaim =
		at === undefined || at === "none"
			? {}
			: at === "string"
				? { auth_time: String(Math.floor(Date.now() / 1000)) }
				: at === "float"
					? { auth_time: Date.now() / 1000 }
					: { auth_time: Math.floor(Date.now() / 1000) + at };
	nextIdToken = await signIdToken({
		iss: "https://accounts.google.com",
		aud: options.aud ?? CLIENT_ID,
		sub: options.sub,
		email: options.email,
		email_verified: options.emailVerified ?? true,
		name: "Test Person",
		...authClaim,
		nonce: options.nonce ? options.nonce(started.nonce) : started.nonce,
		exp: Math.floor(Date.now() / 1000) + (options.expOffsetSec ?? 600),
	});
	const state = options.state ? options.state(started.state) : started.state;
	const res = await SELF.fetch(
		`${ORIGIN}/api/auth/login/google/callback?code=abc&state=${state}`,
		{ redirect: "manual", headers: { cookie: started.txnCookie } },
	);
	// Every callback outcome, success or refusal, is uncacheable.
	expect(res.headers.get("cache-control")).toBe("no-store");
	return {
		status: res.status,
		location: res.headers.get("location") ?? "",
		cookies: res.headers.get("set-cookie") ?? "",
	};
}

async function count(sql: string, ...args: unknown[]): Promise<number> {
	const row = await env.CADMUS_ADMIN_DB.prepare(sql)
		.bind(...args)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

function store(): D1AdminStore {
	return new D1AdminStore({
		db: env.CADMUS_ADMIN_DB,
		encryptionKey: env.CADMUS_ENCRYPTION_KEY,
		edgeCache: getEdgeCache(env),
	});
}

async function invite(email: string, role = "user"): Promise<string> {
	const s = store();
	await s.initialize();
	const accountId = `acct-inv-${crypto.randomUUID().slice(0, 8)}`;
	await s.ensureAccountAndUser({ accountId, userId: `seed-${accountId}` });
	const now = Date.now();
	const created = insertPrimaryUserStatements(
		env.CADMUS_ADMIN_DB,
		email,
		email,
		now,
	);
	await env.CADMUS_ADMIN_DB.batch([
		...created.statements,
		env.CADMUS_ADMIN_DB.prepare(
			`INSERT INTO cadmus_invites (id, account_id, email, role, invited_by, created_at, expires_at)
       VALUES (?1, ?2, ?3, ?4, 'seed', ?5, ?6)`,
		).bind(
			`inv_${crypto.randomUUID()}`,
			accountId,
			email,
			role,
			now,
			now + 86_400_000,
		),
	]);
	return accountId;
}

describe("Google sign-in (issue #3 phase 3b, mocked Google)", () => {
	it("lists google as a provider only when configured", async () => {
		const res = await SELF.fetch(`${ORIGIN}/api/auth/login/providers`);
		expect(await res.json()).toEqual({ providers: [{ id: "google" }] });
		const bare = await handleAuthRoute(
			new Request(`${ORIGIN}/api/auth/login/providers`),
			{ ...env, GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined },
			store(),
		);
		expect(await bare.json()).toEqual({ providers: [] });
	});

	it("returns provider_not_configured while unconfigured", async () => {
		const bare = {
			...env,
			GOOGLE_CLIENT_ID: undefined,
			GOOGLE_CLIENT_SECRET: undefined,
		};
		for (const path of [
			"/api/auth/login/google/start",
			"/api/auth/login/google/callback",
		]) {
			const res = await handleAuthRoute(
				new Request(`${ORIGIN}${path}`),
				bare,
				store(),
			);
			expect(res.status).toBe(404);
			expect(res.headers.get("cache-control"), path).toBe("no-store");
			expect(
				((await res.json()) as { error: { code: string } }).error.code,
			).toBe("provider_not_configured");
		}
	});

	it("starts a PKCE login with state, nonce and a signed transaction", async () => {
		const started = await startLogin();
		expect(started.location.origin + started.location.pathname).toBe(
			"https://accounts.google.com/o/oauth2/v2/auth",
		);
		expect(started.location.searchParams.get("code_challenge_method")).toBe(
			"S256",
		);
		expect(started.location.searchParams.get("client_id")).toBe(CLIENT_ID);
		expect(started.location.searchParams.get("redirect_uri")).toBe(
			`${ORIGIN}/api/auth/login/google/callback`,
		);
		expect(started.state.length).toBeGreaterThan(16);
		expect(started.nonce.length).toBeGreaterThan(16);
	});

	it("attaches a method to the seeded bootstrap user and does not create another", async () => {
		const ids = `SELECT id FROM cadmus_users WHERE email = ?1`;
		for (const sql of [
			`DELETE FROM cadmus_sessions WHERE user_id IN (${ids})`,
			`DELETE FROM cadmus_login_methods WHERE user_id IN (${ids})`,
		]) {
			await env.CADMUS_ADMIN_DB.prepare(sql).bind(BOOTSTRAP).run();
		}
		const mine = `SELECT COUNT(*) AS n FROM cadmus_users WHERE email = ?1`;
		expect(await count(mine, BOOTSTRAP)).toBe(1);
		const sub = uniqueSub();
		const first = await signIn({ sub, email: BOOTSTRAP });
		expect(first.status).toBe(302);
		expect(first.location).toBe("/");
		expect(first.cookies).toContain("__Secure-cadmus_refresh=");
		expect(tokenCalls[0]?.get("code_verifier")?.length).toBeGreaterThan(30);
		expect(
			await count(
				`SELECT COUNT(*) AS n FROM cadmus_account_members m
         JOIN cadmus_login_methods l ON l.user_id = m.user_id
         WHERE l.subject = ?1 AND m.account_id = 'system' AND m.role = 'super-admin'`,
				sub,
			),
		).toBe(1);
		expect(await count(mine, BOOTSTRAP)).toBe(1);
		const again = await signIn({ sub, email: BOOTSTRAP });
		expect(again.location).toBe("/");
		expect(await count(mine, BOOTSTRAP)).toBe(1);
		const otherSub = uniqueSub();
		const other = await signIn({ sub: otherSub, email: BOOTSTRAP });
		expect(other.location).toBe("/");
		expect(await count(mine, BOOTSTRAP)).toBe(1);
		expect(
			await count(
				`SELECT COUNT(*) AS n FROM cadmus_login_methods WHERE subject = ?1`,
				otherSub,
			),
		).toBe(1);
	});

	it("refuses an uninvited email and creates nothing", async () => {
		const users = await count(`SELECT COUNT(*) AS n FROM cadmus_users`);
		const methods = await count(
			`SELECT COUNT(*) AS n FROM cadmus_login_methods`,
		);
		const accounts = await count(`SELECT COUNT(*) AS n FROM cadmus_accounts`);
		const res = await signIn({
			sub: uniqueSub(),
			email: "stranger@example.com",
		});
		expect(res.location).toBe("/?auth_error=not_invited");
		expect(res.cookies).not.toContain("cadmus_refresh=ey");
		expect(await count(`SELECT COUNT(*) AS n FROM cadmus_users`)).toBe(users);
		expect(await count(`SELECT COUNT(*) AS n FROM cadmus_login_methods`)).toBe(
			methods,
		);
		expect(await count(`SELECT COUNT(*) AS n FROM cadmus_accounts`)).toBe(
			accounts,
		);
	});

	it("accepts a pending invite on first verified sign-in and signs into that account", async () => {
		const email = `invitee-${crypto.randomUUID().slice(0, 8)}@example.com`;
		const accountId = await invite(email, "account-admin");
		const sub = uniqueSub();
		const res = await signIn({ sub, email });
		expect(res.location).toBe("/");
		const cookie = /cadmus_refresh=([^;]+)/.exec(res.cookies)?.[1] ?? "";
		expect(cookie.startsWith("cad_rt_")).toBe(true);
		expect(
			await count(
				`SELECT COUNT(*) AS n FROM cadmus_account_members m
         JOIN cadmus_login_methods l ON l.user_id = m.user_id
         WHERE l.subject = ?1 AND m.account_id = ?2 AND m.role = 'account-admin'`,
				sub,
				accountId,
			),
		).toBe(1);
		expect(
			await count(
				`SELECT COUNT(*) AS n FROM cadmus_invites WHERE email = ?1 AND accepted_at IS NOT NULL`,
				email,
			),
		).toBe(1);
		// The refresh cookie from sign-in is a working session for that account.
		const refreshed = await SELF.fetch(`${ORIGIN}/api/auth/session/refresh`, {
			method: "POST",
			headers: {
				origin: ORIGIN,
				"x-cadmus-refresh": "1",
				cookie: `__Secure-cadmus_refresh=${cookie}`,
			},
		});
		expect(refreshed.status).toBe(200);
		const { accessToken } = (await refreshed.json()) as { accessToken: string };
		const who = await SELF.fetch(`${ORIGIN}/api/auth/whoami`, {
			headers: { authorization: `Bearer ${accessToken}` },
		});
		const body = (await who.json()) as {
			principal: { accountId: string; role: string };
		};
		expect(body.principal).toMatchObject({ accountId, role: "account-admin" });
	});

	it("lets an existing user accept an invite to another account", async () => {
		const email = `again-${crypto.randomUUID().slice(0, 8)}@example.com`;
		const first = await invite(email, "user");
		const sub = uniqueSub();
		expect((await signIn({ sub, email })).location).toBe("/");
		const second = await invite(email, "account-admin");
		expect((await signIn({ sub, email })).location).toBe("/");
		expect(
			await count(
				`SELECT COUNT(*) AS n FROM cadmus_account_members m
         JOIN cadmus_login_methods l ON l.user_id = m.user_id
         WHERE l.subject = ?1 AND m.account_id IN (?2, ?3)`,
				sub,
				first,
				second,
			),
		).toBe(2);
		expect(
			await count(
				`SELECT COUNT(*) AS n FROM cadmus_invites WHERE email = ?1 AND accepted_at IS NULL`,
				email,
			),
		).toBe(0);
		expect(
			await count(
				`SELECT COUNT(*) AS n FROM cadmus_users WHERE email = ?1`,
				email,
			),
		).toBe(1);
	});

	it("refuses bad nonce, audience, expiry, state and unverified email", async () => {
		const email = `bad-${crypto.randomUUID().slice(0, 8)}@example.com`;
		await invite(email);
		const methods = await count(
			`SELECT COUNT(*) AS n FROM cadmus_login_methods`,
		);
		const cases: Array<[string, Parameters<typeof signIn>[0]]> = [
			["bad_nonce", { sub: uniqueSub(), email, nonce: () => "wrong" }],
			["bad_audience", { sub: uniqueSub(), email, aud: "someone-else" }],
			["token_expired", { sub: uniqueSub(), email, expOffsetSec: -60 }],
			["bad_state", { sub: uniqueSub(), email, state: () => "forged" }],
			["email_not_verified", { sub: uniqueSub(), email, emailVerified: false }],
		];
		for (const [code, options] of cases) {
			const res = await signIn(options);
			expect(res.location, code).toBe(`/?auth_error=${code}`);
			expect(res.cookies, code).not.toContain("cadmus_refresh=cad_rt_");
		}
		expect(await count(`SELECT COUNT(*) AS n FROM cadmus_login_methods`)).toBe(
			methods,
		);
		expect(
			await count(
				`SELECT COUNT(*) AS n FROM cadmus_invites WHERE email = ?1 AND accepted_at IS NULL`,
				email,
			),
		).toBe(1);
	});

	it("rejects a callback with no transaction cookie", async () => {
		const res = await SELF.fetch(
			`${ORIGIN}/api/auth/login/google/callback?code=abc&state=whatever`,
			{ redirect: "manual" },
		);
		expect(res.headers.get("location")).toBe("/?auth_error=bad_state");
	});

	it("a malformed transaction cookie redirects as bad_state", async () => {
		const res = await SELF.fetch(
			`${ORIGIN}/api/auth/login/google/callback?code=abc&state=whatever`,
			{
				redirect: "manual",
				headers: { cookie: `${TXN_COOKIE}=foo.!!!` },
			},
		);
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("/?auth_error=bad_state");
		expect(res.headers.get("cache-control")).toBe("no-store");
	});

	it("a malformed id-token signature redirects as bad_id_token", async () => {
		const started = await startLogin();
		const header = toBase64Url(JSON.stringify({ alg: "RS256", kid: KID }));
		const payload = toBase64Url(
			JSON.stringify({
				iss: "https://accounts.google.com",
				aud: CLIENT_ID,
				sub: uniqueSub(),
				email: "bad-sig@example.com",
				email_verified: true,
				nonce: started.nonce,
				exp: Math.floor(Date.now() / 1000) + 600,
			}),
		);
		nextIdToken = `${header}.${payload}.!!!`;
		const res = await SELF.fetch(
			`${ORIGIN}/api/auth/login/google/callback?code=abc&state=${started.state}`,
			{ redirect: "manual", headers: { cookie: started.txnCookie } },
		);
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("/?auth_error=bad_id_token");
		expect(res.headers.get("cache-control")).toBe("no-store");
	});

	it("refuses a revoked login method", async () => {
		const email = `rev-${crypto.randomUUID().slice(0, 8)}@example.com`;
		await invite(email);
		const sub = uniqueSub();
		expect((await signIn({ sub, email })).location).toBe("/");
		await env.CADMUS_ADMIN_DB.prepare(
			`UPDATE cadmus_login_methods SET revoked_at = ?2 WHERE subject = ?1`,
		)
			.bind(sub, Date.now())
			.run();
		const res = await signIn({ sub, email });
		expect(res.location).toBe("/?auth_error=login_method_revoked");
	});
});

describe("invite acceptance claims (issue #3)", () => {
	const db = () => env.CADMUS_ADMIN_DB;
	const members = async (accountId: string) =>
		(
			await db()
				.prepare(
					`SELECT user_id FROM cadmus_account_members WHERE account_id = ?1 AND user_id NOT LIKE 'seed-%'`,
				)
				.bind(accountId)
				.all<{ user_id: string }>()
		).results;
	const pendingInvite = async (accountId: string) => {
		const row = await db()
			.prepare(
				`SELECT id, account_id, role FROM cadmus_invites WHERE account_id = ?1`,
			)
			.bind(accountId)
			.first<{ id: string; account_id: string; role: string }>();
		if (!row) throw new Error(`missing pending invite for ${accountId}`);
		return row;
	};
	const acceptAudits = async (accountId: string) =>
		await count(
			`SELECT COUNT(*) AS n FROM cadmus_audit WHERE account_id = ?1 AND action = 'invite.accept'`,
			accountId,
		);
	const login = (sub: string, email: string, now: number) =>
		completeLogin(
			db(),
			{ provider: "google", subject: sub, email, emailVerified: true },
			{ now },
		);

	it("only one of two same-millisecond preselected acceptances wins", async () => {
		const accountId = await invite(
			`race-${crypto.randomUUID().slice(0, 8)}@example.com`,
			"account-admin",
		);
		const inv = await pendingInvite(accountId);
		const now = Date.now();
		for (const user of ["user_A", "user_B"]) {
			await db()
				.prepare(
					`INSERT OR IGNORE INTO cadmus_users (id, name, email, primary_email, created_at) VALUES (?1, ?1, ?1, ?1, ?2)`,
				)
				.bind(user, now)
				.run();
		}
		await db().batch(acceptInvite(db(), inv, "user_B", now));
		await db().batch(acceptInvite(db(), inv, "user_A", now));
		expect((await members(accountId)).map((m) => m.user_id)).toEqual([
			"user_B",
		]);
		expect(await acceptAudits(accountId)).toBe(1);
	});

	it("a revoked or expired invite yields no membership, audit or orphan user", async () => {
		for (const kind of ["revoked", "expired"]) {
			const email = `${kind}-${crypto.randomUUID().slice(0, 8)}@example.com`;
			const accountId = await invite(email);
			const inv = await pendingInvite(accountId);
			await db()
				.prepare(
					kind === "revoked"
						? `UPDATE cadmus_invites SET revoked_at = 1 WHERE id = ?1`
						: `UPDATE cadmus_invites SET expires_at = 1 WHERE id = ?1`,
				)
				.bind(inv.id)
				.run();
			const sub = uniqueSub();
			const res = await login(sub, email, Date.now());
			expect(res).toMatchObject({ ok: false, code: "account_suspended" });
			expect(
				await count(
					`SELECT COUNT(*) AS n FROM cadmus_login_methods WHERE subject = ?1`,
					sub,
				),
			).toBe(1);
			expect(
				await count(
					`SELECT COUNT(*) AS n FROM cadmus_users WHERE email = ?1`,
					email,
				),
			).toBe(1);
			// An already-preselected acceptance also writes nothing.
			await db().batch(acceptInvite(db(), inv, "user_X", Date.now()));
			expect(await members(accountId)).toEqual([]);
			expect(await acceptAudits(accountId)).toBe(0);
		}
	});

	it("a second provider subject for the same email cannot reuse an accepted invite; a duplicate callback adds no audit", async () => {
		const email = `dup-${crypto.randomUUID().slice(0, 8)}@example.com`;
		const accountId = await invite(email, "account-admin");
		const now = Date.now();
		const subA = uniqueSub();
		expect((await login(subA, email, now)).ok).toBe(true);
		expect((await login(subA, email, now)).ok).toBe(true);
		const subB = uniqueSub();
		expect((await login(subB, email, now)).ok).toBe(true);
		expect(await members(accountId)).toHaveLength(1);
		expect(await acceptAudits(accountId)).toBe(1);
	});

	it("a replacement invite issued between read and write cannot leave an orphan user", async () => {
		const email = `swap-${crypto.randomUUID().slice(0, 8)}@example.com`;
		const accountId = await invite(email, "account-admin");
		const first = await pendingInvite(accountId);
		const sub = uniqueSub();
		const res = await completeLogin(
			db(),
			{ provider: "google", subject: sub, email, emailVerified: true },
			{
				beforeWrite: async () => {
					// Revoke I1 and issue a replacement I2 after the login read I1.
					await db()
						.prepare(`UPDATE cadmus_invites SET revoked_at = 1 WHERE id = ?1`)
						.bind(first.id)
						.run();
					await db()
						.prepare(
							`INSERT INTO cadmus_invites (id, account_id, email, role, invited_by, created_at, expires_at)
               VALUES ('inv_replacement_' || ?1, ?2, ?3, 'account-admin', 'seed', ?4, ?5)`,
						)
						.bind(sub, accountId, email, Date.now(), Date.now() + 86_400_000)
						.run();
				},
			},
		);
		expect(res).toMatchObject({ ok: false, code: "account_suspended" });
		expect(
			await count(
				`SELECT COUNT(*) AS n FROM cadmus_users WHERE email = ?1`,
				email,
			),
		).toBe(1);
		expect(
			await count(
				`SELECT COUNT(*) AS n FROM cadmus_login_methods WHERE subject = ?1`,
				sub,
			),
		).toBe(1);
		expect(await members(accountId)).toEqual([]);
		expect((await login(sub, email, Date.now())).ok).toBe(true);
		expect(await members(accountId)).toHaveLength(1);
	});

	it("a preselected invite revoked before an existing user's acceptance batch grants nothing", async () => {
		const email = `exist-${crypto.randomUUID().slice(0, 8)}@example.com`;
		const firstAccount = await invite(email, "user");
		const sub = uniqueSub();
		expect((await login(sub, email, Date.now())).ok).toBe(true);
		const secondAccount = await invite(email, "account-admin");
		const second = await pendingInvite(secondAccount);
		await completeLogin(
			db(),
			{ provider: "google", subject: sub, email, emailVerified: true },
			{
				beforeWrite: async () => {
					await db()
						.prepare(`UPDATE cadmus_invites SET expires_at = 1 WHERE id = ?1`)
						.bind(second.id)
						.run();
				},
			},
		);
		expect(await members(secondAccount)).toEqual([]);
		expect(await acceptAudits(secondAccount)).toBe(0);
		expect(await members(firstAccount)).toHaveLength(1);
	});
});

describe("Google sign-in lockout per verified email (issue #3 phase 8)", () => {
	it("locks a verified email after repeated refused sign-ins, refuses even once invited, and a clear or a success resets it", async () => {
		const email = `lock-${crypto.randomUUID()}@example.com`;
		const attempt = () => signIn({ sub: uniqueSub(), email });
		for (let i = 1; i <= LOCKOUT_MAX_FAILURES; i++) {
			const out = await attempt();
			expect(out.location, `refusal ${i}`).toBe("/?auth_error=not_invited");
		}
		// Locked: an invite no longer helps until the lock ends or is cleared.
		await invite(email);
		const locked = await attempt();
		expect(locked.location).toBe("/?auth_error=locked_out");
		expect(locked.cookies).not.toContain("__Secure-cadmus_refresh=cad_rt_");
		// Another email is unaffected.
		const other = `lock-${crypto.randomUUID()}@example.com`;
		await invite(other);
		const ok = await signIn({ sub: uniqueSub(), email: other });
		expect(ok.location).toBe("/");
		// Clearing the identity lets the invited email in.
		await lockoutClear(env, "google-callback", email);
		const after = await attempt();
		expect(after.location).toBe("/");
		// A success reset its count: failures short of the maximum do not lock.
		const third = `lock-${crypto.randomUUID()}@example.com`;
		for (let i = 1; i < LOCKOUT_MAX_FAILURES; i++) {
			expect((await signIn({ sub: uniqueSub(), email: third })).location).toBe(
				"/?auth_error=not_invited",
			);
		}
		await invite(third);
		expect((await signIn({ sub: uniqueSub(), email: third })).location).toBe(
			"/",
		);
		// A second subject for the same verified address attaches. A new address does not.
		expect((await signIn({ sub: uniqueSub(), email: third })).location).toBe(
			"/",
		);
		const stranger = `lock-${crypto.randomUUID()}@example.com`;
		expect((await signIn({ sub: uniqueSub(), email: stranger })).location).toBe(
			"/?auth_error=not_invited",
		);
	});
});

describe("verifyGoogleIdToken fails closed on malformed JWKs", () => {
	it("returns bad_id_token instead of throwing when the matching JWK has missing n/e", async () => {
		const started = await startLogin();
		nextIdToken = await signIdToken({
			iss: "https://accounts.google.com",
			aud: CLIENT_ID,
			sub: uniqueSub(),
			email: `bad-jwk-${crypto.randomUUID()}@example.com`,
			email_verified: true,
			name: "Bad JWK",
			nonce: started.nonce,
			exp: Math.floor(Date.now() / 1000) + 600,
		});
		globalThis.fetch = async (input, init) => {
			const url =
				typeof input === "string"
					? input
					: input instanceof URL
						? input.toString()
						: input.url;
			if (url === GOOGLE_TOKEN_URL) {
				return Response.json({ id_token: nextIdToken });
			}
			if (url === GOOGLE_JWKS_URL) {
				return Response.json({
					keys: [{ kty: "RSA", kid: KID, alg: "RS256" }],
				});
			}
			return originalFetch(input, init);
		};
		const res = await SELF.fetch(
			`${ORIGIN}/api/auth/login/google/callback?code=abc&state=${started.state}`,
			{ redirect: "manual", headers: { cookie: started.txnCookie } },
		);
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("/?auth_error=bad_id_token");
	});
});
