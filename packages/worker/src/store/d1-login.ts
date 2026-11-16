import { SYSTEM_ACCOUNT_ID } from "@cadmus/contract/grants";
import type { LoginIdentity } from "../auth/google.js";
import { createSession, type SessionTokens } from "./d1-sessions.js";
import { randomId } from "./random-id.js";

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
	invite: { id: string; account_id: string; role: string },
	userId: string,
	now: number,
): D1PreparedStatement[] {
	const pending = `EXISTS (SELECT 1 FROM cadmus_invites WHERE id = ?1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?5)`;
	return [
		db
			.prepare(
				`INSERT OR IGNORE INTO cadmus_account_members (account_id, user_id, role, created_at)
         SELECT ?2, ?3, ?4, ?5 WHERE ${pending}`,
			)
			.bind(invite.id, invite.account_id, userId, invite.role, now),
		db
			.prepare(
				`INSERT INTO cadmus_audit (id, account_id, actor_user_id, actor_kind, action, target_account_id, target, data, at)
         SELECT ?6, ?2, ?3, 'user', 'invite.accept', ?2, ?3, ?7, ?5 WHERE ${pending}`,
			)
			.bind(
				invite.id,
				invite.account_id,
				userId,
				invite.role,
				now,
				randomId("aud_", LOGIN_ID_BYTES),
				JSON.stringify({ inviteId: invite.id }),
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
	| { ok: true; tokens: SessionTokens; userId: string; accountId: string }
	| {
			ok: false;
			code:
				| "not_invited"
				| "login_method_revoked"
				| "user_disabled"
				| "account_suspended";
	  };

interface MembershipRow {
	account_id: string;
	status: string;
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
				`SELECT m.account_id, a.status
         FROM cadmus_account_members m
         JOIN cadmus_accounts a ON a.id = m.account_id
         LEFT JOIN (
           SELECT account_id, MAX(last_used_at) AS last_used
           FROM cadmus_sessions WHERE user_id = ?1 GROUP BY account_id
         ) s ON s.account_id = m.account_id
         WHERE m.user_id = ?1 AND a.status = 'active'
         ORDER BY MAX(COALESCE(m.last_used_at, 0), COALESCE(s.last_used, 0)) DESC, m.created_at ASC
         LIMIT 1`,
			)
			.bind(userId)
			.first<MembershipRow>()) ?? undefined
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
		now?: number;
		/** Test seam: runs between reading pending invites and writing the batch. */
		beforeWrite?: () => Promise<void>;
	} = {},
): Promise<LoginResult> {
	const now = options.now ?? Date.now();
	const email = identity.email.trim().toLowerCase();
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
		// An existing user can be invited to another account. Accept pending
		// invites for the verified email so re-invites work for known logins.
		if (identity.emailVerified) {
			const pending = await db
				.prepare(
					`SELECT id, account_id, role FROM cadmus_invites
           WHERE email = ?1 AND accepted_at IS NULL AND revoked_at IS NULL
             AND expires_at > ?2`,
				)
				.bind(email, now)
				.all<{ id: string; account_id: string; role: string }>();
			const accept = pending.results.flatMap((invite) =>
				acceptInvite(db, invite, userId, now),
			);
			await options.beforeWrite?.();
			if (accept.length > 0) await db.batch(accept);
		}
	} else {
		const bootstrap = options.bootstrapEmail?.trim().toLowerCase();
		const claimed = await db
			.prepare(`SELECT 1 AS x FROM cadmus_bootstrap WHERE id = 1`)
			.first<{ x: number }>();
		const invites = await db
			.prepare(
				`SELECT id, account_id, role FROM cadmus_invites
         WHERE email = ?1 AND accepted_at IS NULL AND revoked_at IS NULL
           AND expires_at > ?2`,
			)
			.bind(email, now)
			.all<{ id: string; account_id: string; role: string }>();
		const isBootstrap = !!bootstrap && email === bootstrap && !claimed;
		if (!isBootstrap && invites.results.length === 0) {
			return { ok: false, code: "not_invited" };
		}
		userId = randomId("usr_", LOGIN_ID_BYTES);
		methodId = randomId("lm_", LOGIN_ID_BYTES);
		// Invite-only sign-ups write the user and method only while an invite for
		// this email is still pending at write time, so a revoke (or a competing
		// acceptance) that lands first leaves no orphan rows.
		// The gate looks at the same preselected invite ids that get accepted
		// below, so a replacement invite cannot satisfy it for a claim that fails.
		const inviteIds = invites.results.map((invite) => invite.id);
		const idSlots = inviteIds.map((_, i) => `?${i + 5}`).join(", ");
		const gate = isBootstrap
			? "1"
			: `EXISTS (SELECT 1 FROM cadmus_invites WHERE id IN (${idSlots}) AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?4)`;
		const statements = [
			db
				.prepare(
					`INSERT INTO cadmus_users (id, name, email, primary_email, created_at)
           SELECT ?1, ?2, ?3, ?3, ?4 WHERE ${gate}`,
				)
				.bind(
					userId,
					identity.display ?? email,
					email,
					now,
					...(isBootstrap ? [] : inviteIds),
				),
			db
				.prepare(
					`INSERT INTO cadmus_login_methods
             (id, user_id, provider, subject, display, created_at, last_used_at)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?6
           WHERE EXISTS (SELECT 1 FROM cadmus_users WHERE id = ?2)`,
				)
				.bind(
					methodId,
					userId,
					identity.provider,
					identity.subject,
					email,
					now,
				),
		];
		const audit = (action: string, accountId: string, data: object) =>
			db
				.prepare(
					`INSERT INTO cadmus_audit (id, account_id, actor_user_id, actor_kind, action, target_account_id, target, data, at)
           VALUES (?1, ?2, ?3, 'user', ?4, ?2, ?3, ?5, ?6)`,
				)
				.bind(
					randomId("aud_", LOGIN_ID_BYTES),
					accountId,
					userId,
					action,
					JSON.stringify(data),
					now,
				);
		if (isBootstrap) {
			statements.push(
				db
					.prepare(
						`INSERT INTO cadmus_bootstrap (id, claimed_at, user_id) VALUES (1, ?1, ?2)`,
					)
					.bind(now, userId),
				db
					.prepare(
						`INSERT INTO cadmus_account_members (account_id, user_id, role, created_at)
             VALUES (?1, ?2, 'super-admin', ?3)`,
					)
					.bind(SYSTEM_ACCOUNT_ID, userId, now),
				audit("bootstrap.claim", SYSTEM_ACCOUNT_ID, { email }),
			);
		}
		for (const invite of invites.results) {
			statements.push(...acceptInvite(db, invite, userId, now));
		}
		await options.beforeWrite?.();
		try {
			await db.batch(statements);
		} catch (error) {
			// Two first sign-ins with the bootstrap email can both pass the read of
			// `claimed` above. The one-row cadmus_bootstrap claim in the batch is
			// the atomic step: only one batch commits and the batch leaves no rows
			// behind when it fails. A loser is told apart by state, not by error
			// text: the claim now belongs to another user. It is refused like any
			// uninvited sign-in. Any other failure is rethrown.
			if (isBootstrap) {
				const claim = await db
					.prepare(`SELECT user_id FROM cadmus_bootstrap WHERE id = 1`)
					.first<{ user_id: string }>();
				if (claim && claim.user_id !== userId) {
					return { ok: false, code: "not_invited" };
				}
			}
			throw error;
		}
		const created = await db
			.prepare(`SELECT 1 AS x FROM cadmus_users WHERE id = ?1`)
			.bind(userId)
			.first<{ x: number }>();
		if (!created) return { ok: false, code: "not_invited" };
	}

	const account = await pickAccount(db, userId);
	if (!account) return { ok: false, code: "account_suspended" };
	const tokens = await createSession(db, {
		userId,
		accountId: account.account_id,
		loginMethodId: methodId,
		freshGoogleAt: options.freshGoogleAt,
		userAgent: options.userAgent,
		ipCountry: options.ipCountry,
		now,
	});
	return { ok: true, tokens, userId, accountId: account.account_id };
}

