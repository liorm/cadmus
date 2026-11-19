import type { Role } from "@cadmus/contract/grants";
import type { LoginIdentity } from "../auth/google.js";
import { createSession, type SessionTokens } from "./d1-sessions.js";
import { randomId } from "./random-id.js";
import { parseStoredRoles, ROLE_RANK_SQL } from "./roles.js";
import { normalizeLoginEmail } from "./user-emails.js";

/** Login rows use 12 random bytes. Other stores use the 8-byte default. */
const LOGIN_ID_BYTES = 12;

/**
 * Accepts one invite atomically. The batch runs as one serialized transaction:
 * the membership and audit rows are written only while the invite is still
 * pending (unaccepted, unrevoked, unexpired), and only then is it marked
 * accepted. A later competing acceptance, or a revoke that landed first, finds
 * the invite no longer pending and writes nothing, so the first writer wins
 * and exactly one user gets the membership.
 */
export function acceptInvite(
	db: D1Database,
	invite: { id: string; account_id: string; roles: string },
	userId: string,
	now: number,
): D1PreparedStatement[] {
	const pendingAt = (at: string) =>
		`EXISTS (SELECT 1 FROM cadmus_invites WHERE id = ?1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ${at})`;
	const roles = parseStoredRoles(invite.roles);
	const stored = roles.length > 0 ? roles : (["user"] as Role[]);
	return [
		db
			.prepare(
				`INSERT OR IGNORE INTO cadmus_account_members (account_id, user_id, created_at)
         SELECT ?2, ?3, ?4 WHERE ${pendingAt("?4")}`,
			)
			.bind(invite.id, invite.account_id, userId, now),
		...stored.map((role) =>
			db
				.prepare(
					`INSERT OR IGNORE INTO cadmus_member_roles (account_id, user_id, role, created_at)
           SELECT ?2, ?3, ?4, ?5 WHERE ${pendingAt("?5")}`,
				)
				.bind(invite.id, invite.account_id, userId, role, now),
		),
		db
			.prepare(
				`INSERT INTO cadmus_audit (id, account_id, actor_user_id, actor_kind, action, target_account_id, target, data, at)
         SELECT ?5, ?2, ?3, 'user', 'invite.accept', ?2, ?3, ?6, ?4 WHERE ${pendingAt("?4")}`,
			)
			.bind(
				invite.id,
				invite.account_id,
				userId,
				now,
				randomId("aud_", LOGIN_ID_BYTES),
				JSON.stringify({ inviteId: invite.id, roles: stored }),
			),
		db
			.prepare(
				`UPDATE cadmus_invites SET accepted_at = ?2
          WHERE id = ?1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?2`,
			)
			.bind(invite.id, now),
	];
}

export type LoginResult =
	| {
			ok: true;
			tokens: SessionTokens;
			userId: string;
			accountId: string;
			provisional?: boolean;
	  }
	| {
			ok: false;
			code:
				| "not_invited"
				| "email_not_verified"
				| "login_method_revoked"
				| "method_in_use"
				| "user_disabled"
				| "account_suspended";
	  };

interface MembershipRow {
	account_id: string;
	status: string;
	role: string;
}

async function acceptPendingInvites(
	db: D1Database,
	email: string,
	userId: string,
	now: number,
	beforeWrite?: () => Promise<void>,
): Promise<void> {
	const pending = await db
		.prepare(
			`SELECT id, account_id, roles FROM cadmus_invites
       WHERE email = ?1 AND accepted_at IS NULL AND revoked_at IS NULL
         AND expires_at > ?2`,
		)
		.bind(email, now)
		.all<{ id: string; account_id: string; roles: string }>();
	const accept = pending.results.flatMap((invite) =>
		acceptInvite(db, invite, userId, now),
	);
	await beforeWrite?.();
	if (accept.length > 0) await db.batch(accept);
}

