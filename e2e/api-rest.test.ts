import { SELF } from "cloudflare:test";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	allowHeaderForCommand,
	apiPathFromCommandType,
	type CommandType,
	coerceQueryToSchema,
	coerceSearchParamsToPayload,
	commandTypeFromApiPath,
	encodePayloadQuery,
	httpStatusForProtocolCode,
	isCommandReadOnly,
	listCommandTypes,
} from "../src/protocol.js";
import { sendRpc, TEST_TOKEN } from "./helpers.js";

const PRIVATE_API_CACHE = "private, no-store";
const PRIVATE_API_VARY = "Authorization, Cookie, X-Cadmus-Family-Id";

function expectPrivateApiCache(response: Response): void {
	expect(response.headers.get("Cache-Control")).toBe(PRIVATE_API_CACHE);
	expect(response.headers.get("Vary")).toBe(PRIVATE_API_VARY);
}

/**
 * Snapshot of the deliberate readOnly decision for every command.
 * A new command must be added to exactly one list. Only side-effect-free
 * queries belong in READONLY; anything that writes, subscribes, or starts
 * a flow belongs in MUTATING so it cannot silently become GET.
 */
const READONLY = [
	"account.credentials.list",
	"account.get",
	"account.members.list",
	"account.models.list",
	"account.oauth.providers",
	"account.oauth.status",
	"account.toolsEnvSecrets.list",
	"account.toolsEnvs.list",
	"bot.get",
	"bot.list",
	"chat.entries",
	"chat.get",
	"chat.list",
	"chat.messages",
	"chat.status",
	"family.get",
	"family.list",
	"file.list",
	"file.read",
	"knowledge.search",
	"schedule.list",
] as const satisfies readonly CommandType[];

const MUTATING = [
	"account.credentials.delete",
	"account.credentials.set",
	"account.members.add",
	"account.oauth.cancel",
	"account.oauth.start",
	"account.oauth.submit",
	"account.toolsEnvSecrets.delete",
	"account.toolsEnvSecrets.set",
	"account.toolsEnvs.create",
	"account.toolsEnvs.delete",
	"account.toolsEnvs.update",
	"account.update",
	"bot.create",
	"bot.delete",
	"bot.update",
	"chat.close",
	"chat.create",
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
	"turn.command",
	"turn.interrupt",
	"turn.steer",
	"turn.submit",
] as const satisfies readonly CommandType[];

function authHeaders(
	accountId: string,
	familyId?: string,
	extra?: Record<string, string>,
): Record<string, string> {
	return {
		Authorization: `Bearer ${TEST_TOKEN}`,
		"x-account-id": accountId,
		...(familyId ? { "X-Cadmus-Family-Id": familyId } : {}),
		...extra,
	};
}

