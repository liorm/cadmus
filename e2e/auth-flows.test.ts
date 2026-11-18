import { describe, expect, it } from "vitest";
import {
	addMemberBearer,
	BOOTSTRAP_EMAIL,
	cookiePair,
	DEV_PASSWORD,
	elevateAccessToken,
	loginDevPassword,
	provisionInvitedMember,
	sendRpc,
	setCookieLines,
	useWorkerFixture,
	WORKER_BASE_URL,
	workerFetch,
} from "./helpers.js";

/**
 * Black-box auth: Google (mocked at egress), invites, refresh rotation and
 * reuse, token login, and the phase 6 empty tenant. Bootstrap is claimed by
 * dev-password first. Google never signs in as the bootstrap email, because
 * that claim is one-shot and a Google subject is a different login method.
 */
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_CLIENT_ID = "test-google-client.apps.googleusercontent.com";
const REFRESH_COOKIE = "__Secure-cadmus_refresh";
const TXN_COOKIE = "__Secure-cadmus_txn";
const KID = "e2e-google-key";

const originalFetch = globalThis.fetch;
let privateKey: CryptoKey | undefined;
let publicJwk: JsonWebKey | undefined;

function b64url(bytes: Uint8Array): string {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function enc(value: unknown): string {
	return b64url(new TextEncoder().encode(JSON.stringify(value)));
}

async function signingKey(): Promise<CryptoKey> {
	if (privateKey && publicJwk) return privateKey;
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
	return privateKey;
}

async function signIdToken(claims: Record<string, unknown>): Promise<string> {
	const key = await signingKey();
	const head = enc({ alg: "RS256", kid: KID, typ: "JWT" });
	const body = enc(claims);
	const sig = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		key,
		new TextEncoder().encode(`${head}.${body}`),
	);
	return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
}

interface GoogleOutcome {
	status: number;
	location: string;
	refresh: string;
}

async function withGoogleEgress<T>(
	run: (
		signIn: (options: GoogleSignIn) => Promise<GoogleOutcome>,
	) => Promise<T>,
): Promise<T> {
	await signingKey();
	let nextIdToken = "";
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
				keys: [{ ...publicJwk, kid: KID, alg: "RS256", use: "sig" }],
			});
		}
		return originalFetch(input, init);
	};
	try {
		return await run(async (options) => {
			nextIdToken = await signIdToken(await claimsFor(options));
			return callback(options);
		});
	} finally {
		globalThis.fetch = originalFetch;
	}
}

interface GoogleSignIn {
	email: string;
	sub: string;
	emailVerified?: boolean;
	nonce?: (real: string) => string;
	aud?: string;
	expOffsetSec?: number;
	state?: (real: string) => string;
}

async function claimsFor(
	options: GoogleSignIn,
): Promise<Record<string, unknown>> {
	const started = await startGoogle();
	pendingStart = started;
	return {
		iss: "https://accounts.google.com",
		aud: options.aud ?? GOOGLE_CLIENT_ID,
		sub: options.sub,
		email: options.email,
		email_verified: options.emailVerified ?? true,
		name: "Test Person",
		nonce: options.nonce ? options.nonce(started.nonce) : started.nonce,
		exp: Math.floor(Date.now() / 1000) + (options.expOffsetSec ?? 600),
	};
}

interface Started {
	state: string;
	nonce: string;
	txn: string;
}

let pendingStart: Started | undefined;

async function startGoogle(): Promise<Started> {
	const res = await workerFetch(
		`${WORKER_BASE_URL}/api/auth/login/google/start`,
		{
			redirect: "manual",
		},
	);
	expect(res.status).toBe(302);
	const location = new URL(res.headers.get("location") ?? "", WORKER_BASE_URL);
	expect(location.hostname).toBe("accounts.google.com");
	const txn = cookiePair(setCookieLines(res), TXN_COOKIE);
	expect(txn.startsWith(`${TXN_COOKIE}=`)).toBe(true);
	return {
		state: location.searchParams.get("state") ?? "",
		nonce: location.searchParams.get("nonce") ?? "",
		txn,
	};
}

