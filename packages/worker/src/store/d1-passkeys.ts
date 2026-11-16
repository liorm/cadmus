/**
 * Phase 7 passkey storage for `auth.passkeys.begin` and `auth.passkeys.finish`.
 *
 * Every effect is one D1 batch. D1 runs a batch as a single transaction, but a
 * statement that changes zero rows does not abort it, so each statement after
 * the first carries its own EXISTS predicate on the per-attempt marker written
 * by the compare-and-set. A later statement therefore cannot act on another
 * attempt's write. The caller checks the changes count of the effect
 * statement, not of the first one.
 *
 * A burned challenge can produce at most one effect. Each finish function first
 * claims the challenge by writing a fresh per-execution id into effect_exec
 * (only while it is NULL); every later statement requires that exact id. A
 * repeated call with the same attempt finds the challenge already claimed, so
 * its claim writes nothing and every later statement is gated out, even for a
 * counterless credential whose counter check would otherwise pass again.
 */
import { toBase64Url } from "../base64url.js";

export const PASSKEY_CHALLENGE_TTL_MS = 120_000;
/** Live (unconsumed, unexpired) challenges per user and purpose. */
export const MAX_LIVE_CHALLENGES = 5;
const PURGE_AFTER_EXPIRY_MS = 60 * 60 * 1000;
/** A passkey elevation lasts as long as the existing elevation window. */
export type ChallengePurpose = "register" | "elevate" | "remove";

const AUDIT_COLUMNS = `INSERT INTO cadmus_audit (id, account_id, actor_user_id, actor_kind, action, target_account_id, target, data, at)`;

const randomB64 = (bytes: number): string =>
	toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));

export interface RpBinding {
	id: string;
	origin: string;
}

/** A live user session for `userId` (never a token session). */
const LIVE_SESSION = (sessionParam: string, userParam: string, now: string) =>
	`EXISTS (SELECT 1 FROM cadmus_sessions s
      WHERE s.id = ${sessionParam} AND s.user_id = ${userParam}
        AND s.token_id IS NULL AND s.revoked_at IS NULL
        AND s.absolute_expires_at > ${now} AND s.idle_expires_at > ${now})`;

const LIVE_USER = (userParam: string) =>
	`EXISTS (SELECT 1 FROM cadmus_users u WHERE u.id = ${userParam} AND u.disabled_at IS NULL)`;

/**
 * Issues a challenge for a signed-in user session. Returns null when the
 * session or user is not live, or when the user already has the maximum number
 * of live challenges for this purpose. Rows expired for over an hour are
 * purged in the same batch.
 */
export async function issueChallenge(
	db: D1Database,
	input: {
		purpose: ChallengePurpose;
		userId: string;
		sessionId: string;
		rp: RpBinding;
		/** Required for remove: the user's active passkey login method to remove. */
		targetMethodId?: string;
		now?: number;
	},
): Promise<{ id: string; challenge: string; expiresAt: number } | null> {
	const now = input.now ?? Date.now();
	const id = `pkc_${randomB64(12)}`;
	const challenge = randomB64(32);
	const expiresAt = now + PASSKEY_CHALLENGE_TTL_MS;
	const [, insert] = await db.batch([
		db
			.prepare(`DELETE FROM cadmus_passkey_challenges WHERE expires_at < ?1`)
			.bind(now - PURGE_AFTER_EXPIRY_MS),
		db
			.prepare(
				`INSERT INTO cadmus_passkey_challenges
           (id, purpose, user_id, session_id, challenge, rp_id, origin, created_at, expires_at, target_method_id)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10
         WHERE ${LIVE_USER("?3")} AND ${LIVE_SESSION("?4", "?3", "?8")}
           AND (?2 <> 'remove' OR EXISTS (SELECT 1 FROM cadmus_passkeys p
                JOIN cadmus_login_methods m ON m.id = p.login_method_id
                WHERE p.login_method_id = ?10 AND p.user_id = ?3 AND m.revoked_at IS NULL))
           AND (?2 = 'remove' OR ?10 IS NULL)
           AND (SELECT COUNT(*) FROM cadmus_passkey_challenges
                WHERE user_id = ?3 AND purpose = ?2
                  AND consumed_at IS NULL AND expires_at > ?8) < ${MAX_LIVE_CHALLENGES}`,
			)
			.bind(
				id,
				input.purpose,
				input.userId,
				input.sessionId,
				challenge,
				input.rp.id,
				input.rp.origin,
				now,
				expiresAt,
				input.targetMethodId ?? null,
			),
	]);
	if ((insert?.meta?.changes ?? 0) === 0) return null;
	return { id, challenge, expiresAt };
}

