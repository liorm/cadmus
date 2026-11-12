import { describe, expect, it } from "bun:test";
import {
	GRANTS,
	isGrant,
	normalizeRole,
	ROLE_GRANTS,
	ROLES,
} from "@cadmus/contract/grants";
import { authorize } from "../../src/authz.js";
import { getCommandGrant, listCommandTypes } from "../../src/protocol.js";

describe("grant conformance", () => {
	it("every command declares a known grant", () => {
		for (const type of listCommandTypes()) {
			const grant = getCommandGrant(type);
			expect(isGrant(grant), `${type} grant`).toBe(true);
		}
	});

	it("every role grant exists in the grant table", () => {
		for (const role of ROLES) {
			for (const grant of ROLE_GRANTS[role]) {
				expect(grant in GRANTS).toBe(true);
			}
		}
	});
});

describe("authorization matrix", () => {
	const caller = (role: (typeof ROLES)[number]) => ({
		accountId: "acct",
		role,
	});

	it("lets a user chat but not manage members", () => {
		expect(authorize(caller("user"), "bot.list")).toBeDefined();
		expect(() => authorize(caller("user"), "account.members.add")).toThrow(
			/forbidden|does not hold/,
		);
	});

	it("lets an account admin manage members", () => {
		expect(authorize(caller("account-admin"), "account.members.add")).toBe(
			"members.manage",
		);
	});

	it("denies a super admin tenant data", () => {
		for (const type of [
			"bot.list",
			"chat.list",
			"file.list",
			"knowledge.search",
		]) {
			expect(() => authorize(caller("super-admin"), type)).toThrow();
		}
	});

	it("denies a caller with no role", () => {
		expect(() => authorize({ accountId: "a" }, "bot.list")).toThrow();
	});

	it("maps legacy role names", () => {
		expect(normalizeRole("owner")).toBe("account-admin");
		expect(normalizeRole("member")).toBe("user");
		expect(normalizeRole("root")).toBeUndefined();
	});
});
