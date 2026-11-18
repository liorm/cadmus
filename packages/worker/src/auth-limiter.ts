import { DurableObject } from "cloudflare:workers";
import { sha256Hex } from "./edge-cache.js";
import { resolveClampedTestInt } from "./env-overrides.js";
import type { Env } from "./types.js";

/**
 * Issue #3 phase 8, decision 15: rate limits for the credential routes.
 *
 * Two layers. The Workers Rate Limiting binding (`CADMUS_AUTH_RATELIMIT`, set
 * in wrangler.jsonc) caps requests per client IP. The lockout counter below is
 * a Durable Object per identity (an email) that counts failed sign-ins and
 * locks the identity for a while, so many IPs cannot share one guess budget.
 * A success clears the counter. The identity is hashed before it names the
 * object, so no email appears in a DO name.
 */
export const LOCKOUT_MAX_FAILURES = 5;
export const LOCKOUT_WINDOW_MS = 15 * 60_000;
export const LOCKOUT_MS = 15 * 60_000;

const MIN_AUTH_WINDOW_MS = 1_000;
const MAX_AUTH_WINDOW_MS = 300_000;
const testWindowCounters = new Map<
	string,
	{ count: number; resetAt: number }
>();

/**
 * Test-only per-IP rate-limit window override (same clamp pattern as
 * `resolveHeartbeatMs`). Returns null when unset, invalid, or in production so
 * production always uses the Cloudflare RateLimit bindings and 60s defaults.
 */
export function resolveAuthRateLimitWindowMs(
	raw: string | undefined,
	deployEnv: string | undefined,
): number | null {
	return resolveClampedTestInt(
		raw,
		deployEnv,
		MIN_AUTH_WINDOW_MS,
		MAX_AUTH_WINDOW_MS,
	);
}

export interface LockState {
	locked: boolean;
	retryAfterSec: number;
}

interface Counter {
	failures: number[];
	lockedUntil: number;
}

export class CadmusAuthLimiterDO extends DurableObject<Env> {
	async status(now: number): Promise<LockState> {
		const c = await this.#load();
		return lockState(c, now);
	}

	async fail(now: number): Promise<LockState> {
		const c = await this.#load();
		if (c.lockedUntil > now) return lockState(c, now);
		c.failures = c.failures.filter((t) => now - t < LOCKOUT_WINDOW_MS);
		c.failures.push(now);
		if (c.failures.length >= LOCKOUT_MAX_FAILURES) {
			c.lockedUntil = now + LOCKOUT_MS;
			c.failures = [];
		}
		await this.ctx.storage.put("counter", c);
		return lockState(c, now);
	}

	async clear(): Promise<void> {
		await this.ctx.storage.deleteAll();
	}

	async #load(): Promise<Counter> {
		return (
			(await this.ctx.storage.get<Counter>("counter")) ?? {
				failures: [],
				lockedUntil: 0,
			}
		);
	}
}

function lockState(c: Counter, now: number): LockState {
	return c.lockedUntil > now
		? { locked: true, retryAfterSec: Math.ceil((c.lockedUntil - now) / 1000) }
		: { locked: false, retryAfterSec: 0 };
}

async function stub(env: Env, kind: string, identity: string) {
	const name = `${kind}:${await sha256Hex(identity.trim().toLowerCase())}`;
	return env.CADMUS_AUTH_LIMITER.get(env.CADMUS_AUTH_LIMITER.idFromName(name));
}

export async function lockoutStatus(
	env: Env,
	kind: string,
	identity: string,
): Promise<LockState> {
	return (await stub(env, kind, identity)).status(Date.now());
}

export async function lockoutFail(
	env: Env,
	kind: string,
	identity: string,
): Promise<LockState> {
	return (await stub(env, kind, identity)).fail(Date.now());
}

export async function lockoutClear(
	env: Env,
	kind: string,
	identity: string,
): Promise<void> {
	await (await stub(env, kind, identity)).clear();
}