/**
 * Burns a challenge for one verification attempt. Succeeds once per challenge,
 * only for the user and session it was issued to, before expiry, and only when
 * the configured relying party still equals the one stored at issue time.
 * Returns the challenge text, or null. The burn only gates verification: the
 * effect must still carry the attempt marker.
 */
export async function consumeChallenge(
	db: D1Database,
	input: {
		id: string;
		purpose: ChallengePurpose;
		userId: string;
		sessionId: string;
		rp: RpBinding;
		attemptId: string;
		now?: number;
	},
): Promise<string | null> {
	const now = input.now ?? Date.now();
	const row = await db
		.prepare(
			`UPDATE cadmus_passkey_challenges
       SET consumed_at = ?1, consumed_attempt_id = ?2
       WHERE id = ?3 AND purpose = ?4 AND user_id = ?5 AND session_id = ?6
         AND consumed_at IS NULL AND expires_at > ?1
         AND rp_id = ?7 AND origin = ?8
       RETURNING challenge`,
		)
		.bind(
			now,
			input.attemptId,
			input.id,
			input.purpose,
			input.userId,
			input.sessionId,
			input.rp.id,
			input.rp.origin,
		)
		.first<{ challenge: string }>();
	return row?.challenge ?? null;
}

export function newAttemptId(): string {
	return `pka_${randomB64(16)}`;
}

export interface StoredPasskey {
	loginMethodId: string;
	userId: string;
	credentialId: string;
	publicKey: string;
	counter: number;
	userHandle: string;
	transports: string[];
	deviceType: string;
	backedUp: boolean;
}

/** The active passkey for a credential id, or null when none or revoked. */
export async function getActivePasskey(
	db: D1Database,
	credentialId: string,
): Promise<StoredPasskey | null> {
	const row = await db
		.prepare(
			`SELECT p.login_method_id, p.user_id, p.credential_id, p.public_key, p.counter,
              p.user_handle, p.transports, p.device_type, p.backed_up
       FROM cadmus_passkeys p
       JOIN cadmus_login_methods m ON m.id = p.login_method_id
       WHERE p.credential_id = ?1 AND m.revoked_at IS NULL`,
		)
		.bind(credentialId)
		.first<{
			login_method_id: string;
			user_id: string;
			credential_id: string;
			public_key: string;
			counter: number;
			user_handle: string;
			transports: string;
			device_type: string;
			backed_up: number;
		}>();
	if (!row) return null;
	return {
		loginMethodId: row.login_method_id,
		userId: row.user_id,
		credentialId: row.credential_id,
		publicKey: row.public_key,
		counter: row.counter,
		userHandle: row.user_handle,
		transports: JSON.parse(row.transports) as string[],
		deviceType: row.device_type,
		backedUp: row.backed_up === 1,
	};
}

/**
 * The stable opaque handle for a user, assigned atomically on first use: the
 * UPDATE keeps an existing value, so concurrent first calls agree.
 */
export async function userHandleFor(
	db: D1Database,
	userId: string,
): Promise<string | null> {
	const [, row] = await db.batch([
		db
			.prepare(
				`UPDATE cadmus_users SET passkey_handle = COALESCE(passkey_handle, ?2) WHERE id = ?1`,
			)
			.bind(userId, randomB64(32)),
		db
			.prepare(`SELECT passkey_handle AS h FROM cadmus_users WHERE id = ?1`)
			.bind(userId),
	]);
	const rows = (row?.results ?? []) as { h: string | null }[];
	return rows[0]?.h ?? null;
}

