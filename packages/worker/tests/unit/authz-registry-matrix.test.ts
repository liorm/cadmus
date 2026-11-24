import { describe, expect, it } from "bun:test";
import {
	GRANTS,
	type Grant,
	isGrant,
	ROLE_GRANTS,
	ROLES,
} from "@cadmus/contract/grants";
import { authorize } from "../../src/authz.js";
import { getCommandGrant, listCommandTypes } from "../../src/protocol.js";

/**
 * Issue #3 L237: the authorization matrix is generated from the command
 * registry, not written by hand. Every registered command is classified by its
 * declared grant; for every role it must be allowed exactly when the role holds
 * that grant, and elevation-flagged grants must demand admin mode from a user
 * session but not from a token session (which carries explicit grants).
 * A command with no grant, or a grant missing from the grant table, fails the
 * test, so a new unclassified command cannot be added silently.
 */
const FUTURE = Date.now() + 60_000;

function outcome(fn: () => unknown): string {
	try {
		fn();
		return "allowed";
	} catch (e) {
		const code = (e as { code?: string }).code ?? "error";
		return `denied:${code}`;
	}
}

describe("authorization matrix generated from the command registry", () => {
	const commands = listCommandTypes();

	it("registers commands and classifies each by a known grant", () => {
		expect(commands.length).toBeGreaterThan(20);
		const unclassified = commands.filter(
			(t) =>
				!t.startsWith("auth.login.") &&
				!t.startsWith("auth.session.") &&
				!isGrant(getCommandGrant(t)),
		);
		expect(unclassified).toEqual([]);
		const publicCommands = commands.filter(
			(t) => t.startsWith("auth.login.") || t.startsWith("auth.session."),
		);
		expect(publicCommands.every((t) => getCommandGrant(t) === undefined)).toBe(
			true,
		);
	});

	for (const role of ROLES) {
		it(`role ${role}: every command is allowed exactly when the role holds its grant`, () => {
			const wrong: string[] = [];
			for (const type of commands) {
				const grant = getCommandGrant(type) as Grant;
				const holds = ROLE_GRANTS[role].includes(grant);
				// A caller with no session id (legacy/daemon path) is never asked to elevate.
				const got = outcome(() => authorize({ accountId: "acct", role }, type));
				const want = holds ? "allowed" : "denied:forbidden";
				if (got !== want) wrong.push(`${type}: ${got} want ${want}`);
			}
			expect(wrong).toEqual([]);
		});

		it(`role ${role}: a user session needs admin mode exactly for elevation grants`, () => {
			const wrong: string[] = [];
			for (const type of commands) {
				const grant = getCommandGrant(type) as Grant;
				if (!ROLE_GRANTS[role].includes(grant)) continue;
				const plain = outcome(() =>
					authorize({ accountId: "acct", role, sessionId: "s" }, type),
				);
				const elevated = outcome(() =>
					authorize(
						{ accountId: "acct", role, sessionId: "s", elevatedUntil: FUTURE },
						type,
					),
				);
				const wantPlain = GRANTS[grant].elevation
					? "denied:elevation_required"
					: "allowed";
				if (plain !== wantPlain) wrong.push(`${type} plain: ${plain}`);
				if (elevated !== "allowed") wrong.push(`${type} elevated: ${elevated}`);
			}
			expect(wrong).toEqual([]);
		});

		it(`role ${role}: a token session is clamped to its grants and never asked to elevate`, () => {
			const wrong: string[] = [];
			const tokenGrants = ROLE_GRANTS[role].filter((g) => !GRANTS[g].elevation);
			for (const type of commands) {
				const grant = getCommandGrant(type) as Grant;
				const got = outcome(() =>
					authorize(
						{
							accountId: "acct",
							role,
							sessionId: "s",
							grants: [...tokenGrants],
						},
						type,
					),
				);
				const want = tokenGrants.includes(grant)
					? "allowed"
					: "denied:forbidden";
				if (got !== want) wrong.push(`${type}: ${got} want ${want}`);
			}
			expect(wrong).toEqual([]);
		});
	}

	it("a token carrying a grant its role lacks is clamped to the role", () => {
		const wrong: string[] = [];
		const all = Object.keys(GRANTS) as Grant[];
		for (const type of commands) {
			const grant = getCommandGrant(type) as Grant;
			const got = outcome(() =>
				authorize(
					{ accountId: "acct", role: "user", sessionId: "s", grants: all },
					type,
				),
			);
			const want = ROLE_GRANTS.user.includes(grant)
				? "allowed"
				: "denied:forbidden";
			if (got !== want) wrong.push(`${type}: ${got} want ${want}`);
		}
		expect(wrong).toEqual([]);
	});

	// Independent of ROLE_GRANTS: the scope split the grant table declares.
	it("only the super-admin holds system-scope grants, and holds no tenant-data grant", () => {
		const system = (Object.keys(GRANTS) as Grant[]).filter(
			(g) => GRANTS[g].scope === "system",
		);
		for (const role of ["user", "account-admin"] as const) {
			expect(ROLE_GRANTS[role].filter((g) => system.includes(g))).toEqual([]);
		}
		const tenantData: Grant[] = [
			"chat.use",
			"bot.read",
			"bot.write",
			"knowledge.write",
			"schedule.write",
			"files.write",
			"credentials.read",
			"toolsEnv.read",
		];
		expect(
			ROLE_GRANTS["super-admin"].filter((g) => tenantData.includes(g)),
		).toEqual([]);
		expect(ROLE_GRANTS.user.filter((g) => GRANTS[g].elevation)).toEqual([]);
	});

	it("a caller with no role is denied every command", () => {
		const allowed = commands.filter(
			(t) => outcome(() => authorize({ accountId: "a" }, t)) === "allowed",
		);
		expect(allowed).toEqual([]);
	});
});

