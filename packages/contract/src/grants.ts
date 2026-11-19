/**
 * Roles, grants and the role to grant sets (issue #3, phase 2).
 *
 * A grant names one capability. Each command schema declares exactly one grant
 * (the `grant` schema option, next to `readOnly`) and the Worker's single
 * `authorize()` checks the principal's grants against it.
 *
 * - `account` grants act inside the principal's current account (tenant data
 *   and settings).
 * - `system` grants act on a target account's record, users and memberships,
 *   never on its tenant data.
 * - `elevation: true` marks sensitive grants that need admin mode. Elevation
 *   is enforced by `authorize()` for user sessions (`auth.elevate`).
 */

export type GrantScope = "account" | "system";

export interface GrantDefinition {
	elevation: boolean;
	scope: GrantScope;
}

export const GRANTS = {
	"chat.use": { elevation: false, scope: "account" },
	"bot.read": { elevation: false, scope: "account" },
	"bot.write": { elevation: false, scope: "account" },
	"knowledge.write": { elevation: false, scope: "account" },
	"schedule.write": { elevation: false, scope: "account" },
	"files.write": { elevation: false, scope: "account" },
	"members.read": { elevation: false, scope: "account" },
	"credentials.read": { elevation: false, scope: "account" },
	"toolsEnv.read": { elevation: false, scope: "account" },
	"tokens.self": { elevation: false, scope: "account" },
	"session.assume": { elevation: false, scope: "account" },
	"admin.elevate": { elevation: false, scope: "account" },
	"bot.delete": { elevation: true, scope: "account" },
	"family.manage": { elevation: true, scope: "account" },
	"members.manage": { elevation: true, scope: "account" },
	"credentials.manage": { elevation: true, scope: "account" },
	"toolsEnv.manage": { elevation: true, scope: "account" },
	"tokens.manage": { elevation: true, scope: "account" },
	"account.manage": { elevation: true, scope: "account" },
	"audit.read": { elevation: false, scope: "account" },
	"system.accounts.read": { elevation: false, scope: "system" },
	"system.accounts.manage": { elevation: true, scope: "system" },
	"system.members.manage": { elevation: true, scope: "system" },
	"system.users.manage": { elevation: true, scope: "system" },
	"system.audit.read": { elevation: false, scope: "system" },
} as const satisfies Record<string, GrantDefinition>;

export type Grant = keyof typeof GRANTS;

export const GRANT_NAMES = Object.keys(GRANTS) as Grant[];

export function isGrant(value: unknown): value is Grant {
	return typeof value === "string" && Object.hasOwn(GRANTS, value);
}

/** Lowest rank first. Not a grant lattice: super-admin has no tenant grants. */
export const ROLES = ["user", "account-admin", "super-admin"] as const;
export type Role = (typeof ROLES)[number];

/** Product rank. Lower is the default hat at login. */
export function roleRank(role: Role): number {
	return ROLES.indexOf(role);
}

/** Reserved id of the one built-in system account. */
export const SYSTEM_ACCOUNT_ID = "system";

const USER_GRANTS: readonly Grant[] = [
	"chat.use",
	"bot.read",
	"bot.write",
	"knowledge.write",
	"schedule.write",
	"files.write",
	"members.read",
	"credentials.read",
	"toolsEnv.read",
	"tokens.self",
	"session.assume",
];

const ACCOUNT_ADMIN_GRANTS: readonly Grant[] = [
	...USER_GRANTS,
	"bot.delete",
	"family.manage",
	"members.manage",
	"credentials.manage",
	"toolsEnv.manage",
	"tokens.manage",
	"account.manage",
	"audit.read",
	"admin.elevate",
];

const SUPER_ADMIN_GRANTS: readonly Grant[] = [
	"tokens.self",
	"session.assume",
	"system.accounts.read",
	"system.accounts.manage",
	"system.members.manage",
	"system.users.manage",
	"system.audit.read",
	"admin.elevate",
];

export const ROLE_GRANTS: Record<Role, readonly Grant[]> = {
	user: USER_GRANTS,
	"account-admin": ACCOUNT_ADMIN_GRANTS,
	"super-admin": SUPER_ADMIN_GRANTS,
};

export function isRole(value: unknown): value is Role {
	return (
		typeof value === "string" && (ROLES as readonly string[]).includes(value)
	);
}

/** A stored or client-sent role, or undefined when it is not one of `ROLES`. */
export function normalizeRole(value: unknown): Role | undefined {
	return isRole(value) ? value : undefined;
}

/** Account-scope grants only: the grants a role holds in a tenant account. */
export function grantsForRole(role: Role): readonly Grant[] {
	return ROLE_GRANTS[role];
}