/** 429 for a locked identity or an exhausted IP budget. Never sets a cookie. */
export function tooManyRequests(
	retryAfterSec: number,
	code: "rate_limited" | "locked_out",
): Response {
	return Response.json(
		{
			error: {
				code,
				message:
					code === "locked_out"
						? "Too many failed sign-ins. Try again later."
						: "Too many requests. Try again shortly.",
			},
		},
		{
			status: 429,
			headers: {
				"cache-control": "no-store",
				"retry-after": String(Math.max(1, retryAfterSec)),
			},
		},
	);
}

/**
 * A top-level browser navigation (Google start and callback) that hits the IP
 * budget goes back to the app with an auth_error, as every other callback
 * failure does, instead of leaving the user on a raw JSON page.
 */
function navigationRefused(retryAfterSec: number): Response {
	return new Response(null, {
		status: 302,
		headers: {
			location: "/?auth_error=rate_limited",
			"cache-control": "no-store",
			"retry-after": String(Math.max(1, retryAfterSec)),
		},
	});
}

/**
 * Per-IP budget on the credential routes. Returns a refusal when exhausted: a
 * 429 for API-style routes, a redirect for browser navigations. The refresh
 * route has its own, larger budget: it needs a valid unguessable refresh
 * cookie (nothing to guess) and every page load and tab calls it, so people
 * sharing one NAT address must not lock each other out of their sessions. The
 * Workers binding counts approximately and per edge location, so these are
 * abuse brakes, not exact quotas.
 */
export async function limitByIp(
	env: Env,
	request: Request,
	route: string,
	mode: "api" | "navigation" = "api",
): Promise<Response | null> {
	// Relied on, not verified: the edge is expected to set this header to the
	// connecting client's IP and to replace any value a client sends. Cloudflare's
	// documentation says the header carries the client IP on edge traffic; it does
	// not say a client-sent value is overwritten, so a forged header is an open
	// deploy-time check. A request with no header is not budgeted (fails open).
	// Most worker tests send none; the budget tests set it explicitly.
	const ip = request.headers.get("cf-connecting-ip");
	if (!ip) return null;
	const testWindowMs = resolveAuthRateLimitWindowMs(
		env.CADMUS_AUTH_RATE_LIMIT_WINDOW_MS,
		env.CADMUS_DEPLOY_ENV,
	);
	if (testWindowMs !== null) {
		const key = `${route}:${ip}`;
		const limit = route === "/api/auth/session/refresh" ? 120 : 20;
		const now = Date.now();
		if (testWindowCounters.size > 500) {
			for (const [k, v] of testWindowCounters) {
				if (v.resetAt <= now) testWindowCounters.delete(k);
			}
		}
		const current = testWindowCounters.get(key);
		if (!current || current.resetAt <= now) {
			testWindowCounters.set(key, { count: 1, resetAt: now + testWindowMs });
			return null;
		}
		if (current.count < limit) {
			current.count += 1;
			return null;
		}
		const retryAfterSec = Math.max(
			1,
			Math.ceil((current.resetAt - now) / 1000),
		);
		return mode === "navigation"
			? navigationRefused(retryAfterSec)
			: tooManyRequests(retryAfterSec, "rate_limited");
	}
	const binding =
		route === "/api/auth/session/refresh"
			? env.CADMUS_AUTH_REFRESH_RATELIMIT
			: env.CADMUS_AUTH_RATELIMIT;
	const { success } = await binding.limit({ key: `${route}:${ip}` });
	if (success) return null;
	return mode === "navigation"
		? navigationRefused(60)
		: tooManyRequests(60, "rate_limited");
}

/**
 * Per-principal budget for the signed-in credential commands (auth.ticket and
 * the passkey begin/finish pair). True when the call may go ahead.
 */
export async function withinPrincipalBudget(
	env: Env,
	command: string,
	principal: string,
): Promise<boolean> {
	const { success } = await env.CADMUS_AUTH_RPC_RATELIMIT.limit({
		key: `${command}:${principal}`,
	});
	return success;
}
