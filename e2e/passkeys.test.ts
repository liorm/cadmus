import { describe, expect, it } from "vitest";
import {
	cookiePair,
	elevateAccessToken,
	loginDevPassword,
	sendRpc,
	setCookieLines,
	type PasskeyAssertionJson,
	type PasskeyRegistrationJson,
	TestPasskey,
	useWorkerFixture,
	WORKER_BASE_URL,
	workerFetch,
} from "./helpers.js";

/**
 * Black-box passkey ceremonies. The authenticator is a P-256 key in the test;
 * verification stays inside the Worker. Enrollment needs a fresh Google
 * sign-in (`/auth/login/google?fresh=1` with a recent auth_time).
 */
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_CLIENT_ID = "test-google-client.apps.googleusercontent.com";
const REFRESH_COOKIE = "__Secure-cadmus_refresh";
const TXN_COOKIE = "__Secure-cadmus_txn";
const KID = "e2e-passkey-google-key";

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

interface Started {
	state: string;
	nonce: string;
	txn: string;
}

async function freshGoogleSession(input: {
	email: string;
	sub: string;
}): Promise<string> {
	await signingKey();
	let nextIdToken = "";
	globalThis.fetch = async (request, init) => {
		const url =
			typeof request === "string"
				? request
				: request instanceof URL
					? request.toString()
					: request.url;
		if (url === GOOGLE_TOKEN_URL) return Response.json({ id_token: nextIdToken });
		if (url === GOOGLE_JWKS_URL) {
			return Response.json({
				keys: [{ ...publicJwk, kid: KID, alg: "RS256", use: "sig" }],
			});
		}
		return originalFetch(request, init);
	};
	try {
		const start = await workerFetch(
			`${WORKER_BASE_URL}/auth/login/google?fresh=1`,
			{ redirect: "manual" },
		);
		expect(start.status).toBe(302);
		const location = new URL(
			start.headers.get("location") ?? "",
			WORKER_BASE_URL,
		);
		const started: Started = {
			state: location.searchParams.get("state") ?? "",
			nonce: location.searchParams.get("nonce") ?? "",
			txn: cookiePair(setCookieLines(start), TXN_COOKIE),
		};
		expect(started.state).not.toBe("");
		expect(started.nonce).not.toBe("");
		nextIdToken = await signIdToken({
			iss: "https://accounts.google.com",
			aud: GOOGLE_CLIENT_ID,
			sub: input.sub,
			email: input.email,
			email_verified: true,
			name: "Passkey Person",
			nonce: started.nonce,
			auth_time: Math.floor(Date.now() / 1000),
			exp: Math.floor(Date.now() / 1000) + 600,
		});
		const back = await workerFetch(
			`${WORKER_BASE_URL}/auth/callback/google?code=abc&state=${encodeURIComponent(started.state)}`,
			{ redirect: "manual", headers: { cookie: started.txn } },
		);
		expect(back.status, await back.clone().text()).toBe(302);
		expect(back.headers.get("location")).toBe("/settings/security");
		const refresh = cookiePair(setCookieLines(back), REFRESH_COOKIE);
		const turned = await workerFetch(`${WORKER_BASE_URL}/auth/refresh`, {
			method: "POST",
			headers: {
				Origin: WORKER_BASE_URL,
				"X-Cadmus-Refresh": "1",
				Cookie: refresh,
			},
		});
		expect(turned.status, await turned.clone().text()).toBe(200);
		const body = (await turned.json()) as { accessToken?: string };
		expect(body.accessToken?.startsWith("cad_at_")).toBe(true);
		return body.accessToken ?? "";
	} finally {
		globalThis.fetch = originalFetch;
	}
}

async function inviteAccountAdmin(): Promise<{ email: string }> {
	const boss = await loginDevPassword();
	await elevateAccessToken(boss.accessToken);
	const created = await sendRpc<{ account: { id: string } }>(
		"system.accounts.create",
		{ name: `Passkey ${crypto.randomUUID().slice(0, 8)}` },
		{ token: boss.accessToken },
	);
	expect(created.frame.ok, JSON.stringify(created.frame)).toBe(true);
	const email = `pk-${crypto.randomUUID()}@example.com`;
	const invite = await sendRpc(
		"system.members.invite",
		{
			accountId: created.frame.result?.account.id ?? "",
			email,
			role: "account-admin",
		},
		{ token: boss.accessToken },
	);
	expect(invite.frame.ok, JSON.stringify(invite.frame)).toBe(true);
	return { email };
}