async function pickAccount(
	db: D1Database,
	userId: string,
): Promise<MembershipRow | undefined> {
	// Most recently used account first (an explicit selection or a session),
	// then the oldest membership.
	return (
		(await db
			.prepare(
				`SELECT m.account_id, a.status, r.role
         FROM cadmus_account_members m
         JOIN cadmus_accounts a ON a.id = m.account_id
         JOIN cadmus_member_roles r ON r.account_id = m.account_id AND r.user_id = m.user_id
         LEFT JOIN (
           SELECT account_id, MAX(last_used_at) AS last_used
           FROM cadmus_sessions WHERE user_id = ?1 GROUP BY account_id
         ) s ON s.account_id = m.account_id
         WHERE m.user_id = ?1 AND a.status = 'active'
         ORDER BY ${ROLE_RANK_SQL.replaceAll("role", "r.role")} ASC,
                  MAX(COALESCE(m.last_used_at, 0), COALESCE(s.last_used, 0)) DESC,
                  m.created_at ASC
         LIMIT 1`,
			)
			.bind(userId)
			.first<MembershipRow & { role: string }>()) ?? undefined
	);
}

/**
 * Applies the first-sign-in rules from issue #3 and starts a session:
 * 1. a known, active login method signs its user in;
 * 2. the bootstrap email, with no claim marker yet, becomes super-admin in the
 *    system account (one-shot, audited);
 * 3. a pending invite for the verified email creates the user, links the
 *    method and accepts every pending invite for that email, in one batch;
 * 4. anything else is `not_invited` and creates no rows.
 */
