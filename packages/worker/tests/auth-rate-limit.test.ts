import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	LOCKOUT_MAX_FAILURES,
	LOCKOUT_MS,
	LOCKOUT_WINDOW_MS,
	limitByIp,
	lockoutClear,
	lockoutFail,
	lockoutStatus,
	resolveAuthRateLimitWindowMs,
} from "../src/auth-limiter.js";
import { getEdgeCache } from "../src/edge-cache.js";
import { IP_LIMITED_AUTH_PATHS, refuseWorkersDev } from "../src/index.js";
import { D1AdminStore } from "../src/store/d1-admin.js";
import type { Env } from "../src/types.js";
import { sendRpc, uniqueAccountId } from "./helpers.js";

/**
 * Issue #3 phase 8, decision 15: per-IP budget (Workers Rate Limiting binding)
 * and a per-identity lockout counter (Durable Object).
 */
/**
 * Hypothesis, not proven for the one failing run: the local rate limiter may
 * use fixed windows aligned to the clock, so a burst that straddles :00 would
 * see a fresh budget. This only delays when each test starts (so a burst has
 * room in its window); it changes no production budget logic.
 */
async function windowRoom(minMs = 25_000) {
	const left = 60_000 - (Date.now() % 60_000);
	if (left < minMs) await new Promise((r) => setTimeout(r, left + 50));
}

beforeEach(async () => {
	await windowRoom();
}, 40_000);

const ORIGIN = "https://example.com";
const LOCAL = "http://localhost";
const LIMIT = 20;
const REFRESH_LIMIT = 120;
let ipSeq = 0;
const freshIp = () => `203.0.113.${(ipSeq++ % 250) + 1}-${crypto.randomUUID()}`;

function post(path: string, ip?: string, host = ORIGIN) {
	// A fresh email each time. An empty email is the shared bootstrap
	// identity, and five wrong passwords would lock it for every other test
	// on this workerd.
	return SELF.fetch(`${host}${path}`, {
		method: "POST",
		headers: {
			origin: host,
			"content-type": "application/json",
			...(ip ? { "cf-connecting-ip": ip } : {}),
		},
		body: JSON.stringify({
			payload: {
				email: `budget-${crypto.randomUUID()}@example.com`,
				password: "wrong",
			},
		}),
	});
}

async function statuses(path: string, n: number, ip?: string, host = ORIGIN) {
	const out: Response[] = [];
	for (let i = 0; i < n; i++) out.push(await post(path, ip, host));
	return out;
}

