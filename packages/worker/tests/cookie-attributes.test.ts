import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { REFRESH_COOKIE, REFRESH_PATH } from "../src/auth-routes.js";
import { getEdgeCache } from "../src/edge-cache.js";
import { D1AdminStore } from "../src/store/d1-admin.js";
import { REFRESH_IDLE_MS } from "../src/store/d1-sessions.js";
import { uniqueAccountId } from "./helpers.js";

/**
 * Issue #3 phase 8: the refresh cookie's full name and attributes, and the
 * rule that only /api/auth/session/refresh reads it (logout does not; the OAuth flow cookies are state, not credentials). The issue names
 * `__Host-cadmus_refresh` with `Path=/api/auth/session`; browsers reject a
 * `__Host-` cookie with a non-root Path, so the documented deviation is
 * `__Secure-cadmus_refresh` with the narrow path (auth-routes.ts).
 */

const ORIGIN = "https://example.com";
const SET_COOKIE =
	/^__Secure-cadmus_refresh=(cad_rt_[^;\s]+); Path=\/api\/auth\/session; HttpOnly; Secure; SameSite=Strict; Max-Age=(\d+)$/;
const CLEAR_COOKIE =
	"__Secure-cadmus_refresh=; Path=/api/auth/session; HttpOnly; Secure; SameSite=Strict; Max-Age=0";

async function seed() {
	const s = new D1AdminStore({
		db: env.CADMUS_ADMIN_DB,
		encryptionKey: env.CADMUS_ENCRYPTION_KEY,
		edgeCache: getEdgeCache(env),
	});
	const accountId = uniqueAccountId("cookie");
	const userId = `usr_${accountId}`;
	await s.ensureAccountAndUser({ accountId, userId, role: "user" });
	return s.createSession({ userId, accountId });
}

function post(path: string, cookie?: string): Promise<Response> {
	return SELF.fetch(`${ORIGIN}${path}`, {
		method: "POST",
		headers: {
			origin: ORIGIN,
			"x-cadmus-refresh": "1",
			...(cookie ? { cookie } : {}),
		},
	});
}

