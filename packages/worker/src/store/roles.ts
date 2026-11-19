import { ROLES, type Role, roleRank } from "@cadmus/contract/grants";

/** Caps access, idle, and absolute expiry of a role-choice session. Not Elevate. */
export const ROLE_CHOICE_SESSION_MS = 15 * 60 * 1000;

const RANK_SQL = `CASE role WHEN 'user' THEN 0 WHEN 'account-admin' THEN 1 WHEN 'super-admin' THEN 2 ELSE 9 END`;

/** Lowest stored role first. Unknown names are dropped. */
export function parseStoredRoles(raw: string | null | undefined): Role[] {
	let parsed: unknown;
	try {
		parsed = raw ? JSON.parse(raw) : [];
	} catch {
		parsed = [];
	}
	const roles = (Array.isArray(parsed) ? parsed : []).filter(
		(role): role is Role =>
			typeof role === "string" && (ROLES as readonly string[]).includes(role),
	);
	return [...new Set(roles)].sort((a, b) => roleRank(a) - roleRank(b));
}

/** SQL expression: one role column ordered low to high. */
export const ROLE_RANK_SQL = RANK_SQL;
