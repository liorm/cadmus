import {
	type Grant,
	isGrant,
	normalizeRole,
	ROLE_GRANTS,
	type Role,
} from "@cadmus/contract/grants";
import { sha256Hex } from "../edge-cache.js";
import {
	API_TOKEN_CREDENTIAL_PREFIX,
	apiTokenHashFromCredential,
} from "./api-token-credential.js";
import { randomId, randomToken } from "./random-id.js";

/**
 * Token-backed sessions (token login) store their access and refresh hashes
 * under a domain-separated digest. The Worker from before token login looks
 * sessions up as `sha256(raw)` and ignores the token grant clamp, so a plain
 * digest would let a rolled-back Worker run, or refresh, a token session with
 * the member's full role. User sessions keep the plain digest. Lookups try both.
 */
export const TOKEN_SESSION_HASH_DOMAIN = "cadmus-token-session-v1:";
function tokenSessionHash(raw: string): Promise<string> {
	return sha256Hex(`${TOKEN_SESSION_HASH_DOMAIN}${raw}`);
}
function sessionHash(raw: string, tokenBacked: boolean): Promise<string> {
	return tokenBacked ? tokenSessionHash(raw) : sha256Hex(raw);
}

/** Lifetimes from issue #3 decision 12. */
export const ACCESS_TTL_MS = 15 * 60 * 1000;
export const REFRESH_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;
/** Admin mode (elevation) lifetime, issue #3 decisions 11 and 12. */
export const ELEVATION_MS = 15 * 60 * 1000;

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
	/** Set for token-backed sessions: the token's grants clamped to the role. */
	grants?: Grant[];
	/** Epoch ms when admin mode on this session ends. Only set while it is on. */
	elevatedUntil?: number;
}

/** Token grants clamped to what the role still holds (demotion clamps). */
export function clampTokenGrants(stored: string | null, role: Role): Grant[] {
	let parsed: unknown;
	try {
		parsed = stored ? JSON.parse(stored) : [];
	} catch {
		parsed = [];
	}
	const held = ROLE_GRANTS[role];
	return (Array.isArray(parsed) ? parsed : []).filter(
		(g): g is Grant => isGrant(g) && held.includes(g),
	);
}

interface TokenJoin {
	token_id: string | null;
	token_grants: string | null;
	token_revoked_at: number | null;
	token_expires_at: number | null;
}

function tokenAllows(row: TokenJoin, now: number): boolean {
	if (!row.token_id) return true;
	if (row.token_revoked_at !== null) return false;
	return row.token_expires_at === null || row.token_expires_at > now;
}

export type RefreshResult =
	| {
			ok: true;
			tokens: SessionTokens;
			accountId: string;
			userId: string;
			viaToken: boolean;
	  }
	| {
			ok: false;
			code: "invalid_refresh" | "refresh_reused" | "session_expired";
	  };

const AUDIT_COLUMNS = `INSERT INTO cadmus_audit (id, account_id, actor_user_id, actor_kind, action, target_account_id, target, data, at)`;

/**
 * Audit rows for sessions revoked at `now` that match `cond` (parameters from
 * ?3). Written in the same batch as the revoking UPDATE, one per session.
 */
function auditRevoked(
	db: D1Database,
	action: string,
	now: number,
	cond: string,
	...binds: unknown[]
) {
	return db
		.prepare(
			`${AUDIT_COLUMNS}
       SELECT 'aud_' || lower(hex(randomblob(12))), account_id, user_id, 'user', ?1, account_id, id,
              json_object('tokenId', token_id, 'loginMethodId', login_method_id), ?2
       FROM cadmus_sessions WHERE revoked_at = ?2 AND ${cond}`,
		)
		.bind(action, now, ...binds);
}