describe("per-IP budget (issue #3 phase 8)", () => {
	it("is configured as a binding with a stated limit", () => {
		expect(typeof env.CADMUS_AUTH_RATELIMIT.limit).toBe("function");
		expect([...IP_LIMITED_AUTH_PATHS].sort()).toEqual([
			"/api/auth/login/devPassword",
			"/api/auth/login/device/approve",
			"/api/auth/login/device/deny",
			"/api/auth/login/device/poll",
			"/api/auth/login/device/start",
			"/api/auth/login/google/callback",
			"/api/auth/login/google/start",
			"/api/auth/session/refresh",
		]);
		expect(resolveAuthRateLimitWindowMs(undefined, "test")).toBeNull();
		expect(resolveAuthRateLimitWindowMs("15000", "production")).toBeNull();
		expect(resolveAuthRateLimitWindowMs("15000", "test")).toBe(15_000);
		expect(resolveAuthRateLimitWindowMs("10", "test")).toBe(1_000);
	});

	it("the test window override counts per route and redirects navigations", async () => {
		const override = {
			CADMUS_DEPLOY_ENV: "test",
			CADMUS_AUTH_RATE_LIMIT_WINDOW_MS: "60000",
		} as Env;
		const ip = `198.51.100.${crypto.randomUUID()}`;
		const ask = (path: string, mode: "api" | "navigation" = "api") =>
			limitByIp(
				override,
				new Request(`http://localhost${path}`, {
					headers: { "cf-connecting-ip": ip },
				}),
				path,
				mode,
			);
		for (let i = 0; i < LIMIT; i++) {
			expect(await ask("/api/auth/login/devPassword")).toBeNull();
		}
		const blocked = await ask("/api/auth/login/devPassword");
		if (!blocked) throw new Error("expected a rate-limit response");
		expect(blocked.status).toBe(429);
		expect(
			((await blocked.json()) as { error: { code: string } }).error.code,
		).toBe("rate_limited");
		for (let i = 0; i < LIMIT; i++) {
			expect(
				await ask("/api/auth/login/google/start", "navigation"),
			).toBeNull();
		}
		const nav = await ask("/api/auth/login/google/start", "navigation");
		expect(nav?.status).toBe(302);
		expect(nav?.headers.get("location")).toBe("/?auth_error=rate_limited");
	});

	it("/api/auth/session/refresh has its own larger budget: 120 pass (more than the credential routes' 20), then 429", async () => {
		const ip = freshIp();
		const res = await statuses(
			"/api/auth/session/refresh",
			REFRESH_LIMIT + 5,
			ip,
		);
		for (const r of res.slice(0, REFRESH_LIMIT)) {
			expect(r.status, "inside the refresh budget").not.toBe(429);
		}
		for (const r of res.slice(REFRESH_LIMIT)) {
			expect(r.status, "over the refresh budget").toBe(429);
			expect(r.headers.get("cache-control")).toBe("no-store");
			expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
			expect(r.headers.get("set-cookie")).toBeNull();
		}
	});

	it("budgets are per IP and per route", async () => {
		const ip = freshIp();
		await statuses("/api/auth/login/devPassword", LIMIT + 2, ip, LOCAL);
		expect((await post("/api/auth/login/devPassword", ip, LOCAL)).status).toBe(
			429,
		);
		expect(
			(await post("/api/auth/login/devPassword", freshIp(), LOCAL)).status,
		).not.toBe(429);
		expect((await post("/api/auth/session/refresh", ip)).status).not.toBe(429);
	});

	it("a refused refresh is a transient 429, never a 401 that would sign the tab out", async () => {
		const ip = freshIp();
		const res = await statuses(
			"/api/auth/session/refresh",
			REFRESH_LIMIT + 1,
			ip,
		);
		expect(res.at(-1)?.status).toBe(429);
		expect(res.at(-1)?.status).not.toBe(401);
	});

	it("google start and callback: over the budget they redirect to the app with auth_error=rate_limited (no raw JSON page, no cookie)", async () => {
		for (const path of [
			"/api/auth/login/google/start",
			"/api/auth/login/google/callback",
		]) {
			const ip = freshIp();
			const res: Response[] = [];
			for (let i = 0; i < LIMIT + 3; i++) {
				res.push(
					await SELF.fetch(`${ORIGIN}${path}`, {
						headers: { "cf-connecting-ip": ip },
						redirect: "manual",
					}),
				);
			}
			for (const r of res.slice(0, LIMIT)) {
				expect(r.headers.get("location"), `${path} inside`).not.toBe(
					"/?auth_error=rate_limited",
				);
			}
			for (const r of res.slice(LIMIT)) {
				expect(r.status, path).toBe(302);
				expect(r.headers.get("location"), path).toBe(
					"/?auth_error=rate_limited",
				);
				expect(r.headers.get("cache-control")).toBe("no-store");
				expect(Number(r.headers.get("retry-after"))).toBeGreaterThan(0);
				expect(r.headers.get("set-cookie")).toBeNull();
			}
		}
	});

	it("dev-password over the IP budget is a JSON 429 (localhost)", async () => {
		const ip = freshIp();
		const dev: Response[] = [];
		for (let n = 0; n < LIMIT + 3; n++) {
			// A fresh email each time keeps the per-identity lockout out of this check.
			dev.push(
				await SELF.fetch(`${LOCAL}/api/auth/login/devPassword`, {
					method: "POST",
					headers: {
						origin: LOCAL,
						"content-type": "application/json",
						"cf-connecting-ip": ip,
					},
					body: JSON.stringify({
						payload: {
							email: `ip-${crypto.randomUUID()}@example.com`,
							password: "wrong",
						},
					}),
				}),
			);
		}
		expect(dev.at(-1)?.status).toBe(429);
	});

	it("providers and logout are not budgeted", async () => {
		const ip = freshIp();
		for (let i = 0; i < LIMIT + 10; i++) {
			const res = await SELF.fetch(`${ORIGIN}/api/auth/login/providers`, {
				headers: { "cf-connecting-ip": ip },
			});
			expect(res.status).toBe(200);
		}
		for (const r of await statuses(
			"/api/auth/session/logout",
			LIMIT + 10,
			ip,
		)) {
			expect(r.status).not.toBe(429);
		}
	});

	it("a request without cf-connecting-ip (not via the edge) is never budgeted", async () => {
		for (const r of await statuses(
			"/api/auth/login/devPassword",
			LIMIT + 10,
			undefined,
			LOCAL,
		)) {
			expect(r.status).not.toBe(429);
		}
		for (let i = 0; i < LIMIT + 5; i++) {
			const r = await SELF.fetch(`${ORIGIN}/api/auth/login/google/start`, {
				redirect: "manual",
			});
			expect(r.headers.get("location")).not.toBe("/?auth_error=rate_limited");
		}
	});
});

