import { normalizeRole, type Role } from "@cadmus/contract/grants";
import { sha256Hex } from "../edge-cache.js";

/** Lifetimes from issue #3 decision 12. */
export const ACCESS_TTL_MS = 15 * 60 * 1000;
export const REFRESH_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;

export const ACCESS_PREFIX = "cad_at_";
export const REFRESH_PREFIX = "cad_rt_";

export interface SessionTokens {
	sessionId: string;
	accessToken: string;
	refreshToken: string;
	accessExpiresAt: number;
	refreshExpiresAt: number;
}

export interface SessionIdentity {
	sessionId: string;
	userId: string;
	accountId: string;
	role: Role;
}

export type RefreshResult =
	| { ok: true; tokens: SessionTokens }
	| {
			ok: false;
			code: "invalid_refresh" | "refresh_reused" | "session_expired";
	  };

function randomToken(prefix: string): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return `${prefix}${btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

function newSessionId(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(12));
	return `ses_${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

export interface CreateSessionInput {
	userId: string;
	accountId: string;
	loginMethodId?: string;
	tokenId?: string;
	userAgent?: string;
	ipCountry?: string;
	now?: number;
}

/** Creates a session with a fresh access and refresh token pair. */
export async function createSession(
	db: D1Database,
	input: CreateSessionInput,
): Promise<SessionTokens> {
	const now = input.now ?? Date.now();
	const sessionId = newSessionId();
	const accessToken = randomToken(ACCESS_PREFIX);
	const refreshToken = randomToken(REFRESH_PREFIX);
	const accessExpiresAt = now + ACCESS_TTL_MS;
	const refreshExpiresAt = Math.min(
		now + REFRESH_IDLE_MS,
		now + SESSION_ABSOLUTE_MS,
	);
	await db
		.prepare(
			`INSERT INTO cadmus_sessions
         (id, session_family_id, user_id, account_id, login_method_id, token_id,
          refresh_hash, previous_refresh_hash, access_hash, access_expires_at,
          user_agent, ip_country, created_at, last_used_at, idle_expires_at, absolute_expires_at)
       VALUES (?1, ?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?8, ?9, ?10, ?11, ?11, ?12, ?13)`,
		)
		.bind(
			sessionId,
			input.userId,
			input.accountId,
			input.loginMethodId ?? null,
			input.tokenId ?? null,
			await sha256Hex(refreshToken),
			await sha256Hex(accessToken),
			accessExpiresAt,
			input.userAgent ?? null,
			input.ipCountry ?? null,
			now,
			refreshExpiresAt,
			now + SESSION_ABSOLUTE_MS,
		)
		.run();
	return {
		sessionId,
		accessToken,
		refreshToken,
		accessExpiresAt,
		refreshExpiresAt,
	};
}

/** Resolves a live access token to its principal inputs, or undefined. */
export async function resolveAccessToken(
	db: D1Database,
	rawToken: string,
	now = Date.now(),
): Promise<SessionIdentity | undefined> {
	if (!rawToken.startsWith(ACCESS_PREFIX)) return undefined;
	const row = await db
		.prepare(
			`SELECT s.id, s.user_id, s.account_id, m.role, s.access_expires_at,
              s.absolute_expires_at, s.revoked_at, u.disabled_at, a.status
       FROM cadmus_sessions s
       JOIN cadmus_account_members m
         ON m.account_id = s.account_id AND m.user_id = s.user_id
       JOIN cadmus_users u ON u.id = s.user_id
       JOIN cadmus_accounts a ON a.id = s.account_id
       WHERE s.access_hash = ?1`,
		)
		.bind(await sha256Hex(rawToken))
		.first<{
			id: string;
			user_id: string;
			account_id: string;
			role: string;
			access_expires_at: number;
			absolute_expires_at: number;
			revoked_at: number | null;
			disabled_at: number | null;
			status: string;
		}>();
	if (!row) return undefined;
	if (row.revoked_at !== null || row.disabled_at !== null) return undefined;
	if (row.status !== "active") return undefined;
	if (row.access_expires_at <= now || row.absolute_expires_at <= now) {
		return undefined;
	}
	const role = normalizeRole(row.role);
	if (!role) return undefined;
	return {
		sessionId: row.id,
		userId: row.user_id,
		accountId: row.account_id,
		role,
	};
}

export async function revokeSession(
	db: D1Database,
	sessionId: string,
	now = Date.now(),
): Promise<boolean> {
	const res = await db
		.prepare(
			`UPDATE cadmus_sessions SET revoked_at = ?2
       WHERE id = ?1 AND revoked_at IS NULL`,
		)
		.bind(sessionId, now)
		.run();
	return (res.meta?.changes ?? 0) > 0;
}

/**
 * Rotates a refresh token. Presenting a token that was already rotated away
 * revokes the whole session (family) and is reported as `refresh_reused`.
 */
export async function rotateRefreshToken(
	db: D1Database,
	rawRefresh: string,
	now = Date.now(),
): Promise<RefreshResult> {
	if (!rawRefresh.startsWith(REFRESH_PREFIX)) {
		return { ok: false, code: "invalid_refresh" };
	}
	const hash = await sha256Hex(rawRefresh);
	const row = await db
		.prepare(
			`SELECT id, session_family_id, refresh_hash, previous_refresh_hash,
              idle_expires_at, absolute_expires_at, revoked_at
       FROM cadmus_sessions
       WHERE refresh_hash = ?1 OR previous_refresh_hash = ?1`,
		)
		.bind(hash)
		.first<{
			id: string;
			session_family_id: string;
			refresh_hash: string;
			previous_refresh_hash: string | null;
			idle_expires_at: number;
			absolute_expires_at: number;
			revoked_at: number | null;
		}>();
	if (!row || row.revoked_at !== null) {
		return { ok: false, code: "invalid_refresh" };
	}
	if (row.refresh_hash !== hash) {
		await db
			.prepare(
				`UPDATE cadmus_sessions SET revoked_at = ?2
         WHERE session_family_id = ?1 AND revoked_at IS NULL`,
			)
			.bind(row.session_family_id, now)
			.run();
		return { ok: false, code: "refresh_reused" };
	}
	if (row.idle_expires_at <= now || row.absolute_expires_at <= now) {
		return { ok: false, code: "session_expired" };
	}
	const accessToken = randomToken(ACCESS_PREFIX);
	const refreshToken = randomToken(REFRESH_PREFIX);
	const accessExpiresAt = now + ACCESS_TTL_MS;
	const refreshExpiresAt = Math.min(
		now + REFRESH_IDLE_MS,
		row.absolute_expires_at,
	);
	// Compare-and-set on the current refresh hash so two concurrent refreshes
	// cannot both win.
	const res = await db
		.prepare(
			`UPDATE cadmus_sessions
         SET previous_refresh_hash = refresh_hash, refresh_hash = ?2,
             access_hash = ?3, access_expires_at = ?4,
             idle_expires_at = ?5, last_used_at = ?6
       WHERE id = ?1 AND refresh_hash = ?7 AND revoked_at IS NULL`,
		)
		.bind(
			row.id,
			await sha256Hex(refreshToken),
			await sha256Hex(accessToken),
			accessExpiresAt,
			refreshExpiresAt,
			now,
			hash,
		)
		.run();
	if ((res.meta?.changes ?? 0) === 0) {
		return { ok: false, code: "invalid_refresh" };
	}
	return {
		ok: true,
		tokens: {
			sessionId: row.id,
			accessToken,
			refreshToken,
			accessExpiresAt,
			refreshExpiresAt,
		},
	};
}