export interface CreateSessionInput {
	userId: string;
	accountId: string;
	loginMethodId?: string;
	/** Verified Google auth_time in epoch ms; only a fresh sign-in flow sets it. */
	freshGoogleAt?: number;
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
	const sessionId = randomId("ses_", 12);
	const accessToken = randomToken(ACCESS_PREFIX);
	const refreshToken = randomToken(REFRESH_PREFIX);
	// A token-backed session never outlives its token.
	let cap = Number.POSITIVE_INFINITY;
	if (input.tokenId) {
		const token = await db
			.prepare(`SELECT expires_at FROM cadmus_auth_tokens WHERE id = ?1`)
			.bind(input.tokenId)
			.first<{ expires_at: number | null }>();
		if (token?.expires_at != null) cap = token.expires_at;
	}
	const accessExpiresAt = Math.min(now + ACCESS_TTL_MS, cap);
	const refreshExpiresAt = Math.min(
		now + REFRESH_IDLE_MS,
		now + SESSION_ABSOLUTE_MS,
		cap,
	);
	const absoluteExpiresAt = Math.min(now + SESSION_ABSOLUTE_MS, cap);
	await db.batch([
		db
			.prepare(
				`INSERT INTO cadmus_sessions
         (id, session_family_id, user_id, account_id, login_method_id, token_id,
          refresh_hash, previous_refresh_hash, access_hash, access_expires_at,
          user_agent, ip_country, created_at, last_used_at, idle_expires_at, absolute_expires_at,
          fresh_google_at)
       VALUES (?1, ?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?8, ?9, ?10, ?11, ?11, ?12, ?13, ?14)`,
			)
			.bind(
				sessionId,
				input.userId,
				input.accountId,
				input.loginMethodId ?? null,
				input.tokenId ?? null,
				await sessionHash(refreshToken, Boolean(input.tokenId)),
				await sessionHash(accessToken, Boolean(input.tokenId)),
				accessExpiresAt,
				input.userAgent ?? null,
				input.ipCountry ?? null,
				now,
				refreshExpiresAt,
				absoluteExpiresAt,
				input.freshGoogleAt ?? null,
			),
		db
			.prepare(
				`${AUDIT_COLUMNS} VALUES (?1, ?2, ?3, 'user', 'session.create', ?2, ?4, ?5, ?6)`,
			)
			.bind(
				`aud_${sessionId.slice(4)}`,
				input.accountId,
				input.userId,
				sessionId,
				JSON.stringify({
					tokenId: input.tokenId ?? null,
					loginMethodId: input.loginMethodId ?? null,
				}),
				now,
			),
	]);
	return {
		sessionId,
		accessToken,
		refreshToken,
		accessExpiresAt,
		refreshExpiresAt,
	};
}

type SessionRow = TokenJoin & {
	id: string;
	user_id: string;
	account_id: string;
	/** The account the session was signed in to. */
	home_account_id: string;
	role: string;
	access_expires_at: number;
	absolute_expires_at: number;
	idle_expires_at: number;
	revoked_at: number | null;
	disabled_at: number | null;
	status: string;
	elevated_until: number | null;
	elevated_account_id: string | null;
};

function sessionSelect(selected: boolean): string {
	// With a selected account (?2) the membership, account and role come from
	// that account; without one, from the session's own account.
	const acct = selected ? "?2" : "s.account_id";
	return `SELECT s.token_id AS token_id, t.grants AS token_grants,
              t.revoked_at AS token_revoked_at, t.expires_at AS token_expires_at, s.id, s.user_id, a.id AS account_id, s.account_id AS home_account_id, m.role, s.access_expires_at,
              s.absolute_expires_at, s.idle_expires_at, s.revoked_at, s.elevated_until, s.elevated_account_id, u.disabled_at, a.status
       FROM cadmus_sessions s
       JOIN cadmus_account_members m
         ON m.account_id = ${acct} AND m.user_id = s.user_id
       JOIN cadmus_users u ON u.id = s.user_id
       JOIN cadmus_accounts a ON a.id = ${acct}
       LEFT JOIN cadmus_auth_tokens t ON t.id = s.token_id`;
}
const SESSION_SELECT = sessionSelect(false);

function identityFromRow(
	row: SessionRow | null,
	now: number,
	checkAccessExpiry: boolean,
): SessionIdentity | undefined {
	if (!row) return undefined;
	if (row.revoked_at !== null || row.disabled_at !== null) return undefined;
	if (row.status !== "active") return undefined;
	if (row.absolute_expires_at <= now || row.idle_expires_at <= now) {
		return undefined;
	}
	if (checkAccessExpiry && row.access_expires_at <= now) return undefined;
	if (!tokenAllows(row, now)) return undefined;
	// A token session is bound to the account it was opened in.
	if (row.token_id && row.account_id !== row.home_account_id) return undefined;
	const role = normalizeRole(row.role);
	if (!role) return undefined;
	return {
		sessionId: row.id,
		userId: row.user_id,
		accountId: row.account_id,
		role,
		...(row.token_id
			? { grants: clampTokenGrants(row.token_grants, role) }
			: row.elevated_until !== null &&
					row.elevated_until > now &&
					row.account_id === (row.elevated_account_id ?? row.home_account_id)
				? { elevatedUntil: row.elevated_until }
				: {}),
	};
}

