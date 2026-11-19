import { describe, expect, it } from "bun:test";
import { API_ROUTES, encodePayloadQuery } from "@cadmus/contract/routes";
import { Type } from "typebox";
import {
	allowHeaderForCommand,
	apiPathFromCommandType,
	apiRouteForCommand,
	type CommandType,
	coerceQueryToSchema,
	coerceSearchParamsToPayload,
	commandTypeFromApiPath,
	httpStatusForProtocolCode,
	isCommandReadOnly,
	listCommandTypes,
} from "../../src/protocol.js";

const READONLY = [
	"account.credentials.list",
	"account.get",
	"account.members.list",
	"account.models.list",
	"account.credentials.oauth.providers",
	"account.credentials.oauth.status",
	"account.toolsEnvs.list",
	"account.audit.list",
	"account.invites.list",
	"auth.memberships.list",
	"auth.login.providers",
	"auth.methods.list",
	"auth.sessions.list",
	"auth.tokens.list",
	"auth.whoami",
	"bot.get",
	"bot.list",
	"chat.entries",
	"chat.get",
	"chat.list",
	"chat.messages",
	"chat.status",
	"chat.tasks.get",
	"chat.tasks.list",
	"family.get",
	"family.list",
	"file.list",
	"file.read",
	"knowledge.search",
	"schedule.list",
	"system.accounts.list",
	"system.audit.list",
	"system.members.list",
] as const satisfies readonly CommandType[];

const MUTATING = [
	"account.credentials.delete",
	"account.credentials.set",
	"account.members.add",
	"account.credentials.oauth.cancel",
	"account.invites.revoke",
	"account.members.invite",
	"account.members.update",
	"account.members.remove",
	"auth.assumeRole",
	"auth.login.devPassword",
	"auth.login.google.start",
	"auth.login.token",
	"auth.methods.delete",
	"auth.session.logout",
	"auth.session.refresh",
	"auth.sessions.revoke",
	"auth.sessions.revokeOthers",
	"auth.elevate",
	"auth.elevation.end",
	"system.accounts.create",
	"system.accounts.suspend",
	"system.accounts.resume",
	"system.accounts.rename",
	"system.members.invite",
	"system.members.update",
	"system.members.remove",
	"system.users.disable",
	"system.users.enable",
	"system.users.revokeSessions",
	"auth.tokens.create",
	"auth.tokens.revoke",
	"auth.ticket",
	"account.credentials.oauth.start",
	"account.credentials.oauth.submit",
	"account.toolsEnvs.create",
	"account.toolsEnvs.delete",
	"account.toolsEnvs.deregister",
	"account.toolsEnvs.pair",
	"account.toolsEnvs.update",
	"account.update",
	"bot.create",
	"bot.delete",
	"bot.update",
	"chat.close",
	"chat.create",
	"chat.delete",
	"chat.rename",
	"chat.reset",
	"chat.subscribe",
	"chat.update",
	"family.create",
	"family.delete",
	"family.update",
	"file.delete",
	"file.write",
	"schedule.create",
	"schedule.delete",
	"schedule.update",
	"turn.abort",
	"turn.interrupt",
	"turn.steer",
	"turn.submit",
] as const satisfies readonly CommandType[];

describe("REST /api command translation unit helpers", () => {
	it("records an explicit readOnly decision for every command schema", () => {
		const actual = [...listCommandTypes()].sort();
		const expected = [...READONLY, ...MUTATING].sort();
		expect(actual).toEqual(expected);
		for (const type of READONLY) {
			expect(isCommandReadOnly(type)).toBe(true);
			expect(allowHeaderForCommand(type)).toBe("GET, HEAD");
			expect(apiPathFromCommandType(type)).toBe(
				`/api/${type.replaceAll(".", "/")}`,
			);
			expect(commandTypeFromApiPath(apiPathFromCommandType(type))).toBe(type);
		}
		for (const type of MUTATING) {
			expect(isCommandReadOnly(type)).toBe(false);
			expect(allowHeaderForCommand(type)).toBe("POST");
		}

		expect(Object.keys(API_ROUTES).sort()).toEqual(actual);
		for (const type of listCommandTypes()) {
			const route = API_ROUTES[type];
			expect({
				method: route.method,
				path: route.path,
				allow: route.allow,
			}).toEqual(apiRouteForCommand(type));
			expect(route.readOnly).toBe(isCommandReadOnly(type));
		}
	});

	it("coerces query values against a payload schema and round-trips encodePayloadQuery", () => {
		const schema = Type.Object({
			n: Type.Number(),
			i: Type.Integer(),
			b: Type.Boolean(),
			tags: Type.Array(Type.String()),
			meta: Type.Object({ a: Type.String() }),
		});
		const params = new URLSearchParams();
		params.append("n", "1.5");
		params.append("i", "4");
		params.append("b", "FALSE");
		params.append("tags", "a");
		params.append("tags", "b");
		params.append("meta", JSON.stringify({ a: "z" }));
		params.append("familyId", "alpha");
		expect(coerceQueryToSchema(schema, params)).toEqual({
			n: 1.5,
			i: 4,
			b: false,
			tags: ["a", "b"],
			meta: { a: "z" },
		});
		const withToken = new URLSearchParams(params);
		withToken.append("token", "secret");
		expect(() => coerceQueryToSchema(schema, withToken)).toThrow(
			/Unknown query parameter 'token'/,
		);

		const encoded = encodePayloadQuery({
			botId: "scribe",
			includeInternal: false,
		});
		expect(coerceSearchParamsToPayload("schedule.list", encoded)).toEqual({
			botId: "scribe",
			includeInternal: false,
		});

		expect(() =>
			coerceQueryToSchema(schema, new URLSearchParams("i=1.5")),
		).toThrow(/not a valid integer/);
		expect(() =>
			coerceQueryToSchema(schema, new URLSearchParams("meta=nope")),
		).toThrow(/JSON-encoded object/);
		expect(() =>
			coerceQueryToSchema(schema, new URLSearchParams("extra=1")),
		).toThrow(/Unknown query parameter 'extra'/);

		expect(httpStatusForProtocolCode("not_found")).toBe(404);
		expect(httpStatusForProtocolCode("family_not_found")).toBe(404);
		expect(httpStatusForProtocolCode("bot_not_found")).toBe(404);
		expect(httpStatusForProtocolCode("cas_conflict")).toBe(409);
		expect(httpStatusForProtocolCode("conflict")).toBe(409);
		expect(httpStatusForProtocolCode("unauthorized")).toBe(401);
		expect(httpStatusForProtocolCode("forbidden")).toBe(403);
		expect(httpStatusForProtocolCode("invalid_command")).toBe(400);
		expect(httpStatusForProtocolCode("command_failed")).toBe(500);
	});
});
