import { SYSTEM_ACCOUNT_ID } from "@cadmus/contract/grants";
import { randomId } from "./random-id.js";

/**
 * Issue #3 phase 6b: the system console's account records and audit log.
 * These act on account records only, never on tenant data (bots, chats,
 * knowledge, credentials).
 */

export interface SystemAccount {
	id: string;
	name: string;
	timezone: string;
	createdAt: number;
	status: "active" | "suspended";
	suspendedAt?: number;
	memberCount: number;
}

export interface SystemAuditEvent {
	id: string;
	accountId: string;
	actorUserId?: string;
	actorKind: string;
	action: string;
	targetAccountId?: string;
	target?: string;
	data?: unknown;
	at: number;
}

export type SystemResult<T> =
	| ({ ok: true } & T)
	| { ok: false; code: "not_found" | "invalid" | "conflict"; message: string };

interface AccountRow {
	id: string;
	name: string;
	timezone: string | null;
	created_at: number;
	status: string;
	suspended_at: number | null;
	member_count: number;
}

function toAccount(row: AccountRow): SystemAccount {
	return {
		id: row.id,
		name: row.name,
		timezone: row.timezone ?? "UTC",
		createdAt: row.created_at,
		status: row.status === "suspended" ? "suspended" : "active",
		...(row.suspended_at !== null ? { suspendedAt: row.suspended_at } : {}),
		memberCount: row.member_count,
	};
}

function auditStatement(
	db: D1Database,
	actor: string,
	action: string,
	targetAccountId: string,
	data: object,
	now: number,
	when?: string,
) {
	return db
		.prepare(
			`INSERT INTO cadmus_audit (id, account_id, actor_user_id, actor_kind, action, target_account_id, target, data, at)
       SELECT ?1, '${SYSTEM_ACCOUNT_ID}', ?2, 'user', ?3, ?4, ?4, ?5, ?6${when ? ` WHERE ${when}` : ""}`,
		)
		.bind(
			randomId("aud_"),
			actor,
			action,
			targetAccountId,
			JSON.stringify(data),
			now,
		);
}

const ACCOUNT_SELECT = `SELECT a.id, a.name, a.timezone, a.created_at, a.status, a.suspended_at,
  (SELECT COUNT(*) FROM cadmus_account_members m WHERE m.account_id = a.id) AS member_count
  FROM cadmus_accounts a`;

/** Every tenant account. The system account itself is not a tenant. */
export async function listSystemAccounts(
	db: D1Database,
): Promise<SystemAccount[]> {
	const { results } = await db
		.prepare(
			`${ACCOUNT_SELECT} WHERE a.id != '${SYSTEM_ACCOUNT_ID}' ORDER BY a.created_at, a.id`,
		)
		.all<AccountRow>();
	return results.map(toAccount);
}

async function getTenant(
	db: D1Database,
	accountId: string,
): Promise<SystemAccount | undefined> {
	if (accountId === SYSTEM_ACCOUNT_ID) return undefined;
	const row = await db
		.prepare(`${ACCOUNT_SELECT} WHERE a.id = ?1`)
		.bind(accountId)
		.first<AccountRow>();
	return row ? toAccount(row) : undefined;
}

function cleanName(raw: string): string | undefined {
	const name = raw.trim();
	return name.length > 0 && name.length <= 80 ? name : undefined;
}

/**
 * Suspend or resume one tenant account. The status flip and its audit row go
 * in one batch, and the audit row is written only when the status changed.
 */
