import {
	grantsForRole,
	normalizeRole,
	type Role,
} from "@cadmus/contract/grants";
import { randomId } from "./random-id.js";
import { parseStoredRoles } from "./roles.js";
import {
	deleteUnclaimedPreloginUser,
	insertPrimaryUserStatements,
	isLoginEmail,
	normalizeLoginEmail,
} from "./user-emails.js";

/** Issue #3 phase 4: invites, role changes and removals with their audit rows. */
export const INVITE_DEFAULT_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export interface InviteSummary {
	id: string;
	email: string;
	roles: Role[];
	invitedBy: string | null;
	createdAt: number;
	expiresAt: number;
	acceptedAt: number | null;
	revokedAt: number | null;
}

function audit(
	db: D1Database,
	accountId: string,
	actor: string,
	action: string,
	target: string,
	data: object,
	now: number,
	/** Optional SQL condition over ?2 (account) and ?5 (target); the row is written only when it holds. */
	when?: string,
	/** "super-admin" when a super-admin acts on this account from the system console. */
	actorKind: "user" | "super-admin" = "user",
	/** Fixed row id, so later statements in the batch can test that this operation's own audit row landed. */
	id: string = randomId("aud_"),
) {
	return db
		.prepare(
			`INSERT INTO cadmus_audit (id, account_id, actor_user_id, actor_kind, action, target_account_id, target, data, at)
       SELECT ?1, ?2, ?3, '${actorKind}', ?4, ?2, ?5, ?6, ?7${when ? ` WHERE ${when}` : ""}`,
		)
		.bind(id, accountId, actor, action, target, JSON.stringify(data), now);
}

export type InviteResult =
	| { ok: true; invite: InviteSummary }
	| { ok: false; code: "invalid" | "conflict"; message: string };