interface BeginResult {
	challengeId: string;
	options: {
		challenge: string;
		user?: { id: string };
	};
}

async function begin(
	token: string,
	purpose: "register" | "elevate" | "remove",
	methodId?: string,
): Promise<{ ok: true; result: BeginResult } | { ok: false; code: string }> {
	const res = await sendRpc<BeginResult>(
		"auth.passkeys.begin",
		methodId === undefined ? { purpose } : { purpose, methodId },
		{ token },
	);
	if (!res.frame.ok || !res.frame.result) {
		return { ok: false, code: res.frame.error?.code ?? "" };
	}
	return { ok: true, result: res.frame.result };
}

async function finish(
	token: string,
	purpose: "register" | "elevate" | "remove",
	challengeId: string,
	response: PasskeyRegistrationJson | PasskeyAssertionJson | { id: string },
): Promise<{
	ok: boolean;
	code?: string;
	methodId?: string;
	elevatedUntil?: number;
	removedMethodId?: string;
}> {
	const res = await sendRpc<{
		methodId?: string;
		elevatedUntil?: number;
		removedMethodId?: string;
	}>(
		"auth.passkeys.finish",
		{ purpose, challengeId, response },
		{ token },
	);
	if (!res.frame.ok) return { ok: false, code: res.frame.error?.code };
	return { ok: true, ...res.frame.result };
}