async function callback(options: GoogleSignIn): Promise<GoogleOutcome> {
	const started = pendingStart;
	if (!started) throw new Error("google login was not started");
	pendingStart = undefined;
	const state = options.state ? options.state(started.state) : started.state;
	const res = await workerFetch(
		`${WORKER_BASE_URL}/api/auth/login/google/callback?code=abc&state=${encodeURIComponent(state)}`,
		{ redirect: "manual", headers: { cookie: started.txn } },
	);
	return {
		status: res.status,
		location: res.headers.get("location") ?? "",
		refresh: cookiePair(setCookieLines(res), REFRESH_COOKIE),
	};
}

async function refresh(cookie: string): Promise<{
	status: number;
	accessToken: string;
	cookie: string;
}> {
	const res = await workerFetch(`${WORKER_BASE_URL}/api/auth/session/refresh`, {
		method: "POST",
		headers: {
			Origin: WORKER_BASE_URL,
			"X-Cadmus-Refresh": "1",
			Cookie: cookie,
		},
	});
	const text = await res.text();
	let accessToken = "";
	if (res.ok) {
		accessToken =
			(JSON.parse(text) as { accessToken?: string }).accessToken ?? "";
	}
	return {
		status: res.status,
		accessToken,
		cookie: cookiePair(setCookieLines(res), REFRESH_COOKIE),
	};
}

async function whoami(token: string): Promise<{
	userId?: string;
	role?: string;
	accountId?: string;
	viaToken?: boolean;
}> {
	const who = await sendRpc<{
		principal: {
			userId?: string;
			role?: string;
			accountId?: string;
			viaToken?: boolean;
		};
	}>("auth.whoami", {}, { token });
	expect(who.frame.ok, JSON.stringify(who.frame)).toBe(true);
	return who.frame.result?.principal ?? {};
}

