import { normalizeRole, type Role } from "@cadmus/contract/grants";
import { sha256Hex } from "../edge-cache.js";
import { randomId, randomToken } from "./random-id.js";
import {
	parseStoredRoles,
	ROLE_CHOICE_SESSION_MS,
	ROLE_RANK_SQL,
} from "./roles.js";

function sessionHash(raw: string): Promise<string> {
	return sha256Hex(raw);
}

/** Lifetimes from issue #3 decision 12. */
export const ACCESS_TTL_MS = 15 * 60 * 1000;
export const REFRESH_IDLE_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;
/** CLI device-login profile. Issue #104. Access stays ACCESS_TTL_MS. */
export const CLI_REFRESH_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
export const CLI_SESSION_ABSOLUTE_MS = 90 * 24 * 60 * 60 * 1000;
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
	/** Epoch ms when admin mode on this session ends. Only set while it is on. */
	elevatedUntil?: number;
	/** Short role-choice session. */
	provisional?: boolean;
}

export type RefreshResult =
	| {
			ok: true;
			tokens: SessionTokens;
			accountId: string;
			userId: string;
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
	userAgent?: string;
	ipCountry?: string;
	now?: number;
	/** Hat for this session. Omitted: the lowest stored role on the account. */
	activeRole?: Role;
	/** Short role-choice session. Caps access, idle, and absolute expiry. */
	provisional?: boolean;
	/** CLI device login. Ignored while provisional. */
	profile?: "cli";
	/** Statements committed in the same batch as the session insert. */
	extra?: D1PreparedStatement[];
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
	const storedHat = await db
		.prepare(
			`SELECT role FROM cadmus_member_roles
        WHERE account_id = ?1 AND user_id = ?2
        ORDER BY ${ROLE_RANK_SQL} ASC LIMIT 1`,
		)
		.bind(input.accountId, input.userId)
		.first<{ role: string }>();
	const activeRole = input.activeRole ?? normalizeRole(storedHat?.role);
	if (!activeRole) {
		throw new Error("session has no stored role on this account");
	}
	const cli = !input.provisional && input.profile === "cli";
	const life = input.provisional
		? ROLE_CHOICE_SESSION_MS
		: cli
			? CLI_SESSION_ABSOLUTE_MS
			: SESSION_ABSOLUTE_MS;
	const idle = input.provisional
		? ROLE_CHOICE_SESSION_MS
		: cli
			? CLI_REFRESH_IDLE_MS
			: REFRESH_IDLE_MS;
	const accessExpiresAt = Math.min(now + ACCESS_TTL_MS, now + life);
	const absoluteExpiresAt = now + life;
	const refreshExpiresAt = Math.min(now + idle, absoluteExpiresAt);
	await db.batch([
		db
			.prepare(
				`INSERT INTO cadmus_sessions
         (id, session_family_id, user_id, account_id, login_method_id, token_id,
          refresh_hash, previous_refresh_hash, access_hash, access_expires_at,
          user_agent, ip_country, created_at, last_used_at, idle_expires_at, absolute_expires_at,
          fresh_google_at, active_role, provisional, client)
       VALUES (?1, ?1, ?2, ?3, ?4, ?5, ?6, NULL, ?7, ?8, ?9, ?10, ?11, ?11, ?12, ?13, ?14, ?15, ?16, ?17)`,
			)
			.bind(
				sessionId,
				input.userId,
				input.accountId,
				input.loginMethodId ?? null,
				null,
				await sessionHash(refreshToken),
				await sessionHash(accessToken),
				accessExpiresAt,
				input.userAgent ?? null,
				input.ipCountry ?? null,
				now,
				refreshExpiresAt,
				absoluteExpiresAt,
				input.freshGoogleAt ?? null,
				activeRole,
				input.provisional ? 1 : 0,
				cli ? "cli" : "web",
			),
		...(input.extra ?? []),
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

export type AssumeRoleResult =
	| { ok: true; tokens: SessionTokens }
	| { ok: false; code: "forbidden" | "role_unchanged" };

/**
 * Mints a full session for a stored hat and revokes the caller in the same
 * batch. Same hat on a finished session is `role_unchanged` and writes nothing.
 * Confirming that hat on a provisional session promotes it.
 */
export async function assumeStoredRole(
	db: D1Database,
	input: {
		sessionId: string;
		userId: string;
		fromAccountId: string;
		fromRole: Role;
		provisional: boolean;
		accountId: string;
		role: Role;
		userAgent?: string;
		ipCountry?: string;
		now?: number;
	},
): Promise<AssumeRoleResult> {
	const now = input.now ?? Date.now();
	const account = await db
		.prepare(
			`SELECT a.status FROM cadmus_accounts a
        WHERE a.id = ?1 AND a.status = 'active'`,
		)
		.bind(input.accountId)
		.first<{ status: string }>();
	const held = await db
		.prepare(
			`SELECT 1 AS x FROM cadmus_member_roles
        WHERE account_id = ?1 AND user_id = ?2 AND role = ?3`,
		)
		.bind(input.accountId, input.userId, input.role)
		.first<{ x: number }>();
	if (!account || !held) return { ok: false, code: "forbidden" };
	const same =
		input.role === input.fromRole && input.accountId === input.fromAccountId;
	if (same && !input.provisional) return { ok: false, code: "role_unchanged" };
	const tokens = await createSession(db, {
		userId: input.userId,
		accountId: input.accountId,
		activeRole: input.role,
		userAgent: input.userAgent,
		ipCountry: input.ipCountry,
		now,
		extra: [
			db
				.prepare(
					`UPDATE cadmus_sessions SET revoked_at = ?2
            WHERE id = ?1 AND revoked_at IS NULL`,
				)
				.bind(input.sessionId, now),
			db
				.prepare(
					`${AUDIT_COLUMNS} VALUES (?1, ?2, ?3, 'user', 'session.assume', ?4, ?5, ?6, ?7)`,
				)
				.bind(
					randomId("aud_"),
					input.accountId,
					input.userId,
					input.fromAccountId,
					input.sessionId,
					JSON.stringify({
						fromRole: input.fromRole,
						toRole: input.role,
						fromAccountId: input.fromAccountId,
						toAccountId: input.accountId,
					}),
					now,
				),
		],
	});
	return { ok: true, tokens };
}

type SessionRow = {
	id: string;
	user_id: string;
	account_id: string;
	/** The account the session was signed in to. */
	home_account_id: string;
	role: string;
	token_id: string | null;
	access_expires_at: number;
	absolute_expires_at: number;
	idle_expires_at: number;
	revoked_at: number | null;
	disabled_at: number | null;
	status: string;
	elevated_until: number | null;
	elevated_account_id: string | null;
	provisional: number;
};

function sessionSelect(selected: boolean): string {
	// With a selected account (?2) the membership, account and role come from
	// that account; without one, from the session's own account.
	const acct = selected ? "?2" : "s.account_id";
	return `SELECT s.token_id AS token_id, s.id, s.user_id, a.id AS account_id, s.account_id AS home_account_id, r.role, s.access_expires_at,
              s.absolute_expires_at, s.idle_expires_at, s.revoked_at, s.elevated_until, s.elevated_account_id, s.provisional, u.disabled_at, a.status
       FROM cadmus_sessions s
       JOIN cadmus_account_members m
         ON m.account_id = ${acct} AND m.user_id = s.user_id
       JOIN cadmus_member_roles r
         ON r.account_id = ${acct} AND r.user_id = s.user_id AND r.role = s.active_role
       JOIN cadmus_users u ON u.id = s.user_id
       JOIN cadmus_accounts a ON a.id = ${acct}`;
}
const SESSION_SELECT = sessionSelect(false);

function identityFromRow(
	row: SessionRow | null,
	now: number,
	checkAccessExpiry: boolean,
): SessionIdentity | undefined {
	if (!row) return undefined;
	if (row.token_id !== null) return undefined;
	if (row.revoked_at !== null || row.disabled_at !== null) return undefined;
	if (row.status !== "active") return undefined;
	if (row.absolute_expires_at <= now || row.idle_expires_at <= now) {
		return undefined;
	}
	if (checkAccessExpiry && row.access_expires_at <= now) return undefined;
	const role = normalizeRole(row.role);
	if (!role) return undefined;
	return {
		sessionId: row.id,
		userId: row.user_id,
		accountId: row.account_id,
		role,
		...(row.elevated_until !== null &&
		row.elevated_until > now &&
		row.account_id === (row.elevated_account_id ?? row.home_account_id)
			? { elevatedUntil: row.elevated_until }
			: {}),
		...(row.provisional ? { provisional: true } : {}),
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
	const row = await (selectedAccountId
		? db
				.prepare(`${sessionSelect(true)} WHERE s.access_hash = ?1`)
				.bind(hash, selectedAccountId)
		: db.prepare(`${SESSION_SELECT} WHERE s.access_hash = ?1`).bind(hash)
	).first<SessionRow>();
	const identity = identityFromRow(row, now, true);
	// An explicit, verified selection counts as use of that account for the
	// next sign-in default. Refused requests returned above and write nothing.
	// Throttled so a busy client is not a D1 write per request.
	if (identity && selectedAccountId) {
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
	const row = await db
		.prepare(
			`SELECT id, session_family_id, refresh_hash
       FROM cadmus_sessions
       WHERE refresh_hash = ?1 OR previous_refresh_hash = ?1`,
		)
		.bind(hash)
		.first<{
			id: string;
			session_family_id: string;
			refresh_hash: string;
		}>();
	if (!row) return false;
	if (row.refresh_hash !== hash) {
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
	const accessToken = randomToken(ACCESS_PREFIX);
	const refreshToken = randomToken(REFRESH_PREFIX);
	const provisional = (state?.provisional ?? 0) !== 0;
	const accessExpiresAt = Math.min(
		now + (provisional ? ROLE_CHOICE_SESSION_MS : ACCESS_TTL_MS),
		row.absolute_expires_at,
	);
	const refreshExpiresAt = Math.min(
		now + (provisional ? ROLE_CHOICE_SESSION_MS : REFRESH_IDLE_MS),
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
			await sessionHash(refreshToken),
			await sessionHash(accessToken),
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
	};
}

// ─── Session and login method management ────────────────────────────────────

export interface SessionSummary {
	id: string;
	accountId: string;
	loginMethod?: string;
	/** web or cli. Absent on sessions created before the column existed. */
	client?: "web" | "cli";
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
			`SELECT s.id, s.account_id, s.token_id, s.user_agent, s.ip_country, s.client,
              s.created_at, s.last_used_at, l.provider
       FROM cadmus_sessions s
       LEFT JOIN cadmus_login_methods l ON l.id = s.login_method_id
       WHERE s.user_id = ?1 AND s.revoked_at IS NULL
         AND s.absolute_expires_at > ?2 AND s.idle_expires_at > ?2
       ORDER BY s.last_used_at DESC, s.created_at DESC`,
		)
		.bind(userId, now)
		.all<{
			id: string;
			account_id: string;
			token_id: string | null;
			user_agent: string | null;
			ip_country: string | null;
			client: string | null;
			created_at: number;
			last_used_at: number;
			provider: string | null;
		}>();
	return results.map((r) => ({
		id: r.id,
		accountId: r.account_id,
		...(r.provider ? { loginMethod: r.provider } : {}),
		...(r.client === "web" || r.client === "cli" ? { client: r.client } : {}),
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
	roles: Role[];
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
			`SELECT m.account_id, a.name,
              (SELECT json_group_array(r.role) FROM cadmus_member_roles r
                WHERE r.account_id = m.account_id AND r.user_id = m.user_id) AS roles
       FROM cadmus_account_members m
       JOIN cadmus_accounts a ON a.id = m.account_id
       WHERE m.user_id = ?1 AND a.status = 'active'
       ORDER BY m.created_at ASC, m.account_id ASC`,
		)
		.bind(userId)
		.all<{ account_id: string; name: string; roles: string }>();
	return results.map((r) => ({
		accountId: r.account_id,
		name: r.name,
		roles: parseStoredRoles(r.roles),
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

/** Identity a consumed ticket yields. A ticket always names a live session. */
export type TicketIdentity = SessionIdentity;

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
	if (!claimed || claimed.session_id === "legacy") return undefined;
	const identity = await resolveSessionById(
		db,
		claimed.session_id,
		claimed.account_id ?? undefined,
		now,
	);
	if (!identity) return undefined;
	// Streams re-read admin mode on each message. The ticket must not snapshot it.
	const { sessionId, userId, accountId, role } = identity;
	return { sessionId, userId, accountId, role };
}
