import { randomId } from "./random-id.js";

const USER_ID_BYTES = 12;

/** Trim and lowercase. Dots and plus-tags stay; they are part of the address. */
export function normalizeLoginEmail(email: string): string {
	return email.trim().toLowerCase();
}

export function isLoginEmail(email: string): boolean {
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/**
 * Statements that insert a user and a primary email when the address is new.
 * A later statement in the same batch can read the row. When the address
 * already exists, the statements insert nothing.
 */
export function insertPrimaryUserStatements(
	db: D1Database,
	email: string,
	name: string,
	now: number,
	userId = randomId("usr_", USER_ID_BYTES),
): { userId: string; statements: D1PreparedStatement[] } {
	return {
		userId,
		statements: [
			db
				.prepare(
					`INSERT INTO cadmus_users (id, name, email, primary_email, created_at)
           SELECT ?1, ?2, ?3, ?3, ?4
           WHERE NOT EXISTS (SELECT 1 FROM cadmus_user_emails WHERE email = ?3)`,
				)
				.bind(userId, name, email, now),
			db
				.prepare(
					`INSERT INTO cadmus_user_emails (email, user_id, kind)
           SELECT ?1, ?2, 'primary'
           WHERE EXISTS (SELECT 1 FROM cadmus_users WHERE id = ?2)
             AND NOT EXISTS (SELECT 1 FROM cadmus_user_emails WHERE email = ?1)`,
				)
				.bind(email, userId),
		],
	};
}

export async function userIdForEmail(
	db: D1Database,
	email: string,
): Promise<string | undefined> {
	const row = await db
		.prepare(`SELECT user_id FROM cadmus_user_emails WHERE email = ?1`)
		.bind(email)
		.first<{ user_id: string }>();
	return row?.user_id;
}

/**
 * Deletes a pre-login user when they have no login method, no membership, and
 * no other pending invite. The email row goes with them.
 */
export async function deleteUnclaimedPreloginUser(
	db: D1Database,
	email: string,
	now: number,
): Promise<void> {
	const userId = await userIdForEmail(db, email);
	if (!userId) return;
	const methods = await db
		.prepare(
			`SELECT COUNT(*) AS n FROM cadmus_login_methods WHERE user_id = ?1`,
		)
		.bind(userId)
		.first<{ n: number }>();
	const members = await db
		.prepare(
			`SELECT COUNT(*) AS n FROM cadmus_account_members WHERE user_id = ?1`,
		)
		.bind(userId)
		.first<{ n: number }>();
	const invites = await db
		.prepare(
			`SELECT COUNT(*) AS n FROM cadmus_invites
       WHERE email IN (SELECT email FROM cadmus_user_emails WHERE user_id = ?1)
         AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ?2`,
		)
		.bind(userId, now)
		.first<{ n: number }>();
	if ((methods?.n ?? 0) > 0 || (members?.n ?? 0) > 0 || (invites?.n ?? 0) > 0) {
		return;
	}
	await db.batch([
		db
			.prepare(`DELETE FROM cadmus_user_emails WHERE user_id = ?1`)
			.bind(userId),
		db
			.prepare(
				`DELETE FROM cadmus_users WHERE id = ?1
         AND NOT EXISTS (SELECT 1 FROM cadmus_login_methods WHERE user_id = ?1)
         AND NOT EXISTS (SELECT 1 FROM cadmus_account_members WHERE user_id = ?1)`,
			)
			.bind(userId),
	]);
}