describe("REST /api command translation", () => {
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
		params.append("token", "secret");
		params.append("familyId", "alpha");
		expect(coerceQueryToSchema(schema, params)).toEqual({
			n: 1.5,
			i: 4,
			b: false,
			tags: ["a", "b"],
			meta: { a: "z" },
		});

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

	it("publishes readOnly on GET /protocol/schema", async () => {
		const res = await SELF.fetch("http://example.com/protocol/schema");
		expect(res.status).toBe(200);
		const schema = (await res.json()) as {
			clientCommand: {
				anyOf: Array<{
					readOnly?: boolean;
					properties?: { type?: { const?: string } };
				}>;
			};
		};
		const byType = new Map(
			schema.clientCommand.anyOf.map((entry) => [
				entry.properties?.type?.const,
				entry,
			]),
		);
		expect(byType.get("file.read")?.readOnly).toBe(true);
		expect(byType.get("chat.messages")?.readOnly).toBe(true);
		expect(byType.get("file.write")?.readOnly).toBeUndefined();
		expect(byType.get("turn.submit")?.readOnly).toBeUndefined();
	});

	it("rejects anonymous /api requests with the same 401 body as /rpc", async () => {
		const rpc = await SELF.fetch("http://example.com/rpc", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ id: "x", type: "bot.list", payload: {} }),
		});
		const api = await SELF.fetch("http://example.com/api/bot/list");
		expect(api.status).toBe(401);
		expect(rpc.status).toBe(401);
		expectPrivateApiCache(api);
		expect(rpc.headers.get("Cache-Control")).toBeNull();
		expect(await api.json()).toEqual(await rpc.json());
	});

	it("reads and writes files over /api and matches /rpc results and error codes", async () => {
		const accountId = "acct-api-files";
		const headers = authHeaders(accountId, "default");

		const created = await sendRpc(
			"bot.create",
			{ slug: "scribe", name: "Scribe", model: "faux/echo" },
			{ accountId },
		);
		expect(created.status).toBe(200);

		const readUrl =
			"http://example.com/api/file/read?botId=scribe&path=SOUL.md";
		const apiRead = await SELF.fetch(readUrl, { headers });
		expect(apiRead.status).toBe(200);
		expectPrivateApiCache(apiRead);
		const apiBody = await apiRead.json();
		const rpcRead = await sendRpc(
			"file.read",
			{ botId: "scribe", path: "SOUL.md" },
			{ accountId },
		);
		expect(rpcRead.status).toBe(200);
		expect(apiBody).toEqual(rpcRead.frame.result);

		const head = await SELF.fetch(readUrl, { method: "HEAD", headers });
		expect(head.status).toBe(200);
		expect(await head.text()).toBe("");
		expect(head.headers.get("content-type")).toContain("application/json");

		const wrongMethod = await SELF.fetch(readUrl, {
			method: "POST",
			headers: { ...headers, "Content-Type": "application/json" },
			body: JSON.stringify({ botId: "scribe", path: "SOUL.md" }),
		});
		expect(wrongMethod.status).toBe(405);
		expectPrivateApiCache(wrongMethod);
		expect(wrongMethod.headers.get("Allow")).toBe("GET, HEAD");
		expect(await wrongMethod.json()).toMatchObject({
			error: { code: "method_not_allowed" },
		});

		const getWrite = await SELF.fetch(
			"http://example.com/api/file/write?botId=scribe&path=MEMORY.md",
			{ headers },
		);
		expect(getWrite.status).toBe(405);
		expect(getWrite.headers.get("Allow")).toBe("POST");

		const headWrite = await SELF.fetch("http://example.com/api/file/write", {
			method: "HEAD",
			headers,
		});
		expect(headWrite.status).toBe(405);
		expect(await headWrite.text()).toBe("");
		expect(headWrite.headers.get("Allow")).toBe("POST");

		const write = await SELF.fetch("http://example.com/api/file/write", {
			method: "POST",
			headers: { ...headers, "Content-Type": "application/json" },
			body: JSON.stringify({
				botId: "scribe",
				path: "MEMORY.md",
				content: "Remember the gate.",
				expectedVersion: 0,
			}),
		});
		expect(write.status).toBe(200);
		expect(await write.json()).toMatchObject({
			path: "MEMORY.md",
			version: 1,
			content: "Remember the gate.",
		});

		const enveloped = await SELF.fetch("http://example.com/api/file/write", {
			method: "POST",
			headers: { ...headers, "Content-Type": "application/json" },
			body: JSON.stringify({
				id: "api-fixed1",
				type: "file.write",
				payload: {
					botId: "scribe",
					path: "MEMORY.md",
					content: "Remember the gate, revised.",
					expectedVersion: 1,
				},
			}),
		});
		expect(enveloped.status).toBe(200);
		expect(await enveloped.json()).toMatchObject({ version: 2 });

		const conflict = await SELF.fetch("http://example.com/api/file/write", {
			method: "POST",
			headers: { ...headers, "Content-Type": "application/json" },
			body: JSON.stringify({
				botId: "scribe",
				path: "MEMORY.md",
				content: "stale",
				expectedVersion: 0,
			}),
		});
		expect(conflict.status).toBe(409);
		expect(await conflict.json()).toMatchObject({
			error: { code: "cas_conflict" },
		});
		const rpcConflict = await sendRpc(
			"file.write",
			{
				botId: "scribe",
				path: "MEMORY.md",
				content: "stale",
				expectedVersion: 0,
			},
			{ accountId },
		);
		expect(rpcConflict.status).toBe(400);
		expect(rpcConflict.frame.error?.code).toBe("cas_conflict");

		const missing = await SELF.fetch(
			"http://example.com/api/file/read?botId=missing&path=SOUL.md",
			{ headers },
		);
		expect(missing.status).toBe(404);
		expect(await missing.json()).toMatchObject({
			error: { code: "not_found" },
		});

		const headMissing = await SELF.fetch(
			"http://example.com/api/bot/get?botId=missing",
			{ method: "HEAD", headers },
		);
		expect(headMissing.status).toBe(404);
		expect(await headMissing.text()).toBe("");

		const badBool = await SELF.fetch(
			"http://example.com/api/schedule/list?includeInternal=yes",
			{ headers },
		);
		expect(badBool.status).toBe(400);
		expect(await badBool.json()).toMatchObject({
			error: { code: "invalid_command" },
		});

		const listed = await SELF.fetch(
			"http://example.com/api/schedule/list?includeInternal=false",
			{ headers },
		);
		expect(listed.status).toBe(200);
		const rpcListed = await sendRpc(
			"schedule.list",
			{ includeInternal: false },
			{ accountId },
		);
		expect(await listed.json()).toEqual(rpcListed.frame.result);
	});

	it("returns 404 for unknown paths and preserves family routing", async () => {
		const accountId = "acct-api-route";
		const unknown = await SELF.fetch("http://example.com/api/no/such", {
			headers: authHeaders(accountId),
		});
		expect(unknown.status).toBe(404);
		expect(await unknown.json()).toMatchObject({
			error: { code: "not_found" },
		});

		const missingFamily = await SELF.fetch(
			"http://example.com/api/bot/list?familyId=missing-family",
			{ headers: authHeaders(accountId) },
		);
		expect(missingFamily.status).toBe(404);
		expect(await missingFamily.json()).toMatchObject({
			error: { code: "family_not_found" },
		});

		const created = await SELF.fetch("http://example.com/api/family/create", {
			method: "POST",
			headers: {
				...authHeaders(accountId),
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ familyId: "alpha", name: "Alpha" }),
		});
		expect(created.status).toBe(200);
		expect(await created.json()).toMatchObject({
			family: { familyId: "alpha", name: "Alpha" },
		});

		const bot = await SELF.fetch(
			"http://example.com/api/bot/create?familyId=alpha",
			{
				method: "POST",
				headers: {
					...authHeaders(accountId),
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					slug: "scout",
					name: "Scout",
					model: "faux/echo",
				}),
			},
		);
		expect(bot.status).toBe(200);

		const viaQuery = await SELF.fetch(
			"http://example.com/api/bot/get?familyId=alpha&botId=scout",
			{ headers: authHeaders(accountId) },
		);
		expect(viaQuery.status).toBe(200);
		expect(await viaQuery.json()).toMatchObject({
			bot: { id: "scout", name: "Scout" },
		});
		const rpcBot = await sendRpc(
			"bot.get",
			{ botId: "scout" },
			{ accountId, familyId: "alpha" },
		);
		expect(rpcBot.frame.result).toEqual(
			await (
				await SELF.fetch(
					"http://example.com/api/bot/get?familyId=alpha&botId=scout",
					{ headers: authHeaders(accountId) },
				)
			).json(),
		);

		const headerWins = await SELF.fetch(
			"http://example.com/api/bot/get?familyId=alpha&botId=scout",
			{ headers: authHeaders(accountId, "default") },
		);
		expect(headerWins.status).toBe(404);

		const payloadWins = await SELF.fetch(
			"http://example.com/api/family/get?familyId=alpha",
			{ headers: authHeaders(accountId, "default") },
		);
		expect(payloadWins.status).toBe(200);
		expect(await payloadWins.json()).toMatchObject({
			family: { familyId: "alpha", name: "Alpha" },
		});

		const badType = await SELF.fetch("http://example.com/api/file/write", {
			method: "POST",
			headers: {
				...authHeaders(accountId),
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ type: "file.read", payload: {} }),
		});
		expect(badType.status).toBe(400);

		const unknownParam = await SELF.fetch(
			"http://example.com/api/bot/list?nope=1",
			{ headers: authHeaders(accountId) },
		);
		expect(unknownParam.status).toBe(400);
	});

	it("authenticates /api with a session cookie and a query token", async () => {
		const viaCookie = await SELF.fetch("http://example.com/api/bot/list", {
			headers: {
				Cookie: `cadmus_session=${encodeURIComponent(`acct-api-cookie:owner:${TEST_TOKEN}`)}`,
			},
		});
		expect(viaCookie.status).toBe(200);
		expect(await viaCookie.json()).toMatchObject({ bots: [] });

		const viaQuery = await SELF.fetch(
			`http://example.com/api/bot/list?token=${TEST_TOKEN}&accountId=acct-api-query&userId=query-user`,
		);
		expect(viaQuery.status).toBe(200);
		expect(await viaQuery.json()).toMatchObject({ bots: [] });
	});
});