export async function setAccountStatus(
	db: D1Database,
	input: { accountId: string; status: "active" | "suspended"; actor: string },
	now = Date.now(),
): Promise<SystemResult<{ account: SystemAccount; changed: boolean }>> {
	if (!(await getTenant(db, input.accountId))) {
		return { ok: false, code: "not_found", message: "Account not found" };
	}
	const from = input.status === "suspended" ? "active" : "suspended";
	const [flip] = await db.batch([
		db
			.prepare(
				`UPDATE cadmus_accounts SET status = ?1, suspended_at = ?2
         WHERE id = ?3 AND id != '${SYSTEM_ACCOUNT_ID}' AND status = ?4`,
			)
			.bind(
				input.status,
				input.status === "suspended" ? now : null,
				input.accountId,
				from,
			),
		auditStatement(
			db,
			input.actor,
			input.status === "suspended" ? "account.suspend" : "account.resume",
			input.accountId,
			{},
			now,
			`changes() > 0`,
		),
	]);
	const account = await getTenant(db, input.accountId);
	if (!account) {
		return { ok: false, code: "not_found", message: "Account not found" };
	}
	return { ok: true, account, changed: (flip?.meta?.changes ?? 0) > 0 };
}

export async function renameAccount(
	db: D1Database,
	input: { accountId: string; name: string; actor: string },
	now = Date.now(),
): Promise<SystemResult<{ account: SystemAccount; changed: boolean }>> {
	const name = cleanName(input.name);
	if (!name) {
		return {
			ok: false,
			code: "invalid",
			message: "Account name must be 1 to 80 characters",
		};
	}
	if (!(await getTenant(db, input.accountId))) {
		return { ok: false, code: "not_found", message: "Account not found" };
	}
	// The audit row reads the name it replaces inside the same batch, before the
	// update, so a concurrent rename cannot make it claim a stale "from".
	const changing = `EXISTS (SELECT 1 FROM cadmus_accounts WHERE id = ?3 AND name != ?4)`;
	const [, update] = await db.batch([
		db
			.prepare(
				`INSERT INTO cadmus_audit (id, account_id, actor_user_id, actor_kind, action, target_account_id, target, data, at)
         SELECT ?1, '${SYSTEM_ACCOUNT_ID}', ?2, 'user', 'account.rename', ?3, ?3,
                json_object('from', (SELECT name FROM cadmus_accounts WHERE id = ?3), 'to', ?4), ?5
         WHERE ${changing}`,
			)
			.bind(randomId("aud_"), input.actor, input.accountId, name, now),
		db
			.prepare(
				`UPDATE cadmus_accounts SET name = ?1 WHERE id = ?2 AND id != '${SYSTEM_ACCOUNT_ID}' AND name != ?1`,
			)
			.bind(name, input.accountId),
	]);
	const account = await getTenant(db, input.accountId);
	if (!account) {
		return { ok: false, code: "not_found", message: "Account not found" };
	}
	return { ok: true, account, changed: (update?.meta?.changes ?? 0) > 0 };
}

/** Audit row for a newly created account, written by the caller's batch. */
export function accountCreateAudit(
	db: D1Database,
	input: { accountId: string; actor: string; name: string },
	now: number,
) {
	return auditStatement(
		db,
		input.actor,
		"account.create",
		input.accountId,
		{ name: input.name },
		now,
	);
}

export { cleanName };

type AuditRow = {
	id: string;
	account_id: string;
	actor_user_id: string | null;
	actor_kind: string;
	action: string;
	target_account_id: string | null;
	target: string | null;
	data: string | null;
	at: number;
};

function mapAuditRow(r: AuditRow): SystemAuditEvent {
	let data: unknown;
	try {
		data = r.data ? JSON.parse(r.data) : undefined;
	} catch {
		data = undefined;
	}
	return {
		id: r.id,
		accountId: r.account_id,
		...(r.actor_user_id ? { actorUserId: r.actor_user_id } : {}),
		actorKind: r.actor_kind,
		action: r.action,
		...(r.target_account_id ? { targetAccountId: r.target_account_id } : {}),
		...(r.target ? { target: r.target } : {}),
		...(data !== undefined ? { data } : {}),
		at: r.at,
	};
}

/**
 * System-scope audit: rows written in the system account plus membership
 * changes a super-admin made inside a tenant (marked actor_kind 'super-admin'),
 * newest first. Other tenant audit rows stay with the tenant's own admins.
 */
