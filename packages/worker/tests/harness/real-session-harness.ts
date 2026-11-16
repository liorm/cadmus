/**
 * Test-only. The real-session specs (passkeys-real) need a session whose
 * `fresh_google_at` is set, which only the real Google callback writes, plus a
 * few reads of rows their assertions check. This module serves a fixed set of
 * typed operations for that, in the same worker process that serves the app.
 *
 * Nothing under `src/` imports this file, and `wrangler.jsonc` `main` does not
 * point at it. It is only reachable through `real-session-worker.ts`, which
 * only the explicit real-session harness runs pass to `wrangler dev`.
 *
 * Every operation has its own server-owned SQL. No operation takes SQL text, a
 * table name or a column name from the caller.
 */
import { ensureLogger } from "../../src/log.js";
import { D1AdminStore } from "../../src/store/d1-admin.js";
import type { Env } from "../../src/types.js";

export const HARNESS_PREFIX = "/api/__test-harness/";

export type HarnessEnv = Env & { CADMUS_HARNESS_TOKEN?: string };

const ID = /^[A-Za-z0-9_-]{1,120}$/;
const AUDIT_ACTIONS = [
	"auth.passkey.register",
	"auth.passkey.remove",
	"auth.elevate",
	"auth.elevation.end",
] as const;
type AuditAction = (typeof AUDIT_ACTIONS)[number];
const MAX_FRESH_AGE_MS = 24 * 60 * 60 * 1000;

class BadInput extends Error {}

const notFound = () => new Response("Not Found", { status: 404 });
const badRequest = () => new Response("Bad Request", { status: 400 });

async function digest(value: string): Promise<ArrayBuffer> {
	return crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
}

async function sameToken(given: string, expected: string): Promise<boolean> {
	const [a, b] = await Promise.all([digest(given), digest(expected)]);
	return crypto.subtle.timingSafeEqual(a, b);
}

function isLocalHost(hostname: string): boolean {
	return (
		hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
	);
}

/** Exactly the listed keys, no others. */
function fields(
	body: unknown,
	keys: readonly string[],
): Record<string, unknown> {
	if (typeof body !== "object" || body === null || Array.isArray(body)) {
		throw new BadInput();
	}
	const record = body as Record<string, unknown>;
	const names = Object.keys(record);
	if (names.length !== keys.length || !keys.every((k) => k in record)) {
		throw new BadInput();
	}
	return record;
}

function id(value: unknown): string {
	if (typeof value !== "string" || !ID.test(value)) throw new BadInput();
	return value;
}

async function count(
	db: D1Database,
	sql: string,
	...binds: unknown[]
): Promise<number> {
	const row = await db
		.prepare(sql)
		.bind(...binds)
		.first<{ n: number }>();
	return row?.n ?? 0;
}

type Op = (env: HarnessEnv, body: unknown) => Promise<unknown>;