export type RegisterResult =
	| { ok: true; loginMethodId: string }
	| { ok: false; reason: "refused" | "duplicate_credential" };

/**
 * Claims a burned challenge for exactly one effect by writing a fresh
 * per-execution id into effect_exec while it is still NULL. Every later
 * statement in the batch requires that id, which no other call can hold.
 */
const claim = (
	db: D1Database,
	purpose: ChallengePurpose,
	b: {
		exec: string;
		challengeId: string;
		attemptId: string;
		userId: string;
		sessionId: string;
		now: number;
	},
) =>
	db
		.prepare(
			`UPDATE cadmus_passkey_challenges SET effect_exec = ?1
       WHERE id = ?2 AND consumed_attempt_id = ?3 AND purpose = '${purpose}'
         AND user_id = ?4 AND session_id = ?5 AND effect_exec IS NULL
         AND ${LIVE_USER("?4")} AND ${LIVE_SESSION("?5", "?4", "?6")}
         ${purpose === "register" ? `AND ${ENROLL_AUTHORITY_SQL("?5", "?4", "?6")}` : ""}`,
		)
		.bind(b.exec, b.challengeId, b.attemptId, b.userId, b.sessionId, b.now);

const claimed = (challengeParam: string, execParam: string) =>
	`EXISTS (SELECT 1 FROM cadmus_passkey_challenges c
      WHERE c.id = ${challengeParam} AND c.effect_exec = ${execParam})`;

/**
 * Advances a passkey's signature counter by compare-and-set and records this
 * execution's attempt marker, gated on the claimed challenge, a live login
 * method, user, and session.
 */
const advancePasskeyCounter = (
	db: D1Database,
	purpose: Extract<ChallengePurpose, "elevate" | "remove">,
	b: {
		attemptId: string;
		sessionId: string;
		credentialId: string;
		now: number;
		newCounter: number;
		verifiedAgainstCounter: number;
		challengeId: string;
		exec: string;
	},
) =>
	db
		.prepare(
			`UPDATE cadmus_passkeys
       SET counter = ?5, last_used_at = ?4, last_attempt_id = ?8
       WHERE credential_id = ?3 AND counter = ?6
         AND EXISTS (SELECT 1 FROM cadmus_login_methods m
                     WHERE m.id = cadmus_passkeys.login_method_id AND m.revoked_at IS NULL)
         AND ${LIVE_USER("cadmus_passkeys.user_id")}
         AND ${LIVE_SESSION("?2", "cadmus_passkeys.user_id", "?4")}
         AND EXISTS (SELECT 1 FROM cadmus_passkey_challenges c
                     WHERE c.id = ?7 AND c.consumed_attempt_id = ?1 AND c.effect_exec = ?8
                       AND c.purpose = '${purpose}' AND c.session_id = ?2
                       AND c.user_id = cadmus_passkeys.user_id)`,
		)
		.bind(
			b.attemptId,
			b.sessionId,
			b.credentialId,
			b.now,
			b.newCounter,
			b.verifiedAgainstCounter,
			b.challengeId,
			b.exec,
		);

/**
 * Stores a verified registration. The effect is one batch: claim the burned
 * register challenge (single use), then insert the login method, the passkey
 * and an audit row, each gated on this execution's claim. A session revoked or
 * user disabled after verification, a repeated call with the same attempt, or
 * a different credential id on a repeated attempt all leave no rows. A
 * duplicate credential id aborts the batch and rolls everything back.
 */