/** Resolves a live access token to its principal inputs, or undefined. */
export async function resolveAccessToken(
	db: D1Database,
	rawToken: string,
	selectedAccountId?: string,
	now = Date.now(),
): Promise<SessionIdentity | undefined> {
	if (!rawToken.startsWith(ACCESS_PREFIX)) return undefined;
	const hash = await sha256Hex(rawToken);
	const tokenHash = await tokenSessionHash(rawToken);
	const row = await (selectedAccountId
		? db
				.prepare(`${sessionSelect(true)} WHERE s.access_hash IN (?1, ?3)`)
				.bind(hash, selectedAccountId, tokenHash)
		: db
				.prepare(`${SESSION_SELECT} WHERE s.access_hash IN (?1, ?2)`)
				.bind(hash, tokenHash)
	).first<SessionRow>();
	const identity = identityFromRow(row, now, true);
	// An explicit, verified selection counts as use of that account for the
	// next sign-in default. Refused requests returned above and write nothing;
	// token sessions never select. Throttled so a busy client is not a D1 write
	// per request.
	if (identity && selectedAccountId && !row?.token_id) {
		await db
			.prepare(
				`UPDATE cadmus_account_members SET last_used_at = ?3
         WHERE account_id = ?1 AND user_id = ?2
           AND (last_used_at IS NULL OR last_used_at < ?3 - ?4)`,
			)
			.bind(identity.accountId, identity.userId, now, MEMBER_USE_THROTTLE_MS)
			.run();
	}
	return identity;
}

/** Minimum gap between recorded account selections (see resolveAccessToken). */
export const MEMBER_USE_THROTTLE_MS = 5 * 60_000;

/**
 * Re-reads a session's effective authority (revocation, user, account, role,
 * token state). Open sockets and streams use it so revoking a session or token,
 * removing or demoting a member and expiry take effect without a reconnect.
 */
export async function resolveSessionById(
	db: D1Database,
	sessionId: string,
	accountId?: string,
	now = Date.now(),
): Promise<SessionIdentity | undefined> {
	// With an account (the one a socket or stream was opened for), the
	// membership, status, role and elevation are those of that account.
	const row = await (accountId
		? db
				.prepare(`${sessionSelect(true)} WHERE s.id = ?1`)
				.bind(sessionId, accountId)
		: db.prepare(`${SESSION_SELECT} WHERE s.id = ?1`).bind(sessionId)
	).first<SessionRow>();
	return identityFromRow(row, now, false);
}

/**
 * Why a session that no longer resolves is refused, when the reason is the
 * account or the user rather than the session itself. Lets the edge close a
 * socket with "forbidden" instead of "session ended".
 */
export async function sessionRefusalReason(
	db: D1Database,
	sessionId: string,
	accountId?: string,
): Promise<"account_suspended" | "user_disabled" | undefined> {
	const row = await db
		.prepare(
			`SELECT a.status AS status, u.disabled_at AS disabled_at
       FROM cadmus_sessions s
       JOIN cadmus_users u ON u.id = s.user_id
       JOIN cadmus_accounts a ON a.id = COALESCE(?2, s.account_id)
       WHERE s.id = ?1`,
		)
		.bind(sessionId, accountId ?? null)
		.first<{ status: string; disabled_at: number | null }>();
	if (!row) return undefined;
	if (row.status !== "active") return "account_suspended";
	if (row.disabled_at !== null) return "user_disabled";
	return undefined;
}

/** 4403 when the user is disabled or the account is not active, else 4401 (sessionless credential that no longer resolves). */
export async function legacyEndCode(
	db: D1Database,
	userId: string,
	accountId: string,
): Promise<4401 | 4403> {
	const row = await db
		.prepare(
			`SELECT a.status AS status, u.disabled_at AS disabled_at
       FROM cadmus_users u, cadmus_accounts a
       WHERE u.id = ?1 AND a.id = ?2`,
		)
		.bind(userId, accountId)
		.first<{ status: string; disabled_at: number | null }>();
	if (!row) return 4401;
	return row.status !== "active" || row.disabled_at !== null ? 4403 : 4401;
}

export async function revokeSession(
	db: D1Database,
	sessionId: string,
	now = Date.now(),
): Promise<boolean> {
	const [res] = await db.batch([
		db
			.prepare(
				`UPDATE cadmus_sessions SET revoked_at = ?2
       WHERE id = ?1 AND revoked_at IS NULL`,
			)
			.bind(sessionId, now),
		auditRevoked(db, "session.revoke", now, "id = ?3", sessionId),
	]);
	return (res?.meta?.changes ?? 0) > 0;
}