describe("auth flows (google, invites, sessions, phase 6)", () => {
	useWorkerFixture();

	it("claims bootstrap once through dev-password and attaches Google for that email", async () => {
		const first = await loginDevPassword();
		const second = await loginDevPassword();
		const a = await whoami(first.accessToken);
		const b = await whoami(second.accessToken);
		expect(a.role).toBe("super-admin");
		expect(a.userId).toBe(b.userId);
		await withGoogleEgress(async (signIn) => {
			const outcome = await signIn({
				email: BOOTSTRAP_EMAIL,
				sub: `g-${crypto.randomUUID()}`,
			});
			expect(outcome.status).toBe(302);
			expect(outcome.location).toBe("/");
			expect(outcome.refresh.startsWith(`${REFRESH_COOKIE}=cad_rt_`)).toBe(
				true,
			);
			const rotated = await refresh(outcome.refresh);
			expect((await whoami(rotated.accessToken)).userId).toBe(a.userId);
		});
		const third = await whoami((await loginDevPassword()).accessToken);
		expect(third.userId).toBe(a.userId);
	});

	it("refuses a bad Google nonce, state, audience, expiry, or unverified email", async () => {
		await withGoogleEgress(async (signIn) => {
			const cases: Array<{
				name: string;
				options: GoogleSignIn;
				code: string;
			}> = [
				{
					name: "nonce",
					code: "bad_nonce",
					options: {
						email: `n-${crypto.randomUUID()}@example.com`,
						sub: `g-${crypto.randomUUID()}`,
						nonce: () => "wrong-nonce",
					},
				},
				{
					name: "state",
					code: "bad_state",
					options: {
						email: `s-${crypto.randomUUID()}@example.com`,
						sub: `g-${crypto.randomUUID()}`,
						state: () => "wrong-state",
					},
				},
				{
					name: "audience",
					code: "bad_audience",
					options: {
						email: `a-${crypto.randomUUID()}@example.com`,
						sub: `g-${crypto.randomUUID()}`,
						aud: "someone-else.apps.googleusercontent.com",
					},
				},
				{
					name: "expiry",
					code: "token_expired",
					options: {
						email: `e-${crypto.randomUUID()}@example.com`,
						sub: `g-${crypto.randomUUID()}`,
						expOffsetSec: -600,
					},
				},
				{
					name: "unverified",
					code: "email_not_verified",
					options: {
						email: `u-${crypto.randomUUID()}@example.com`,
						sub: `g-${crypto.randomUUID()}`,
						emailVerified: false,
					},
				},
			];
			for (const item of cases) {
				const outcome = await signIn(item.options);
				expect(outcome.status, item.name).toBe(302);
				expect(outcome.location, item.name).toContain(
					`auth_error=${item.code}`,
				);
				expect(outcome.refresh, item.name).toBe("");
			}
		});
	});

	it("does not create a user for an uninvited Google email", async () => {
		const email = `stranger-${crypto.randomUUID()}@example.com`;
		await withGoogleEgress(async (signIn) => {
			const outcome = await signIn({
				email,
				sub: `g-${crypto.randomUUID()}`,
			});
			expect(outcome.location).toContain("auth_error=not_invited");
			expect(outcome.refresh).toBe("");
		});
		const res = await workerFetch(
			"http://127.0.0.1/api/auth/login/devPassword",
			{
				method: "POST",
				headers: {
					Origin: "http://127.0.0.1",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					id: "dev",
					type: "auth.login.devPassword",
					payload: { email, password: DEV_PASSWORD },
				}),
			},
		);
		expect(res.status).toBe(401);
		expect(await res.text()).toContain("not_invited");
	});

	it("accepts an invited user through Google", async () => {
		const email = `invited-${crypto.randomUUID()}@example.com`;
		const boss = await loginDevPassword();
		await elevateAccessToken(boss.accessToken);
		const created = await sendRpc<{ account: { id: string } }>(
			"system.accounts.create",
			{
				name: `Invite ${crypto.randomUUID().slice(0, 8)}`,
				ownerEmail: `owner-${crypto.randomUUID()}@example.com`,
			},
			{ token: boss.accessToken },
		);
		expect(created.frame.ok, JSON.stringify(created.frame)).toBe(true);
		const accountId = created.frame.result?.account.id ?? "";
		const invite = await sendRpc(
			"system.members.invite",
			{ accountId, email, role: "user" },
			{ token: boss.accessToken },
		);
		expect(invite.frame.ok, JSON.stringify(invite.frame)).toBe(true);
		await withGoogleEgress(async (signIn) => {
			const outcome = await signIn({
				email,
				sub: `g-${crypto.randomUUID()}`,
			});
			expect(outcome.status).toBe(302);
			expect(outcome.location).toBe("/");
			expect(outcome.refresh.startsWith(`${REFRESH_COOKIE}=`)).toBe(true);
			const turned = await refresh(outcome.refresh);
			expect(turned.status).toBe(200);
			const principal = await whoami(turned.accessToken);
			expect(principal.role).toBe("user");
			expect(principal.accountId).toBe(accountId);
		});
	});

	it("rotates a refresh cookie and revokes the session family on reuse", async () => {
		const member = await provisionInvitedMember({ role: "user" });
		const session = await loginDevPassword(member.email);
		const first = await refresh(session.refreshCookie);
		expect(first.status).toBe(200);
		expect(first.accessToken.startsWith("cad_at_")).toBe(true);
		expect(first.cookie.startsWith(`${REFRESH_COOKIE}=`)).toBe(true);
		const replay = await refresh(session.refreshCookie);
		expect(replay.status).toBe(401);
		const rotated = await refresh(first.cookie);
		expect(rotated.status).toBe(401);
		const dead = await sendRpc("auth.whoami", {}, { token: first.accessToken });
		expect(dead.frame.ok).toBe(false);
		expect(dead.frame.error?.code).toBe("unauthorized");
	});

	it("exchanges a cad_pat_ at /api/auth/login/token and clamps the session", async () => {
		const tenant = await provisionInvitedMember({ role: "user" });
		const bearer = await addMemberBearer({ accountId: tenant.accountId });
		expect(bearer.token.startsWith("cad_pat_")).toBe(true);
		const viaQuery = await workerFetch(
			`${WORKER_BASE_URL}/api/auth/login/token?token=hidden`,
			{
				method: "POST",
				headers: { Authorization: `Bearer ${bearer.token}` },
			},
		);
		expect(viaQuery.status).toBe(401);
		const login = await workerFetch(`${WORKER_BASE_URL}/api/auth/login/token`, {
			method: "POST",
			headers: { Authorization: `Bearer ${bearer.token}` },
		});
		expect(login.status).toBe(200);
		const body = (await login.json()) as { accessToken?: string };
		expect(body.accessToken?.startsWith("cad_at_")).toBe(true);
		const principal = await whoami(body.accessToken ?? "");
		expect(principal.viaToken).toBe(true);
		expect(principal.accountId).toBe(tenant.accountId);
		const chat = await sendRpc("chat.list", {}, { token: body.accessToken });
		expect(chat.frame.ok, JSON.stringify(chat.frame)).toBe(true);
		const bots = await sendRpc("bot.list", {}, { token: body.accessToken });
		expect(bots.frame.ok).toBe(false);
		expect(bots.frame.error?.code).toBe("forbidden");
	});

	it("phase 6: an invited account-admin signs in to an empty tenant", async () => {
		const admin = await provisionInvitedMember({ role: "account-admin" });
		const read = async () => {
			const bots = await sendRpc<{ bots: unknown[] }>(
				"bot.list",
				{},
				{ token: admin.accessToken },
			);
			const account = await sendRpc<{
				account: { id: string; name: string };
			}>("account.get", {}, { token: admin.accessToken });
			expect(bots.frame.ok, JSON.stringify(bots.frame)).toBe(true);
			expect(bots.frame.result?.bots).toEqual([]);
			expect(account.frame.ok, JSON.stringify(account.frame)).toBe(true);
			expect(account.frame.result?.account.id).toBe(admin.accountId);
			expect(account.frame.result?.account.name).toBe(admin.accountName);
		};
		await read();
		await read();
	});

	it("phase 6: the same empty tenant holds after a Google sign-in", async () => {
		const boss = await loginDevPassword();
		await elevateAccessToken(boss.accessToken);
		const accountName = `Empty ${crypto.randomUUID().slice(0, 8)}`;
		const created = await sendRpc<{ account: { id: string; name: string } }>(
			"system.accounts.create",
			{
				name: accountName,
				ownerEmail: `owner-${crypto.randomUUID()}@example.com`,
			},
			{ token: boss.accessToken },
		);
		expect(created.frame.ok, JSON.stringify(created.frame)).toBe(true);
		const accountId = created.frame.result?.account.id ?? "";
		const email = `admin-${crypto.randomUUID()}@example.com`;
		const invite = await sendRpc(
			"system.members.invite",
			{ accountId, email, role: "account-admin" },
			{ token: boss.accessToken },
		);
		expect(invite.frame.ok, JSON.stringify(invite.frame)).toBe(true);
		await withGoogleEgress(async (signIn) => {
			const outcome = await signIn({
				email,
				sub: `g-${crypto.randomUUID()}`,
			});
			expect(outcome.location).toBe("/");
			const turned = await refresh(outcome.refresh);
			expect(turned.status).toBe(200);
			const read = async () => {
				const bots = await sendRpc<{ bots: unknown[] }>(
					"bot.list",
					{},
					{ token: turned.accessToken },
				);
				const account = await sendRpc<{
					account: { id: string; name: string };
				}>("account.get", {}, { token: turned.accessToken });
				expect(bots.frame.result?.bots).toEqual([]);
				expect(account.frame.result?.account.name).toBe(accountName);
				expect(account.frame.result?.account.id).toBe(accountId);
			};
			await read();
			await read();
		});
	});
});