export async function listSystemAudit(
	db: D1Database,
	input: {
		limit: number;
		accountId?: string;
		before?: number;
		beforeId?: string;
	},
): Promise<SystemAuditEvent[]> {
	const limit = Math.min(Math.max(Math.floor(input.limit), 1), 200);
	const { results } = await db
		.prepare(
			`SELECT id, account_id, actor_user_id, actor_kind, action, target_account_id, target, data, at
       FROM cadmus_audit
       WHERE (account_id = '${SYSTEM_ACCOUNT_ID}' OR actor_kind = 'super-admin')
         AND (?1 IS NULL OR target_account_id = ?1)
         AND (?2 IS NULL OR at < ?2 OR (at = ?2 AND ?4 IS NOT NULL AND id < ?4))
       ORDER BY at DESC, id DESC LIMIT ?3`,
		)
		.bind(
			input.accountId ?? null,
			input.before ?? null,
			limit,
			input.beforeId ?? null,
		)
		.all<AuditRow>();
	return results.map(mapAuditRow);
}

/**
 * Audit rows kept in one tenant account, newest first. Only rows whose own
 * account_id is the tenant: rows the system console keeps in the system scope
 * stay there even when they are about the tenant. The caller supplies the
 * account from its own session, never from a request payload.
 */
export async function listAccountAudit(
	db: D1Database,
	input: {
		accountId: string;
		limit: number;
		before?: number;
		beforeId?: string;
	},
): Promise<SystemAuditEvent[]> {
	const limit = Math.min(Math.max(Math.floor(input.limit), 1), 200);
	const { results } = await db
		.prepare(
			`SELECT id, account_id, actor_user_id, actor_kind, action, target_account_id, target, data, at
       FROM cadmus_audit
       WHERE account_id = ?1
         AND (?2 IS NULL OR at < ?2 OR (at = ?2 AND ?4 IS NOT NULL AND id < ?4))
       ORDER BY at DESC, id DESC LIMIT ?3`,
		)
		.bind(input.accountId, input.before ?? null, limit, input.beforeId ?? null)
		.all<AuditRow>();
	return results.map(mapAuditRow);
}

export interface SystemMember {
	userId: string;
	name: string;
	email?: string;
	role: string;
	createdAt: number;
	disabledAt?: number;
}

/**
 * Members of one tenant account with their identity and disabled state. The
 * system account is not a tenant, so its members are not listed here.
 */
export async function listAccountMembers(
	db: D1Database,
	accountId: string,
): Promise<SystemResult<{ members: SystemMember[] }>> {
	if (!(await getTenant(db, accountId))) {
		return { ok: false, code: "not_found", message: "Account not found" };
	}
	const { results } = await db
		.prepare(
			`SELECT m.user_id, u.name, COALESCE(u.primary_email, u.email) AS email, m.role, m.created_at, u.disabled_at
       FROM cadmus_account_members m JOIN cadmus_users u ON u.id = m.user_id
       WHERE m.account_id = ?1 ORDER BY m.created_at, m.user_id`,
		)
		.bind(accountId)
		.all<{
			user_id: string;
			name: string;
			email: string | null;
			role: string;
			created_at: number;
			disabled_at: number | null;
		}>();
	return {
		ok: true,
		members: results.map((r) => ({
			userId: r.user_id,
			name: r.name,
			...(r.email ? { email: r.email } : {}),
			role: r.role,
			createdAt: r.created_at,
			...(r.disabled_at !== null ? { disabledAt: r.disabled_at } : {}),
		})),
	};
}

function systemUserAudit(
	db: D1Database,
	actor: string,
	action: string,
	userId: string,
	dataSql: string,
	now: number,
	when: string,
) {
	return db
		.prepare(
			`INSERT INTO cadmus_audit (id, account_id, actor_user_id, actor_kind, action, target_account_id, target, data, at)
       SELECT ?1, '${SYSTEM_ACCOUNT_ID}', ?2, 'user', ?3, NULL, ?4, ${dataSql}, ?5 WHERE ${when}`,
		)
		.bind(randomId("aud_"), actor, action, userId, now);
}