const OPS: Record<string, Op> = {
	ping: async (_env, body) => {
		fields(body, []);
		return { harness: true };
	},

	/** An account-admin user session whose Google sign-in was `freshAgeMs` ago. */
	session: async (env, body) => {
		const input = fields(body, ["accountId", "freshAgeMs"]);
		const accountId = id(input.accountId);
		const freshAgeMs = input.freshAgeMs;
		if (
			typeof freshAgeMs !== "number" ||
			!Number.isInteger(freshAgeMs) ||
			freshAgeMs < 0 ||
			freshAgeMs > MAX_FRESH_AGE_MS
		) {
			throw new BadInput();
		}
		const db = env.CADMUS_ADMIN_DB;
		const store = new D1AdminStore({
			db,
			encryptionKey: env.CADMUS_ENCRYPTION_KEY,
		});
		await store.initialize();
		const userId = `usr_${accountId}`;
		await store.ensureAccountAndUser({
			accountId,
			userId,
			role: "account-admin",
		});
		const googleMethodId = `lm_${crypto.randomUUID()}`;
		await db
			.prepare(
				`INSERT INTO cadmus_login_methods (id, user_id, provider, subject, display, created_at, last_used_at)
           VALUES (?1, ?2, 'google', ?3, 'fixture@example.com', ?4, ?4)`,
			)
			.bind(googleMethodId, userId, `g-${googleMethodId}`, Date.now())
			.run();
		const tokens = await store.createSession({
			userId,
			accountId,
			loginMethodId: googleMethodId,
			freshGoogleAt: Date.now() - freshAgeMs,
		});
		return {
			accountId,
			userId,
			sessionId: tokens.sessionId,
			refreshToken: tokens.refreshToken,
			accessToken: tokens.accessToken,
			googleMethodId,
		};
	},

	/** A passkey login method and passkey row owned by `userId`. */
	seedPasskey: async (env, body) => {
		const input = fields(body, ["userId"]);
		const userId = id(input.userId);
		const db = env.CADMUS_ADMIN_DB;
		const methodId = `lm_${crypto.randomUUID()}`;
		const now = Date.now();
		await db.batch([
			db
				.prepare(
					`INSERT INTO cadmus_login_methods (id, user_id, provider, subject, display, created_at, last_used_at)
           VALUES (?1, ?2, 'passkey', ?3, 'Other passkey', ?4, ?4)`,
				)
				.bind(methodId, userId, `cred-${methodId}`, now),
			db
				.prepare(
					`INSERT INTO cadmus_passkeys (login_method_id, user_id, credential_id, public_key, counter, user_handle, transports, device_type, backed_up, created_at)
           VALUES (?1, ?2, ?3, 'AAAA', 0, 'handle', '[]', 'singleDevice', 0, ?4)`,
				)
				.bind(methodId, userId, `cred-${methodId}`, now),
		]);
		return { methodId };
	},

	/** Passkeys whose login method is not revoked. */
	activePasskeys: async (env, body) => {
		const userId = id(fields(body, ["userId"]).userId);
		return {
			n: await count(
				env.CADMUS_ADMIN_DB,
				`SELECT count(*) AS n FROM cadmus_passkeys p JOIN cadmus_login_methods m ON m.id = p.login_method_id WHERE p.user_id = ?1 AND m.revoked_at IS NULL`,
				userId,
			),
		};
	},

	/** Rows in cadmus_passkeys, revoked or not. */
	passkeyRows: async (env, body) => {
		const userId = id(fields(body, ["userId"]).userId);
		return {
			n: await count(
				env.CADMUS_ADMIN_DB,
				`SELECT count(*) AS n FROM cadmus_passkeys WHERE user_id = ?1`,
				userId,
			),
		};
	},

	/** Passkey-provider login methods that are not revoked. */
	activePasskeyMethods: async (env, body) => {
		const userId = id(fields(body, ["userId"]).userId);
		return {
			n: await count(
				env.CADMUS_ADMIN_DB,
				`SELECT count(*) AS n FROM cadmus_login_methods WHERE user_id = ?1 AND provider = 'passkey' AND revoked_at IS NULL`,
				userId,
			),
		};
	},

	activePasskeyMethodId: async (env, body) => {
		const userId = id(fields(body, ["userId"]).userId);
		const row = await env.CADMUS_ADMIN_DB.prepare(
			`SELECT m.id AS id FROM cadmus_login_methods m WHERE m.user_id = ?1 AND m.provider = 'passkey' AND m.revoked_at IS NULL`,
		)
			.bind(userId)
			.first<{ id: string }>();
		return { id: row?.id ?? null };
	},

	auditCount: async (env, body) => {
		const input = fields(body, ["userId", "action"]);
		const userId = id(input.userId);
		const action = input.action;
		if (!AUDIT_ACTIONS.includes(action as AuditAction)) throw new BadInput();
		return {
			n: await count(
				env.CADMUS_ADMIN_DB,
				`SELECT count(*) AS n FROM cadmus_audit WHERE actor_user_id = ?1 AND action = ?2`,
				userId,
				action,
			),
		};
	},

	elevatedUntil: async (env, body) => {
		const sessionId = id(fields(body, ["sessionId"]).sessionId);
		const row = await env.CADMUS_ADMIN_DB.prepare(
			`SELECT elevated_until AS e FROM cadmus_sessions WHERE id = ?1`,
		)
			.bind(sessionId)
			.first<{ e: number | null }>();
		return { e: row?.e ?? null };
	},

	registerChallenge: async (env, body) => {
		const userId = id(fields(body, ["userId"]).userId);
		const row = await env.CADMUS_ADMIN_DB.prepare(
			`SELECT rp_id, origin, consumed_at FROM cadmus_passkey_challenges WHERE user_id = ?1 AND purpose = 'register'`,
		)
			.bind(userId)
			.first<{ rp_id: string; origin: string; consumed_at: number | null }>();
		return { row: row ?? null };
	},
};

/**
 * Serves a harness request, or returns undefined when the request is not one
 * (or when no harness token is configured, so the app answers exactly as it
 * does without this module).
 */
export async function handleHarness(
	request: Request,
	env: HarnessEnv,
): Promise<Response | undefined> {
	const url = new URL(request.url);
	if (!url.pathname.startsWith(HARNESS_PREFIX)) return undefined;
	const expected = env.CADMUS_HARNESS_TOKEN;
	if (!expected) return undefined;
	const given = request.headers.get("x-harness-token");
	if (
		request.method !== "POST" ||
		!isLocalHost(url.hostname) ||
		given === null ||
		!(await sameToken(given, expected))
	) {
		return notFound();
	}
	const name = url.pathname.slice(HARNESS_PREFIX.length);
	const op = Object.hasOwn(OPS, name) ? OPS[name] : undefined;
	if (!op) return notFound();
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return badRequest();
	}
	try {
		return Response.json(await op(env, body), {
			headers: { "cache-control": "no-store" },
		});
	} catch (error) {
		if (error instanceof BadInput) return badRequest();
		// An unexpected failure (a D1 error, say) must stay visible: an empty 500
		// for the client, and the error name and message in the server log. Never
		// the token, the headers or the request body.
		const e = error instanceof Error ? error : new Error(String(error));
		ensureLogger().error("real-session harness op failed", {
			op: name,
			error: e.name,
			message: e.message,
		});
		return new Response(null, { status: 500 });
	}
}
