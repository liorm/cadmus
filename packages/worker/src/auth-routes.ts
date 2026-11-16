import { devPasswordState, verifyDevPassword } from "./auth/dev-password.js";
import {
	exchangeGoogleCode,
	getGoogleConfig,
	LINK_BIND_COOKIE,
	startGoogleLogin,
	TXN_COOKIE,
	verifyGoogleIdToken,
	verifyLinkTicket,
	verifyTransaction,
} from "./auth/google.js";
import { bearerToken, readCookie, timingSafeEqualSha256 } from "./auth.js";
import {
	lockoutClear,
	lockoutFail,
	lockoutStatus,
	tooManyRequests,
} from "./auth-limiter.js";
import { resolveClampedTestInt } from "./env-overrides.js";
import { getLogger } from "./log.js";
import type { AdminStore } from "./store/admin-interface.js";
import type { SessionTokens } from "./store/d1-sessions.js";
import type { Env } from "./types.js";

/**
 * The refresh cookie. The issue names it `__Host-cadmus_refresh` with
 * `Path=/auth/refresh`, but browsers reject a `__Host-` cookie that is not
 * scoped to `Path=/`, so `__Secure-` keeps the narrow path.
 */
export const REFRESH_COOKIE = "__Secure-cadmus_refresh";
export const REFRESH_PATH = "/auth/refresh";

const LOGOUT_PATH = "/auth/logout";
const TOKEN_LOGIN_PATH = "/auth/token-login";
const DEV_PASSWORD_PATH = "/auth/login/dev-password";
const PROVIDERS_PATH = "/auth/providers";
const GOOGLE_LOGIN_PATH = "/auth/login/google";
const GOOGLE_CALLBACK_PATH = "/auth/callback/google";

export function isAuthRoute(pathname: string): boolean {
	return (
		pathname === REFRESH_PATH ||
		pathname === LOGOUT_PATH ||
		pathname === TOKEN_LOGIN_PATH ||
		pathname === DEV_PASSWORD_PATH ||
		pathname === PROVIDERS_PATH ||
		pathname === GOOGLE_LOGIN_PATH ||
		pathname === GOOGLE_CALLBACK_PATH
	);
}

/** Dispatches the public /auth/* routes. */
export async function handleAuthRoute(
	request: Request,
	env: Env,
	adminStore: AdminStore,
): Promise<Response> {
	const { pathname } = new URL(request.url);
	if (pathname === REFRESH_PATH) return handleRefresh(request, adminStore);
	if (pathname === LOGOUT_PATH) return handleLogout(request, adminStore);
	if (pathname === TOKEN_LOGIN_PATH) {
		return handleTokenLogin(request, adminStore);
	}
	if (pathname === DEV_PASSWORD_PATH) {
		return handleDevPassword(request, env, adminStore);
	}
	if (pathname === PROVIDERS_PATH) return handleProviders(request, env);
	if (pathname === GOOGLE_LOGIN_PATH) return handleGoogleLogin(request, env);
	return handleGoogleCallback(request, env, adminStore);
}

function redirectUriFor(request: Request, env: Env): string {
	const base = env.CADMUS_PUBLIC_URL?.trim() || new URL(request.url).origin;
	return `${base.replace(/\/$/, "")}${GOOGLE_CALLBACK_PATH}`;
}

function notConfigured(): Response {
	return Response.json(
		{
			error: {
				code: "provider_not_configured",
				message: "Google sign-in is not configured",
			},
		},
		noStore({ status: 404 }),
	);
}

/** Public list of sign-in methods the UI may offer. Empty until configured. */
function handleProviders(request: Request, env: Env): Response {
	if (request.method !== "GET") {
		return Response.json(
			{ error: { code: "method_not_allowed", message: "Use GET" } },
			noStore({ status: 405 }),
		);
	}
	const providers: Array<{ id: string }> = getGoogleConfig(env)
		? [{ id: "google" }]
		: [];
	if (devPasswordState(env, new URL(request.url)).state === "on") {
		providers.push({ id: "dev-password" });
	}
	const waitMs = resolveClampedTestInt(
		env.CADMUS_BOOT_REFRESH_RETRY_MS,
		env.CADMUS_DEPLOY_ENV,
		50,
		60_000,
	);
	const retries = resolveClampedTestInt(
		env.CADMUS_BOOT_REFRESH_RETRIES,
		env.CADMUS_DEPLOY_ENV,
		0,
		10,
	);
	const bootRetry =
		waitMs !== null || retries !== null
			? {
					...(waitMs !== null ? { waitMs } : {}),
					...(retries !== null ? { retries } : {}),
				}
			: undefined;
	return Response.json(
		bootRetry ? { providers, bootRetry } : { providers },
		noStore({ status: 200 }),
	);
}

