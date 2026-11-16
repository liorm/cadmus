import { env, SELF } from "cloudflare:test";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
	GOOGLE_JWKS_URL,
	GOOGLE_TOKEN_URL,
	LINK_BIND_COOKIE,
	signLinkTicket,
	TXN_COOKIE,
} from "../src/auth/google.js";
import { LOCKOUT_MAX_FAILURES, lockoutClear } from "../src/auth-limiter.js";
import { handleAuthRoute } from "../src/auth-routes.js";
import { fromBase64UrlString, toBase64Url } from "../src/base64url.js";
import { getEdgeCache } from "../src/edge-cache.js";
import { D1AdminStore } from "../src/store/d1-admin.js";
import { acceptInvite, completeLogin } from "../src/store/d1-login.js";
import { rpc } from "./helpers.js";

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
		`${ORIGIN}/auth/login/google${fresh ? "?fresh=1" : ""}`,
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
		`${ORIGIN}/auth/callback/google?code=abc&state=${state}`,
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
	await env.CADMUS_ADMIN_DB.prepare(
		`INSERT INTO cadmus_invites (id, account_id, email, role, invited_by, created_at, expires_at)
     VALUES (?1, ?2, ?3, ?4, 'seed', ?5, ?6)`,
	)
		.bind(
			`inv_${crypto.randomUUID()}`,
			accountId,
			email,
			role,
			Date.now(),
			Date.now() + 86_400_000,
		)
		.run();
	return accountId;
}