describe("per-identity lockout (issue #3 phase 8)", () => {
	const email = () => `lock-${crypto.randomUUID()}@example.com`;

	it("the policy is 5 failures in 15 minutes, locked for 15 minutes", () => {
		expect(LOCKOUT_MAX_FAILURES).toBe(5);
		expect(LOCKOUT_WINDOW_MS).toBe(15 * 60_000);
		expect(LOCKOUT_MS).toBe(15 * 60_000);
	});

	it("locks after the maximum number of failures, not before", async () => {
		const id = email();
		for (let i = 1; i < LOCKOUT_MAX_FAILURES; i++) {
			expect((await lockoutFail(env, "t", id)).locked, `failure ${i}`).toBe(
				false,
			);
			expect((await lockoutStatus(env, "t", id)).locked).toBe(false);
		}
		const last = await lockoutFail(env, "t", id);
		expect(last.locked).toBe(true);
		expect(last.retryAfterSec).toBeGreaterThan(LOCKOUT_MS / 1000 - 5);
		expect((await lockoutStatus(env, "t", id)).locked).toBe(true);
	});

	it("is per identity, per kind, and case-insensitive", async () => {
		const id = email();
		for (let i = 0; i < LOCKOUT_MAX_FAILURES; i++) {
			await lockoutFail(env, "a", id.toUpperCase());
		}
		expect((await lockoutStatus(env, "a", id)).locked).toBe(true);
		expect((await lockoutStatus(env, "b", id)).locked).toBe(false);
		expect((await lockoutStatus(env, "a", email())).locked).toBe(false);
	});

	it("a clear resets the count", async () => {
		const id = email();
		for (let i = 0; i < LOCKOUT_MAX_FAILURES - 1; i++) {
			await lockoutFail(env, "c", id);
		}
		await lockoutClear(env, "c", id);
		for (let i = 0; i < LOCKOUT_MAX_FAILURES - 1; i++) {
			expect((await lockoutFail(env, "c", id)).locked).toBe(false);
		}
		await lockoutClear(env, "c", id);
		for (let i = 0; i < LOCKOUT_MAX_FAILURES; i++)
			await lockoutFail(env, "c", id);
		expect((await lockoutStatus(env, "c", id)).locked).toBe(true);
		await lockoutClear(env, "c", id);
		expect((await lockoutStatus(env, "c", id)).locked).toBe(false);
	});

	it("dev-password: repeated wrong passwords lock the email, the right password is then refused, another email is unaffected", async () => {
		const login = (email: string, password: string) =>
			SELF.fetch(`${LOCAL}/api/auth/login/devPassword`, {
				method: "POST",
				headers: { origin: LOCAL, "content-type": "application/json" },
				body: JSON.stringify({ payload: { email, password } }),
			});
		const victim = email();
		for (let i = 1; i < LOCKOUT_MAX_FAILURES; i++) {
			expect((await login(victim, "nope")).status, `failure ${i}`).toBe(401);
		}
		const locking = await login(victim, "nope");
		expect(locking.status).toBe(429);
		expect(locking.headers.get("cache-control")).toBe("no-store");
		expect(locking.headers.get("set-cookie")).toBeNull();
		expect(
			((await locking.json()) as { error: { code: string } }).error.code,
		).toBe("locked_out");
		// The correct password does not get through while locked.
		const right = await login(victim, "dev-pass");
		expect(right.status).toBe(429);
		expect(right.headers.get("set-cookie")).toBeNull();
		// An empty email means the bootstrap super-admin, a different identity.
		// It is unaffected by the locked one, and a success clears only that email's own count:
		// after it, a full run of failures short of the maximum still returns 401.
		expect((await login("", "nope")).status).toBe(401);
		expect((await login("", "dev-pass")).status).toBe(200);
		for (let i = 1; i < LOCKOUT_MAX_FAILURES; i++) {
			expect((await login("", "nope")).status, `after clear ${i}`).toBe(401);
		}
		expect((await login("", "dev-pass")).status).toBe(200);
	});
});