function txnCookie(value: string, maxAge: number): string {
	return `${TXN_COOKIE}=${value}; Path=${GOOGLE_CALLBACK_PATH}; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function linkBindCookie(value: string, maxAge: number): string {
	return `${LINK_BIND_COOKIE}=${value}; Path=${GOOGLE_LOGIN_PATH}; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

async function handleGoogleLogin(
	request: Request,
	env: Env,
): Promise<Response> {
	const config = getGoogleConfig(env);
	if (!config) return notConfigured();
	if (request.method !== "GET") {
		return Response.json(
			{ error: { code: "method_not_allowed", message: "Use GET" } },
			noStore({ status: 405 }),
		);
	}
	const params = new URL(request.url).searchParams;
	let linkUserId: string | undefined;
	let linkSessionId: string | undefined;
	const rawTicket = params.get("link");
	if (rawTicket !== null) {
		// Linking: the ticket names the signed-in user, and the browser must also
		// hold the bind cookie only the caller of auth.methods.link.start received.
		const ticket = await verifyLinkTicket(env, rawTicket);
		const bound = readCookie(request, LINK_BIND_COOKIE);
		if (
			!ticket ||
			!bound ||
			!(await timingSafeEqualSha256(bound, ticket.bind))
		) {
			const h = new Headers({
				location: `/settings/security?link_error=bad_ticket`,
				"cache-control": "no-store",
			});
			h.append("set-cookie", linkBindCookie("", 0));
			return new Response(null, { status: 302, headers: h });
		}
		linkUserId = ticket.userId;
		linkSessionId = ticket.sessionId;
	}
	const { location, txnValue } = await startGoogleLogin(
		env,
		config,
		redirectUriFor(request, env),
		Date.now(),
		{
			fresh: params.get("fresh") === "1",
			...(linkUserId && linkSessionId ? { linkUserId, linkSessionId } : {}),
		},
	);
	const headers = new Headers({ location, "cache-control": "no-store" });
	headers.append("set-cookie", txnCookie(txnValue, 600));
	if (linkUserId) headers.append("set-cookie", linkBindCookie("", 0));
	return new Response(null, { status: 302, headers });
}

function failRedirect(code: string): Response {
	const headers = new Headers({
		location: `/?auth_error=${encodeURIComponent(code)}`,
		"cache-control": "no-store",
	});
	headers.append("set-cookie", txnCookie("", 0));
	return new Response(null, { status: 302, headers });
}

async function handleGoogleCallback(
	request: Request,
	env: Env,
	adminStore: AdminStore,
): Promise<Response> {
	const config = getGoogleConfig(env);
	if (!config) return notConfigured();
	const url = new URL(request.url);
	if (request.method !== "GET") {
		return Response.json(
			{ error: { code: "method_not_allowed", message: "Use GET" } },
			noStore({ status: 405 }),
		);
	}
	const txnRaw = readCookie(request, TXN_COOKIE);
	const txn = txnRaw ? await verifyTransaction(env, txnRaw) : undefined;
	const state = url.searchParams.get("state");
	const code = url.searchParams.get("code");
	if (url.searchParams.get("error")) return failRedirect("login_denied");
	if (!txn || !state || state !== txn.state || !code) {
		return failRedirect("bad_state");
	}
	const exchanged = await exchangeGoogleCode(config, {
		code,
		verifier: txn.verifier,
		redirectUri: redirectUriFor(request, env),
	});
	if (!exchanged.ok) return failRedirect(exchanged.code);
	const verified = await verifyGoogleIdToken(exchanged.idToken, {
		clientId: config.clientId,
		nonce: txn.nonce,
		requireAuthTime: txn.fresh === true,
	});
	if (!verified.ok) return failRedirect(verified.code);
	const googleEmail = verified.identity.email ?? verified.identity.subject;
	const lock = await lockoutStatus(env, "google-callback", googleEmail);
	if (lock.locked) return failRedirect("locked_out");
	if (txn.linkUserId || txn.linkSessionId) {
		// Link only: no session is created or changed, and the email is never used
		// to find a user. The method attaches to the user the ticket named.
		const linked = await adminStore.linkLoginMethod(
			txn.linkUserId ?? "",
			txn.linkSessionId ?? "",
			verified.identity,
		);
		const headers = new Headers({
			location: linked.ok
				? `/settings/security?linked=${encodeURIComponent(verified.identity.provider)}`
				: `/settings/security?link_error=${encodeURIComponent(linked.code)}`,
			"cache-control": "no-store",
		});
		headers.append("set-cookie", txnCookie("", 0));
		return new Response(null, { status: 302, headers });
	}
	const login = await adminStore.completeLogin(verified.identity, {
		bootstrapEmail: env.CADMUS_BOOTSTRAP_SUPER_ADMIN_EMAIL,
		userAgent: request.headers.get("user-agent") ?? undefined,
		ipCountry: request.headers.get("cf-ipcountry") ?? undefined,
		freshGoogleAt: verified.authTimeMs,
	});
	if (!login.ok) {
		await lockoutFail(env, "google-callback", googleEmail);
		return failRedirect(login.code);
	}
	await lockoutClear(env, "google-callback", googleEmail);
	// A fresh sign-in exists to enroll a passkey, so it returns to the security
	// page. The target is a fixed path, never taken from the request.
	const headers = new Headers({
		location: txn.fresh === true ? "/settings/security" : "/",
		"cache-control": "no-store",
	});
	headers.append("set-cookie", refreshCookieHeader(login.tokens));
	headers.append("set-cookie", txnCookie("", 0));
	return new Response(null, { status: 302, headers });
}

export function refreshCookieHeader(tokens: SessionTokens): string {
	const maxAge = Math.max(
		0,
		Math.floor((tokens.refreshExpiresAt - Date.now()) / 1000),
	);
	return `${REFRESH_COOKIE}=${tokens.refreshToken}; Path=${REFRESH_PATH}; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}

export function clearRefreshCookieHeader(): string {
	return `${REFRESH_COOKIE}=; Path=${REFRESH_PATH}; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

function noStore(init: ResponseInit & { cookie?: string }): ResponseInit {
	const headers = new Headers(init.headers);
	headers.set("cache-control", "no-store");
	if (init.cookie) headers.append("set-cookie", init.cookie);
	return { status: init.status, headers };
}

/**
 * POST /auth/refresh: the only route that reads cookies. It needs the app
 * Origin and `X-Cadmus-Refresh: 1` (CSRF), rotates the refresh token on every
 * use, and revokes the whole session when a rotated token is replayed.
 */
export async function handleRefresh(
	request: Request,
	adminStore: AdminStore,
): Promise<Response> {
	if (request.method !== "POST") {
		return Response.json(
			{ error: { code: "method_not_allowed", message: "Use POST" } },
			noStore({ status: 405 }),
		);
	}
	const origin = request.headers.get("origin");
	if (
		origin !== new URL(request.url).origin ||
		request.headers.get("x-cadmus-refresh") !== "1"
	) {
		return Response.json(
			{ error: { code: "forbidden", message: "Refresh CSRF check failed" } },
			noStore({ status: 403 }),
		);
	}
	const raw = readCookie(request, REFRESH_COOKIE);
	if (!raw) {
		return Response.json(
			{ error: { code: "unauthorized", message: "No refresh cookie" } },
			noStore({ status: 401 }),
		);
	}
	const result = await adminStore.rotateRefreshToken(raw);
	if (!result.ok) {
		return Response.json(
			{ error: { code: result.code, message: "Refresh refused" } },
			noStore({ status: 401, cookie: clearRefreshCookieHeader() }),
		);
	}
	return Response.json(
		{
			accessToken: result.tokens.accessToken,
			expiresAt: result.tokens.accessExpiresAt,
			sessionId: result.tokens.sessionId,
			accountId: result.accountId,
			userId: result.userId,
			viaToken: result.viaToken,
		},
		noStore({ status: 200, cookie: refreshCookieHeader(result.tokens) }),
	);
}

/**
 * POST /auth/login/dev-password {email?, password}: local development only.
 * Off (404) unless enabled; enabled but not local, preview or production is a
 * loud 500 plus a log line. Logs in as the bootstrap super-admin email, or as
 * an invited email, through the same rules as Google sign-in.
 */
async function handleDevPassword(
	request: Request,
	env: Env,
	adminStore: AdminStore,
): Promise<Response> {
	const state = devPasswordState(env, new URL(request.url));
	if (state.state === "off") return notConfigured();
	if (state.state === "refused") {
		getLogger().error("dev password login refused: unsafe environment", {
			reason: state.reason,
		});
		return Response.json(
			{
				error: {
					code: "dev_password_unsafe_environment",
					message: "Dev password login is enabled in an unsafe environment",
				},
			},
			noStore({ status: 500 }),
		);
	}
	if (request.method !== "POST") {
		return Response.json(
			{ error: { code: "method_not_allowed", message: "Use POST" } },
			noStore({ status: 405 }),
		);
	}
	if (request.headers.get("origin") !== new URL(request.url).origin) {
		return Response.json(
			{ error: { code: "forbidden", message: "Login CSRF check failed" } },
			noStore({ status: 403 }),
		);
	}
	let body: { email?: unknown; password?: unknown } = {};
	try {
		body = (await request.json()) as typeof body;
	} catch {
		body = {};
	}
	const password = typeof body.password === "string" ? body.password : "";
	const email = (
		typeof body.email === "string" && body.email.trim()
			? body.email
			: (env.CADMUS_BOOTSTRAP_SUPER_ADMIN_EMAIL ?? "")
	)
		.trim()
		.toLowerCase();
	// With no email (none sent and no bootstrap email configured) there is no
	// identity to lock, and nothing to guess either: the check below refuses
	// every password. That case is bounded by the per-IP budget alone, and no
	// failure count exists for it.
	if (email) {
		const lock = await lockoutStatus(env, "dev-password", email);
		if (lock.locked) return tooManyRequests(lock.retryAfterSec, "locked_out");
	}
	if (!email || !(await verifyDevPassword(password, state.hash))) {
		if (email) {
			const lock = await lockoutFail(env, "dev-password", email);
			if (lock.locked) return tooManyRequests(lock.retryAfterSec, "locked_out");
		}
		return Response.json(
			{ error: { code: "unauthorized", message: "Login refused" } },
			noStore({ status: 401 }),
		);
	}
	const login = await adminStore.completeLogin(
		{
			provider: "dev-password",
			subject: email,
			email,
			emailVerified: true,
			display: email,
		},
		{
			bootstrapEmail: env.CADMUS_BOOTSTRAP_SUPER_ADMIN_EMAIL,
			userAgent: request.headers.get("user-agent") ?? undefined,
		},
	);
	if (login.ok) await lockoutClear(env, "dev-password", email);
	if (!login.ok) {
		return Response.json(
			{ error: { code: login.code, message: "Login refused" } },
			noStore({ status: 401 }),
		);
	}
	return Response.json(
		{
			accessToken: login.tokens.accessToken,
			expiresAt: login.tokens.accessExpiresAt,
		},
		noStore({ status: 200, cookie: refreshCookieHeader(login.tokens) }),
	);
}

/**
 * POST /auth/token-login: exchanges `Authorization: Bearer cad_pat_|cad_svc_`
 * (header only, never a query parameter) for a normal session bound to the
 * token's account, and sets the refresh cookie. The session's grants are
 * clamped to the token's. Failures are uniform 401 so a probe learns nothing.
 */
async function handleTokenLogin(
	request: Request,
	adminStore: AdminStore,
): Promise<Response> {
	if (request.method !== "POST") {
		return Response.json(
			{ error: { code: "method_not_allowed", message: "Use POST" } },
			noStore({ status: 405 }),
		);
	}
	const url = new URL(request.url);
	const header = request.headers.get("authorization") ?? "";
	const raw = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
	if (url.searchParams.has("token") || !raw) {
		return Response.json(
			{ error: { code: "unauthorized", message: "Token login refused" } },
			noStore({ status: 401 }),
		);
	}
	const result = await adminStore.tokenLogin(raw, {
		userAgent: request.headers.get("user-agent") ?? undefined,
		ipCountry:
			(request as Request & { cf?: { country?: string } }).cf?.country ??
			undefined,
	});
	if (!result.ok) {
		return Response.json(
			{ error: { code: "unauthorized", message: "Token login refused" } },
			noStore({ status: 401 }),
		);
	}
	return Response.json(
		{
			accessToken: result.tokens.accessToken,
			expiresAt: result.tokens.accessExpiresAt,
			accountId: result.accountId,
		},
		noStore({ status: 200, cookie: refreshCookieHeader(result.tokens) }),
	);
}

/**
 * POST /auth/logout: revokes the session named by the bearer access token (the
 * web app refreshes first so the token is current). It does not read cookies:
 * only /auth/refresh does, and the refresh cookie is scoped to
 * Path=/auth/refresh so a browser never sends it here anyway. Same CSRF checks
 * as refresh. Always succeeds from the caller's point of view so a stale
 * bearer cannot wedge sign-out.
 */
async function handleLogout(
	request: Request,
	adminStore: AdminStore,
): Promise<Response> {
	if (request.method !== "POST") {
		return Response.json(
			{ error: { code: "method_not_allowed", message: "Use POST" } },
			noStore({ status: 405 }),
		);
	}
	if (
		request.headers.get("origin") !== new URL(request.url).origin ||
		request.headers.get("x-cadmus-refresh") !== "1"
	) {
		return Response.json(
			{ error: { code: "forbidden", message: "Logout CSRF check failed" } },
			noStore({ status: 403 }),
		);
	}
	let revoked = false;
	const bearer = bearerToken(request);
	if (bearer) {
		const identity = await adminStore.resolveAccessToken(bearer);
		if (identity) {
			revoked = (await adminStore.revokeSession(identity.sessionId)) || revoked;
		}
	}
	// The refresh cookie belongs to whichever session this browser last signed
	// in as, which may not be the session the bearer named, and only
	// /auth/refresh reads cookies (issue #3), so logout neither reads nor
	// clears it. The client flushes it through /auth/refresh, which clears it
	// once its session is gone.
	return Response.json({ revoked }, noStore({ status: 200 }));
}