export async function finishRegistration(
	db: D1Database,
	input: {
		attemptId: string;
		challengeId: string;
		userId: string;
		sessionId: string;
		accountId: string;
		credential: {
			id: string;
			publicKey: string;
			counter: number;
			transports: string[];
			deviceType: string;
			backedUp: boolean;
		};
		display: string;
		now?: number;
	},
): Promise<RegisterResult> {
	const now = input.now ?? Date.now();
	const methodId = `lm_${randomB64(12)}`;
	const exec = `pke_${randomB64(16)}`;
	try {
		const results = await db.batch([
			claim(db, "register", { ...input, exec, now }),
			db
				.prepare(
					`UPDATE cadmus_users SET passkey_handle = COALESCE(passkey_handle, ?2)
           WHERE id = ?1 AND ${claimed("?3", "?4")}`,
				)
				.bind(input.userId, randomB64(32), input.challengeId, exec),
			db
				.prepare(
					`INSERT INTO cadmus_login_methods
             (id, user_id, provider, subject, display, created_at, last_used_at)
           SELECT ?1, ?2, 'passkey', ?3, ?4, ?5, ?5
           WHERE ${claimed("?6", "?7")}`,
				)
				.bind(
					methodId,
					input.userId,
					input.credential.id,
					input.display,
					now,
					input.challengeId,
					exec,
				),
			db
				.prepare(
					`INSERT INTO cadmus_passkeys
             (login_method_id, user_id, credential_id, public_key, counter, user_handle,
              transports, device_type, backed_up, created_at)
           SELECT ?1, ?2, ?3, ?4, ?5, u.passkey_handle, ?6, ?7, ?8, ?9
           FROM cadmus_users u
           WHERE u.id = ?2 AND u.passkey_handle IS NOT NULL
             AND EXISTS (SELECT 1 FROM cadmus_login_methods
                         WHERE id = ?1 AND user_id = ?2 AND provider = 'passkey')`,
				)
				.bind(
					methodId,
					input.userId,
					input.credential.id,
					input.credential.publicKey,
					input.credential.counter,
					JSON.stringify(input.credential.transports),
					input.credential.deviceType,
					input.credential.backedUp ? 1 : 0,
					now,
				),
			db
				.prepare(
					`${AUDIT_COLUMNS}
           SELECT 'aud_' || lower(hex(randomblob(12))), ?1, ?2, 'user', 'auth.passkey.register', ?1, ?3,
                  json_object('credentialId', ?4), ?5
           WHERE EXISTS (SELECT 1 FROM cadmus_passkeys WHERE login_method_id = ?3)`,
				)
				.bind(
					input.accountId,
					input.userId,
					methodId,
					input.credential.id,
					now,
				),
			// Each elevation the first passkey ends is audited, then ended. The
			// audit runs first so it sees the sessions the next statement clears.
			db
				.prepare(
					`${AUDIT_COLUMNS}
           SELECT 'aud_' || lower(hex(randomblob(12))), account_id, user_id, 'user', 'auth.elevation.end', account_id, id,
                  json_object('reason', 'first_passkey', 'methodId', ?2), ?3
           FROM cadmus_sessions
           WHERE user_id = ?1 AND elevated_until IS NOT NULL
             AND EXISTS (SELECT 1 FROM cadmus_passkeys WHERE login_method_id = ?2)
             AND NOT EXISTS (SELECT 1 FROM cadmus_passkeys p
                             JOIN cadmus_login_methods m ON m.id = p.login_method_id
                             WHERE p.user_id = ?1 AND p.login_method_id <> ?2
                               AND m.revoked_at IS NULL)`,
				)
				.bind(input.userId, methodId, now),
			// The user's first passkey ends every elevation made without one, so
			// "elevated while a passkey exists" always means a passkey proved it.
			db
				.prepare(
					`UPDATE cadmus_sessions SET elevated_until = NULL
           WHERE user_id = ?1 AND elevated_until IS NOT NULL
             AND EXISTS (SELECT 1 FROM cadmus_passkeys WHERE login_method_id = ?2)
             AND NOT EXISTS (SELECT 1 FROM cadmus_passkeys p
                             JOIN cadmus_login_methods m ON m.id = p.login_method_id
                             WHERE p.user_id = ?1 AND p.login_method_id <> ?2
                               AND m.revoked_at IS NULL)`,
				)
				.bind(input.userId, methodId),
		]);
		// The passkey row, not the first statement, proves the effect landed.
		if ((results[3]?.meta?.changes ?? 0) === 0) {
			return { ok: false, reason: "refused" };
		}
		return { ok: true, loginMethodId: methodId };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (/UNIQUE constraint failed/i.test(message)) {
			return { ok: false, reason: "duplicate_credential" };
		}
		throw error;
	}
}

