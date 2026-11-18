import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { readCookie } from "../src/auth.js";
import { REFRESH_COOKIE } from "../src/auth-routes.js";
import { getEdgeCache } from "../src/edge-cache.js";
import { D1AdminStore } from "../src/store/d1-admin.js";
import { uniqueAccountId } from "./helpers.js";

/**
 * Issue #3 phase 8 (L159): "no route other than /api/auth/session/refresh reads cookies".
 * Intended reading: no route takes a CREDENTIAL from a cookie. The Google
 * sign-in routes also read two short-lived OAuth state cookies (the
 * transaction and the link bind); they carry no session, are bound to the
 * flow, and are the CSRF binding for it, so they are an explicit allowlist
 * here and are exercised in google-login.test.ts.
 *
 * What the OAuth cookies hold (source: auth/google.ts, auth-routes.ts):
 * - the link bind cookie is a random 24-byte nonce. The signed link ticket
 *   (HMAC, 120 s, purpose "link", names the user and session) comes in the
 *   query string from auth.methods.link.start, which is header-authenticated,
 *   and only works when the browser also presents the nonce that matches the
 *   ticket. Neither value alone starts a link; the nonce is not a session.
 * - the txn cookie binds the OAuth callback to the browser that started it.
 *
 * Reach of this file, stated honestly:
 * - The source guard counts direct reads of the cookie header per file, and
 *   calls of the shared `readCookie` helper. It does not see a read through
 *   another Headers object or a variable name.
 * - The behaviour test sends cookies only to /api/auth/session/logout, /api/auth/login/providers,
 *   /api/auth/login/devPassword and /api/auth/login/google/start. Cookies on /rpc, /api,
 *   /events, /ws and /api/auth/login/token are covered in cookie-attributes.test.ts
 *   ("cookies are not credentials" and the token-login case).
 */
const ORIGIN = "https://example.com";
const LOCAL = "http://localhost";

const sources = import.meta.glob("../src/**/*.ts", {
	query: "?raw",
	import: "default",
	eager: true,
}) as Record<string, string>;

describe("cookie reads are confined (issue #3 phase 8, L159)", () => {
	it("only auth.ts and auth-routes.ts read the cookie header, at the known sites", () => {
		const readers: Record<string, number> = {};
		for (const [file, text] of Object.entries(sources)) {
			const n = (
				text.match(/headers\s*\.\s*get\(\s*["'`]cookie["'`]\s*\)/gi) ?? []
			).length;
			if (n > 0) readers[file.replace("../src/", "")] = n;
		}
		// The only Cookie-header read is readCookie in auth.ts. auth-routes.ts
		// calls it for the two OAuth state cookies and the refresh cookie.
		// auth.ts also calls it once, for the retired cadmus_session credential.
		expect(readers).toEqual({ "auth.ts": 1 });
		const callers: Record<string, number> = {};
		for (const [file, text] of Object.entries(sources)) {
			const n = (text.match(/\breadCookie\s*\(/g) ?? []).length;
			if (n > 0) callers[file.replace("../src/", "")] = n;
		}
		expect(callers).toEqual({ "auth.ts": 2, "auth-routes.ts": 3 });
		expect(Object.keys(sources).length).toBeGreaterThan(10);
	});

	it("logout, providers, dev-password and Google start ignore session and refresh cookies", async () => {
		const s = new D1AdminStore({
			db: env.CADMUS_ADMIN_DB,
			encryptionKey: env.CADMUS_ENCRYPTION_KEY,
			edgeCache: getEdgeCache(env),
		});
		const accountId = uniqueAccountId("cookie-reads");
		const userId = `usr_${accountId}`;
		await s.ensureAccountAndUser({ accountId, userId, role: "account-admin" });
		const t = await s.createSession({ userId, accountId });
		const whoami = (headers: Record<string, string>) =>
			SELF.fetch(`${ORIGIN}/api/auth/whoami`, { headers });
		// Positive control: the session works from the header.
		expect(
			(await whoami({ authorization: `Bearer ${t.accessToken}` })).status,
		).toBe(200);

		const cookie = `cadmus_session=${t.accessToken}; ${REFRESH_COOKIE}=${t.refreshToken}`;
		// Public login routes ignore the cookies: no Set-Cookie, no session.
		for (const [path, base, method] of [
			["/api/auth/login/providers", ORIGIN, "GET"],
			["/api/auth/login/devPassword", LOCAL, "POST"],
			["/api/auth/login/google/start", ORIGIN, "GET"],
		] as const) {
			const res = await SELF.fetch(`${base}${path}`, {
				method,
				headers: { origin: base, "x-cadmus-refresh": "1", cookie },
				redirect: "manual",
			});
			const set = res.headers.get("set-cookie") ?? "";
			expect(set, path).not.toContain("cad_rt_");
			expect(set, path).not.toContain(REFRESH_COOKIE);
		}
		expect(
			(await whoami({ authorization: `Bearer ${t.accessToken}` })).status,
		).toBe(200);
		const logout = await SELF.fetch(`${ORIGIN}/api/auth/session/logout`, {
			method: "POST",
			headers: { origin: ORIGIN, "x-cadmus-refresh": "1", cookie },
		});
		expect(logout.status).toBe(200);
		expect(await logout.json()).toEqual({ revoked: true });
		expect(logout.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
		expect(
			(await whoami({ authorization: `Bearer ${t.accessToken}` })).status,
		).toBe(401);
		const refreshed = await SELF.fetch(`${ORIGIN}/api/auth/session/refresh`, {
			method: "POST",
			headers: {
				origin: ORIGIN,
				"x-cadmus-refresh": "1",
				cookie: `${REFRESH_COOKIE}=${t.refreshToken}`,
			},
		});
		expect(refreshed.status).toBe(401);
	});

	it("a malformed cadmus_session percent-escape is absent, not a 500", async () => {
		const onlyBad = new Request(`${ORIGIN}/api/auth/whoami`, {
			headers: { cookie: "cadmus_session=%ZZ" },
		});
		expect(readCookie(onlyBad, "cadmus_session", { decode: true })).toBe(
			undefined,
		);
		const later = new Request(`${ORIGIN}/api/auth/whoami`, {
			headers: { cookie: "cadmus_session=%ZZ; cadmus_session=cad_at_ok" },
		});
		expect(readCookie(later, "cadmus_session", { decode: true })).toBe(
			"cad_at_ok",
		);

		// The bad escape is absent, so these are the same 401 as a request with
		// no credential. They must not be a 500 from decodeURIComponent.
		const cookie = "cadmus_session=%ZZ";
		const probes: Array<[string, RequestInit]> = [
			["/api/auth/whoami", { headers: { cookie } }],
			[
				"/rpc",
				{
					method: "POST",
					headers: { cookie, "content-type": "application/json" },
					body: JSON.stringify({
						id: "bad-cookie",
						type: "auth.whoami",
						payload: {},
					}),
				},
			],
			["/events", { headers: { cookie } }],
			["/ws", { headers: { cookie, upgrade: "websocket" } }],
		];
		for (const [path, init] of probes) {
			const res = await SELF.fetch(`${ORIGIN}${path}`, init);
			expect(res.status, path).toBe(401);
			expect(await res.json(), path).toMatchObject({
				type: "protocol.error",
				payload: { code: "unauthorized" },
			});
		}
	});
});