describe("per-principal budget on auth.ticket and passkeys (issue #3 phase 8)", () => {
	async function session() {
		const s = new D1AdminStore({
			db: env.CADMUS_ADMIN_DB,
			encryptionKey: env.CADMUS_ENCRYPTION_KEY,
			edgeCache: getEdgeCache(env),
		});
		const accountId = uniqueAccountId("rpc-limit");
		const userId = `usr_${accountId}`;
		await s.ensureAccountAndUser({ accountId, userId, role: "account-admin" });
		return (await s.createSession({ userId, accountId })).accessToken;
	}
	const rpc = async (
		accessToken: string,
		type: string,
		payload: Record<string, unknown> = {},
	) => {
		const { status, frame } = await sendRpc(type, payload, {
			token: accessToken,
		});
		return { status, body: frame };
	};

	it("auth.ticket: 60 calls pass, the next is rate_limited; another session is unaffected; whoami is not budgeted", async () => {
		const token = await session();
		for (let i = 0; i < 60; i++) {
			const r = await rpc(token, "auth.ticket", { target: "ws" });
			expect(r.body.ok, `call ${i + 1}: ${JSON.stringify(r.body)}`).toBe(true);
		}
		const over = await rpc(token, "auth.ticket", { target: "ws" });
		expect(over.body.ok).toBe(false);
		expect(over.body.error?.code).toBe("rate_limited");
		// /rpc keeps 400 for every failed command (documented in protocol/rest.ts).
		expect(over.status).toBe(400);
		const who = await rpc(token, "auth.whoami");
		expect(who.body.ok, JSON.stringify(who.body).slice(0, 200)).toBe(true);
		const other = await session();
		expect((await rpc(other, "auth.ticket", { target: "ws" })).body.ok).toBe(
			true,
		);
	});

	it("the REST adapter maps rate_limited to 429 (POST /api/auth/ticket)", async () => {
		const token = await session();
		let last = 0;
		let body = "";
		for (let i = 0; i < 61; i++) {
			const res = await SELF.fetch(`${ORIGIN}/api/auth/ticket`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
					origin: ORIGIN,
				},
				body: JSON.stringify({ target: "ws" }),
			});
			last = res.status;
			body = await res.text();
			if (i < 60) expect(res.status, `call ${i + 1}: ${body}`).toBe(200);
		}
		expect(last, body).toBe(429);
		expect(JSON.parse(body).error.code).toBe("rate_limited");
	});
});

describe("lockout counter timing, driven with an explicit clock (issue #3 phase 8)", () => {
	const T0 = 1_800_000_000_000;
	const counter = () =>
		env.CADMUS_AUTH_LIMITER.get(
			env.CADMUS_AUTH_LIMITER.idFromName(`clock:${crypto.randomUUID()}`),
		);

	it("the fifth failure inside the window locks for exactly 15 minutes, in seconds", async () => {
		const c = counter();
		for (let i = 0; i < LOCKOUT_MAX_FAILURES - 1; i++) {
			expect((await c.fail(T0 + i * 1_000)).locked).toBe(false);
		}
		const locked = await c.fail(T0 + 10_000);
		expect(locked.locked).toBe(true);
		expect(locked.retryAfterSec).toBe(LOCKOUT_MS / 1000);
		expect((await c.status(T0 + 10_000 + 60_000)).retryAfterSec).toBe(
			LOCKOUT_MS / 1000 - 60,
		);
	});

	it("the lock lasts to the last millisecond before 15 minutes, then expires", async () => {
		const c = counter();
		for (let i = 0; i < LOCKOUT_MAX_FAILURES; i++) await c.fail(T0);
		expect((await c.status(T0 + LOCKOUT_MS - 1)).locked).toBe(true);
		expect((await c.status(T0 + LOCKOUT_MS)).locked).toBe(false);
		expect((await c.status(T0 + 10 * LOCKOUT_MS)).locked).toBe(false);
		// Counting starts afresh after expiry: one failure does not re-lock.
		expect((await c.fail(T0 + LOCKOUT_MS + 1)).locked).toBe(false);
	});

	it("a failure older than the window no longer counts", async () => {
		const c = counter();
		for (let i = 0; i < LOCKOUT_MAX_FAILURES - 1; i++) await c.fail(T0);
		// The four earlier failures are now outside the 15 minute window.
		expect((await c.fail(T0 + LOCKOUT_WINDOW_MS)).locked).toBe(false);
		// Inside the window the same fifth failure does lock (positive control).
		const d = counter();
		for (let i = 0; i < LOCKOUT_MAX_FAILURES - 1; i++) await d.fail(T0);
		expect((await d.fail(T0 + LOCKOUT_WINDOW_MS - 1)).locked).toBe(true);
	});
});

describe("workers.dev is not a production entry (issue #99)", () => {
	it("refuses a workers.dev host only for production, not for previews", () => {
		const workers = new URL("https://cadmus.example.workers.dev/health");
		const custom = new URL("https://cadmus.purelogicstudios.com/health");
		const production = { CADMUS_DEPLOY_ENV: "production" };
		expect(refuseWorkersDev(workers, production)?.status).toBe(404);
		expect(refuseWorkersDev(custom, production)).toBeNull();
		expect(
			refuseWorkersDev(workers, {
				CADMUS_DEPLOY_ENV: "production",
				IS_PREVIEW: "true",
			}),
		).toBeNull();
		expect(refuseWorkersDev(workers, { CADMUS_DEPLOY_ENV: "test" })).toBeNull();
		expect(refuseWorkersDev(workers, {})).toBeNull();
		expect(
			refuseWorkersDev(new URL("https://workers.dev/"), production)?.status,
		).toBe(404);
	});
});