export type ElevateResult =
	| { ok: true; elevatedUntil: number }
	| { ok: false; reason: "refused" };

/**
 * Stores a verified elevation assertion. One batch: claim the burned elevate
 * challenge (single use); advance the counter by compare-and-set and write the
 * attempt marker, gated on the claim, a live method, user and session; then
 * elevate the session and audit it, each gated on this execution's claim AND
 * the credential's marker. A repeated call with the same attempt cannot claim
 * the challenge again, so it changes nothing, even for a counterless (0 to 0)
 * credential whose counter check would pass again.
 */
export async function finishElevation(
	db: D1Database,
	input: {
		attemptId: string;
		challengeId: string;
		credentialId: string;
		verifiedAgainstCounter: number;
		newCounter: number;
		sessionId: string;
		elevationMs: number;
		/** The selected account admin mode is enabled in (default: the session's own). */
		accountId?: string;
		now?: number;
	},
): Promise<ElevateResult> {
	const now = input.now ?? Date.now();
	const until = now + input.elevationMs;
	const exec = `pke_${randomB64(16)}`;
	const gate = `${claimed("?3", "?4")}
      AND EXISTS (SELECT 1 FROM cadmus_passkeys p
                  JOIN cadmus_login_methods m ON m.id = p.login_method_id
                  WHERE p.credential_id = ?5 AND p.last_attempt_id = ?6
                    AND p.user_id = s.user_id AND m.revoked_at IS NULL)
      AND ${LIVE_USER("s.user_id")}`;
	const owner = await db
		.prepare(
			`SELECT user_id AS u FROM cadmus_passkeys WHERE credential_id = ?1`,
		)
		.bind(input.credentialId)
		.first<{ u: string }>();
	if (!owner) return { ok: false, reason: "refused" };
	const results = await db.batch([
		claim(db, "elevate", {
			exec,
			challengeId: input.challengeId,
			attemptId: input.attemptId,
			userId: owner.u,
			sessionId: input.sessionId,
			now,
		}),
		advancePasskeyCounter(db, "elevate", {
			attemptId: input.attemptId,
			sessionId: input.sessionId,
			credentialId: input.credentialId,
			now,
			newCounter: input.newCounter,
			verifiedAgainstCounter: input.verifiedAgainstCounter,
			challengeId: input.challengeId,
			exec,
		}),
		db
			.prepare(
				`UPDATE cadmus_sessions AS s SET elevated_until = ?1, elevated_account_id = ?8
         WHERE s.id = ?2 AND s.revoked_at IS NULL AND s.token_id IS NULL
           AND s.absolute_expires_at > ?7 AND s.idle_expires_at > ?7
           AND ${gate}`,
			)
			.bind(
				until,
				input.sessionId,
				input.challengeId,
				exec,
				input.credentialId,
				exec,
				now,
				input.accountId ?? null,
			),
		db
			.prepare(
				`${AUDIT_COLUMNS}
         SELECT 'aud_' || lower(hex(randomblob(12))), COALESCE(?8, s.account_id), s.user_id, 'user', 'auth.elevate', COALESCE(?8, s.account_id), s.id,
                json_object('until', ?1, 'method', 'passkey'), ?7
         FROM cadmus_sessions s
         WHERE s.id = ?2 AND s.elevated_until = ?1 AND s.revoked_at IS NULL AND ${gate}`,
			)
			.bind(
				until,
				input.sessionId,
				input.challengeId,
				exec,
				input.credentialId,
				exec,
				now,
				input.accountId ?? null,
			),
	]);
	if ((results[2]?.meta?.changes ?? 0) === 0) {
		return { ok: false, reason: "refused" };
	}
	return { ok: true, elevatedUntil: until };
}