/**
 * Golden classification, written as literals so that a change to a command's
 * grant or to a role's grant list fails here and forces a review. Snapshot of
 * the registry at the time #94 phase 6 was reviewed.
 */
const GOLDEN_ROLE_GRANTS: Record<string, string[]> = {
	user: [
		"chat.use",
		"bot.read",
		"bot.write",
		"bot.delete",
		"family.manage",
		"knowledge.write",
		"schedule.write",
		"files.write",
		"members.read",
		"credentials.read",
		"toolsEnv.read",
		"toolsEnv.manage",
		"tokens.self",
		"session.assume",
	],
	"account-admin": [
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
		"bot.delete",
		"family.manage",
		"members.manage",
		"credentials.manage",
		"toolsEnv.manage",
		"account.manage",
		"audit.read",
		"admin.elevate",
		"session.assume",
	],
	"super-admin": [
		"tokens.self",
		"system.accounts.read",
		"system.accounts.manage",
		"system.members.manage",
		"system.users.manage",
		"system.audit.read",
		"admin.elevate",
		"session.assume",
	],
};

const GOLDEN_COMMAND_GRANTS: Record<string, string> = {
	"account.audit.list": "audit.read",
	"account.credentials.delete": "credentials.manage",
	"account.credentials.list": "credentials.read",
	"account.credentials.set": "credentials.manage",
	"account.credentials.test": "credentials.manage",
	"account.get": "members.read",
	"account.invites.list": "members.manage",
	"account.invites.revoke": "members.manage",
	"account.members.invite": "members.manage",
	"account.members.list": "members.read",
	"account.members.remove": "members.manage",
	"account.members.update": "members.manage",
	"account.models.list": "bot.read",
	"account.credentials.oauth.cancel": "credentials.manage",
	"account.credentials.oauth.providers": "credentials.read",
	"account.credentials.oauth.start": "credentials.manage",
	"account.credentials.oauth.status": "credentials.manage",
	"account.credentials.oauth.submit": "credentials.manage",
	"account.toolsEnvs.create": "toolsEnv.manage",
	"account.toolsEnvs.delete": "toolsEnv.manage",
	"account.toolsEnvs.deregister": "toolsEnv.manage",
	"account.toolsEnvs.list": "toolsEnv.read",
	"account.toolsEnvs.pair": "toolsEnv.manage",
	"account.toolsEnvs.update": "toolsEnv.manage",
	"account.update": "account.manage",
	"auth.assumeRole": "session.assume",
	"auth.elevate": "admin.elevate",
	"auth.elevation.end": "admin.elevate",
	"auth.memberships.list": "tokens.self",
	"auth.methods.list": "tokens.self",
	"auth.methods.delete": "tokens.self",
	"auth.sessions.list": "tokens.self",
	"auth.sessions.revoke": "tokens.self",
	"auth.sessions.revokeOthers": "tokens.self",
	"auth.ticket": "chat.use",
	"auth.whoami": "tokens.self",
	"bot.create": "bot.write",
	"bot.delete": "bot.delete",
	"bot.get": "bot.read",
	"bot.list": "bot.read",
	"bot.update": "bot.write",
	"chat.get": "chat.use",
	"chat.list": "chat.use",
	"chat.reset": "chat.use",
	"chat.status": "chat.use",
	"chat.tasks.get": "chat.use",
	"chat.tasks.list": "chat.use",
	"chat.update": "chat.use",
	"family.create": "family.manage",
	"family.delete": "family.manage",
	"family.get": "bot.read",
	"family.list": "bot.read",
	"family.update": "family.manage",
	"file.delete": "files.write",
	"file.list": "bot.read",
	"file.read": "bot.read",
	"file.write": "files.write",
	"skill.search": "bot.read",
	"schedule.create": "schedule.write",
	"schedule.delete": "schedule.write",
	"schedule.list": "bot.read",
	"schedule.update": "schedule.write",
	"system.accounts.create": "system.accounts.manage",
	"system.accounts.get": "system.accounts.read",
	"system.accounts.list": "system.accounts.read",
	"system.accounts.rename": "system.accounts.manage",
	"system.accounts.resume": "system.accounts.manage",
	"system.accounts.suspend": "system.accounts.manage",
	"system.audit.list": "system.audit.read",
	"system.members.invite": "system.members.manage",
	"system.members.list": "system.members.manage",
	"system.members.remove": "system.members.manage",
	"system.members.update": "system.members.manage",
	"system.metrics": "system.accounts.read",
	"system.sessions.revoke": "system.users.manage",
	"system.users.disable": "system.users.manage",
	"system.users.enable": "system.users.manage",
	"system.users.revokeSessions": "system.users.manage",
	"turn.abort": "chat.use",
	"turn.interrupt": "chat.use",
	"turn.steer": "chat.use",
	"turn.submit": "chat.use",
};

describe("golden classification", () => {
	it("each role holds exactly the listed grants", () => {
		for (const role of ROLES) {
			expect([...ROLE_GRANTS[role]].sort()).toEqual(
				[...(GOLDEN_ROLE_GRANTS[role] ?? [])].sort(),
			);
		}
	});

	it("every registered command has exactly the listed grant, and none is missing or extra", () => {
		const actual = Object.fromEntries(
			listCommandTypes()
				.sort()
				.map((t) => [t, getCommandGrant(t)]),
		);
		expect(actual).toEqual(GOLDEN_COMMAND_GRANTS);
	});

	it("exactly these grants require admin mode (independent literal)", () => {
		const elevation = (Object.keys(GRANTS) as Grant[])
			.filter((g) => GRANTS[g].elevation)
			.sort();
		expect(elevation).toEqual(
			[
				"account.manage",
				"credentials.manage",
				"members.manage",
				"system.accounts.manage",
				"system.members.manage",
				"system.users.manage",
			].sort(),
		);
	});
});
