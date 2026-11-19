import { devPasswordState, verifyDevPassword } from "./auth/dev-password.js";
import {
	exchangeGoogleCode,
	getGoogleConfig,
	startGoogleLogin,
	TXN_COOKIE,
	verifyGoogleIdToken,
	verifyTransaction,
} from "./auth/google.js";
import { authenticateRequest, bearerToken, readCookie } from "./auth.js";
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
 * Refresh cookie. `__Secure-` (not `__Host-`) so the path can stay under the
 * session routes. The path covers both refresh and logout.
 */
export const REFRESH_COOKIE = "__Secure-cadmus_refresh";
/** Cookie path prefix. Matches `/api/auth/session/refresh` and `/logout`. */
export const REFRESH_PATH = "/api/auth/session";

const SESSION_REFRESH_PATH = "/api/auth/session/refresh";
const LOGOUT_PATH = "/api/auth/session/logout";
const DEV_PASSWORD_PATH = "/api/auth/login/devPassword";
const ASSUME_ROLE_PATH = "/api/auth/assumeRole";
const PROVIDERS_PATH = "/api/auth/login/providers";
const GOOGLE_LOGIN_PATH = "/api/auth/login/google/start";
const GOOGLE_CALLBACK_PATH = "/api/auth/login/google/callback";
const DEVICE_START_PATH = "/api/auth/login/device/start";
const DEVICE_POLL_PATH = "/api/auth/login/device/poll";
const DEVICE_APPROVE_PATH = "/api/auth/login/device/approve";
const DEVICE_DENY_PATH = "/api/auth/login/device/deny";

export function isAuthRoute(pathname: string): boolean {
	return (
		pathname === SESSION_REFRESH_PATH ||
		pathname === LOGOUT_PATH ||
		pathname === DEV_PASSWORD_PATH ||
		pathname === ASSUME_ROLE_PATH ||
		pathname === PROVIDERS_PATH ||
		pathname === GOOGLE_LOGIN_PATH ||
		pathname === GOOGLE_CALLBACK_PATH ||
		pathname === DEVICE_START_PATH ||
		pathname === DEVICE_POLL_PATH ||
		pathname === DEVICE_APPROVE_PATH ||
		pathname === DEVICE_DENY_PATH
	);
}