/** How recent the verified Google authentication must be to enroll a first passkey. */
export const FRESH_GOOGLE_MS = 5 * 60_000;
const FRESH_SKEW_MS = 60_000;

/**
 * SQL: the session is a user (non-token) session, live, created through an
 * active Google login method, and BOTH its creation and its verified Google
 * auth_time (cadmus_sessions.fresh_google_at, written only by the fresh
 * sign-in flow after the ID token's auth_time claim was checked) are within
 * FRESH_GOOGLE_MS, with auth_time not in the future beyond a small skew. The
 * normal login flow never writes fresh_google_at, so it never qualifies.
 */
const FRESH_GOOGLE_SQL = (sess: string, user: string, now: string) =>
	`EXISTS (SELECT 1 FROM cadmus_sessions s
      JOIN cadmus_login_methods m ON m.id = s.login_method_id
      WHERE s.id = ${sess} AND s.user_id = ${user} AND s.token_id IS NULL
        AND s.revoked_at IS NULL AND m.provider = 'google' AND m.revoked_at IS NULL
        AND s.created_at > ${now} - ${FRESH_GOOGLE_MS}
        AND s.fresh_google_at IS NOT NULL
        AND s.fresh_google_at > ${now} - ${FRESH_GOOGLE_MS}
        AND s.fresh_google_at <= ${now} + ${FRESH_SKEW_MS})`;

const ACTIVE_PASSKEY_SQL = (user: string) =>
	`EXISTS (SELECT 1 FROM cadmus_passkeys p
      JOIN cadmus_login_methods m ON m.id = p.login_method_id
      WHERE p.user_id = ${user} AND m.revoked_at IS NULL)`;

/**
 * SQL: who may enroll a passkey right now. With no active passkey, a verified
 * fresh Google authentication. With one, an elevated session; elevation is
 * only ever produced by a passkey while one exists (the first enrollment ends
 * earlier elevations and startElevation is closed). Evaluated inside the
 * effect batch, so a change between verification and effect refuses it.
 */
const ENROLL_AUTHORITY_SQL = (sess: string, user: string, now: string) =>
	`((NOT ${ACTIVE_PASSKEY_SQL(user)} AND ${FRESH_GOOGLE_SQL(sess, user, now)})
    OR (${ACTIVE_PASSKEY_SQL(user)}
        AND EXISTS (SELECT 1 FROM cadmus_sessions e
                    WHERE e.id = ${sess} AND e.user_id = ${user}
                      AND e.revoked_at IS NULL AND e.elevated_until > ${now})))`;

/** Pre-verification mirror of the fresh Google gate (the effect re-checks in SQL). */
export async function hasFreshGoogleLogin(
	db: D1Database,
	input: { sessionId: string; userId: string; now?: number },
): Promise<boolean> {
	const now = input.now ?? Date.now();
	const row = await db
		.prepare(`SELECT 1 AS x WHERE ${FRESH_GOOGLE_SQL("?1", "?2", "?3")}`)
		.bind(input.sessionId, input.userId, now)
		.first();
	return row !== null;
}

/** Pre-verification mirror of the enrollment authority (the effect re-checks in SQL). */
export async function canEnrollPasskey(
	db: D1Database,
	input: { sessionId: string; userId: string; now?: number },
): Promise<boolean> {
	const now = input.now ?? Date.now();
	const row = await db
		.prepare(`SELECT 1 AS x WHERE ${ENROLL_AUTHORITY_SQL("?1", "?2", "?3")}`)
		.bind(input.sessionId, input.userId, now)
		.first();
	return row !== null;
}

/** The user's active passkeys, for excludeCredentials and allowCredentials. */
export async function listActivePasskeys(
	db: D1Database,
	userId: string,
): Promise<{ id: string; transports: string[] }[]> {
	const { results } = await db
		.prepare(
			`SELECT p.credential_id, p.transports FROM cadmus_passkeys p
       JOIN cadmus_login_methods m ON m.id = p.login_method_id
       WHERE p.user_id = ?1 AND m.revoked_at IS NULL ORDER BY p.created_at`,
		)
		.bind(userId)
		.all<{ credential_id: string; transports: string }>();
	return results.map((r) => ({
		id: r.credential_id,
		transports: JSON.parse(r.transports) as string[],
	}));
}