export async function completeLogin(
	db: D1Database,
	identity: LoginIdentity,
	options: {
		bootstrapEmail?: string;
		userAgent?: string;
		ipCountry?: string;
		/** Verified Google auth_time (epoch ms) from a fresh sign-in flow. */
		freshGoogleAt?: number;
		chooseRole?: boolean;
		now?: number;
		/** Test seam: runs between reading pending invites and writing the batch. */
		beforeWrite?: () => Promise<void>;
	} = {},
): Promise<LoginResult> {
	const now = options.now ?? Date.now();
	const email = normalizeLoginEmail(identity.email);
	if (!identity.emailVerified || !email) {
		return { ok: false, code: "email_not_verified" };
	}
	const method = await db
		.prepare(
			`SELECT id, user_id, revoked_at FROM cadmus_login_methods
       WHERE provider = ?1 AND subject = ?2`,
		)
		.bind(identity.provider, identity.subject)
		.first<{ id: string; user_id: string; revoked_at: number | null }>();

	let userId: string;
	let methodId: string;
	if (method) {
		if (method.revoked_at !== null) {
			return { ok: false, code: "login_method_revoked" };
		}
		const user = await db
			.prepare(`SELECT disabled_at FROM cadmus_users WHERE id = ?1`)
			.bind(method.user_id)
			.first<{ disabled_at: number | null }>();
		if (!user || user.disabled_at !== null) {
			return { ok: false, code: "user_disabled" };
		}
		userId = method.user_id;
		methodId = method.id;
		await db
			.prepare(
				`UPDATE cadmus_login_methods SET last_used_at = ?2 WHERE id = ?1`,
			)
			.bind(methodId, now)
			.run();
		// A later address on the same subject is not a second login key and does
		// not accept invites that belong to a different user.
		const ownsEmail = await db
			.prepare(
				`SELECT 1 AS x FROM cadmus_user_emails WHERE email = ?1 AND user_id = ?2`,
			)
			.bind(email, userId)
			.first<{ x: number }>();
		if (ownsEmail) {
			await acceptPendingInvites(db, email, userId, now, options.beforeWrite);
		}
	} else {
		const owner = await db
			.prepare(`SELECT user_id FROM cadmus_user_emails WHERE email = ?1`)
			.bind(email)
			.first<{ user_id: string }>();
		if (!owner) return { ok: false, code: "not_invited" };
		const user = await db
			.prepare(`SELECT disabled_at FROM cadmus_users WHERE id = ?1`)
			.bind(owner.user_id)
			.first<{ disabled_at: number | null }>();
		if (!user || user.disabled_at !== null) {
			return { ok: false, code: "user_disabled" };
		}
		userId = owner.user_id;
		methodId = randomId("lm_", LOGIN_ID_BYTES);
		const invites = await db
			.prepare(
				`SELECT id, account_id, roles FROM cadmus_invites
         WHERE email = ?1 AND accepted_at IS NULL AND revoked_at IS NULL
           AND expires_at > ?2`,
			)
			.bind(email, now)
			.all<{ id: string; account_id: string; roles: string }>();
		const statements: D1PreparedStatement[] = [
			db
				.prepare(
					`INSERT INTO cadmus_login_methods
             (id, user_id, provider, subject, display, created_at, last_used_at)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?6
           WHERE NOT EXISTS (
             SELECT 1 FROM cadmus_login_methods WHERE provider = ?3 AND subject = ?4
           )`,
				)
				.bind(
					methodId,
					userId,
					identity.provider,
					identity.subject,
					email,
					now,
				),
			db
				.prepare(
					`INSERT INTO cadmus_audit (id, account_id, actor_user_id, actor_kind, action, target_account_id, target, data, at)
           SELECT ?1, COALESCE(
             (SELECT account_id FROM cadmus_account_members WHERE user_id = ?2 LIMIT 1),
             (SELECT account_id FROM cadmus_invites WHERE email = ?3 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?4 LIMIT 1)
           ), ?2, 'user', 'method.associate', COALESCE(
             (SELECT account_id FROM cadmus_account_members WHERE user_id = ?2 LIMIT 1),
             (SELECT account_id FROM cadmus_invites WHERE email = ?3 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?4 LIMIT 1)
           ), ?5, ?6, ?4
           WHERE EXISTS (SELECT 1 FROM cadmus_login_methods WHERE id = ?5)
             AND COALESCE(
               (SELECT account_id FROM cadmus_account_members WHERE user_id = ?2 LIMIT 1),
               (SELECT account_id FROM cadmus_invites WHERE email = ?3 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?4 LIMIT 1)
             ) IS NOT NULL`,
				)
				.bind(
					randomId("aud_", LOGIN_ID_BYTES),
					userId,
					email,
					now,
					methodId,
					JSON.stringify({ provider: identity.provider }),
				),
		];
		for (const invite of invites.results) {
			statements.push(...acceptInvite(db, invite, userId, now));
		}
		await options.beforeWrite?.();
		try {
			await db.batch(statements);
		} catch (error) {
			const raced = await db
				.prepare(
					`SELECT id, user_id, revoked_at FROM cadmus_login_methods
           WHERE provider = ?1 AND subject = ?2`,
				)
				.bind(identity.provider, identity.subject)
				.first<{ id: string; user_id: string; revoked_at: number | null }>();
			if (!raced) throw error;
			if (raced.revoked_at !== null) {
				return { ok: false, code: "login_method_revoked" };
			}
			if (raced.user_id !== userId) return { ok: false, code: "method_in_use" };
			methodId = raced.id;
		}
		const attached = await db
			.prepare(
				`SELECT id, user_id, revoked_at FROM cadmus_login_methods
         WHERE provider = ?1 AND subject = ?2`,
			)
			.bind(identity.provider, identity.subject)
			.first<{ id: string; user_id: string; revoked_at: number | null }>();
		if (!attached || attached.revoked_at !== null) {
			return { ok: false, code: "login_method_revoked" };
		}
		if (attached.user_id !== userId)
			return { ok: false, code: "method_in_use" };
		methodId = attached.id;
	}

	const account = await pickAccount(db, userId);
	if (!account) return { ok: false, code: "account_suspended" };
	const hats = await db
		.prepare(
			`SELECT COUNT(*) AS n FROM cadmus_member_roles r
         JOIN cadmus_accounts a ON a.id = r.account_id AND a.status = 'active'
        WHERE r.user_id = ?1`,
		)
		.bind(userId)
		.first<{ n: number }>();
	const provisional = options.chooseRole === true && (hats?.n ?? 0) > 1;
	const tokens = await createSession(db, {
		userId,
		accountId: account.account_id,
		activeRole: parseStoredRoles(JSON.stringify([account.role]))[0],
		loginMethodId: methodId,
		freshGoogleAt: options.freshGoogleAt,
		userAgent: options.userAgent,
		ipCountry: options.ipCountry,
		provisional,
		now,
	});
	return {
		ok: true,
		tokens,
		userId,
		accountId: account.account_id,
		...(provisional ? { provisional: true } : {}),
	};
}