/** Logout path: revoke the session that owns this refresh token. No rotation. */
export async function revokeSessionByRefresh(
	db: D1Database,
	rawRefresh: string,
	now = Date.now(),
): Promise<boolean> {
	if (!rawRefresh.startsWith(REFRESH_PREFIX)) return false;
	const hash = await sha256Hex(rawRefresh);
	const tokenHash = await tokenSessionHash(rawRefresh);
	const row = await db
		.prepare(
			`SELECT id, session_family_id, refresh_hash
       FROM cadmus_sessions
       WHERE refresh_hash IN (?1, ?2) OR previous_refresh_hash IN (?1, ?2)`,
		)
		.bind(hash, tokenHash)
		.first<{
			id: string;
			session_family_id: string;
			refresh_hash: string;
		}>();
	if (!row) return false;
	if (row.refresh_hash !== hash && row.refresh_hash !== tokenHash) {
		const [res] = await db.batch([
			db
				.prepare(
					`UPDATE cadmus_sessions SET revoked_at = ?2
         WHERE session_family_id = ?1 AND revoked_at IS NULL`,
				)
				.bind(row.session_family_id, now),
			auditRevoked(
				db,
				"session.refresh_reuse",
				now,
				"session_family_id = ?3",
				row.session_family_id,
			),
		]);
		return (res?.meta?.changes ?? 0) > 0;
	}
	return revokeSession(db, row.id, now);
}

/**
 * Turns admin mode on for a user session (never a token session) and audits
 * it in the same batch. Returns the end time, or undefined when the session is
 * not a live user session. The toggle works only in the session's own account.
 */
export async function startElevation(
	db: D1Database,
	sessionId: string,
	now = Date.now(),
	accountId?: string,
): Promise<number | undefined> {
	const until = now + ELEVATION_MS;
	const [res] = await db.batch([
		db
			.prepare(
				`UPDATE cadmus_sessions SET elevated_until = ?2, elevated_account_id = ?4
       WHERE id = ?1 AND revoked_at IS NULL AND token_id IS NULL
         AND (?4 IS NULL OR ?4 = account_id)`,
			)
			.bind(sessionId, until, now, accountId ?? null),
		db
			.prepare(
				`${AUDIT_COLUMNS}
       SELECT 'aud_' || lower(hex(randomblob(12))), COALESCE(?4, account_id), user_id, 'user', 'auth.elevate', COALESCE(?4, account_id), id,
              json_object('until', ?2), ?3
       FROM cadmus_sessions WHERE id = ?1 AND elevated_until = ?2 AND revoked_at IS NULL`,
			)
			.bind(sessionId, until, now, accountId ?? null),
	]);
	return (res?.meta?.changes ?? 0) > 0 ? until : undefined;
}

/** Turns admin mode off. True when it was on, and audits that in one batch. */
export async function endElevation(
	db: D1Database,
	sessionId: string,
	now = Date.now(),
): Promise<boolean> {
	const [audit] = await db.batch([
		db
			.prepare(
				`${AUDIT_COLUMNS}
       SELECT 'aud_' || lower(hex(randomblob(12))), account_id, user_id, 'user', 'auth.elevation.end', account_id, id,
              '{}', ?2
       FROM cadmus_sessions WHERE id = ?1 AND elevated_until > ?2`,
			)
			.bind(sessionId, now),
		db
			.prepare(
				`UPDATE cadmus_sessions SET elevated_until = NULL, elevated_account_id = NULL
       WHERE id = ?1 AND elevated_until IS NOT NULL`,
			)
			.bind(sessionId),
	]);
	return (audit?.meta?.changes ?? 0) > 0;
}

export type ElevatedCommandPhase = "attempt" | "ok" | "failed";

/** Links the attempt and outcome rows of one elevated command. */
export interface ElevatedOperation {
	/** Unique per command execution; both rows carry it. */
	id: string;
	/** The bot family the command ran against, when it has one. */
	familyId?: string;
}

/**
 * Audits a command that was authorized in admin mode. The elevation check
 * already happened when the command was allowed, so these rows do not depend
 * on the mode still being on later: an action that finished after the mode
 * expired or ended is still on record.
 *
 * - "attempt" (action \`elevated.command\`) is written before the command runs
 *   and means only that it was allowed to start. It is also the pending
 *   record: an operation id with an attempt row and no result row is a
 *   command whose outcome is unknown and needs reconciling.
 * - "ok" and "failed" (action \`elevated.command.result\`) record the outcome
 *   as \`completed\` or \`threw\`. \`threw\` says the handler raised; it does not
 *   claim that nothing changed.
 *
 * Both rows carry the same \`op\` id, the command type and the family, with
 * the acting user and session on the row itself.
 */