/** Super-admins are managed apart from tenant users and are never disabled here. */
const NOT_SUPER_ADMIN = `NOT EXISTS (SELECT 1 FROM cadmus_account_members WHERE user_id = ?4 AND role = 'super-admin')`;

async function checkTargetUser(
	db: D1Database,
	userId: string,
	actor: string,
): Promise<SystemResult<{ checked: true }>> {
	const user = await db
		.prepare(`SELECT id FROM cadmus_users WHERE id = ?1`)
		.bind(userId)
		.first<{ id: string }>();
	if (!user) return { ok: false, code: "not_found", message: "User not found" };
	if (userId === actor) {
		return {
			ok: false,
			code: "invalid",
			message: "You cannot change your own account state here",
		};
	}
	const superAdmin = await db
		.prepare(
			`SELECT 1 AS x FROM cadmus_account_members WHERE user_id = ?1 AND role = 'super-admin'`,
		)
		.bind(userId)
		.first();
	if (superAdmin) {
		return {
			ok: false,
			code: "invalid",
			message: "Super-admins are not managed from the user console",
		};
	}
	return { ok: true, checked: true };
}

/** Disable or re-enable a user everywhere. The audit row is written only when the state changed. */
export async function setUserDisabled(
	db: D1Database,
	input: { userId: string; disabled: boolean; actor: string },
	now = Date.now(),
): Promise<SystemResult<{ changed: boolean }>> {
	const check = await checkTargetUser(db, input.userId, input.actor);
	if (!check.ok) return check;
	const from = input.disabled
		? "disabled_at IS NULL"
		: "disabled_at IS NOT NULL";
	const [update] = await db.batch([
		db
			.prepare(
				`UPDATE cadmus_users SET disabled_at = ?1 WHERE id = ?2 AND ${from} AND ${NOT_SUPER_ADMIN.replace("?4", "?2")}`,
			)
			.bind(input.disabled ? now : null, input.userId),
		systemUserAudit(
			db,
			input.actor,
			input.disabled ? "user.disable" : "user.enable",
			input.userId,
			"'{}'",
			now,
			"changes() > 0",
		),
	]);
	return { ok: true, changed: (update?.meta?.changes ?? 0) > 0 };
}

/** Revoke every live session of a user. The audit row records the count it covered. */
export async function revokeUserSessions(
	db: D1Database,
	input: { userId: string; actor: string },
	now = Date.now(),
): Promise<SystemResult<{ revoked: number }>> {
	const check = await checkTargetUser(db, input.userId, input.actor);
	if (!check.ok) return check;
	const live = `SELECT COUNT(*) FROM cadmus_sessions WHERE user_id = ?4 AND revoked_at IS NULL`;
	const [, update] = await db.batch([
		systemUserAudit(
			db,
			input.actor,
			"user.sessions.revoke",
			input.userId,
			`json_object('sessions', (${live}))`,
			now,
			`EXISTS (SELECT 1 FROM cadmus_sessions WHERE user_id = ?4 AND revoked_at IS NULL) AND ${NOT_SUPER_ADMIN}`,
		),
		db
			.prepare(
				`UPDATE cadmus_sessions SET revoked_at = ?2 WHERE user_id = ?1 AND revoked_at IS NULL AND ${NOT_SUPER_ADMIN.replace("?4", "?1")}`,
			)
			.bind(input.userId, now),
	]);
	return { ok: true, revoked: update?.meta?.changes ?? 0 };
}

/**
 * Removes every passkey of a user (they are per user, so this covers all of
 * their accounts) and ends all of their sessions, including any admin mode.
 * The target may be another super-admin; the actor may not reset themselves.
 *
 * Authority is checked again inside the batch: the actor's own session must be
 * a live, non-token session of a live super-admin that is in admin mode right
 * now. One batch: a system-scope audit row with a fresh per-call id (counts
 * only) is written first and counts what the next statements change. Those
 * statements run only when that exact row exists, so no other call can supply
 * it. Nothing is written to a tenant account.
 */
