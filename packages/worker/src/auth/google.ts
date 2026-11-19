import {
	fromBase64Url,
	fromBase64UrlString,
	toBase64Url,
} from "../base64url.js";
import type { Env } from "../types.js";

/**
 * Google OIDC (authorization code + PKCE) for sign-in. The provider is hidden
 * and fails closed until GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET are set.
 */

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = ["https://accounts.google.com", "accounts.google.com"];

export const TXN_COOKIE = "__Secure-cadmus_txn";
export const TXN_TTL_MS = 10 * 60 * 1000;

export interface GoogleConfig {
	clientId: string;
	clientSecret: string;
}

export function getGoogleConfig(env: Partial<Env>): GoogleConfig | undefined {
	const clientId = env.GOOGLE_CLIENT_ID?.trim();
	const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
	if (!clientId || !clientSecret) return undefined;
	return { clientId, clientSecret };
}

export interface LoginIdentity {
	provider: string;
	subject: string;
	email: string;
	emailVerified: boolean;
	display?: string;
}

function randomB64url(bytes: number): string {
	return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function sha256B64url(text: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(text),
	);
	return toBase64Url(new Uint8Array(digest));
}

// ─── Signed transaction (state, nonce, PKCE verifier) ───────────────────────

export interface LoginTransaction {
	state: string;
	nonce: string;
	verifier: string;
	exp: number;
	/** A fresh sign-in: the ID token must carry a recent auth_time. */
	fresh?: boolean;
	/** Role choice requested. Stays in this cookie, never in the redirect URL. */
	chooseRole?: boolean;
	/** Link flow: the callback attaches the verified identity to this user. */
	linkUserId?: string;
	/** The session that started the link; it must still be live at the callback. */
	linkSessionId?: string;
}

// ─── Link ticket (auth.methods.link.start) ──────────────────────────────────

/** A link ticket is only useful for this long. */
export const LINK_TICKET_TTL_MS = 120_000;
export const LINK_BIND_COOKIE = "cadmus_link_bind";

interface LinkTicket {
	purpose: "link";
	userId: string;
	sessionId: string;
	/** Random value the browser must also present as a cookie. */
	bind: string;
	exp: number;
}

export async function signLinkTicket(
	env: Partial<Env>,
	userId: string,
	sessionId: string,
	now = Date.now(),
): Promise<{ ticket: string; bind: string; expiresAt: number }> {
	const bind = randomB64url(24);
	const expiresAt = now + LINK_TICKET_TTL_MS;
	const body = toBase64Url(
		JSON.stringify({
			purpose: "link",
			userId,
			sessionId,
			bind,
			exp: expiresAt,
		}),
	);
	const sig = await crypto.subtle.sign(
		"HMAC",
		await hmacKey(env),
		new TextEncoder().encode(`link.${body}`),
	);
	return {
		ticket: `${body}.${toBase64Url(new Uint8Array(sig))}`,
		bind,
		expiresAt,
	};
}

export async function verifyLinkTicket(
	env: Partial<Env>,
	value: string,
	now = Date.now(),
): Promise<{ userId: string; sessionId: string; bind: string } | undefined> {
	const [body, sig] = value.split(".");
	if (!body || !sig) return undefined;
	try {
		const ok = await crypto.subtle.verify(
			"HMAC",
			await hmacKey(env),
			fromBase64Url(sig),
			new TextEncoder().encode(`link.${body}`),
		);
		if (!ok) return undefined;
		const t = JSON.parse(fromBase64UrlString(body)) as LinkTicket;
		if (t.purpose !== "link" || typeof t.exp !== "number" || t.exp <= now) {
			return undefined;
		}
		if (
			typeof t.userId !== "string" ||
			typeof t.sessionId !== "string" ||
			typeof t.bind !== "string"
		) {
			return undefined;
		}
		return { userId: t.userId, sessionId: t.sessionId, bind: t.bind };
	} catch {
		return undefined;
	}
}

