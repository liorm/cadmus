import { describe, expect, it } from "vitest";
import {
	sendRpc,
	TEST_TOKEN,
	uniqueAccountId,
	useWorkerFixture,
	workerFetch,
} from "./helpers.js";

const PRIVATE_API_CACHE = "private, no-store";
const PRIVATE_API_VARY = "Authorization, Cookie, X-Cadmus-Family-Id";

function expectPrivateApiCache(response: Response): void {
	expect(response.headers.get("Cache-Control")).toBe(PRIVATE_API_CACHE);
	expect(response.headers.get("Vary")).toBe(PRIVATE_API_VARY);
}

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
	useWorkerFixture();

	it("publishes readOnly on GET /protocol/schema", async () => {
		const res = await workerFetch("http://example.com/protocol/schema");
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
		const rpc = await workerFetch("http://example.com/rpc", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ id: "x", type: "bot.list", payload: {} }),
		});
		const api = await workerFetch("http://example.com/api/bot/list");
		expect(api.status).toBe(401);
		expect(rpc.status).toBe(401);
		expectPrivateApiCache(api);
		// An authentication refusal is an auth response: no-store (issue #3 phase 8).
		expect(rpc.headers.get("Cache-Control")).toBe("no-store");
		expect(await api.json()).toEqual(await rpc.json());
	});

	it("reads and writes files over /api and matches /rpc results and error codes", async () => {
		const accountId = uniqueAccountId("api-files");
		const headers = authHeaders(accountId, "default");

		const created = await sendRpc(
			"bot.create",
			{ slug: "scribe", name: "Scribe", model: "faux/echo" },
			{ accountId },
		);
		expect(created.status).toBe(200);

		const readUrl =
			"http://example.com/api/file/read?botId=scribe&path=SOUL.md";
		const apiRead = await workerFetch(readUrl, { headers });
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

		const head = await workerFetch(readUrl, { method: "HEAD", headers });
		expect(head.status).toBe(200);
		expect(await head.text()).toBe("");
		expect(head.headers.get("content-type")).toContain("application/json");

		const wrongMethod = await workerFetch(readUrl, {
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

		const getWrite = await workerFetch(
			"http://example.com/api/file/write?botId=scribe&path=MEMORY.md",
			{ headers },
		);
		expect(getWrite.status).toBe(405);
		expect(getWrite.headers.get("Allow")).toBe("POST");

		const headWrite = await workerFetch("http://example.com/api/file/write", {
			method: "HEAD",
			headers,
		});
		expect(headWrite.status).toBe(405);
		expect(await headWrite.text()).toBe("");
		expect(headWrite.headers.get("Allow")).toBe("POST");

		const write = await workerFetch("http://example.com/api/file/write", {
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

		const enveloped = await workerFetch("http://example.com/api/file/write", {
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

		const conflict = await workerFetch("http://example.com/api/file/write", {
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

		const missing = await workerFetch(
			"http://example.com/api/file/read?botId=missing&path=SOUL.md",
			{ headers },
		);
		expect(missing.status).toBe(404);
		expect(await missing.json()).toMatchObject({
			error: { code: "not_found" },
		});

		const headMissing = await workerFetch(
			"http://example.com/api/bot/get?botId=missing",
			{ method: "HEAD", headers },
		);
		expect(headMissing.status).toBe(404);
		expect(await headMissing.text()).toBe("");

		const badBool = await workerFetch(
			"http://example.com/api/schedule/list?includeInternal=yes",
			{ headers },
		);
		expect(badBool.status).toBe(400);
		expect(await badBool.json()).toMatchObject({
			error: { code: "invalid_command" },
		});

		const listed = await workerFetch(
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
		const accountId = uniqueAccountId("api-route");
		const unknown = await workerFetch("http://example.com/api/no/such", {
			headers: authHeaders(accountId),
		});
		expect(unknown.status).toBe(404);
		expect(await unknown.json()).toMatchObject({
			error: { code: "not_found" },
		});

		const missingFamily = await workerFetch(
			"http://example.com/api/bot/list?familyId=missing-family",
			{ headers: authHeaders(accountId) },
		);
		expect(missingFamily.status).toBe(404);
		expect(await missingFamily.json()).toMatchObject({
			error: { code: "family_not_found" },
		});

		const created = await workerFetch("http://example.com/api/family/create", {
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

		const bot = await workerFetch(
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

		const viaQuery = await workerFetch(
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
				await workerFetch(
					"http://example.com/api/bot/get?familyId=alpha&botId=scout",
					{ headers: authHeaders(accountId) },
				)
			).json(),
		);

		const headerWins = await workerFetch(
			"http://example.com/api/bot/get?familyId=alpha&botId=scout",
			{ headers: authHeaders(accountId, "default") },
		);
		expect(headerWins.status).toBe(404);

		const payloadWins = await workerFetch(
			"http://example.com/api/family/get?familyId=alpha",
			{ headers: authHeaders(accountId, "default") },
		);
		expect(payloadWins.status).toBe(200);
		expect(await payloadWins.json()).toMatchObject({
			family: { familyId: "alpha", name: "Alpha" },
		});

		const badType = await workerFetch("http://example.com/api/file/write", {
			method: "POST",
			headers: {
				...authHeaders(accountId),
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ type: "file.read", payload: {} }),
		});
		expect(badType.status).toBe(400);

		const unknownParam = await workerFetch(
			"http://example.com/api/bot/list?nope=1",
			{ headers: authHeaders(accountId) },
		);
		expect(unknownParam.status).toBe(400);
	});

	it("accepts Authorization Bearer on GET and POST /api and rejects query tokens and cookies", async () => {
		const accountId = uniqueAccountId("api-bearer");
		const headers = authHeaders(accountId);

		const listed = await workerFetch("http://example.com/api/bot/list", {
			headers,
		});
		expect(listed.status).toBe(200);
		expectPrivateApiCache(listed);
		expect(await listed.json()).toMatchObject({ bots: [] });

		const created = await workerFetch("http://example.com/api/family/create", {
			method: "POST",
			headers: { ...headers, "Content-Type": "application/json" },
			body: JSON.stringify({ familyId: "bearer-fam", name: "Bearer" }),
		});
		expect(created.status).toBe(200);
		expectPrivateApiCache(created);
		expect(await created.json()).toMatchObject({
			family: { familyId: "bearer-fam", name: "Bearer" },
		});

		const queryAccountId = uniqueAccountId("api-query");
		const cookieAccountId = uniqueAccountId("api-cookie");
		const otherAccountId = uniqueAccountId("api-other");
		const rpcQueryAccountId = uniqueAccountId("rpc-query");
		const rpcCookieAccountId = uniqueAccountId("rpc-cookie");
		const eventsAccountId = uniqueAccountId("events-query");
		const querySecret = `qtok-${crypto.randomUUID()}`;

		const expectQueryTokenRejected = async (
			url: string,
			init?: RequestInit,
		) => {
			const response = await workerFetch(url, init);
			expect(response.status).toBe(401);
			expectPrivateApiCache(response);
			if ((init?.method ?? "GET").toUpperCase() === "HEAD") {
				expect(await response.text()).toBe("");
				expect(response.headers.get("content-type")).toContain(
					"application/json",
				);
				return;
			}
			expect(await response.json()).toEqual({
				error: {
					code: "query_token_not_allowed",
					message:
						"The token query parameter is not allowed. Send Authorization: Bearer instead.",
				},
			});
		};

		await expectQueryTokenRejected(
			`http://example.com/api/bot/list?token=${encodeURIComponent(querySecret)}&accountId=${encodeURIComponent(queryAccountId)}`,
		);
		await expectQueryTokenRejected(
			`http://example.com/api/bot/list?token=${encodeURIComponent(querySecret)}`,
			{ headers },
		);
		await expectQueryTokenRejected(
			`http://example.com/api/family/create?token=${encodeURIComponent(querySecret)}`,
			{
				method: "POST",
				headers: { ...headers, "Content-Type": "application/json" },
				body: JSON.stringify({ familyId: "should-not-run", name: "No" }),
			},
		);
		await expectQueryTokenRejected("http://example.com/api/bot/list?token=", {
			headers,
		});
		await expectQueryTokenRejected(
			"http://example.com/api/no/such/path?token=",
		);
		await expectQueryTokenRejected("http://example.com/api/bot/list?token=", {
			method: "DELETE",
		});
		await expectQueryTokenRejected("http://example.com/api/bot/list?token=", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({}),
		});
		await expectQueryTokenRejected("http://example.com/api/bot/list?token=", {
			method: "HEAD",
		});

		const viaCookie = await workerFetch("http://example.com/api/bot/list", {
			headers: {
				Cookie: `cadmus_session=${encodeURIComponent(`${cookieAccountId}:owner:${TEST_TOKEN}`)}`,
			},
		});
		expect(viaCookie.status).toBe(401);
		expectPrivateApiCache(viaCookie);
		expect(await viaCookie.json()).toEqual({
			error: {
				code: "header_required",
				message:
					"Authorization: Bearer token is required. Session cookies are not accepted.",
			},
		});

		const headCookie = await workerFetch("http://example.com/api/bot/list", {
			method: "HEAD",
			headers: {
				Cookie: `cadmus_session=${encodeURIComponent(`${cookieAccountId}:owner:${TEST_TOKEN}`)}`,
			},
		});
		expect(headCookie.status).toBe(401);
		expectPrivateApiCache(headCookie);
		expect(await headCookie.text()).toBe("");
		expect(headCookie.headers.get("content-type")).toContain(
			"application/json",
		);

		const cookieIgnored = await workerFetch("http://example.com/api/bot/list", {
			headers: {
				...headers,
				Cookie: `cadmus_session=${encodeURIComponent(`${otherAccountId}:owner:not-the-header-token`)}`,
			},
		});
		expect(cookieIgnored.status).toBe(200);
		expect(await cookieIgnored.json()).toMatchObject({ bots: [] });

		const rpcQuery = await workerFetch(
			`http://example.com/rpc?token=${encodeURIComponent(TEST_TOKEN)}&accountId=${encodeURIComponent(rpcQueryAccountId)}&userId=rpc-query-user`,
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ id: "rpc-q", type: "bot.list", payload: {} }),
			},
		);
		// ?token= is retired on /rpc for every credential, the master secret
		// included. The same credential in the header is the control.
		expect(rpcQuery.status).toBe(401);
		const rpcHeaderControl = await sendRpc(
			"bot.list",
			{},
			{ accountId: rpcQueryAccountId, userId: "rpc-query-user" },
		);
		expect(rpcHeaderControl.status).toBe(200);
		expect(rpcHeaderControl.frame.ok).toBe(true);

		const rpcCookie = await sendRpc(
			"bot.list",
			{},
			{
				token: "",
				cookie: `cadmus_session=${encodeURIComponent(`${rpcCookieAccountId}:owner:${TEST_TOKEN}`)}`,
			},
		);
		// The cadmus_session cookie is retired as a credential on /rpc.
		expect(rpcCookie.status).toBe(401);
		const rpcCookieControl = await sendRpc(
			"bot.list",
			{},
			{ token: `${rpcCookieAccountId}:owner:${TEST_TOKEN}` },
		);
		expect(rpcCookieControl.status).toBe(200);
		expect(rpcCookieControl.frame.ok).toBe(true);

		// ?token= is retired on /events for the master secret too. The ticket
		// minted over the header is the control.
		const eventsQuery = await workerFetch(
			`http://example.com/events?token=${encodeURIComponent(TEST_TOKEN)}&accountId=${encodeURIComponent(eventsAccountId)}`,
		);
		expect(eventsQuery.status).toBe(401);
		const minted = await sendRpc<{ ticket: string }>(
			"auth.ticket",
			{ target: "events" },
			{ accountId: eventsAccountId },
		);
		expect(minted.frame.ok).toBe(true);
		const eventsTicket = await workerFetch(
			`http://example.com/events?ticket=${encodeURIComponent(minted.frame.result?.ticket ?? "")}`,
		);
		expect(eventsTicket.status).toBe(200);
		expect(eventsTicket.headers.get("content-type")).toContain(
			"text/event-stream",
		);
		await eventsTicket.body?.cancel();
	});
});

describe("API document routes", () => {
	useWorkerFixture();

	const specs = ["/api/openapi.json", "/api/asyncapi.json"] as const;

	it("treats OpenAPI and AsyncAPI paths as unknown /api commands", async () => {
		const accountId = uniqueAccountId("docs");
		for (const path of specs) {
			const res = await workerFetch(`http://example.com${path}`, {
				headers: authHeaders(accountId),
			});
			expect(res.status).toBe(404);
			expectPrivateApiCache(res);
			expect(await res.json()).toMatchObject({
				error: { code: "not_found" },
			});

			const head = await workerFetch(`http://example.com${path}`, {
				method: "HEAD",
				headers: authHeaders(accountId),
			});
			expect(head.status).toBe(404);
			expect(await head.text()).toBe("");
			expectPrivateApiCache(head);
		}
	});

	it("authenticates those paths as /api before 404", async () => {
		const accountId = uniqueAccountId("docs-auth");
		for (const path of specs) {
			const anon = await workerFetch(`http://example.com${path}`);
			expect(anon.status).toBe(401);
			expectPrivateApiCache(anon);
			expect(await anon.json()).toMatchObject({
				type: "protocol.error",
				payload: { code: "unauthorized" },
			});

			const query = await workerFetch(
				`http://example.com${path}?token=${encodeURIComponent(TEST_TOKEN)}`,
				{ headers: authHeaders(accountId) },
			);
			expect(query.status).toBe(401);
			expectPrivateApiCache(query);
			expect(await query.json()).toEqual({
				error: {
					code: "query_token_not_allowed",
					message: expect.any(String),
				},
			});

			const headQuery = await workerFetch(
				`http://example.com${path}?token=${encodeURIComponent(TEST_TOKEN)}`,
				{ method: "HEAD", headers: authHeaders(accountId) },
			);
			expect(headQuery.status).toBe(401);
			expect(await headQuery.text()).toBe("");
			expectPrivateApiCache(headQuery);

			const cookie = await workerFetch(`http://example.com${path}`, {
				headers: {
					Cookie: `cadmus_session=${encodeURIComponent(`${uniqueAccountId("docs")}:owner:${TEST_TOKEN}`)}`,
				},
			});
			expect(cookie.status).toBe(401);
			expectPrivateApiCache(cookie);
			expect(await cookie.json()).toEqual({
				error: {
					code: "header_required",
					message: expect.any(String),
				},
			});
		}
	});
});
