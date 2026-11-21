import { readCookie } from "./auth.js";
import type { SessionTokens } from "./store/d1-sessions.js";
import type { Env } from "./types.js";

/**
 * Non-credential presence cookie scoped to `/app`.
 *
 * Carries only the literal `"1"` (never a token, user id, or secret) so the
 * edge can 302-redirect unauthenticated `/app*` navigations to `/login` without
 * serving `/app/index.html` or loading the main app bundle, while keeping
 * `__Secure-cadmus_refresh` strictly isolated on `/api/auth/session`.
 */
export const SESSION_HINT_COOKIE = "__Secure-cadmus_signed_in";
export const SESSION_HINT_PATH = "/app";

/**
 * Content-Security-Policy applied to Worker-served HTML documents (Cloudflare
 * Static Assets `_headers` is not applied to `env.ASSETS.fetch()` responses).
 * Kept in lockstep with `packages/web-app/public/_headers` (enforced by test).
 */
export const WEB_HTML_CSP =
	"default-src 'none'; script-src 'self' 'sha256-ju9Bcp5J4voBN4+1tq2r4ccodPkoNuEjg3kxpbPAfVs=' https://static.cloudflareinsights.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'";

export function sessionHintCookieHeader(tokens: SessionTokens): string {
	const maxAge = Math.max(
		0,
		Math.floor((tokens.refreshExpiresAt - Date.now()) / 1000),
	);
	return `${SESSION_HINT_COOKIE}=1; Path=${SESSION_HINT_PATH}; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearSessionHintCookieHeader(): string {
	return `${SESSION_HINT_COOKIE}=; Path=${SESSION_HINT_PATH}; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

const SENTINEL_ORIGIN = "https://cadmus.invalid";

function hasUnsafePathChars(raw: string): boolean {
	for (let i = 0; i < raw.length; i++) {
		const code = raw.charCodeAt(i);
		if (code < 0x20 || code === 0x7f) return true;
	}
	return raw.includes("\\");
}

/**
 * Validates a relative `/app` destination (pathname + optional query string).
 * Rejects scheme-relative (`//`), cross-origin, backslash, and non-`/app` paths.
 */
export function sanitizeAppNextPath(
	raw: string | null | undefined,
): string | undefined {
	if (!raw) return undefined;
	const trimmed = raw.trim();
	if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return undefined;
	if (hasUnsafePathChars(trimmed)) return undefined;
	let parsed: URL;
	try {
		parsed = new URL(trimmed, SENTINEL_ORIGIN);
	} catch {
		return undefined;
	}
	if (parsed.origin !== SENTINEL_ORIGIN) return undefined;
	if (parsed.pathname !== "/app" && !parsed.pathname.startsWith("/app/")) {
		return undefined;
	}
	return `${parsed.pathname}${parsed.search}`;
}

/**
 * Validates a post-login Google OAuth `returnTo` destination stored in the
 * signed OAuth transaction cookie. Only `/app`, `/app/*`, and `/login/device`
 * are accepted.
 */
export function sanitizeGoogleReturnTo(
	raw: string | null | undefined,
): string | undefined {
	if (!raw) return undefined;
	const trimmed = raw.trim();
	if (trimmed === "/login/device") return "/login/device";
	return sanitizeAppNextPath(trimmed);
}

function redirectResponse(location: string): Response {
	return new Response(null, {
		status: 302,
		headers: {
			location,
			"cache-control": "no-store",
		},
	});
}

async function serveHtmlAsset(
	request: Request,
	url: URL,
	env: Env,
	assetPath: string,
): Promise<Response> {
	if (!env.ASSETS) {
		return new Response("Not found", {
			status: 404,
			headers: { "cache-control": "no-store" },
		});
	}
	const assetUrl = new URL(assetPath, url.origin);
	const res = await env.ASSETS.fetch(
		new Request(assetUrl.toString(), { method: request.method }),
	);
	const out = new Response(res.body, res);
	out.headers.set("content-security-policy", WEB_HTML_CSP);
	out.headers.set("cache-control", "no-store");
	return out;
}

/**
 * Handles browser document navigations for `/`, `/sign-in*`, `/login*`, and
 * `/app*` (plus fallback passthrough for `/login/assets/*` and `/app/assets/*`).
 * Returns `null` when the request belongs to the API/RPC/WS/auth handlers.
 */
export async function handleWebRoute(
	request: Request,
	url: URL,
	env: Env,
): Promise<Response | null> {
	if (request.method !== "GET" && request.method !== "HEAD") return null;
	const { pathname, search } = url;

	if (pathname === "/") {
		return redirectResponse("/app");
	}

	if (pathname === "/sign-in" || pathname.startsWith("/sign-in/")) {
		const suffix = pathname.slice("/sign-in".length);
		return redirectResponse(`/login${suffix}${search}`);
	}

	if (
		pathname.startsWith("/login/assets/") ||
		pathname.startsWith("/app/assets/")
	) {
		if (!env.ASSETS) {
			return new Response("Not found", {
				status: 404,
				headers: { "cache-control": "no-store" },
			});
		}
		return env.ASSETS.fetch(request);
	}

	if (pathname === "/login" || pathname.startsWith("/login/")) {
		return serveHtmlAsset(request, url, env, "/login/index.html");
	}

	if (pathname === "/app" || pathname.startsWith("/app/")) {
		if (readCookie(request, SESSION_HINT_COOKIE) !== "1") {
			const next = sanitizeAppNextPath(`${pathname}${search}`);
			const target =
				next && next !== "/app" && next !== "/app/"
					? `/login?next=${encodeURIComponent(next)}`
					: "/login";
			return redirectResponse(target);
		}
		return serveHtmlAsset(request, url, env, "/app/index.html");
	}

	return null;
}