export async function auditElevatedCommand(
	db: D1Database,
	sessionId: string,
	commandType: string,
	phase: ElevatedCommandPhase,
	operation: ElevatedOperation,
	now = Date.now(),
): Promise<void> {
	const action =
		phase === "attempt" ? "elevated.command" : "elevated.command.result";
	const outcome =
		phase === "attempt" ? "started" : phase === "ok" ? "completed" : "threw";
	await db
		.prepare(
			`${AUDIT_COLUMNS}
       SELECT 'aud_' || lower(hex(randomblob(12))), account_id, user_id, 'user', ?5, account_id, id,
              json_object('command', ?2, 'op', ?3, 'family', ?4, 'outcome', ?6), ?7
       FROM cadmus_sessions WHERE id = ?1`,
		)
		.bind(
			sessionId,
			commandType,
			operation.id,
			operation.familyId ?? null,
			action,
			outcome,
			now,
		)
		.run();
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
	const tokenHash = await tokenSessionHash(rawRefresh);
	const row = await db
		.prepare(
			`SELECT id, session_family_id, refresh_hash, previous_refresh_hash,
              idle_expires_at, absolute_expires_at, revoked_at
       FROM cadmus_sessions
       WHERE refresh_hash IN (?1, ?2) OR previous_refresh_hash IN (?1, ?2)`,
		)
		.bind(hash, tokenHash)
		.first<
			TokenJoin & {
				id: string;
				session_family_id: string;
				refresh_hash: string;
				previous_refresh_hash: string | null;
				idle_expires_at: number;
				absolute_expires_at: number;
				revoked_at: number | null;
			}
		>();
	if (!row || row.revoked_at !== null) {
		return { ok: false, code: "invalid_refresh" };
	}
	if (row.refresh_hash !== hash && row.refresh_hash !== tokenHash) {
		await db.batch([
			db
				.prepare(
					`UPDATE cadmus_sessions SET revoked_at = ?2
         WHERE session_family_id = ?1 AND revoked_at IS NULL`,
				)
				.bind(row.session_family_id, now),
			auditRevoked(
				db,
				"session.refresh_reuse",
				now,
				"session_family_id = ?3",
				row.session_family_id,
			),
		]);
		return { ok: false, code: "refresh_reused" };
	}
	if (row.idle_expires_at <= now || row.absolute_expires_at <= now) {
		return { ok: false, code: "session_expired" };
	}
	// Refresh only while the session's effective authority still holds: the
	// user, account, membership and any source token must all be live.
	const state = await db
		.prepare(`${SESSION_SELECT} WHERE s.id = ?1`)
		.bind(row.id)
		.first<SessionRow>();
	const identity = identityFromRow(state, now, false);
	if (!identity) {
		return { ok: false, code: "invalid_refresh" };
	}
	const cap = state?.token_expires_at ?? Number.POSITIVE_INFINITY;
	const accessToken = randomToken(ACCESS_PREFIX);
	const refreshToken = randomToken(REFRESH_PREFIX);
	const accessExpiresAt = Math.min(now + ACCESS_TTL_MS, cap);
	const refreshExpiresAt = Math.min(
		now + REFRESH_IDLE_MS,
		row.absolute_expires_at,
		cap,
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
			await sessionHash(refreshToken, Boolean(state?.token_id)),
			await sessionHash(accessToken, Boolean(state?.token_id)),
			accessExpiresAt,
			refreshExpiresAt,
			now,
			row.refresh_hash,
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
		accountId: identity.accountId,
		userId: identity.userId,
		viaToken: Boolean(state?.token_id),
	};
}

// ─── Session and login method management ────────────────────────────────────

export interface SessionSummary {
	id: string;
	accountId: string;
	loginMethod?: string;
	tokenId?: string;
	userAgent?: string;
	ipCountry?: string;
	createdAt: number;
	lastUsedAt: number;
}

