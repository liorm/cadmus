import type { AdminStore } from "./store/admin-interface.js";
import type { SessionTokens } from "./store/d1-sessions.js";

/**
 * The refresh cookie. The issue names it `__Host-cadmus_refresh` with
 * `Path=/auth/refresh`, but browsers reject a `__Host-` cookie that is not
 * scoped to `Path=/`, so `__Secure-` keeps the narrow path.
 */
export const REFRESH_COOKIE = "__Secure-cadmus_refresh";
export const REFRESH_PATH = "/auth/refresh";

export function isAuthRoute(pathname: string): boolean {
	return pathname === REFRESH_PATH;
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

function readRefreshCookie(request: Request): string | undefined {
	const header = request.headers.get("cookie");
	if (!header) return undefined;
	for (const part of header.split(";")) {
		const [name, ...rest] = part.trim().split("=");
		if (name === REFRESH_COOKIE) return rest.join("=");
	}
	return undefined;
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
	const raw = readRefreshCookie(request);
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
		},
		noStore({ status: 200, cookie: refreshCookieHeader(result.tokens) }),
	);
}