/** Dispatches the public /auth/* routes. */
export async function handleAuthRoute(
	request: Request,
	env: Env,
	adminStore: AdminStore,
): Promise<Response> {
	const { pathname } = new URL(request.url);
	if (pathname === SESSION_REFRESH_PATH)
		return handleRefresh(request, adminStore);
	if (pathname === LOGOUT_PATH) return handleLogout(request, adminStore);
	if (pathname === DEV_PASSWORD_PATH) {
		return handleDevPassword(request, env, adminStore);
	}
	if (pathname === ASSUME_ROLE_PATH) {
		return handleAssumeRole(request, env, adminStore);
	}
	if (pathname === PROVIDERS_PATH) return handleProviders(request, env);
	if (pathname === GOOGLE_LOGIN_PATH) return handleGoogleLogin(request, env);
	if (pathname === DEVICE_START_PATH) {
		return handleDeviceStart(request, env, adminStore);
	}
	if (pathname === DEVICE_POLL_PATH) {
		return handleDevicePoll(request, adminStore);
	}
	if (pathname === DEVICE_APPROVE_PATH) {
		return handleDeviceDecision(request, adminStore, "approve");
	}
	if (pathname === DEVICE_DENY_PATH) {
		return handleDeviceDecision(request, adminStore, "deny");
	}
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

async function handleGoogleLogin(
	request: Request,
	env: Env,
): Promise<Response> {
	const config = getGoogleConfig(env);
	if (!config) return notConfigured();
	if (request.method !== "GET" && request.method !== "POST") {
		return Response.json(
			{ error: { code: "method_not_allowed", message: "Use GET or POST" } },
			noStore({ status: 405 }),
		);
	}
	let chooseRole = false;
	if (request.method === "POST") {
		try {
			const body = (await request.json()) as {
				payload?: { chooseRole?: unknown };
			};
			chooseRole = body.payload?.chooseRole === true;
		} catch {
			chooseRole = false;
		}
	}
	const started = await startGoogleLogin(
		env,
		config,
		redirectUriFor(request, env),
		undefined,
		{ chooseRole },
	);
	if (request.method === "POST") {
		return Response.json(
			{
				authorizationUrl: started.location,
				transactionId:
					new URL(started.location).searchParams.get("state") ?? "",
			},
			noStore({ status: 200, cookie: txnCookie(started.txnValue, 600) }),
		);
	}
	const headers = new Headers({
		location: started.location,
		"cache-control": "no-store",
	});
	headers.append("set-cookie", txnCookie(started.txnValue, 600));
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
	const login = await adminStore.completeLogin(verified.identity, {
		userAgent: request.headers.get("user-agent") ?? undefined,
		ipCountry: request.headers.get("cf-ipcountry") ?? undefined,
		chooseRole: txn.chooseRole === true,
	});
	if (!login.ok) {
		await lockoutFail(env, "google-callback", googleEmail);
		return failRedirect(login.code);
	}
	await lockoutClear(env, "google-callback", googleEmail);
	// Fixed path. Never taken from the request.
	const headers = new Headers({
		location: "/",
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
	const payload = await readPayload(request);
	const bodyRefresh =
		typeof payload.refreshToken === "string" ? payload.refreshToken : "";
	const cookieRefresh = readCookie(request, REFRESH_COOKIE) ?? "";
	if (bodyRefresh && cookieRefresh) {
		return Response.json(
			{
				error: {
					code: "refresh_ambiguous",
					message: "Send the cookie or the refresh secret, not both",
				},
			},
			noStore({ status: 400 }),
		);
	}
	if (bodyRefresh) {
		if (request.headers.get("sec-fetch-site")) {
			return Response.json(
				{
					error: {
						code: "forbidden",
						message: "Browser refresh uses the cookie",
					},
				},
				noStore({ status: 403 }),
			);
		}
		if (request.headers.get("x-cadmus-cli") !== "1") {
			return Response.json(
				{
					error: {
						code: "forbidden",
						message: "CLI refresh header required",
					},
				},
				noStore({ status: 403 }),
			);
		}
	}
	const raw = bodyRefresh || cookieRefresh;
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
			...(bodyRefresh ? { refreshToken: result.tokens.refreshToken } : {}),
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
	let body: {
		payload?: { email?: unknown; password?: unknown; chooseRole?: unknown };
	} = {};
	try {
		body = (await request.json()) as typeof body;
	} catch {
		body = {};
	}
	const payload = body.payload ?? {};
	const password = typeof payload.password === "string" ? payload.password : "";
	const email = (
		typeof payload.email === "string" && payload.email.trim()
			? payload.email
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
			chooseRole: payload.chooseRole === true,
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
			...(login.provisional ? { provisional: true } : {}),
		},
		noStore({ status: 200, cookie: refreshCookieHeader(login.tokens) }),
	);
}

const ROLES = new Set(["user", "account-admin", "super-admin"]);

async function handleAssumeRole(
	request: Request,
	env: Env,
	adminStore: AdminStore,
): Promise<Response> {
	if (request.method !== "POST") {
		return Response.json(
			{ error: { code: "method_not_allowed", message: "Use POST" } },
			noStore({ status: 405 }),
		);
	}
	const token = bearerToken(request);
	if (!token) {
		return Response.json(
			{ error: { code: "unauthorized", message: "Sign in required" } },
			noStore({ status: 401 }),
		);
	}
	const auth = await authenticateRequest(request, env, adminStore, {
		allowQueryToken: false,
		allowCookie: false,
	});
	if (!auth.ok) {
		return Response.json(
			{ error: { code: auth.code, message: auth.message } },
			noStore({ status: auth.code === "unauthorized" ? 401 : 403 }),
		);
	}
	if (!auth.scope.sessionId) {
		return Response.json(
			{ error: { code: "forbidden", message: "Assume role refused" } },
			noStore({ status: 403 }),
		);
	}
	let body: { payload?: { role?: unknown; accountId?: unknown } } = {};
	try {
		body = (await request.json()) as typeof body;
	} catch {
		body = {};
	}
	const role = body.payload?.role;
	const accountId = body.payload?.accountId;
	if (typeof role !== "string" || !ROLES.has(role)) {
		return Response.json(
			{ error: { code: "invalid", message: "role is not a role" } },
			noStore({ status: 400 }),
		);
	}
	if (typeof accountId !== "string" || accountId.length === 0) {
		return Response.json(
			{ error: { code: "invalid", message: "accountId is required" } },
			noStore({ status: 400 }),
		);
	}
	const result = await adminStore.assumeRole({
		rawAccess: token,
		role: role as "user" | "account-admin" | "super-admin",
		accountId,
		userAgent: request.headers.get("user-agent") ?? undefined,
	});
	if (!result.ok) {
		const status =
			result.code === "unauthorized"
				? 401
				: result.code === "role_unchanged"
					? 409
					: 403;
		return Response.json(
			{ error: { code: result.code, message: "Assume role refused" } },
			noStore({ status }),
		);
	}
	return Response.json(
		{
			accessToken: result.tokens.accessToken,
			expiresAt: result.tokens.accessExpiresAt,
			sessionId: result.tokens.sessionId,
		},
		noStore({ status: 200, cookie: refreshCookieHeader(result.tokens) }),
	);
}

/**
 * POST /api/auth/session/logout. Bearer or the refresh cookie revokes that
 * session. The cookie is cleared either way. CSRF matches refresh.
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
	const payload = await readPayload(request);
	const bodyRefresh =
		typeof payload.refreshToken === "string" ? payload.refreshToken : "";
	const cookieRefresh = readCookie(request, REFRESH_COOKIE) ?? "";
	if (bodyRefresh && cookieRefresh) {
		return Response.json(
			{
				error: {
					code: "refresh_ambiguous",
					message: "Send the cookie or the refresh secret, not both",
				},
			},
			noStore({ status: 400 }),
		);
	}
	const bearer = bearerToken(request);
	if (bearer && !bodyRefresh) {
		const identity = await adminStore.resolveAccessToken(bearer);
		if (identity) {
			revoked = (await adminStore.revokeSession(identity.sessionId)) || revoked;
		}
	}
	const refresh = bodyRefresh || cookieRefresh;
	if (refresh) {
		revoked = (await adminStore.revokeSessionByRefresh(refresh)) || revoked;
	}
	return Response.json(
		{ revoked },
		noStore({ status: 200, cookie: clearRefreshCookieHeader() }),
	);
}

async function readPayload(request: Request): Promise<Record<string, unknown>> {
	const type = request.headers.get("content-type") ?? "";
	if (!type.includes("application/json")) return {};
	try {
		const body = (await request.json()) as unknown;
		if (!body || typeof body !== "object" || Array.isArray(body)) return {};
		const record = body as Record<string, unknown>;
		const payload = record.payload;
		if (payload && typeof payload === "object" && !Array.isArray(payload)) {
			return payload as Record<string, unknown>;
		}
		return record;
	} catch {
		return {};
	}
}

function publicOrigin(request: Request, env: Env): string {
	const base = env.CADMUS_PUBLIC_URL?.trim() || new URL(request.url).origin;
	return base.replace(/\/$/, "");
}

async function handleDeviceStart(
	request: Request,
	env: Env,
	adminStore: AdminStore,
): Promise<Response> {
	if (request.method !== "POST") {
		return Response.json(
			{ error: { code: "method_not_allowed", message: "Use POST" } },
			noStore({ status: 405 }),
		);
	}
	const cli = request.headers.get("x-cadmus-cli") === "1";
	const started = await adminStore.startDeviceLogin({
		// Country is the edge's view of the CLI connection, not a client header.
		ipCountry: request.headers.get("cf-ipcountry") ?? undefined,
		userAgent: cli
			? (request.headers.get("user-agent") ?? "Cadmus CLI")
			: "Cadmus CLI",
	});
	const origin = publicOrigin(request, env);
	return Response.json(
		{
			deviceCode: started.deviceCode,
			deviceSecret: started.deviceSecret,
			verificationUrl: `${origin}/login/device?code=${encodeURIComponent(started.deviceCode)}`,
			interval: started.interval,
			expiresIn: started.expiresIn,
		},
		noStore({ status: 200 }),
	);
}

async function handleDevicePoll(
	request: Request,
	adminStore: AdminStore,
): Promise<Response> {
	if (request.method !== "POST") {
		return Response.json(
			{ error: { code: "method_not_allowed", message: "Use POST" } },
			noStore({ status: 405 }),
		);
	}
	const payload = await readPayload(request);
	const deviceSecret =
		typeof payload.deviceSecret === "string" ? payload.deviceSecret : "";
	if (!deviceSecret) {
		return Response.json(
			{ error: { code: "unauthorized", message: "Device login refused" } },
			noStore({ status: 401 }),
		);
	}
	const result = await adminStore.pollDeviceLogin(deviceSecret);
	if (!result.ok) {
		return Response.json(
			{ error: { code: "unauthorized", message: "Device login refused" } },
			noStore({ status: 401 }),
		);
	}
	if (result.status === "pending") {
		return Response.json({ status: "pending" }, noStore({ status: 200 }));
	}
	return Response.json(
		{
			status: "approved",
			accessToken: result.tokens.accessToken,
			refreshToken: result.tokens.refreshToken,
			expiresAt: result.tokens.accessExpiresAt,
			sessionId: result.tokens.sessionId,
			accountId: result.accountId,
			userId: result.userId,
		},
		noStore({ status: 200 }),
	);
}

async function handleDeviceDecision(
	request: Request,
	adminStore: AdminStore,
	decision: "approve" | "deny",
): Promise<Response> {
	if (request.method !== "POST") {
		return Response.json(
			{ error: { code: "method_not_allowed", message: "Use POST" } },
			noStore({ status: 405 }),
		);
	}
	const bearer = bearerToken(request);
	if (!bearer) {
		return Response.json(
			{ error: { code: "unauthorized", message: "Device login refused" } },
			noStore({ status: 401 }),
		);
	}
	const identity = await adminStore.resolveAccessToken(bearer);
	if (!identity) {
		return Response.json(
			{ error: { code: "unauthorized", message: "Device login refused" } },
			noStore({ status: 401 }),
		);
	}
	if (identity.provisional) {
		return Response.json(
			{
				error: {
					code: "provisional_session",
					message: "Finish choosing a role before approving a device",
				},
			},
			noStore({ status: 409 }),
		);
	}
	const payload = await readPayload(request);
	const deviceCode =
		typeof payload.deviceCode === "string" ? payload.deviceCode : "";
	if (!deviceCode) {
		return Response.json(
			{ error: { code: "unauthorized", message: "Device login refused" } },
			noStore({ status: 401 }),
		);
	}
	const result =
		decision === "approve"
			? await adminStore.approveDeviceLogin({ deviceCode, identity })
			: await adminStore.denyDeviceLogin(deviceCode);
	if (!result.ok) {
		const status = result.code === "provisional_session" ? 409 : 401;
		return Response.json(
			{
				error: {
					code: result.code,
					message:
						result.code === "provisional_session"
							? "Finish choosing a role before approving a device"
							: "Device login refused",
				},
			},
			noStore({ status }),
		);
	}
	return Response.json(
		decision === "approve" ? { approved: true } : { denied: true },
		noStore({ status: 200 }),
	);
}