/** How recent a fresh sign-in's auth_time must be, and the clock skew allowed. */
export const FRESH_AUTH_MAX_AGE_MS = 5 * 60_000;
export const FRESH_AUTH_SKEW_MS = 60_000;

async function hmacKey(env: Partial<Env>): Promise<CryptoKey> {
	const secret = `cadmus-auth-txn:${env.CADMUS_ENCRYPTION_KEY ?? "dev"}`;
	return crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign", "verify"],
	);
}

export async function signTransaction(
	env: Partial<Env>,
	txn: LoginTransaction,
): Promise<string> {
	const body = toBase64Url(JSON.stringify(txn));
	const sig = await crypto.subtle.sign(
		"HMAC",
		await hmacKey(env),
		new TextEncoder().encode(body),
	);
	return `${body}.${toBase64Url(new Uint8Array(sig))}`;
}

export async function verifyTransaction(
	env: Partial<Env>,
	value: string,
	now = Date.now(),
): Promise<LoginTransaction | undefined> {
	const [body, sig] = value.split(".");
	if (!body || !sig) return undefined;
	try {
		const ok = await crypto.subtle.verify(
			"HMAC",
			await hmacKey(env),
			fromBase64Url(sig),
			new TextEncoder().encode(body),
		);
		if (!ok) return undefined;
		const txn = JSON.parse(fromBase64UrlString(body)) as LoginTransaction;
		if (typeof txn.exp !== "number" || txn.exp <= now) return undefined;
		return txn;
	} catch {
		return undefined;
	}
}

export async function startGoogleLogin(
	env: Partial<Env>,
	config: GoogleConfig,
	redirectUri: string,
	now = Date.now(),
	options: {
		fresh?: boolean;
		chooseRole?: boolean;
		linkUserId?: string;
		linkSessionId?: string;
	} = {},
): Promise<{ location: string; txnValue: string }> {
	const txn: LoginTransaction = {
		state: randomB64url(24),
		nonce: randomB64url(24),
		verifier: randomB64url(48),
		exp: now + TXN_TTL_MS,
		...(options.fresh ? { fresh: true } : {}),
		...(options.chooseRole ? { chooseRole: true } : {}),
		...(options.linkUserId && options.linkSessionId
			? {
					linkUserId: options.linkUserId,
					linkSessionId: options.linkSessionId,
				}
			: {}),
	};
	const params = new URLSearchParams({
		client_id: config.clientId,
		redirect_uri: redirectUri,
		response_type: "code",
		scope: "openid email profile",
		state: txn.state,
		nonce: txn.nonce,
		code_challenge: await sha256B64url(txn.verifier),
		code_challenge_method: "S256",
		prompt: "select_account",
	});
	// Documented by Google as an optional claim request; whether the token carries
	// auth_time is checked on return, never assumed.
	if (options.fresh) {
		params.set(
			"claims",
			JSON.stringify({ id_token: { auth_time: { essential: true } } }),
		);
	}
	return {
		location: `${GOOGLE_AUTH_URL}?${params.toString()}`,
		txnValue: await signTransaction(env, txn),
	};
}

// ─── ID token verification ───────────────────────────────────────────────────

interface Jwk {
	kid?: string;
	kty: string;
	alg?: string;
	n?: string;
	e?: string;
}

export type IdTokenResult =
	| { ok: true; identity: LoginIdentity; authTimeMs?: number }
	| { ok: false; code: string };

function parseJwtPart<T>(part: string): T | undefined {
	try {
		return JSON.parse(fromBase64UrlString(part)) as T;
	} catch {
		return undefined;
	}
}