export async function listSessions(
	db: D1Database,
	userId: string,
	now = Date.now(),
): Promise<SessionSummary[]> {
	const { results } = await db
		.prepare(
			`SELECT s.id, s.account_id, s.token_id, s.user_agent, s.ip_country,
              s.created_at, s.last_used_at, l.provider
       FROM cadmus_sessions s
       LEFT JOIN cadmus_login_methods l ON l.id = s.login_method_id
       WHERE s.user_id = ?1 AND s.revoked_at IS NULL
         AND s.absolute_expires_at > ?2 AND s.idle_expires_at > ?2
       ORDER BY s.last_used_at DESC`,
		)
		.bind(userId, now)
		.all<{
			id: string;
			account_id: string;
			token_id: string | null;
			user_agent: string | null;
			ip_country: string | null;
			created_at: number;
			last_used_at: number;
			provider: string | null;
		}>();
	return results.map((r) => ({
		id: r.id,
		accountId: r.account_id,
		...(r.provider ? { loginMethod: r.provider } : {}),
		...(r.token_id ? { tokenId: r.token_id } : {}),
		...(r.user_agent ? { userAgent: r.user_agent } : {}),
		...(r.ip_country ? { ipCountry: r.ip_country } : {}),
		createdAt: r.created_at,
		lastUsedAt: r.last_used_at,
	}));
}

/** Revokes a session only when it belongs to `userId`. */
export async function revokeOwnSession(
	db: D1Database,
	userId: string,
	sessionId: string,
	now = Date.now(),
): Promise<boolean> {
	const [res] = await db.batch([
		db
			.prepare(
				`UPDATE cadmus_sessions SET revoked_at = ?3
       WHERE id = ?1 AND user_id = ?2 AND revoked_at IS NULL`,
			)
			.bind(sessionId, userId, now),
		auditRevoked(
			db,
			"session.revoke",
			now,
			"id = ?3 AND user_id = ?4",
			sessionId,
			userId,
		),
	]);
	return (res?.meta?.changes ?? 0) > 0;
}

export async function revokeOtherSessions(
	db: D1Database,
	userId: string,
	currentSessionId: string,
	now = Date.now(),
): Promise<number> {
	const [res] = await db.batch([
		db
			.prepare(
				`UPDATE cadmus_sessions SET revoked_at = ?3
       WHERE user_id = ?1 AND id != ?2 AND revoked_at IS NULL`,
			)
			.bind(userId, currentSessionId, now),
		auditRevoked(
			db,
			"session.revoke",
			now,
			"user_id = ?3 AND id != ?4",
			userId,
			currentSessionId,
		),
	]);
	return res?.meta?.changes ?? 0;
}

export interface LoginMethodSummary {
	id: string;
	provider: string;
	display?: string;
	createdAt: number;
	lastUsedAt?: number;
}

export async function listLoginMethods(
	db: D1Database,
	userId: string,
): Promise<LoginMethodSummary[]> {
	const { results } = await db
		.prepare(
			`SELECT id, provider, display, created_at, last_used_at
       FROM cadmus_login_methods
       WHERE user_id = ?1 AND revoked_at IS NULL
       ORDER BY created_at ASC`,
		)
		.bind(userId)
		.all<{
			id: string;
			provider: string;
			display: string | null;
			created_at: number;
			last_used_at: number | null;
		}>();
	return results.map((r) => ({
		id: r.id,
		provider: r.provider,
		...(r.display ? { display: r.display } : {}),
		createdAt: r.created_at,
		...(r.last_used_at ? { lastUsedAt: r.last_used_at } : {}),
	}));
}

export interface MembershipSummary {
	accountId: string;
	name: string;
	role: string;
}

/**
 * The user's own memberships in active accounts, oldest first. A suspended
 * account is left out: every request in it is refused anyway.
 */
export async function listMemberships(
	db: D1Database,
	userId: string,
): Promise<MembershipSummary[]> {
	const { results } = await db
		.prepare(
			`SELECT m.account_id, a.name, m.role
       FROM cadmus_account_members m
       JOIN cadmus_accounts a ON a.id = m.account_id
       WHERE m.user_id = ?1 AND a.status = 'active'
       ORDER BY m.created_at ASC, m.account_id ASC`,
		)
		.bind(userId)
		.all<{ account_id: string; name: string; role: string }>();
	return results.map((r) => ({
		accountId: r.account_id,
		name: r.name,
		role: r.role,
	}));
}

export type RevokeMethodResult =
	| { ok: true; revoked: boolean; sessionsRevoked: number }
	| { ok: false; code: "last_login_method" };

/**
 * Revokes one of the user's login methods and the sessions created through it.
 * The last active method cannot be revoked.
 */
