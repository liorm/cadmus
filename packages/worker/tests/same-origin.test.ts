import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getEdgeCache } from "../src/edge-cache.js";
import { D1AdminStore } from "../src/store/d1-admin.js";
import { uniqueAccountId } from "./helpers.js";

/**
 * Issue #3 phase 8: strict same-origin. The worker sends no CORS allow headers,
 * which stops a browser from READING a cross-origin answer; it does not stop
 * the request from arriving. A browser names the page's origin on every
 * cross-origin write and every WebSocket handshake, so refuseCrossOrigin()
 * (index.ts) refuses those before auth or any handler runs. Non-browser clients
 * send no Origin and GET navigations (the OAuth callback) are unaffected.
 */
const ORIGIN = "https://example.com";
const EVIL = "https://evil.example";
const WRITE_PATHS = [
	"/api/auth/session/refresh",
	"/api/auth/session/logout",
	"/api/auth/login/devPassword",
	"/api/auth/whoami",
	"/api/bot/list",
	"/rpc",
	"/tools-env/pair",
];

async function sessionAccess(): Promise<string> {
	const s = new D1AdminStore({
		db: env.CADMUS_ADMIN_DB,
		encryptionKey: env.CADMUS_ENCRYPTION_KEY,
		edgeCache: getEdgeCache(env),
	});
	const accountId = uniqueAccountId("same-origin");
	const userId = `usr_${accountId}`;
	await s.ensureAccountAndUser({ accountId, userId, role: "account-admin" });
	const session = await s.createSession({ userId, accountId });
	return session.accessToken;
}

function expectRefused(res: Response, label: string) {
	expect(res.status, label).toBe(403);
	expect(res.headers.get("cache-control"), label).toBe("no-store");
	expect(res.headers.get("access-control-allow-origin"), label).toBeNull();
	expect(res.headers.get("set-cookie"), label).toBeNull();
}

describe("strict same-origin (issue #3 phase 8)", () => {
	for (const path of WRITE_PATHS) {
		it(`${path}: a cross-origin or null-origin write is refused, a same-origin or origin-less one is not`, async () => {
			for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
				for (const origin of [EVIL, "null", "http://example.com"]) {
					const res = await SELF.fetch(`${ORIGIN}${path}`, {
						method,
						headers: { origin },
					});
					expectRefused(res, `${method} ${path} origin=${origin}`);
					const body = (await res.json()) as { error: { code: string } };
					expect(body.error.code).toBe("forbidden");
				}
				for (const headers of [{ origin: ORIGIN }, {}] as Record<
					string,
					string
				>[]) {
					const res = await SELF.fetch(`${ORIGIN}${path}`, {
						method,
						headers,
					});
					const text = await res.text();
					expect(
						text.includes("Cross-origin request refused"),
						`${method} ${path} ${JSON.stringify(headers)} reached the handler`,
					).toBe(false);
				}
			}
		});
	}

	it("a cross-origin preflight is refused and grants nothing", async () => {
		const res = await SELF.fetch(`${ORIGIN}/rpc`, {
			method: "OPTIONS",
			headers: {
				origin: EVIL,
				"access-control-request-method": "POST",
				"access-control-request-headers": "authorization",
			},
		});
		expectRefused(res, "preflight");
		expect(res.headers.get("access-control-allow-headers")).toBeNull();
		expect(res.headers.get("access-control-allow-methods")).toBeNull();
	});

	it("a valid bearer cannot write through /api or /rpc from another origin", async () => {
		const accessToken = await sessionAccess();
		const auth = { authorization: `Bearer ${accessToken}` };
		const same = await SELF.fetch(`${ORIGIN}/api/bot/list`, {
			headers: { ...auth, origin: ORIGIN },
		});
		expect(same.status, await same.clone().text()).toBe(200);
		for (const path of ["/api/auth/whoami", "/api/bot/list", "/rpc"]) {
			const res = await SELF.fetch(`${ORIGIN}${path}`, {
				method: "POST",
				headers: { ...auth, origin: EVIL },
			});
			expectRefused(res, `${path} with a valid bearer`);
		}
	});

	it("a WebSocket handshake from another origin is refused, a same-origin one is not", async () => {
		const evil = await SELF.fetch(`${ORIGIN}/ws`, {
			headers: { upgrade: "websocket", origin: EVIL },
		});
		expectRefused(evil, "ws evil");
		const evilEvents = await SELF.fetch(`${ORIGIN}/tools-env/ws`, {
			headers: { upgrade: "websocket", origin: EVIL },
		});
		expectRefused(evilEvents, "tools-env ws evil");
		const same = await SELF.fetch(`${ORIGIN}/ws`, {
			headers: { upgrade: "websocket", origin: ORIGIN },
		});
		expect(same.status).toBe(401);
	});

	it("safe GET navigations with a foreign Origin are not refused (OAuth callback, providers)", async () => {
		for (const path of [
			"/api/auth/login/providers",
			"/api/auth/login/google/callback",
			"/health",
		]) {
			const res = await SELF.fetch(`${ORIGIN}${path}`, {
				headers: { origin: EVIL },
				redirect: "manual",
			});
			expect(res.status, path).not.toBe(403);
		}
	});

	it("no response carries an access-control-* header", async () => {
		for (const path of [
			"/health",
			"/api/auth/login/providers",
			"/api/bot/list",
			"/rpc",
		]) {
			const res = await SELF.fetch(`${ORIGIN}${path}`, {
				headers: { origin: EVIL },
			});
			for (const [name] of res.headers) {
				expect(name.startsWith("access-control-"), `${path} ${name}`).toBe(
					false,
				);
			}
		}
	});
});