export async function verifyGoogleIdToken(
	idToken: string,
	options: {
		clientId: string;
		nonce: string;
		now?: number;
		/** Fresh sign-in: require an integer auth_time that is recent and not in the future. */
		requireAuthTime?: boolean;
	},
): Promise<IdTokenResult> {
	const parts = idToken.split(".");
	if (parts.length !== 3) return { ok: false, code: "bad_id_token" };
	const [h, p, s] = parts as [string, string, string];
	const header = parseJwtPart<{ alg?: string; kid?: string }>(h);
	const claims = parseJwtPart<{
		iss?: string;
		aud?: string | string[];
		exp?: number;
		nonce?: string;
		sub?: string;
		email?: string;
		email_verified?: boolean | string;
		name?: string;
		auth_time?: unknown;
	}>(p);
	if (!header || !claims) return { ok: false, code: "bad_id_token" };
	if (header.alg !== "RS256") return { ok: false, code: "bad_id_token" };

	const jwksRes = await fetch(GOOGLE_JWKS_URL);
	if (!jwksRes.ok) return { ok: false, code: "jwks_unavailable" };
	const jwks = (await jwksRes.json()) as { keys?: Jwk[] };
	const jwk = jwks.keys?.find((k) => k.kid === header.kid && k.kty === "RSA");
	if (!jwk) return { ok: false, code: "bad_id_token" };
	let valid = false;
	try {
		const key = await crypto.subtle.importKey(
			"jwk",
			{ kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
			{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
			false,
			["verify"],
		);
		valid = await crypto.subtle.verify(
			"RSASSA-PKCS1-v1_5",
			key,
			fromBase64Url(s),
			new TextEncoder().encode(`${h}.${p}`),
		);
	} catch {
		return { ok: false, code: "bad_id_token" };
	}
	if (!valid) return { ok: false, code: "bad_id_token" };

	const now = options.now ?? Date.now();
	if (!claims.iss || !GOOGLE_ISSUERS.includes(claims.iss)) {
		return { ok: false, code: "bad_issuer" };
	}
	const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
	if (!aud.includes(options.clientId))
		return { ok: false, code: "bad_audience" };
	if (typeof claims.exp !== "number" || claims.exp * 1000 <= now) {
		return { ok: false, code: "token_expired" };
	}
	if (claims.nonce !== options.nonce) return { ok: false, code: "bad_nonce" };
	if (!claims.sub || !claims.email) return { ok: false, code: "bad_id_token" };
	const verified =
		claims.email_verified === true || claims.email_verified === "true";
	if (!verified) return { ok: false, code: "email_not_verified" };
	let authTimeMs: number | undefined;
	if (options.requireAuthTime) {
		const at = claims.auth_time;
		if (typeof at !== "number" || !Number.isSafeInteger(at) || at <= 0) {
			return { ok: false, code: "auth_time_missing" };
		}
		authTimeMs = at * 1000;
		if (
			authTimeMs > now + FRESH_AUTH_SKEW_MS ||
			now - authTimeMs > FRESH_AUTH_MAX_AGE_MS
		) {
			return { ok: false, code: "auth_time_stale" };
		}
	}
	return {
		ok: true,
		...(authTimeMs === undefined ? {} : { authTimeMs }),
		identity: {
			provider: "google",
			subject: claims.sub,
			email: claims.email.trim().toLowerCase(),
			emailVerified: true,
			display: claims.name ?? claims.email,
		},
	};
}

export async function exchangeGoogleCode(
	config: GoogleConfig,
	input: { code: string; verifier: string; redirectUri: string },
): Promise<{ ok: true; idToken: string } | { ok: false; code: string }> {
	const res = await fetch(GOOGLE_TOKEN_URL, {
		method: "POST",
		headers: { "content-type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			code: input.code,
			client_id: config.clientId,
			client_secret: config.clientSecret,
			redirect_uri: input.redirectUri,
			code_verifier: input.verifier,
		}).toString(),
	});
	if (!res.ok) return { ok: false, code: "code_exchange_failed" };
	const body = (await res.json()) as { id_token?: string };
	if (!body.id_token) return { ok: false, code: "code_exchange_failed" };
	return { ok: true, idToken: body.id_token };
}