describe("passkey registration, elevation, and removal", () => {
	useWorkerFixture();

	it("registers an ES256 passkey and later verifies elevate and remove", async () => {
		const { email } = await inviteAccountAdmin();
		const token = await freshGoogleSession({
			email,
			sub: `g-${crypto.randomUUID()}`,
		});
		const passkey = await TestPasskey.create();
		const started = await begin(token, "register");
		expect(started.ok, JSON.stringify(started)).toBe(true);
		if (!started.ok) return;
		const registered = await finish(
			token,
			"register",
			started.result.challengeId,
			await passkey.registration({ challenge: started.result.options.challenge }),
		);
		expect(registered.ok, JSON.stringify(registered)).toBe(true);
		expect(registered.methodId?.startsWith("lm_")).toBe(true);

		const handle = started.result.options.user?.id ?? "";
		expect(handle).not.toBe("");
		const elevating = await begin(token, "elevate");
		expect(elevating.ok, JSON.stringify(elevating)).toBe(true);
		if (!elevating.ok) return;
		const elevated = await finish(
			token,
			"elevate",
			elevating.result.challengeId,
			await passkey.assertion({
				challenge: elevating.result.options.challenge,
				userHandle: handle,
			}),
		);
		expect(elevated.ok, JSON.stringify(elevated)).toBe(true);
		expect(typeof elevated.elevatedUntil).toBe("number");

		const removing = await begin(token, "remove", registered.methodId);
		expect(removing.ok, JSON.stringify(removing)).toBe(true);
		if (!removing.ok) return;
		const removed = await finish(
			token,
			"remove",
			removing.result.challengeId,
			await passkey.assertion({
				challenge: removing.result.options.challenge,
				userHandle: handle,
			}),
		);
		expect(removed.ok, JSON.stringify(removed)).toBe(true);
		expect(removed.removedMethodId).toBe(registered.methodId);
	});

	it("rejects malformed, replayed, mismatched, and unverifiable ceremonies", async () => {
		const { email } = await inviteAccountAdmin();
		const token = await freshGoogleSession({
			email,
			sub: `g-${crypto.randomUUID()}`,
		});
		const passkey = await TestPasskey.create();
		const started = await begin(token, "register");
		expect(started.ok, JSON.stringify(started)).toBe(true);
		if (!started.ok) return;

		const malformed = await finish(token, "register", started.result.challengeId, {
			id: "not-a-credential",
		});
		expect(malformed.ok).toBe(false);
		expect(malformed.code).toBe("forbidden");

		const wrong = await begin(token, "register");
		expect(wrong.ok).toBe(true);
		if (!wrong.ok) return;
		const idSplit = await begin(token, "register");
		expect(idSplit.ok).toBe(true);
		if (!idSplit.ok) return;
		const splitId = await finish(
			token,
			"register",
			idSplit.result.challengeId,
			await passkey.registration({
				challenge: idSplit.result.options.challenge,
				reportedId: bytesToUnusedId(),
			}),
		);
		expect(splitId.code).toBe("forbidden");

		const badChallenge = await finish(
			token,
			"register",
			wrong.result.challengeId,
			await passkey.registration({
				challenge: wrong.result.options.challenge,
				challengeOverride: "not-the-issued-challenge",
			}),
		);
		expect(badChallenge.code).toBe("forbidden");

		const replayedBegin = await begin(token, "register");
		expect(replayedBegin.ok).toBe(true);
		if (!replayedBegin.ok) return;
		const created = await passkey.registration({
			challenge: replayedBegin.result.options.challenge,
		});
		const once = await finish(
			token,
			"register",
			replayedBegin.result.challengeId,
			created,
		);
		expect(once.ok, JSON.stringify(once)).toBe(true);
		const replay = await finish(
			token,
			"register",
			replayedBegin.result.challengeId,
			created,
		);
		expect(replay.code).toBe("forbidden");

		const handle = replayedBegin.result.options.user?.id ?? "";
		const noUv = await begin(token, "elevate");
		expect(noUv.ok, JSON.stringify(noUv)).toBe(true);
		if (!noUv.ok) return;
		const unverified = await finish(
			token,
			"elevate",
			noUv.result.challengeId,
			await passkey.assertion({
				challenge: noUv.result.options.challenge,
				userHandle: handle,
				userVerified: false,
			}),
		);
		expect(unverified.code).toBe("forbidden");

		const other = await TestPasskey.create();
		const wrongKey = await begin(token, "elevate");
		expect(wrongKey.ok).toBe(true);
		if (!wrongKey.ok) return;
		const foreign = await finish(
			token,
			"elevate",
			wrongKey.result.challengeId,
			await passkey.assertion({
				challenge: wrongKey.result.options.challenge,
				userHandle: handle,
				key: await otherKeys(other),
			}),
		);
		expect(foreign.code).toBe("forbidden");

		const mismatchedId = await begin(token, "elevate");
		expect(mismatchedId.ok).toBe(true);
		if (!mismatchedId.ok) return;
		const idMismatch = await finish(
			token,
			"elevate",
			mismatchedId.result.challengeId,
			await passkey.assertion({
				challenge: mismatchedId.result.options.challenge,
				userHandle: handle,
				rawId: `${passkey.id}x`,
			}),
		);
		expect(idMismatch.code).toBe("forbidden");

		const unknown = await begin(token, "elevate");
		expect(unknown.ok).toBe(true);
		if (!unknown.ok) return;
		const otherAssertion = await other.assertion({
			challenge: unknown.result.options.challenge,
			userHandle: handle,
		});
		const unknownId = await finish(
			token,
			"elevate",
			unknown.result.challengeId,
			otherAssertion,
		);
		expect(unknownId.code).toBe("forbidden");

		const badHandle = await begin(token, "elevate");
		expect(badHandle.ok).toBe(true);
		if (!badHandle.ok) return;
		const handleMismatch = await finish(
			token,
			"elevate",
			badHandle.result.challengeId,
			await passkey.assertion({
				challenge: badHandle.result.options.challenge,
				userHandle: "not-the-user-handle",
			}),
		);
		expect(handleMismatch.code).toBe("forbidden");
	});
});

function bytesToUnusedId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function otherKeys(passkey: TestPasskey): Promise<CryptoKeyPair> {
	void passkey;
	return (await crypto.subtle.generateKey(
		{ name: "ECDSA", namedCurve: "P-256" },
		true,
		["sign", "verify"],
	)) as CryptoKeyPair;
}