export async function inviteMember(
	db: D1Database,
	input: {
		accountId: string;
		invitedBy: string;
		email: string;
		roles?: Role[];
		ttlMs?: number;
		now?: number;
		actorKind?: "user" | "super-admin";
	},
): Promise<InviteResult> {
	const now = input.now ?? Date.now();
	const email = normalizeLoginEmail(input.email);
	if (!isLoginEmail(email)) {
		return { ok: false, code: "invalid", message: "email is not valid" };
	}
	const roles = (input.roles?.length ? input.roles : ["user"]).filter(
		(role): role is Role => role === "user" || role === "account-admin",
	);
	if (
		roles.length === 0 ||
		input.roles?.some((role) => role === "super-admin")
	) {
		return {
			ok: false,
			code: "invalid",
			message: "super-admin cannot be invited",
		};
	}
	if (input.accountId === "system") {
		return {
			ok: false,
			code: "invalid",
			message: "the system account is managed with system.members.*",
		};
	}
	const pending = await db
		.prepare(
			`SELECT id FROM cadmus_invites
        WHERE account_id = ?1 AND email = ?2 AND accepted_at IS NULL
          AND revoked_at IS NULL AND expires_at > ?3`,
		)
		.bind(input.accountId, email, now)
		.first<{ id: string }>();
	if (pending) {
		return {
			ok: false,
			code: "conflict",
			message: "a pending invite for this email already exists",
		};
	}
	const id = randomId("inv_");
	const expiresAt = now + (input.ttlMs ?? INVITE_DEFAULT_TTL_MS);
	const user = insertPrimaryUserStatements(db, email, email, now);
	await db.batch([
		...user.statements,
		db
			.prepare(
				`INSERT INTO cadmus_invites (id, account_id, email, roles, invited_by, created_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
			)
			.bind(
				id,
				input.accountId,
				email,
				JSON.stringify(roles),
				input.invitedBy,
				now,
				expiresAt,
			),
		audit(
			db,
			input.accountId,
			input.invitedBy,
			"member.invite",
			id,
			{
				email,
				roles,
			},
			now,
			undefined,
			input.actorKind,
		),
	]);
	return {
		ok: true,
		invite: {
			id,
			email,
			roles,
			invitedBy: input.invitedBy,
			createdAt: now,
			expiresAt,
			acceptedAt: null,
			revokedAt: null,
		},
	};
}

export async function listInvites(
	db: D1Database,
	accountId: string,
): Promise<InviteSummary[]> {
	const res = await db
		.prepare(
			`SELECT id, email, roles, invited_by, created_at, expires_at, accepted_at, revoked_at
         FROM cadmus_invites WHERE account_id = ?1 ORDER BY created_at DESC LIMIT 200`,
		)
		.bind(accountId)
		.all<{
			id: string;
			email: string;
			roles: string;
			invited_by: string | null;
			created_at: number;
			expires_at: number;
			accepted_at: number | null;
			revoked_at: number | null;
		}>();
	return (res.results ?? []).map((r) => ({
		id: r.id,
		email: r.email,
		roles: parseStoredRoles(r.roles),
		invitedBy: r.invited_by,
		createdAt: r.created_at,
		expiresAt: r.expires_at,
		acceptedAt: r.accepted_at,
		revokedAt: r.revoked_at,
	}));
}

export async function revokeInvite(
	db: D1Database,
	input: { accountId: string; inviteId: string; actor: string },
	now = Date.now(),
): Promise<boolean> {
	const res = await db
		.prepare(
			`UPDATE cadmus_invites SET revoked_at = ?3
        WHERE id = ?1 AND account_id = ?2 AND accepted_at IS NULL AND revoked_at IS NULL`,
		)
		.bind(input.inviteId, input.accountId, now)
		.run();
	if ((res.meta?.changes ?? 0) === 0) return false;
	const invite = await db
		.prepare(`SELECT email FROM cadmus_invites WHERE id = ?1`)
		.bind(input.inviteId)
		.first<{ email: string }>();
	await audit(
		db,
		input.accountId,
		input.actor,
		"member.invite.revoke",
		input.inviteId,
		{},
		now,
	).run();
	if (invite) await deleteUnclaimedPreloginUser(db, invite.email, now);
	return true;
}

export type MemberChangeResult =
	| {
			ok: true;
			changed: boolean;
			tokensRevoked: number;
			sessionsRevoked: number;
	  }
	| { ok: false; code: "invalid" | "conflict" | "not_found"; message: string };

/** Personal tokens (kind=pat) the user created in the account. */
function revokePersonalTokens(
	db: D1Database,
	accountId: string,
	userId: string,
	now: number,
	/** Optional SQL condition over ?1 (account) and ?2 (user), so the revoke only applies when the guarded change succeeded. */
	when?: string,
) {
	const and = when ? ` AND ${when}` : "";
	return [
		db
			.prepare(
				`UPDATE cadmus_sessions SET revoked_at = ?3
          WHERE revoked_at IS NULL AND token_id IN
            (SELECT id FROM cadmus_auth_tokens
              WHERE account_id = ?1 AND user_id = ?2 AND kind = 'pat' AND revoked_at IS NULL)${and}`,
			)
			.bind(accountId, userId, now),
		db
			.prepare(
				`UPDATE cadmus_auth_tokens SET revoked_at = ?3
          WHERE account_id = ?1 AND user_id = ?2 AND kind = 'pat' AND revoked_at IS NULL${and}`,
			)
			.bind(accountId, userId, now),
	];
}

/**
 * Service tokens never gain grants back: when their creator's role shrinks
 * (demotion, or removal before the token moves to an admin) the stored grant
 * set is cut to the intersection with the new role's grants. A later promotion
 * or reassignment cannot restore what was lost.
 */
function clampServiceTokens(
	db: D1Database,
	accountId: string,
	userId: string,
	role: Role,
	/** SQL over ?1 (account) and ?2 (user): the statement applies only when it holds. */
	when: string,
): D1PreparedStatement {
	const allowed = [...grantsForRole(role)];
	const marks = allowed.map((_, i) => `?${i + 3}`).join(", ");
	// Computed from each token's stored grants at write time, inside the same
	// transaction as the role change, so a token minted a moment earlier is
	// clamped too.
	return db
		.prepare(
			`UPDATE cadmus_auth_tokens
          SET grants = COALESCE((SELECT json_group_array(value) FROM json_each(grants)
                                  WHERE value IN (${marks || "''"})), '[]')
        WHERE account_id = ?1 AND user_id = ?2 AND kind = 'service' AND revoked_at IS NULL
          AND ${when}`,
		)
		.bind(accountId, userId, ...allowed);
}

const OTHER_ADMIN = `EXISTS (SELECT 1 FROM cadmus_member_roles r
            JOIN cadmus_users u ON u.id = r.user_id
           WHERE r.account_id = ?1 AND r.user_id <> ?2
             AND r.role = 'account-admin' AND u.disabled_at IS NULL)`;

export async function updateMemberRole(
	db: D1Database,
	input: {
		accountId: string;
		userId: string;
		op: "grant" | "revoke";
		role: Role;
		actor: string;
		actorKind?: "user" | "super-admin";
	},
	now = Date.now(),
): Promise<MemberChangeResult> {
	if (
		input.role === "super-admin" ||
		input.accountId === "system" ||
		(input.role !== "user" && input.role !== "account-admin")
	) {
		return {
			ok: false,
			code: "invalid",
			message: "only user and account-admin can be granted on a tenant",
		};
	}
	const member = await db
		.prepare(
			`SELECT 1 AS x FROM cadmus_account_members WHERE account_id = ?1 AND user_id = ?2`,
		)
		.bind(input.accountId, input.userId)
		.first<{ x: number }>();
	if (!member) {
		return { ok: false, code: "not_found", message: "member not found" };
	}
	const held = await db
		.prepare(
			`SELECT role FROM cadmus_member_roles WHERE account_id = ?1 AND user_id = ?2`,
		)
		.bind(input.accountId, input.userId)
		.all<{ role: string }>();
	const roles = held.results
		.map((row) => normalizeRole(row.role))
		.filter((role): role is Role => role !== undefined);
	const has = roles.includes(input.role);
	if (input.op === "grant" ? has : !has) {
		return { ok: true, changed: false, tokensRevoked: 0, sessionsRevoked: 0 };
	}
	if (input.op === "revoke" && roles.length <= 1) {
		return {
			ok: false,
			code: "conflict",
			message: "last_role: a member's last role cannot be revoked",
		};
	}
	const droppingAdmin = input.op === "revoke" && input.role === "account-admin";
	const before = droppingAdmin
		? await db
				.prepare(
					`SELECT COUNT(*) AS n FROM cadmus_auth_tokens
            WHERE account_id = ?1 AND user_id = ?2 AND kind = 'pat' AND revoked_at IS NULL`,
				)
				.bind(input.accountId, input.userId)
				.first<{ n: number }>()
		: null;
	const sessionsBefore = droppingAdmin
		? await db
				.prepare(
					`SELECT COUNT(*) AS n FROM cadmus_sessions
            WHERE account_id = ?1 AND user_id = ?2 AND active_role = 'account-admin'
              AND revoked_at IS NULL`,
				)
				.bind(input.accountId, input.userId)
				.first<{ n: number }>()
		: null;
	const opId = randomId("aud_");
	const mine = `EXISTS (SELECT 1 FROM cadmus_audit WHERE id = '${opId}')`;
	const remaining = droppingAdmin
		? roles.filter((role) => role !== "account-admin")
		: roles;
	const clampTo = remaining.includes("account-admin")
		? "account-admin"
		: "user";
	const write =
		input.op === "grant"
			? db
					.prepare(
						`INSERT OR IGNORE INTO cadmus_member_roles (account_id, user_id, role, created_at)
             VALUES (?1, ?2, ?3, ?4)`,
					)
					.bind(input.accountId, input.userId, input.role, now)
			: db
					.prepare(
						`DELETE FROM cadmus_member_roles
            WHERE account_id = ?1 AND user_id = ?2 AND role = ?3
              AND (?4 = 0 OR ${OTHER_ADMIN})
              AND (SELECT COUNT(*) FROM cadmus_member_roles
                    WHERE account_id = ?1 AND user_id = ?2) > 1`,
					)
					.bind(
						input.accountId,
						input.userId,
						input.role,
						droppingAdmin ? 1 : 0,
					);
	const results = await db.batch([
		write,
		audit(
			db,
			input.accountId,
			input.actor,
			input.op === "grant" ? "member.role.grant" : "member.role.revoke",
			input.userId,
			{ role: input.role },
			now,
			"changes() > 0",
			input.actorKind,
			opId,
		),
		...(droppingAdmin
			? [
					clampServiceTokens(db, input.accountId, input.userId, clampTo, mine),
					...revokePersonalTokens(db, input.accountId, input.userId, now, mine),
					db
						.prepare(
							`UPDATE cadmus_sessions SET revoked_at = ?3
                WHERE account_id = ?1 AND user_id = ?2 AND active_role = 'account-admin'
                  AND revoked_at IS NULL AND ${mine}`,
						)
						.bind(input.accountId, input.userId, now),
				]
			: []),
	]);
	if ((results[0]?.meta?.changes ?? 0) === 0) {
		const still = await db
			.prepare(
				`SELECT 1 AS x FROM cadmus_member_roles
          WHERE account_id = ?1 AND user_id = ?2 AND role = ?3`,
			)
			.bind(input.accountId, input.userId, input.role)
			.first<{ x: number }>();
		if (!still) {
			return { ok: true, changed: false, tokensRevoked: 0, sessionsRevoked: 0 };
		}
		if (droppingAdmin) {
			return {
				ok: false,
				code: "conflict",
				message: "last_admin: the last account-admin cannot be revoked",
			};
		}
		return { ok: true, changed: false, tokensRevoked: 0, sessionsRevoked: 0 };
	}
	return {
		ok: true,
		changed: true,
		tokensRevoked: before?.n ?? 0,
		sessionsRevoked: sessionsBefore?.n ?? 0,
	};
}

export async function removeMember(
	db: D1Database,
	input: {
		accountId: string;
		userId: string;
		actor: string;
		actorKind?: "user" | "super-admin";
	},
	now = Date.now(),
): Promise<MemberChangeResult> {
	const current = await db
		.prepare(
			`SELECT 1 AS x FROM cadmus_account_members WHERE account_id = ?1 AND user_id = ?2`,
		)
		.bind(input.accountId, input.userId)
		.first<{ x: number }>();
	if (!current) {
		return { ok: false, code: "not_found", message: "member not found" };
	}
	const targetAdmin = `SELECT r.user_id FROM cadmus_member_roles r
                            JOIN cadmus_users u ON u.id = r.user_id
                           WHERE r.account_id = ?1 AND r.user_id <> ?2
                             AND r.role = 'account-admin'
                             AND u.disabled_at IS NULL
                           ORDER BY r.user_id LIMIT 1`;
	const count = async (sql: string) =>
		(
			await db
				.prepare(sql)
				.bind(input.accountId, input.userId)
				.first<{ n: number }>()
		)?.n ?? 0;
	const tokens = await count(
		`SELECT COUNT(*) AS n FROM cadmus_auth_tokens
      WHERE account_id = ?1 AND user_id = ?2 AND revoked_at IS NULL
        AND (kind = 'pat' OR (kind = 'service' AND (${targetAdmin}) IS NULL))`,
	);
	const sessions = await count(
		`SELECT COUNT(*) AS n FROM cadmus_sessions
      WHERE account_id = ?1 AND user_id = ?2 AND revoked_at IS NULL`,
	);
	// The guard is in the DELETE (first statement); the rest only apply once the
	// membership is gone, so a lost race changes nothing.
	const opId = randomId("aud_");
	const gone = `NOT EXISTS (SELECT 1 FROM cadmus_account_members WHERE account_id = ?1 AND user_id = ?2)`;
	const mine = `EXISTS (SELECT 1 FROM cadmus_audit WHERE id = '${opId}')`;
	const actorKind = input.actorKind === "super-admin" ? "super-admin" : "user";
	const results = await db.batch([
		db
			.prepare(
				`DELETE FROM cadmus_account_members
          WHERE account_id = ?1 AND user_id = ?2
            AND (NOT EXISTS (SELECT 1 FROM cadmus_member_roles
                              WHERE account_id = ?1 AND user_id = ?2 AND role = 'account-admin')
                 OR EXISTS (SELECT 1 FROM cadmus_member_roles r
                              JOIN cadmus_users u ON u.id = r.user_id
                             WHERE r.account_id = ?1 AND r.user_id <> ?2
                               AND r.role = 'account-admin'
                               AND u.disabled_at IS NULL))`,
			)
			.bind(input.accountId, input.userId),
		audit(
			db,
			input.accountId,
			input.actor,
			"member.remove",
			input.userId,
			{
				roles: "removed",
			},
			now,
			"changes() > 0",
			input.actorKind,
			opId,
		),
		db
			.prepare(
				`DELETE FROM cadmus_member_roles
          WHERE account_id = ?1 AND user_id = ?2 AND ${gone} AND ${mine}`,
			)
			.bind(input.accountId, input.userId),
		...revokePersonalTokens(
			db,
			input.accountId,
			input.userId,
			now,
			`${gone} AND ${mine}`,
		),
		// Service tokens outlive their creator (issue #3 decision 14): when an
		// enabled admin remains, move ownership to that admin and keep the minted
		// grants (created_by keeps provenance). Audit before updating user_id so
		// chained transfers and re-invited creators only log tokens owned by ?2.
		db
			.prepare(
				`INSERT INTO cadmus_audit (id, account_id, actor_user_id, actor_kind, action, target_account_id, target, data, at)
         SELECT '${opId}_' || t.id, ?1, ?3, '${actorKind}', 'token.transfer', ?1, t.id,
                json_object('from', ?2, 'to', (${targetAdmin}), 'grants', json(t.grants)), ?4
           FROM cadmus_auth_tokens t
          WHERE t.account_id = ?1 AND t.user_id = ?2
            AND t.kind = 'service' AND t.revoked_at IS NULL
            AND (${targetAdmin}) IS NOT NULL AND ${gone} AND ${mine}`,
			)
			.bind(input.accountId, input.userId, input.actor, now),
		db
			.prepare(
				`UPDATE cadmus_auth_tokens
            SET user_id = (${targetAdmin})
          WHERE account_id = ?1 AND user_id = ?2 AND kind = 'service' AND revoked_at IS NULL
            AND (${targetAdmin}) IS NOT NULL AND ${gone} AND ${mine}`,
			)
			.bind(input.accountId, input.userId),
		// If every remaining admin is disabled, no enabled owner exists to hold
		// orphaned service tokens, so revoke them and their sessions instead of
		// writing user_id = NULL.
		db
			.prepare(
				`UPDATE cadmus_sessions SET revoked_at = ?3
          WHERE revoked_at IS NULL AND token_id IN
            (SELECT id FROM cadmus_auth_tokens
              WHERE account_id = ?1 AND user_id = ?2 AND kind = 'service' AND revoked_at IS NULL)
            AND (${targetAdmin}) IS NULL AND ${gone} AND ${mine}`,
			)
			.bind(input.accountId, input.userId, now),
		db
			.prepare(
				`INSERT INTO cadmus_audit (id, account_id, actor_user_id, actor_kind, action, target_account_id, target, data, at)
         SELECT '${opId}_' || t.id, ?1, ?3, '${actorKind}', 'token.revoke', ?1, t.id, '{}', ?4
           FROM cadmus_auth_tokens t
          WHERE t.account_id = ?1 AND t.user_id = ?2
            AND t.kind = 'service' AND t.revoked_at IS NULL
            AND (${targetAdmin}) IS NULL AND ${gone} AND ${mine}`,
			)
			.bind(input.accountId, input.userId, input.actor, now),
		db
			.prepare(
				`UPDATE cadmus_auth_tokens SET revoked_at = ?3
          WHERE account_id = ?1 AND user_id = ?2 AND kind = 'service' AND revoked_at IS NULL
            AND (${targetAdmin}) IS NULL AND ${gone} AND ${mine}`,
			)
			.bind(input.accountId, input.userId, now),
		db
			.prepare(
				`UPDATE cadmus_sessions SET revoked_at = ?3
          WHERE account_id = ?1 AND user_id = ?2 AND revoked_at IS NULL AND ${gone} AND ${mine}`,
			)
			.bind(input.accountId, input.userId, now),
	]);
	if ((results[0]?.meta?.changes ?? 0) === 0) {
		const still = await db
			.prepare(
				`SELECT 1 AS x FROM cadmus_account_members WHERE account_id = ?1 AND user_id = ?2`,
			)
			.bind(input.accountId, input.userId)
			.first();
		if (!still) {
			// A concurrent removal won; nothing more to do or audit.
			return { ok: true, changed: false, tokensRevoked: 0, sessionsRevoked: 0 };
		}
		return {
			ok: false,
			code: "conflict",
			message: "last_admin: the last account-admin cannot be removed",
		};
	}
	return {
		ok: true,
		changed: true,
		tokensRevoked: tokens,
		sessionsRevoked: sessions,
	};
}