/** Label shown by the authenticator: the user's primary email, else a fixed text. */
export async function passkeyUserLabel(
	db: D1Database,
	userId: string,
): Promise<string> {
	const row = await db
		.prepare(`SELECT primary_email AS e FROM cadmus_users WHERE id = ?1`)
		.bind(userId)
		.first<{ e: string | null }>();
	return row?.e ?? "Cadmus user";
}

/** True while the session's admin mode (elevation) is on. */
export async function isSessionElevated(
	db: D1Database,
	sessionId: string,
	now = Date.now(),
): Promise<boolean> {
	const row = await db
		.prepare(
			`SELECT 1 AS x FROM cadmus_sessions
       WHERE id = ?1 AND revoked_at IS NULL AND elevated_until > ?2`,
		)
		.bind(sessionId, now)
		.first();
	return row !== null;
}

export type RemoveResult =
	| { ok: true; methodId: string }
	| { ok: false; reason: "refused" };

/**
 * Removes one passkey after a verified passkey assertion. The method to remove
 * was fixed when the challenge was issued (target_method_id), never taken from
 * the finish call. One batch: claim the burned remove challenge (single use);
 * advance the proving credential's counter and write its attempt marker; revoke
 * the target method only while the user keeps another active login method;
 * end the sessions created through it; and, when no passkey is left, audit and
 * end every admin mode, since passkey proof no longer backs them. Each effect is
 * gated on this execution's claim and the credential's marker.
 */