describe("refresh cookie name and attributes (issue #3 phase 8)", () => {
	it("pins the exported name and path", () => {
		expect(REFRESH_COOKIE).toBe("__Secure-cadmus_refresh");
		expect(REFRESH_PATH).toBe("/api/auth/session");
	});

	it("a rotated cookie carries every attribute, once", async () => {
		const t = await seed();
		const res = await post(
			"/api/auth/session/refresh",
			`${REFRESH_COOKIE}=${t.refreshToken}`,
		);
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toBe("no-store");
		const cookies = res.headers.getSetCookie();
		expect(cookies).toHaveLength(1);
		const m = SET_COOKIE.exec(cookies[0] ?? "");
		expect(m, cookies[0]).not.toBeNull();
		expect(m?.[1]).not.toBe(t.refreshToken);
		const maxAge = Number(m?.[2]);
		expect(maxAge).toBeGreaterThan(0);
		expect(maxAge * 1000).toBeLessThanOrEqual(REFRESH_IDLE_MS);
		// Fresh rotation: close to the full idle window, not a stub value.
		expect(maxAge * 1000).toBeGreaterThan(REFRESH_IDLE_MS - 60_000);
	});

	it("a refused refresh clears it with the same attributes; logout neither reads nor sets it", async () => {
		const bad = await post(
			"/api/auth/session/refresh",
			`${REFRESH_COOKIE}=cad_rt_nope`,
		);
		expect(bad.status).toBe(401);
		expect(bad.headers.getSetCookie()).toEqual([CLEAR_COOKIE]);
		// Issue #3: only /api/auth/session/refresh reads cookies. A cookie sent to logout is
		// ignored (revokes nothing, nothing set); the session survives.
		const t = await seed();
		const out = await post(
			"/api/auth/session/logout",
			`${REFRESH_COOKIE}=${t.refreshToken}`,
		);
		expect(out.status).toBe(200);
		expect(out.headers.get("cache-control")).toBe("no-store");
		expect(out.headers.getSetCookie()).toEqual([CLEAR_COOKIE]);
		expect(((await out.json()) as { revoked: boolean }).revoked).toBe(true);
		expect(
			(
				await post(
					"/api/auth/session/refresh",
					`${REFRESH_COOKIE}=${t.refreshToken}`,
				)
			).status,
		).toBe(401);
	});

	it("cookies are never a credential on the live routes", async () => {
		const t = await seed();
		const master = env.CADMUS_AUTH_SECRET ?? "";
		const whoami = JSON.stringify({
			id: "c1",
			type: "auth.whoami",
			payload: {},
		});
		const rpc = (headers: Record<string, string>) =>
			SELF.fetch(`${ORIGIN}/rpc`, {
				method: "POST",
				headers: { "content-type": "application/json", ...headers },
				body: whoami,
			});
		// Positive controls: the same credentials work from the header.
		expect(
			(await rpc({ authorization: `Bearer ${t.accessToken}` })).status,
		).toBe(200);
		expect((await rpc({ authorization: `Bearer ${master}` })).status).toBe(200);
		expect(
			(
				await SELF.fetch(`${ORIGIN}/api/auth/whoami`, {
					headers: { authorization: `Bearer ${t.accessToken}` },
				})
			).status,
		).toBe(200);

		const cookies = [
			`cadmus_session=${t.accessToken}`,
			`cadmus_session=${master}`,
			`${REFRESH_COOKIE}=${t.refreshToken}`,
			`${REFRESH_COOKIE}=${t.accessToken}`,
		];
		for (const cookie of cookies) {
			const probes: [string, Response][] = [
				["rpc", await rpc({ cookie })],
				[
					"api",
					await SELF.fetch(`${ORIGIN}/api/auth/whoami`, {
						headers: { cookie },
					}),
				],
				[
					"events",
					await SELF.fetch(`${ORIGIN}/events`, { headers: { cookie } }),
				],
				[
					"ws",
					await SELF.fetch(`${ORIGIN}/ws`, {
						headers: { cookie, upgrade: "websocket" },
					}),
				],
			];
			for (const [name, res] of probes) {
				const label = `${name} with ${cookie.split("=")[0]}`;
				expect(res.status, label).toBe(401);
				expect(res.headers.get("set-cookie"), label).toBeNull();
			}
		}
		// The refresh cookie was not consumed by any of those requests.
		expect(
			(
				await post(
					"/api/auth/session/refresh",
					`${REFRESH_COOKIE}=${t.refreshToken}`,
				)
			).status,
		).toBe(200);
	});

	it("token-login takes the token from the Authorization header only", async () => {
		const s = new D1AdminStore({
			db: env.CADMUS_ADMIN_DB,
			encryptionKey: env.CADMUS_ENCRYPTION_KEY,
			edgeCache: getEdgeCache(env),
		});
		const accountId = uniqueAccountId("cookie-tok");
		const userId = `usr_${accountId}`;
		await s.ensureAccountAndUser({ accountId, userId, role: "account-admin" });
		const created = await s.createToken({
			accountId,
			creatorUserId: userId,
			creatorRole: "account-admin",
			creatorGrants: ["chat.use"],
			kind: "service",
			label: "cookie probe",
			grants: ["chat.use"],
		});
		expect(created.ok).toBe(true);
		const raw = (created as { token: string }).token;
		expect(raw.startsWith("cad_svc_")).toBe(true);
		const login = (headers: Record<string, string>, query = "") =>
			SELF.fetch(`${ORIGIN}/api/auth/login/token${query}`, {
				method: "POST",
				headers: { origin: ORIGIN, ...headers },
			});
		// Positive control.
		const ok = await login({ authorization: `Bearer ${raw}` });
		expect(ok.status).toBe(200);
		expect(ok.headers.get("cache-control")).toBe("no-store");
		for (const [name, res] of [
			["cookie", await login({ cookie: `cadmus_session=${raw}` })],
			[
				"refresh-named cookie",
				await login({ cookie: `${REFRESH_COOKIE}=${raw}` }),
			],
			["query", await login({}, `?token=${raw}`)],
			[
				"header plus query",
				await login({ authorization: `Bearer ${raw}` }, `?token=${raw}`),
			],
		] as const) {
			expect(res.status, name).toBe(401);
			expect(res.headers.get("set-cookie"), name).toBeNull();
		}
	});

	it("other cookie names never refresh", async () => {
		const t = await seed();
		for (const name of ["cadmus_refresh", "__Host-cadmus_refresh"]) {
			const res = await post(
				"/api/auth/session/refresh",
				`${name}=${t.refreshToken}`,
			);
			expect(res.status, name).toBe(401);
		}
		// Positive control for the same token.
		expect(
			(
				await post(
					"/api/auth/session/refresh",
					`${REFRESH_COOKIE}=${t.refreshToken}`,
				)
			).status,
		).toBe(200);
	});
});