export async function revokeLoginMethod(
	db: D1Database,
	userId: string,
	methodId: string,
	now = Date.now(),
): Promise<RevokeMethodResult> {
	const exists = await db
		.prepare(
			`SELECT 1 AS x FROM cadmus_login_methods
       WHERE id = ?1 AND user_id = ?2 AND revoked_at IS NULL`,
		)
		.bind(methodId, userId)
		.first<{ x: number }>();
	if (!exists) return { ok: true, revoked: false, sessionsRevoked: 0 };
	const results = await db.batch([
		db
			.prepare(
				`UPDATE cadmus_login_methods SET revoked_at = ?3
         WHERE id = ?1 AND user_id = ?2 AND revoked_at IS NULL
           AND (SELECT COUNT(*) FROM cadmus_login_methods
                 WHERE user_id = ?2 AND revoked_at IS NULL) > 1`,
			)
			.bind(methodId, userId, now),
		db
			.prepare(
				`UPDATE cadmus_sessions SET revoked_at = ?2
         WHERE login_method_id = ?1 AND revoked_at IS NULL
           AND EXISTS (SELECT 1 FROM cadmus_login_methods
                        WHERE id = ?1 AND revoked_at = ?2)`,
			)
			.bind(methodId, now),
		auditRevoked(db, "session.revoke", now, "login_method_id = ?3", methodId),
		db
			.prepare(
				`${AUDIT_COLUMNS}
         SELECT 'aud_' || lower(hex(randomblob(12))), a.account_id, ?2, 'user', 'method.delete', a.account_id, ?1, '{}', ?3
         FROM (SELECT account_id FROM cadmus_account_members WHERE user_id = ?2 LIMIT 1) a
         WHERE EXISTS (SELECT 1 FROM cadmus_login_methods WHERE id = ?1 AND revoked_at = ?3)`,
			)
			.bind(methodId, userId, now),
	]);
	if ((results[0]?.meta?.changes ?? 0) === 0) {
		return { ok: false, code: "last_login_method" };
	}
	return {
		ok: true,
		revoked: true,
		sessionsRevoked: results[1]?.meta?.changes ?? 0,
	};
}

// ─── WS / events tickets ────────────────────────────────────────────────────

export const TICKET_TTL_MS = 60 * 1000;
export type TicketTarget = "ws" | "events";

export async function createTicket(
	db: D1Database,
	sessionId: string,
	target: TicketTarget,
	accountId?: string,
	now = Date.now(),
): Promise<{ ticket: string; expiresAt: number }> {
	const ticket = randomToken("cad_tk_");
	const expiresAt = now + TICKET_TTL_MS;
	await db
		.prepare(
			`INSERT INTO cadmus_tickets (ticket_hash, session_id, target, expires_at, account_id)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
		)
		.bind(
			await sha256Hex(ticket),
			sessionId,
			target,
			expiresAt,
			accountId ?? null,
		)
		.run();
	return { ticket, expiresAt };
}

/** `session_id` of a ticket minted by a credential that has no session. */
export const LEGACY_TICKET_SESSION = "legacy";

/** Identity a consumed ticket yields. Legacy tickets carry no session. */
export type TicketIdentity = Omit<SessionIdentity, "sessionId"> & {
	sessionId?: string;
	/** Legacy tickets only: the credential the edge named at mint. */
	credential?: string;
};

/**
 * A ticket for a credential with no session: the master secret or a legacy
 * member token. It is minted over the header-authenticated RPC, so the
 * credential never goes in a URL. Consuming it re-reads the live membership.
 */
export async function createLegacyTicket(
	db: D1Database,
	userId: string,
	accountId: string,
	target: TicketTarget,
	credential: string | undefined,
	now = Date.now(),
): Promise<{ ticket: string; expiresAt: number }> {
	const ticket = randomToken("cad_tk_");
	const expiresAt = now + TICKET_TTL_MS;
	await db
		.prepare(
			`INSERT INTO cadmus_tickets (ticket_hash, session_id, target, expires_at, account_id, user_id, credential)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
		)
		.bind(
			await sha256Hex(ticket),
			LEGACY_TICKET_SESSION,
			target,
			expiresAt,
			accountId,
			userId,
			credential ?? null,
		)
		.run();
	return { ticket, expiresAt };
}

/**
 * Live authority of a credential that has no session: the master secret, a
 * legacy member token, or an API token (`cad_pat_` / `cad_svc_`) presented as
 * a bearer. A legacy member token must still have a live `cadmus_auth_tokens`
 * row (not revoked, not expired) for this user and account, and its grants
 * are the `user` set (issue #3 data model: legacy rows are `pat` rows with the
 * `user` grant set). An API token's grants are the stored set clamped to the
 * member's live role. The grants are an intersection with that role
 * (callerGrants), so a demotion never widens them. The master secret has no
 * row, so it keeps the member's role (master callers map to account-admin
 * until phase 9). Either way the membership, user and account state are
 * re-read.
 */