export type LinkMethodResult =
	| { ok: true; methodId: string; alreadyLinked: boolean }
	| {
			ok: false;
			code:
				| "method_in_use"
				| "login_method_revoked"
				| "user_disabled"
				| "session_ended";
	  };

/**
 * Attaches a verified provider identity to an existing user. The identity
 * (provider, subject) is the only key: an email match never merges users, and
 * an identity that already belongs to another user is refused. The session that
 * started the link must still be a live user session of that user, at the
 * callback and again at the write. A new link is audited as `method.link` in the account of the initiating session (the session row always carries one, so a user without a current membership is audited too).
 */
export async function linkLoginMethod(
	db: D1Database,
	userId: string,
	sessionId: string,
	identity: LoginIdentity,
	now = Date.now(),
): Promise<LinkMethodResult> {
	const liveSession = `SELECT 1 FROM cadmus_sessions
       WHERE id = ?7 AND user_id = ?2 AND token_id IS NULL AND revoked_at IS NULL
         AND idle_expires_at > ?6 AND absolute_expires_at > ?6`;
	const live = await db
		.prepare(
			`SELECT 1 AS x FROM cadmus_sessions
       WHERE id = ?1 AND user_id = ?2 AND token_id IS NULL AND revoked_at IS NULL
         AND idle_expires_at > ?3 AND absolute_expires_at > ?3`,
		)
		.bind(sessionId, userId, now)
		.first<{ x: number }>();
	if (!live) return { ok: false, code: "session_ended" };
	const user = await db
		.prepare(`SELECT disabled_at FROM cadmus_users WHERE id = ?1`)
		.bind(userId)
		.first<{ disabled_at: number | null }>();
	if (!user || user.disabled_at !== null) {
		return { ok: false, code: "user_disabled" };
	}
	const existing = await db
		.prepare(
			`SELECT id, user_id, revoked_at FROM cadmus_login_methods
       WHERE provider = ?1 AND subject = ?2`,
		)
		.bind(identity.provider, identity.subject)
		.first<{ id: string; user_id: string; revoked_at: number | null }>();
	if (existing) {
		if (existing.user_id !== userId)
			return { ok: false, code: "method_in_use" };
		if (existing.revoked_at !== null) {
			return { ok: false, code: "login_method_revoked" };
		}
		return { ok: true, methodId: existing.id, alreadyLinked: true };
	}
	const methodId = randomId("lm_", LOGIN_ID_BYTES);
	// The unique (provider, subject) key and the NOT EXISTS settle a race between
	// two links; the liveness check runs again inside the write.
	const [res] = await db.batch([
		db
			.prepare(
				`INSERT INTO cadmus_login_methods
         (id, user_id, provider, subject, display, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6
       WHERE NOT EXISTS (
         SELECT 1 FROM cadmus_login_methods WHERE provider = ?3 AND subject = ?4)
         AND EXISTS (${liveSession})`,
			)
			.bind(
				methodId,
				userId,
				identity.provider,
				identity.subject,
				identity.email.trim().toLowerCase(),
				now,
				sessionId,
			),
		db
			.prepare(
				`INSERT INTO cadmus_audit (id, account_id, actor_user_id, actor_kind, action, target_account_id, target, data, at)
         SELECT 'aud_' || lower(hex(randomblob(12))), a.account_id, ?2, 'user', 'method.link', a.account_id, ?1, json_object('provider', ?3), ?4
         FROM (SELECT account_id FROM cadmus_sessions WHERE id = ?5 AND user_id = ?2) a
         WHERE EXISTS (SELECT 1 FROM cadmus_login_methods WHERE id = ?1 AND user_id = ?2 AND created_at = ?4)`,
			)
			.bind(methodId, userId, identity.provider, now, sessionId),
	]);
	if (!res?.meta?.changes) {
		const stillLive = await db
			.prepare(
				`SELECT 1 AS x FROM cadmus_sessions
         WHERE id = ?1 AND user_id = ?2 AND token_id IS NULL AND revoked_at IS NULL
           AND idle_expires_at > ?3 AND absolute_expires_at > ?3`,
			)
			.bind(sessionId, userId, now)
			.first<{ x: number }>();
		return { ok: false, code: stillLive ? "method_in_use" : "session_ended" };
	}
	return { ok: true, methodId, alreadyLinked: false };
}