export async function resetUserPasskeys(
	db: D1Database,
	input: { userId: string; actor: string; actorSessionId: string },
	now = Date.now(),
): Promise<SystemResult<{ passkeys: number; sessions: number }>> {
	const user = await db
		.prepare(`SELECT id FROM cadmus_users WHERE id = ?1`)
		.bind(input.userId)
		.first<{ id: string }>();
	if (!user) return { ok: false, code: "not_found", message: "User not found" };
	if (input.userId === input.actor) {
		return {
			ok: false,
			code: "invalid",
			message: "You cannot reset your own passkeys here",
		};
	}
	const op = randomId("aud_");
	// ?1 target, ?2 actor, ?3 actor session, ?4 now, ?5 operation (audit row) id.
	const authority = `?1 <> ?2
      AND EXISTS (SELECT 1 FROM cadmus_users u WHERE u.id = ?2 AND u.disabled_at IS NULL)
      AND EXISTS (SELECT 1 FROM cadmus_account_members WHERE user_id = ?2 AND role = 'super-admin')
      AND EXISTS (SELECT 1 FROM cadmus_sessions s
                  WHERE s.id = ?3 AND s.user_id = ?2 AND s.token_id IS NULL
                    AND s.revoked_at IS NULL AND s.elevated_until > ?4
                    AND s.absolute_expires_at > ?4 AND s.idle_expires_at > ?4)`;
	const active = `SELECT p.login_method_id FROM cadmus_passkeys p
    JOIN cadmus_login_methods m ON m.id = p.login_method_id
    WHERE p.user_id = ?1 AND m.revoked_at IS NULL`;
	const opRan = `EXISTS (SELECT 1 FROM cadmus_audit WHERE id = ?5 AND action = 'user.passkeys.reset')`;
	const bind = (st: D1PreparedStatement) =>
		st.bind(input.userId, input.actor, input.actorSessionId, now, op);
	const [audit, methods, sessions] = await db.batch([
		bind(
			db.prepare(
				`INSERT INTO cadmus_audit (id, account_id, actor_user_id, actor_kind, action, target_account_id, target, data, at)
         SELECT ?5, '${SYSTEM_ACCOUNT_ID}', ?2, 'user', 'user.passkeys.reset', NULL, ?1,
                json_object('passkeys', (SELECT COUNT(*) FROM (${active})),
                            'sessions', (SELECT COUNT(*) FROM cadmus_sessions WHERE user_id = ?1 AND revoked_at IS NULL)),
                ?4
         WHERE EXISTS (${active}) AND ${authority}`,
			),
		),
		bind(
			db.prepare(
				`UPDATE cadmus_login_methods SET revoked_at = ?4
         WHERE user_id = ?1 AND revoked_at IS NULL
           AND id IN (SELECT login_method_id FROM cadmus_passkeys WHERE user_id = ?1)
           AND ${opRan}`,
			),
		),
		bind(
			db.prepare(
				`UPDATE cadmus_sessions SET revoked_at = ?4, elevated_until = NULL
         WHERE user_id = ?1 AND revoked_at IS NULL AND ${opRan}`,
			),
		),
	]);
	if ((audit?.meta?.changes ?? 0) === 0) {
		// Nothing to reset, or the actor's authority no longer held at execution.
		const stillActive = await db
			.prepare(`SELECT 1 AS x WHERE EXISTS (${active})`)
			.bind(input.userId)
			.first();
		if (stillActive) {
			return {
				ok: false,
				code: "conflict",
				message: "Passkey reset is not allowed for this session",
			};
		}
		return { ok: true, passkeys: 0, sessions: 0 };
	}
	return {
		ok: true,
		passkeys: methods?.meta?.changes ?? 0,
		sessions: sessions?.meta?.changes ?? 0,
	};
}