describe("Google sign-in (issue #3 phase 3b, mocked Google)", () => {
	it("lists google as a provider only when configured", async () => {
		const res = await SELF.fetch(`${ORIGIN}/auth/providers`);
		expect(await res.json()).toEqual({ providers: [{ id: "google" }] });
		const bare = await handleAuthRoute(
			new Request(`${ORIGIN}/auth/providers`),
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
		for (const path of ["/auth/login/google", "/auth/callback/google"]) {
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
			`${ORIGIN}/auth/callback/google`,
		);
		expect(started.state.length).toBeGreaterThan(16);
		expect(started.nonce.length).toBeGreaterThan(16);
	});

	it("claims super-admin once for the bootstrap email and is idempotent", async () => {
		// Dev-password tests on this worker sign the same bootstrap email in
		// first. Drop those rows so this claim is the only user with the email.
		const ids = `SELECT id FROM cadmus_users WHERE email = ?1`;
		for (const sql of [
			`DELETE FROM cadmus_bootstrap`,
			`DELETE FROM cadmus_invites WHERE email = ?1`,
			`DELETE FROM cadmus_sessions WHERE user_id IN (${ids})`,
			`DELETE FROM cadmus_account_members WHERE user_id IN (${ids})`,
			`DELETE FROM cadmus_audit WHERE actor_user_id IN (${ids})`,
			`DELETE FROM cadmus_login_methods WHERE user_id IN (${ids})`,
			`DELETE FROM cadmus_auth_tokens WHERE user_id IN (${ids})`,
			`DELETE FROM cadmus_users WHERE email = ?1`,
		]) {
			const stmt = env.CADMUS_ADMIN_DB.prepare(sql);
			await (sql.includes("?1") ? stmt.bind(BOOTSTRAP) : stmt).run();
		}
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
		// Exactly one claim row for this user. The user id scopes the count, so
		// other tests' claims in the shared database do not matter.
		const claims = `SELECT COUNT(*) AS n FROM cadmus_audit a
         JOIN cadmus_login_methods l ON l.user_id = a.target
         WHERE a.action = 'bootstrap.claim' AND l.provider = 'google' AND l.subject = ?1`;
		expect(await count(claims, sub)).toBe(1);

		// Repeat sign-in: same user, no new rows, and no second claim row.
		const mine = `SELECT COUNT(*) AS n FROM cadmus_users WHERE email = ?1`;
		expect(await count(mine, BOOTSTRAP)).toBe(1);
		const again = await signIn({ sub, email: BOOTSTRAP });
		expect(again.location).toBe("/");
		expect(await count(mine, BOOTSTRAP)).toBe(1);
		expect(await count(claims, sub)).toBe(1);

		// A different Google account with the bootstrap email cannot claim again.
		const other = await signIn({ sub: uniqueSub(), email: BOOTSTRAP });
		expect(other.location).toBe("/?auth_error=not_invited");
		expect(await count(mine, BOOTSTRAP)).toBe(1);
	});

	describe("two first sign-ins claim the bootstrap email at once", () => {
		const RACE_EMAIL = "race-boss@example.com";
		const rows = async (sql: string, ...v: unknown[]) =>
			(
				await env.CADMUS_ADMIN_DB.prepare(sql)
					.bind(...v)
					.all()
			).results;
		const cleanup = async () => {
			const ids = `SELECT id FROM cadmus_users WHERE email = ?1`;
			for (const sql of [
				`DELETE FROM cadmus_bootstrap`,
				`DELETE FROM cadmus_invites WHERE email = ?1`,
				`DELETE FROM cadmus_sessions WHERE user_id IN (${ids})`,
				`DELETE FROM cadmus_account_members WHERE user_id IN (${ids})`,
				`DELETE FROM cadmus_audit WHERE actor_user_id IN (${ids})`,
				`DELETE FROM cadmus_login_methods WHERE user_id IN (${ids})`,
				`DELETE FROM cadmus_users WHERE email = ?1`,
			]) {
				const stmt = env.CADMUS_ADMIN_DB.prepare(sql);
				await (sql.includes("?1") ? stmt.bind(RACE_EMAIL) : stmt).run();
			}
		};
		beforeEach(cleanup);
		afterEach(cleanup);
		const identity = (sub: string) => ({
			provider: "google" as const,
			subject: sub,
			email: RACE_EMAIL,
			emailVerified: true,
		});
		/** Both calls read the unclaimed state, then both write. */
		const bothReadThenWrite = async (
			subs: [string, string],
			extraBeforeWrite?: () => Promise<void>,
		) => {
			let arrived = 0;
			let release: () => void = () => {};
			const gate = new Promise<void>((r) => {
				release = r;
			});
			const beforeWrite = async () => {
				arrived += 1;
				if (arrived === 2) release();
				await gate;
				await extraBeforeWrite?.();
			};
			return Promise.allSettled(
				subs.map((sub) =>
					completeLogin(db(), identity(sub), {
						bootstrapEmail: RACE_EMAIL,
						beforeWrite,
					}),
				),
			);
		};
		const db = () => env.CADMUS_ADMIN_DB;

		it("one wins, the other is refused as not_invited, and no second user or super-admin exists", async () => {
			const results = await bothReadThenWrite([uniqueSub(), uniqueSub()]);
			const fulfilled = results.map((r) =>
				r.status === "fulfilled" ? r.value : { threw: String(r.reason) },
			);
			expect(fulfilled.filter((r) => "ok" in r && r.ok)).toHaveLength(1);
			expect(fulfilled.filter((r) => "code" in r)).toEqual([
				{ ok: false, code: "not_invited" },
			]);
			expect(
				await rows(`SELECT id FROM cadmus_users WHERE email = ?1`, RACE_EMAIL),
			).toHaveLength(1);
			expect(
				await rows(
					`SELECT m.user_id FROM cadmus_account_members m JOIN cadmus_users u ON u.id = m.user_id
           WHERE u.email = ?1 AND m.account_id = 'system' AND m.role = 'super-admin'`,
					RACE_EMAIL,
				),
			).toHaveLength(1);
			expect(await rows(`SELECT user_id FROM cadmus_bootstrap`)).toHaveLength(
				1,
			);
		});

		it("the same Google account in both requests: the loser is refused, one user and one method exist", async () => {
			const sub = uniqueSub();
			const results = await bothReadThenWrite([sub, sub]);
			const values = results.map((r) =>
				r.status === "fulfilled" ? r.value : { threw: String(r.reason) },
			);
			expect(values.filter((r) => "ok" in r && r.ok)).toHaveLength(1);
			expect(values.filter((r) => "code" in r)).toEqual([
				{ ok: false, code: "not_invited" },
			]);
			expect(
				await rows(`SELECT id FROM cadmus_users WHERE email = ?1`, RACE_EMAIL),
			).toHaveLength(1);
			expect(
				await rows(
					`SELECT id FROM cadmus_login_methods WHERE subject = ?1`,
					sub,
				),
			).toHaveLength(1);
		});

		it("a non-bootstrap sign-in that fails is rethrown even when the claim belongs to someone else", async () => {
			const sub = uniqueSub();
			const now = Date.now();
			await db()
				.prepare(
					`INSERT INTO cadmus_bootstrap (id, claimed_at, user_id) VALUES (1, ?1, 'usr_other')`,
				)
				.bind(now)
				.run();
			await db()
				.prepare(
					`INSERT INTO cadmus_invites (id, account_id, email, role, invited_by, created_at, expires_at)
           VALUES ('inv_ctl_' || ?1, 'system', ?2, 'user', 'seed', ?3, ?4)`,
				)
				.bind(sub, RACE_EMAIL, now, now + 86_400_000)
				.run();
			await expect(
				completeLogin(db(), identity(sub), {
					bootstrapEmail: RACE_EMAIL,
					beforeWrite: async () => {
						await db()
							.prepare(
								`INSERT INTO cadmus_login_methods (id, user_id, provider, subject, display, created_at, last_used_at)
                 VALUES ('lm_preexisting', 'usr_ghost', 'google', ?1, 'x', 1, 1)`,
							)
							.bind(sub)
							.run();
					},
				}),
			).rejects.toThrow();
			await db()
				.prepare(`DELETE FROM cadmus_login_methods WHERE id = 'lm_preexisting'`)
				.run();
		});

		it("a bootstrap batch that fails for another reason is rethrown, not refused", async () => {
			const sub = uniqueSub();
			// The login-method row for this identity appears after the read, so the
			// batch fails on its unique key while the bootstrap claim is still free.
			await expect(
				completeLogin(db(), identity(sub), {
					bootstrapEmail: RACE_EMAIL,
					beforeWrite: async () => {
						await db()
							.prepare(
								`INSERT INTO cadmus_login_methods (id, user_id, provider, subject, display, created_at, last_used_at)
                 VALUES ('lm_preexisting', 'usr_ghost', 'google', ?1, 'x', 1, 1)`,
							)
							.bind(sub)
							.run();
					},
				}),
			).rejects.toThrow();
			expect(await rows(`SELECT user_id FROM cadmus_bootstrap`)).toHaveLength(
				0,
			);
			await db()
				.prepare(`DELETE FROM cadmus_login_methods WHERE id = 'lm_preexisting'`)
				.run();
		});
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
		const refreshed = await SELF.fetch(`${ORIGIN}/auth/refresh`, {
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

	it("only the fresh flow asks Google for auth_time; the normal flow is unchanged", async () => {
		const normal = await startLogin();
		expect(normal.location.searchParams.get("claims")).toBeNull();
		expect(normal.location.searchParams.get("prompt")).toBe("select_account");
		const fresh = await startLogin(true);
		expect(
			JSON.parse(fresh.location.searchParams.get("claims") ?? "null"),
		).toEqual({
			id_token: { auth_time: { essential: true } },
		});
		expect(fresh.location.searchParams.get("prompt")).toBe("select_account");
	});

	it("a fresh sign-in stores the verified auth_time on the session; a normal one stores none", async () => {
		const email = `fr-${crypto.randomUUID().slice(0, 8)}@example.com`;
		await invite(email);
		const sub = uniqueSub();
		const before = Date.now();
		const ok = await signIn({ sub, email, fresh: true, authTime: -30 });
		expect(ok.location).toBe("/settings/security");
		const stored = await count(
			`SELECT s.fresh_google_at AS n FROM cadmus_sessions s JOIN cadmus_login_methods m ON m.id = s.login_method_id
       WHERE m.subject = ?1 ORDER BY s.created_at DESC LIMIT 1`,
			sub,
		);
		expect(stored).toBeGreaterThan(before - 31_000);
		expect(stored).toBeLessThan(Date.now());
		expect((await signIn({ sub, email })).location).toBe("/");
		expect(
			await count(
				`SELECT s.fresh_google_at IS NULL AS n FROM cadmus_sessions s JOIN cadmus_login_methods m ON m.id = s.login_method_id
         WHERE m.subject = ?1 ORDER BY s.created_at DESC LIMIT 1`,
				sub,
			),
		).toBe(1);
	});

	it("after a fresh sign-in the refresh cookie rotates into a signed-in access token, and the session keeps its auth_time", async () => {
		const email = `fs-${crypto.randomUUID().slice(0, 8)}@example.com`;
		const accountId = await invite(email, "account-admin");
		const sub = uniqueSub();
		const res = await signIn({ sub, email, fresh: true, authTime: -20 });
		expect(res.location).toBe("/settings/security");
		const cookie = /cadmus_refresh=([^;]+)/.exec(res.cookies)?.[1] ?? "";
		const refresh = (value: string) =>
			SELF.fetch(`${ORIGIN}/auth/refresh`, {
				method: "POST",
				headers: {
					origin: ORIGIN,
					"x-cadmus-refresh": "1",
					cookie: `__Secure-cadmus_refresh=${value}`,
				},
			});
		const refreshed = await refresh(cookie);
		expect(refreshed.status).toBe(200);
		const rotated = /cadmus_refresh=([^;]+)/.exec(
			refreshed.headers.get("set-cookie") ?? "",
		)?.[1];
		expect(rotated?.startsWith("cad_rt_")).toBe(true);
		expect(rotated).not.toBe(cookie);
		const { accessToken } = (await refreshed.json()) as { accessToken: string };
		const who = await SELF.fetch(`${ORIGIN}/api/auth/whoami`, {
			headers: { authorization: `Bearer ${accessToken}` },
		});
		const body = (await who.json()) as {
			principal: { accountId: string; role: string };
		};
		expect(body.principal).toMatchObject({ accountId, role: "account-admin" });
		// Rotation keeps the same session row, so the auth_time is still there.
		expect(
			await count(
				`SELECT s.fresh_google_at IS NOT NULL AS n FROM cadmus_sessions s JOIN cadmus_login_methods m ON m.id = s.login_method_id
         WHERE m.subject = ?1 AND s.revoked_at IS NULL ORDER BY s.created_at DESC LIMIT 1`,
				sub,
			),
		).toBe(1);
		// The old cookie is spent.
		expect((await refresh(cookie)).status).not.toBe(200);
	});

	it("a fresh sign-in fails closed on missing, stale, future or malformed auth_time and creates no session", async () => {
		const email = `fc-${crypto.randomUUID().slice(0, 8)}@example.com`;
		await invite(email);
		const cases: Array<[string, Parameters<typeof signIn>[0]]> = [
			[
				"auth_time_missing",
				{ sub: uniqueSub(), email, fresh: true, authTime: "none" },
			],
			[
				"auth_time_missing",
				{ sub: uniqueSub(), email, fresh: true, authTime: "string" },
			],
			[
				"auth_time_missing",
				{ sub: uniqueSub(), email, fresh: true, authTime: "float" },
			],
			[
				"auth_time_stale",
				{ sub: uniqueSub(), email, fresh: true, authTime: -400 },
			],
			[
				"auth_time_stale",
				{ sub: uniqueSub(), email, fresh: true, authTime: 300 },
			],
		];
		const sessions = await count(`SELECT COUNT(*) AS n FROM cadmus_sessions`);
		for (const [code, options] of cases) {
			const res = await signIn(options);
			expect(res.location, code).toBe(`/?auth_error=${code}`);
			expect(res.cookies, code).not.toContain("cadmus_refresh=cad_rt_");
		}
		expect(await count(`SELECT COUNT(*) AS n FROM cadmus_sessions`)).toBe(
			sessions,
		);
	});

	it("a normal sign-in ignores auth_time entirely", async () => {
		const email = `nm-${crypto.randomUUID().slice(0, 8)}@example.com`;
		await invite(email);
		expect(
			(await signIn({ sub: uniqueSub(), email, authTime: -4000 })).location,
		).toBe("/");
	});

	it("rejects a callback with no transaction cookie", async () => {
		const res = await SELF.fetch(
			`${ORIGIN}/auth/callback/google?code=abc&state=whatever`,
			{ redirect: "manual" },
		);
		expect(res.headers.get("location")).toBe("/?auth_error=bad_state");
	});

	it("a malformed transaction cookie redirects as bad_state", async () => {
		const res = await SELF.fetch(
			`${ORIGIN}/auth/callback/google?code=abc&state=whatever`,
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
			`${ORIGIN}/auth/callback/google?code=abc&state=${started.state}`,
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
			// First-login gate: nothing is created.
			const res = await login(sub, email, Date.now());
			expect(res).toMatchObject({ ok: false, code: "not_invited" });
			expect(
				await count(
					`SELECT COUNT(*) AS n FROM cadmus_login_methods WHERE subject = ?1`,
					sub,
				),
			).toBe(0);
			expect(
				await count(
					`SELECT COUNT(*) AS n FROM cadmus_users WHERE email = ?1`,
					email,
				),
			).toBe(0);
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
		expect(await login(uniqueSub(), email, now)).toMatchObject({
			ok: false,
			code: "not_invited",
		});
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
		expect(res).toMatchObject({ ok: false, code: "not_invited" });
		expect(
			await count(
				`SELECT COUNT(*) AS n FROM cadmus_users WHERE email = ?1`,
				email,
			),
		).toBe(0);
		expect(
			await count(
				`SELECT COUNT(*) AS n FROM cadmus_login_methods WHERE subject = ?1`,
				sub,
			),
		).toBe(0);
		expect(await members(accountId)).toEqual([]);
		// The replacement stays pending, so the next sign-in succeeds.
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

describe("linking a Google login (issue #3 phase 3, mocked Google)", () => {
	async function newUser(): Promise<{
		userId: string;
		accessToken: string;
		email: string;
		sub: string;
	}> {
		const email = `lnk-${crypto.randomUUID().slice(0, 8)}@example.com`;
		await invite(email);
		const sub = uniqueSub();
		const out = await signIn({ sub, email });
		const refresh = /(__Secure-cadmus_refresh=[^;]+)/.exec(out.cookies)?.[1];
		const res = await SELF.fetch(`${ORIGIN}/auth/refresh`, {
			method: "POST",
			headers: {
				origin: ORIGIN,
				"x-cadmus-refresh": "1",
				cookie: refresh ?? "",
			},
		});
		const accessToken = ((await res.json()) as { accessToken: string })
			.accessToken;
		const row = await env.CADMUS_ADMIN_DB.prepare(
			`SELECT user_id FROM cadmus_login_methods WHERE subject = ?1`,
		)
			.bind(sub)
			.first<{ user_id: string }>();
		return { userId: row?.user_id ?? "", accessToken, email, sub };
	}

	/** Runs a whole link flow for `sub`/`email` as the ticket's user. */
	async function link(
		ticket: string,
		bind: string | undefined,
		identity: { sub: string; email: string },
	): Promise<{ startStatus: number; startLocation: string; end?: Outcome }> {
		const start = await SELF.fetch(
			`${ORIGIN}/auth/login/google?link=${encodeURIComponent(ticket)}`,
			{
				redirect: "manual",
				headers: bind ? { cookie: `${LINK_BIND_COOKIE}=${bind}` } : {},
			},
		);
		// Both the refused (bad ticket) and the accepted start are uncacheable.
		expect(start.headers.get("cache-control")).toBe("no-store");
		const startLocation = start.headers.get("location") ?? "";
		if (!startLocation.startsWith("https://accounts.google.com")) {
			return { startStatus: start.status, startLocation };
		}
		const loc = new URL(startLocation);
		const cookie = start.headers.get("set-cookie") ?? "";
		const txnCookie = /(__Secure-cadmus_txn=[^;]+)/.exec(cookie)?.[1] ?? "";
		nextIdToken = await signIdToken({
			iss: "https://accounts.google.com",
			aud: CLIENT_ID,
			sub: identity.sub,
			email: identity.email,
			email_verified: true,
			nonce: loc.searchParams.get("nonce"),
			exp: Math.floor(Date.now() / 1000) + 600,
		});
		const res = await SELF.fetch(
			`${ORIGIN}/auth/callback/google?code=abc&state=${loc.searchParams.get("state")}`,
			{ redirect: "manual", headers: { cookie: txnCookie } },
		);
		// Every link outcome, linked or link_error, is uncacheable.
		expect(res.headers.get("cache-control")).toBe("no-store");
		return {
			startStatus: start.status,
			startLocation,
			end: {
				status: res.status,
				location: res.headers.get("location") ?? "",
				cookies: res.headers.get("set-cookie") ?? "",
			},
		};
	}

	const sessionOf = async (userId: string) =>
		(
			await env.CADMUS_ADMIN_DB.prepare(
				`SELECT id FROM cadmus_sessions WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 1`,
			)
				.bind(userId)
				.first<{ id: string }>()
		)?.id ?? "";
	const methodCount = (userId: string) =>
		count(
			`SELECT count(*) AS n FROM cadmus_login_methods WHERE user_id = ?1 AND revoked_at IS NULL`,
			userId,
		);
	const sessionCount = () => count(`SELECT count(*) AS n FROM cadmus_sessions`);
	const userCount = () => count(`SELECT count(*) AS n FROM cadmus_users`);

	it("attaches a new Google identity to the signed-in user without a new session or user", async () => {
		const u = await newUser();
		const started = await rpc(u.accessToken, "auth.methods.link.start", {
			provider: "google",
		});
		expect(started.ok).toBe(true);
		const { ticket, bind } = started.result as { ticket: string; bind: string };
		const before = { s: await sessionCount(), u: await userCount() };
		const second = { sub: uniqueSub(), email: "other-address@example.org" };
		const out = await link(ticket, bind, second);
		expect(out.startStatus).toBe(302);
		expect(out.end?.location).toBe("/settings/security?linked=google");
		// No session minted or changed, no refresh cookie, no new user.
		expect(out.end?.cookies).not.toContain("cadmus_refresh=");
		expect(await sessionCount()).toBe(before.s);
		expect(await userCount()).toBe(before.u);
		expect(await methodCount(u.userId)).toBe(2);
		const linked = await env.CADMUS_ADMIN_DB.prepare(
			`SELECT user_id FROM cadmus_login_methods WHERE subject = ?1`,
		)
			.bind(second.sub)
			.first<{ user_id: string }>();
		expect(linked?.user_id).toBe(u.userId);
		// Linking the same identity again is idempotent.
		const again = await rpc(u.accessToken, "auth.methods.link.start", {
			provider: "google",
		});
		const r2 = again.result as { ticket: string; bind: string };
		expect((await link(r2.ticket, r2.bind, second)).end?.location).toBe(
			"/settings/security?linked=google",
		);
		expect(await methodCount(u.userId)).toBe(2);
	});

	it("never merges users on an email match: the identity attaches to the ticket's user only", async () => {
		const a = await newUser();
		const b = await newUser();
		const { ticket, bind } = (
			await rpc(a.accessToken, "auth.methods.link.start", {
				provider: "google",
			})
		).result as { ticket: string; bind: string };
		const sub = uniqueSub();
		const out = await link(ticket, bind, { sub, email: b.email });
		expect(out.end?.location).toBe("/settings/security?linked=google");
		const row = await env.CADMUS_ADMIN_DB.prepare(
			`SELECT user_id FROM cadmus_login_methods WHERE subject = ?1`,
		)
			.bind(sub)
			.first<{ user_id: string }>();
		expect(row?.user_id).toBe(a.userId);
		expect(await methodCount(b.userId)).toBe(1);
	});

	it("refuses an identity that already belongs to another user, and changes nothing", async () => {
		const a = await newUser();
		const b = await newUser();
		const { ticket, bind } = (
			await rpc(a.accessToken, "auth.methods.link.start", {
				provider: "google",
			})
		).result as { ticket: string; bind: string };
		const out = await link(ticket, bind, { sub: b.sub, email: b.email });
		expect(out.end?.location).toBe(
			"/settings/security?link_error=method_in_use",
		);
		expect(await methodCount(a.userId)).toBe(1);
		expect(await methodCount(b.userId)).toBe(1);
	});

	it("refuses a revoked identity of the same user", async () => {
		const a = await newUser();
		const sub = uniqueSub();
		const { ticket, bind } = (
			await rpc(a.accessToken, "auth.methods.link.start", {
				provider: "google",
			})
		).result as { ticket: string; bind: string };
		expect(
			(await link(ticket, bind, { sub, email: a.email })).end?.location,
		).toBe("/settings/security?linked=google");
		await env.CADMUS_ADMIN_DB.prepare(
			`UPDATE cadmus_login_methods SET revoked_at = ?2 WHERE subject = ?1`,
		)
			.bind(sub, Date.now())
			.run();
		const again = (
			await rpc(a.accessToken, "auth.methods.link.start", {
				provider: "google",
			})
		).result as { ticket: string; bind: string };
		expect(
			(await link(again.ticket, again.bind, { sub, email: a.email })).end
				?.location,
		).toBe("/settings/security?link_error=login_method_revoked");
	});

	it("refuses a missing, wrong, tampered or expired ticket or bind cookie before Google is contacted", async () => {
		const a = await newUser();
		const { ticket, bind } = (
			await rpc(a.accessToken, "auth.methods.link.start", {
				provider: "google",
			})
		).result as { ticket: string; bind: string };
		const sid = await sessionOf(a.userId);
		const expired = await signLinkTicket(
			env,
			a.userId,
			sid,
			Date.now() - 600_000,
		);
		const cases: Array<[string, string, string | undefined]> = [
			["no bind cookie", ticket, undefined],
			["wrong bind cookie", ticket, "not-the-bind"],
			["tampered ticket", `${ticket.slice(0, -2)}xx`, bind],
			["garbage ticket", "garbage", bind],
			["expired ticket", expired.ticket, expired.bind],
		];
		for (const [label, t, b] of cases) {
			const out = await link(t, b, { sub: uniqueSub(), email: a.email });
			expect(out.startStatus, label).toBe(302);
			expect(out.startLocation, label).toBe(
				"/settings/security?link_error=bad_ticket",
			);
			expect(out.end, label).toBeUndefined();
		}
		expect(await methodCount(a.userId)).toBe(1);
	});

	it("link.start needs a signed-in user session: the master token and a missing token are refused, a session works", async () => {
		const u = await newUser();
		const ok = await rpc(u.accessToken, "auth.methods.link.start", {
			provider: "google",
		});
		expect(ok.ok).toBe(true);
		const master = await rpc(
			env.CADMUS_AUTH_SECRET || "dev-cadmus-secret",
			"auth.methods.link.start",
			{ provider: "google" },
		);
		expect(master.ok).toBe(false);
		expect(master.error?.code).toBe("forbidden");
		const none = await rpc("not-a-token", "auth.methods.link.start", {
			provider: "google",
		});
		expect(none.ok).not.toBe(true);
		expect(none.result).toBeUndefined();
	});

	it("a plain Google sign-in still creates a session and refresh cookie (control)", async () => {
		const email = `plain-${crypto.randomUUID().slice(0, 8)}@example.com`;
		await invite(email);
		const out = await signIn({ sub: uniqueSub(), email });
		expect(out.location).toBe("/");
		expect(out.cookies).toContain("cadmus_refresh=");
	});

	it("audits a new link as method.link naming the method, and a repeat adds no row", async () => {
		const a = await newUser();
		const sub = uniqueSub();
		const go = async () => {
			const r = (
				await rpc(a.accessToken, "auth.methods.link.start", {
					provider: "google",
				})
			).result as { ticket: string; bind: string };
			return link(r.ticket, r.bind, { sub, email: a.email });
		};
		expect((await go()).end?.location).toBe("/settings/security?linked=google");
		const method = await env.CADMUS_ADMIN_DB.prepare(
			`SELECT id FROM cadmus_login_methods WHERE subject = ?1`,
		)
			.bind(sub)
			.first<{ id: string }>();
		const rows = async () =>
			count(
				`SELECT count(*) AS n FROM cadmus_audit WHERE action = 'method.link' AND actor_user_id = ?1 AND target = ?2`,
				a.userId,
				method?.id,
			);
		expect(await rows()).toBe(1);
		await go();
		expect(await rows()).toBe(1);
	});

	it("refuses to link when the initiating session ended before the callback, and writes nothing", async () => {
		const a = await newUser();
		const { ticket, bind } = (
			await rpc(a.accessToken, "auth.methods.link.start", {
				provider: "google",
			})
		).result as { ticket: string; bind: string };
		await env.CADMUS_ADMIN_DB.prepare(
			`UPDATE cadmus_sessions SET revoked_at = ?2 WHERE id = ?1`,
		)
			.bind(await sessionOf(a.userId), Date.now())
			.run();
		const sub = uniqueSub();
		const out = await link(ticket, bind, { sub, email: a.email });
		expect(out.end?.location).toBe(
			"/settings/security?link_error=session_ended",
		);
		expect(
			await count(
				`SELECT count(*) AS n FROM cadmus_login_methods WHERE subject = ?1`,
				sub,
			),
		).toBe(0);
		expect(
			await count(
				`SELECT count(*) AS n FROM cadmus_audit WHERE action = 'method.link' AND actor_user_id = ?1`,
				a.userId,
			),
		).toBe(0);
	});

	it("audits method.link in the initiating session's account, also for a multi-account user and one with no membership", async () => {
		const a = await newUser();
		const sid = await sessionOf(a.userId);
		const sessionAccount = (
			await env.CADMUS_ADMIN_DB.prepare(
				`SELECT account_id FROM cadmus_sessions WHERE id = ?1`,
			)
				.bind(sid)
				.first<{ account_id: string }>()
		)?.account_id;
		// A second membership that sorts before the session's account.
		const other = await env.CADMUS_ADMIN_DB.prepare(
			`SELECT id FROM cadmus_accounts WHERE id <> ?1 LIMIT 1`,
		)
			.bind(sessionAccount)
			.first<{ id: string }>();
		expect(other?.id).toBeTruthy();
		await env.CADMUS_ADMIN_DB.prepare(
			`INSERT OR IGNORE INTO cadmus_account_members (account_id, user_id, role, created_at) VALUES (?1, ?2, 'user', 1)`,
		)
			.bind(other?.id, a.userId)
			.run();
		const audited = (sub: string) =>
			env.CADMUS_ADMIN_DB.prepare(
				`SELECT a.account_id FROM cadmus_audit a JOIN cadmus_login_methods m ON m.id = a.target
         WHERE a.action = 'method.link' AND m.subject = ?1`,
			)
				.bind(sub)
				.first<{ account_id: string }>();
		const start = async () =>
			(
				await rpc(a.accessToken, "auth.methods.link.start", {
					provider: "google",
				})
			).result as { ticket: string; bind: string };
		const t1 = await start();
		const sub1 = uniqueSub();
		await link(t1.ticket, t1.bind, { sub: sub1, email: a.email });
		const first = await audited(sub1);
		expect(first?.account_id).toBe(sessionAccount);
		expect(first?.account_id).not.toBe(other?.id);
		// Membership removed between start and callback: the link is still audited,
		// in the initiating session's account.
		const t2 = await start();
		await env.CADMUS_ADMIN_DB.prepare(
			`DELETE FROM cadmus_account_members WHERE user_id = ?1`,
		)
			.bind(a.userId)
			.run();
		const sub2 = uniqueSub();
		await link(t2.ticket, t2.bind, { sub: sub2, email: a.email });
		const second = await audited(sub2);
		expect(second?.account_id).toBe(sessionAccount);
	});

	it("refuses an idle-expired or absolute-expired initiating session", async () => {
		for (const column of ["idle_expires_at", "absolute_expires_at"]) {
			const a = await newUser();
			const { ticket, bind } = (
				await rpc(a.accessToken, "auth.methods.link.start", {
					provider: "google",
				})
			).result as { ticket: string; bind: string };
			await env.CADMUS_ADMIN_DB.prepare(
				`UPDATE cadmus_sessions SET ${column} = ?2 WHERE id = ?1`,
			)
				.bind(await sessionOf(a.userId), Date.now() - 1000)
				.run();
			const sub = uniqueSub();
			const out = await link(ticket, bind, { sub, email: a.email });
			expect(out.end?.location, column).toBe(
				"/settings/security?link_error=session_ended",
			);
			expect(
				await count(
					`SELECT count(*) AS n FROM cadmus_login_methods WHERE subject = ?1`,
					sub,
				),
				column,
			).toBe(0);
		}
	});

	it("refuses a disabled user at the callback", async () => {
		const a = await newUser();
		const { ticket, bind } = (
			await rpc(a.accessToken, "auth.methods.link.start", {
				provider: "google",
			})
		).result as { ticket: string; bind: string };
		await env.CADMUS_ADMIN_DB.prepare(
			`UPDATE cadmus_users SET disabled_at = ?2 WHERE id = ?1`,
		)
			.bind(a.userId, Date.now())
			.run();
		const out = await link(ticket, bind, { sub: uniqueSub(), email: a.email });
		expect(out.end?.location).toBe(
			"/settings/security?link_error=user_disabled",
		);
	});

	it("an API-token session is refused link.start (control: the user session works)", async () => {
		const u = await newUser();
		const pat = await rpc(u.accessToken, "auth.tokens.create", {
			kind: "pat",
			label: "link test",
			grants: ["tokens.self"],
			ttlDays: 1,
		});
		expect(pat.ok).toBe(true);
		const login = await SELF.fetch(`${ORIGIN}/auth/token-login`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${(pat.result as unknown as { token: string }).token}`,
			},
		});
		expect(login.status).toBe(200);
		const tokenSession = ((await login.json()) as { accessToken: string })
			.accessToken;
		const refused = await rpc(tokenSession, "auth.methods.link.start", {
			provider: "google",
		});
		expect(refused.ok).toBe(false);
		expect(refused.error?.code).toBe("forbidden");
		const control = await rpc(u.accessToken, "auth.methods.link.start", {
			provider: "google",
		});
		expect(control.ok).toBe(true);
	});

	it("keeps ticket and login transaction apart, and rejects a ticket with another purpose", async () => {
		const a = await newUser();
		const { ticket, bind } = (
			await rpc(a.accessToken, "auth.methods.link.start", {
				provider: "google",
			})
		).result as { ticket: string; bind: string };
		// A login transaction cookie value is not a link ticket.
		const plain = await SELF.fetch(`${ORIGIN}/auth/login/google`, {
			redirect: "manual",
		});
		const txn = /__Secure-cadmus_txn=([^;]+)/.exec(
			plain.headers.get("set-cookie") ?? "",
		)?.[1];
		const asTicket = await link(txn ?? "", bind, {
			sub: uniqueSub(),
			email: a.email,
		});
		expect(asTicket.startLocation).toBe(
			"/settings/security?link_error=bad_ticket",
		);
		// A link ticket is not a login transaction: the callback has no valid txn.
		const cb = await SELF.fetch(
			`${ORIGIN}/auth/callback/google?code=abc&state=x`,
			{
				redirect: "manual",
				headers: { cookie: `__Secure-cadmus_txn=${ticket}` },
			},
		);
		expect(cb.headers.get("location")).toBe("/?auth_error=bad_state");
		// Same key, same shape, other purpose: refused by the purpose check.
		const body = ticket.split(".")[0] ?? "";
		const forged = JSON.parse(fromBase64UrlString(body)) as Record<
			string,
			unknown
		>;
		forged.purpose = "login";
		const forgedBody = enc(forged);
		const key = await crypto.subtle.importKey(
			"raw",
			new TextEncoder().encode(
				`cadmus-auth-txn:${env.CADMUS_ENCRYPTION_KEY ?? "dev"}`,
			),
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["sign"],
		);
		const sig = await crypto.subtle.sign(
			"HMAC",
			key,
			new TextEncoder().encode(`link.${forgedBody}`),
		);
		const other = await link(
			`${forgedBody}.${toBase64Url(new Uint8Array(sig))}`,
			bind,
			{
				sub: uniqueSub(),
				email: a.email,
			},
		);
		expect(other.startLocation).toBe(
			"/settings/security?link_error=bad_ticket",
		);
		// Control: the untouched ticket and bind still link.
		const ok = await link(ticket, bind, { sub: uniqueSub(), email: a.email });
		expect(ok.end?.location).toBe("/settings/security?linked=google");
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
		// The success cleared the earlier failures. A second Google identity for the
		// same email has no invite, so each of these is a refusal: the full budget is
		// available again, and the one after it is locked.
		for (let i = 1; i <= LOCKOUT_MAX_FAILURES; i++) {
			const out = await signIn({ sub: uniqueSub(), email: third });
			expect(out.location, `post-success refusal ${i}`).toBe(
				"/?auth_error=not_invited",
			);
		}
		expect((await signIn({ sub: uniqueSub(), email: third })).location).toBe(
			"/?auth_error=locked_out",
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
			`${ORIGIN}/auth/callback/google?code=abc&state=${started.state}`,
			{ redirect: "manual", headers: { cookie: started.txnCookie } },
		);
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("/?auth_error=bad_id_token");
	});
});