export async function resolveLegacyCredential(
	db: D1Database,
	credential: string | null | undefined,
	userId: string,
	accountId: string,
	now = Date.now(),
): Promise<{ role: Role; grants?: Grant[] } | undefined> {
	const apiHash = apiTokenHashFromCredential(credential);
	if (apiHash) {
		const row = await db
			.prepare(
				`SELECT t.grants, m.role
         FROM cadmus_auth_tokens t
         JOIN cadmus_account_members m
           ON m.account_id = t.account_id AND m.user_id = t.user_id
         JOIN cadmus_users u ON u.id = t.user_id AND u.disabled_at IS NULL
         JOIN cadmus_accounts a ON a.id = t.account_id AND a.status = 'active'
         WHERE t.token_hash = ?1 AND t.user_id = ?2 AND t.account_id = ?3
           AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at > ?4)`,
			)
			.bind(apiHash, userId, accountId, now)
			.first<{ grants: string | null; role: string }>();
		if (!row) return undefined;
		const role = normalizeRole(row.role);
		if (!role) return undefined;
		return { role, grants: clampTokenGrants(row.grants, role) };
	}
	if (credential?.startsWith(API_TOKEN_CREDENTIAL_PREFIX)) return undefined;
	let clampToUser = false;
	if (credential?.startsWith("member-token:")) {
		const live = await db
			.prepare(
				`SELECT 1 AS ok FROM cadmus_auth_tokens
         WHERE token_hash = ?1 AND user_id = ?2 AND account_id = ?3
           AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?4)`,
			)
			.bind(credential.slice("member-token:".length), userId, accountId, now)
			.first();
		if (!live) return undefined;
		clampToUser = true;
	} else if (credential !== "master") {
		return undefined;
	}
	const member = await db
		.prepare(
			`SELECT m.role, u.disabled_at, a.status
         FROM cadmus_account_members m
         JOIN cadmus_users u ON u.id = m.user_id
         JOIN cadmus_accounts a ON a.id = m.account_id
         WHERE m.account_id = ?1 AND m.user_id = ?2`,
		)
		.bind(accountId, userId)
		.first<{ role: string; disabled_at: number | null; status: string }>();
	if (!member || member.disabled_at !== null || member.status !== "active") {
		return undefined;
	}
	const role = normalizeRole(member.role);
	if (!role) return undefined;
	// Master callers map to account-admin (issue phase 2), on /rpc and on a
	// socket alike, whatever the membership row says; the row only has to exist.
	return clampToUser
		? { role, grants: [...ROLE_GRANTS.user] }
		: { role: "account-admin" };
}

/** Consumes a ticket exactly once; returns the identity it was minted for. */
export async function consumeTicket(
	db: D1Database,
	ticket: string,
	target: TicketTarget,
	now = Date.now(),
): Promise<TicketIdentity | undefined> {
	if (!ticket.startsWith("cad_tk_")) return undefined;
	const hash = await sha256Hex(ticket);
	const claimed = await db
		.prepare(
			`UPDATE cadmus_tickets SET used_at = ?2
       WHERE ticket_hash = ?1 AND used_at IS NULL AND target = ?3 AND expires_at > ?2
       RETURNING session_id, account_id, user_id, credential`,
		)
		.bind(hash, now, target)
		.first<{
			session_id: string;
			account_id: string | null;
			user_id: string | null;
			credential: string | null;
		}>();
	if (!claimed) return undefined;
	if (claimed.session_id === LEGACY_TICKET_SESSION) {
		if (!claimed.account_id || !claimed.user_id) return undefined;
		const live = await resolveLegacyCredential(
			db,
			claimed.credential,
			claimed.user_id,
			claimed.account_id,
			now,
		);
		if (!live) return undefined;
		return {
			userId: claimed.user_id,
			accountId: claimed.account_id,
			role: live.role,
			...(live.grants ? { grants: live.grants } : {}),
			credential: claimed.credential ?? undefined,
		};
	}
	const identity = await resolveSessionById(
		db,
		claimed.session_id,
		claimed.account_id ?? undefined,
		now,
	);
	if (!identity) return undefined;
	// Streams re-read admin mode on each message. The ticket must not snapshot it.
	const { sessionId, userId, accountId, role, grants } = identity;
	return {
		sessionId,
		userId,
		accountId,
		role,
		...(grants ? { grants } : {}),
	};
}