export async function finishRemoval(
	db: D1Database,
	input: {
		attemptId: string;
		challengeId: string;
		credentialId: string;
		verifiedAgainstCounter: number;
		newCounter: number;
		sessionId: string;
		now?: number;
	},
): Promise<RemoveResult> {
	const now = input.now ?? Date.now();
	const exec = `pkr_${randomB64(16)}`;
	const owner = await db
		.prepare(
			`SELECT user_id AS u FROM cadmus_passkeys WHERE credential_id = ?1`,
		)
		.bind(input.credentialId)
		.first<{ u: string }>();
	if (!owner) return { ok: false, reason: "refused" };
	const sessionAccount = await db
		.prepare(`SELECT account_id AS a FROM cadmus_sessions WHERE id = ?1`)
		.bind(input.sessionId)
		.first<{ a: string }>();
	if (!sessionAccount) return { ok: false, reason: "refused" };
	const target = `(SELECT c.target_method_id FROM cadmus_passkey_challenges c
      WHERE c.id = ?1 AND c.effect_exec = ?2 AND c.purpose = 'remove')`;
	const proven = `${claimed("?1", "?2")}
      AND EXISTS (SELECT 1 FROM cadmus_passkeys p
                  JOIN cadmus_login_methods m ON m.id = p.login_method_id
                  WHERE p.credential_id = ?3 AND p.last_attempt_id = ?2
                    AND p.user_id = ?5 AND m.revoked_at IS NULL)`;
	// After the target is revoked the proving credential may be that very passkey,
	// so later statements check only the claim and the credential's marker.
	const provenAfter = `${claimed("?1", "?2")}
      AND EXISTS (SELECT 1 FROM cadmus_passkeys p
                  WHERE p.credential_id = ?3 AND p.last_attempt_id = ?2
                    AND p.user_id = ?5)`;
	const noneLeft = `NOT EXISTS (SELECT 1 FROM cadmus_passkeys p
      JOIN cadmus_login_methods m ON m.id = p.login_method_id
      WHERE p.user_id = ?5 AND m.revoked_at IS NULL)`;
	// Params: ?1 challenge, ?2 exec, ?3 credential, ?4 attempt, ?5 user, ?6 now.
	const bind = (st: D1PreparedStatement) =>
		st.bind(
			input.challengeId,
			exec,
			input.credentialId,
			input.attemptId,
			owner.u,
			now,
		);
	const results = await db.batch([
		claim(db, "remove", {
			exec,
			challengeId: input.challengeId,
			attemptId: input.attemptId,
			userId: owner.u,
			sessionId: input.sessionId,
			now,
		}),
		advancePasskeyCounter(db, "remove", {
			attemptId: input.attemptId,
			sessionId: input.sessionId,
			credentialId: input.credentialId,
			now,
			newCounter: input.newCounter,
			verifiedAgainstCounter: input.verifiedAgainstCounter,
			challengeId: input.challengeId,
			exec,
		}),
		bind(
			db.prepare(
				`UPDATE cadmus_login_methods SET revoked_at = ?6
         WHERE id = ${target} AND user_id = ?5 AND revoked_at IS NULL
           AND EXISTS (SELECT 1 FROM cadmus_passkeys WHERE login_method_id = cadmus_login_methods.id)
           AND (SELECT COUNT(*) FROM cadmus_login_methods
                 WHERE user_id = ?5 AND revoked_at IS NULL) > 1
           AND ${proven}`,
			),
		),
		// Fence owned by this call: true only when the statement above, which
		// runs immediately before this one, changed a row. Later effects key on
		// it, not on a timestamp that another call could also match.
		db
			.prepare(
				`UPDATE cadmus_passkey_challenges SET removed_exec = ?2
         WHERE id = ?1 AND effect_exec = ?2 AND removed_exec IS NULL AND changes() > 0`,
			)
			.bind(input.challengeId, exec),
		bind(
			db.prepare(
				`UPDATE cadmus_sessions SET revoked_at = ?6
         WHERE login_method_id = ${target} AND revoked_at IS NULL
           AND EXISTS (SELECT 1 FROM cadmus_passkey_challenges f WHERE f.id = ?1 AND f.removed_exec = ?2)
           AND ${provenAfter}`,
			),
		),
		db
			.prepare(
				`${AUDIT_COLUMNS}
         SELECT 'aud_' || lower(hex(randomblob(12))), ?7, ?5, 'user', 'auth.passkey.remove', ?7, ${target},
                json_object('proof', ?3), ?6
         WHERE EXISTS (SELECT 1 FROM cadmus_passkey_challenges f WHERE f.id = ?1 AND f.removed_exec = ?2)
           AND ${provenAfter}`,
			)
			.bind(
				input.challengeId,
				exec,
				input.credentialId,
				input.attemptId,
				owner.u,
				now,
				sessionAccount.a,
			),
		bind(
			db.prepare(
				`${AUDIT_COLUMNS}
         SELECT 'aud_' || lower(hex(randomblob(12))), account_id, user_id, 'user', 'auth.elevation.end', account_id, id,
                json_object('reason', 'last_passkey_removed', 'methodId', ${target}), ?6
         FROM cadmus_sessions
         WHERE user_id = ?5 AND elevated_until IS NOT NULL
           AND EXISTS (SELECT 1 FROM cadmus_passkey_challenges f WHERE f.id = ?1 AND f.removed_exec = ?2)
           AND ${noneLeft} AND ${provenAfter}`,
			),
		),
		bind(
			db.prepare(
				`UPDATE cadmus_sessions SET elevated_until = NULL
         WHERE user_id = ?5 AND elevated_until IS NOT NULL AND ?6 IS NOT NULL
           AND EXISTS (SELECT 1 FROM cadmus_passkey_challenges f WHERE f.id = ?1 AND f.removed_exec = ?2)
           AND ${noneLeft} AND ${provenAfter}`,
			),
		),
	]);
	if ((results[2]?.meta?.changes ?? 0) === 0) {
		return { ok: false, reason: "refused" };
	}
	const row = await db
		.prepare(
			`SELECT target_method_id AS t FROM cadmus_passkey_challenges WHERE id = ?1`,
		)
		.bind(input.challengeId)
		.first<{ t: string }>();
	return { ok: true, methodId: row?.t ?? "" };
}
