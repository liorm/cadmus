import { describe, expect, it } from "bun:test";
import { encodePayloadQuery } from "@cadmus/contract/routes";
import type { ProtocolErrorEvent, ServerEvent } from "@cadmus/contract/types";
import { CadmusClient, type FetchFunction } from "./client.js";

function familyResult() {
	return {
		family: {
			accountId: "default-account",
			familyId: "default",
			doName: "cadmus:default-account:default",
			name: "Default Family",
			timezone: "UTC",
			harvestDelayMs: 60000,
			createdAt: Date.now(),
		},
	};
}

describe("CadmusClient", () => {
	it("1. callRpc sends readonly commands as GET /api with auth headers and query params", async () => {
		let capturedUrl = "";
		let capturedOptions: RequestInit | undefined;

		const mockFetch: FetchFunction = async (input, init) => {
			capturedUrl = String(input);
			capturedOptions = init;
			return new Response(JSON.stringify(familyResult()), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const client = new CadmusClient({
			baseUrl: "",
			token: "dev-cadmus-secret",
			userId: "dev",
			accountId: "default-account",
			familyId: "default",
			fetchImpl: mockFetch,
		});

		const result = await client.callRpc("family.get", { familyId: "default" });

		expect(capturedUrl).toBe("/api/family/get?familyId=default");
		expect(capturedOptions?.method).toBe("GET");
		expect(capturedOptions?.body).toBeUndefined();

		const headers = capturedOptions?.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer dev-cadmus-secret");
		expect(headers["Content-Type"]).toBeUndefined();
		expect(headers["x-user-id"]).toBe("dev");
		expect(headers["x-account-id"]).toBe("default-account");
		expect(headers["X-Cadmus-Family-Id"]).toBe("default");

		expect(result.ok).toBe(true);
		expect(result.type).toBe("command.result");
		expect(result.id.startsWith("cmd-")).toBe(true);
		expect(result.command).toBe("family.get");
		expect(result.result?.family.familyId).toBe("default");
	});

	it("2. concurrent callRpc calls resolve independently via their own HTTP responses", async () => {
		const mockFetch: FetchFunction = async (input) => {
			const url = new URL(String(input), "http://cadmus.test");
			if (url.pathname === "/api/bot/list") {
				await new Promise((r) => setTimeout(r, 20));
				return new Response(
					JSON.stringify({ bots: [{ id: "bot-1", name: "Cadmus Assistant" }] }),
				);
			}
			if (url.pathname === "/api/chat/list") {
				return new Response(
					JSON.stringify({
						chats: [
							{
								key: "main",
								botId: "bot-1",
								conversationId: 1,
								createdAt: Date.now(),
								title: "General",
							},
						],
					}),
				);
			}
			return new Response(JSON.stringify({}));
		};

		const client = new CadmusClient({
			fetchImpl: mockFetch,
		});

		const [botsResult, chatsResult] = await Promise.all([
			client.callRpc("bot.list"),
			client.callRpc("chat.list"),
		]);

		expect(botsResult.ok).toBe(true);
		expect(botsResult.command).toBe("bot.list");
		expect(botsResult.result?.bots[0]?.id).toBe("bot-1");
		expect(botsResult.id).not.toBe(chatsResult.id);

		expect(chatsResult.ok).toBe(true);
		expect(chatsResult.command).toBe("chat.list");
		expect(chatsResult.result?.chats[0]?.key).toBe("main");
	});

	it("3. callRpc normalizes REST error bodies and auth protocol.error frames", async () => {
		const restFetch: FetchFunction = async () => {
			return new Response(
				JSON.stringify({
					error: {
						code: "cas_conflict",
						message: "expectedVersion does not match",
					},
				}),
				{ status: 409 },
			);
		};

		const restClient = new CadmusClient({ fetchImpl: restFetch });
		const rest = await restClient.callRpc("file.write", {
			botId: "scribe",
			path: "MEMORY.md",
			content: "stale",
			expectedVersion: 0,
		});
		expect(rest.ok).toBe(false);
		expect(rest.type).toBe("command.result");
		expect(rest.command).toBe("file.write");
		expect(rest.error).toEqual({
			code: "cas_conflict",
			message: "expectedVersion does not match",
		});

		const authFetch: FetchFunction = async () => {
			const errorFrame: ProtocolErrorEvent = {
				type: "protocol.error",
				payload: {
					code: "unauthorized",
					message: "Missing or invalid authentication token",
				},
			};
			return new Response(JSON.stringify(errorFrame), { status: 401 });
		};
		const auth = await new CadmusClient({ fetchImpl: authFetch }).callRpc(
			"bot.list",
		);
		expect(auth.ok).toBe(false);
		expect(auth.command).toBe("bot.list");
		expect(auth.error).toEqual({
			code: "unauthorized",
			message: "Missing or invalid authentication token",
		});
	});

	it("4. updating setFamilyId('team-alpha') updates the X-Cadmus-Family-Id header on subsequent callRpc calls", async () => {
		let capturedFamilyHeader = "";

		const mockFetch: FetchFunction = async (_input, init) => {
			const headers = init?.headers as Record<string, string>;
			capturedFamilyHeader = headers["X-Cadmus-Family-Id"] ?? "";
			return new Response(JSON.stringify({}));
		};

		const client = new CadmusClient({
			familyId: "default",
			fetchImpl: mockFetch,
		});

		await client.callRpc("family.get", { familyId: "default" });
		expect(capturedFamilyHeader).toBe("default");

		client.setFamilyId("team-alpha");
		expect(client.getFamilyId()).toBe("team-alpha");

		await client.callRpc("bot.list");
		expect(capturedFamilyHeader).toBe("team-alpha");
	});

	it("5. updateConfig updates credentials, headers, and baseUrl correctly", async () => {
		let capturedUrl = "";
		let capturedHeaders: Record<string, string> = {};

		const mockFetch: FetchFunction = async (input, init) => {
			capturedUrl = String(input);
			capturedHeaders = init?.headers as Record<string, string>;
			return new Response(JSON.stringify({ bots: [] }));
		};

		const client = new CadmusClient({
			baseUrl: "http://api.cadmus.local",
			token: "initial-token",
			userId: "initial-user",
			accountId: "initial-account",
			familyId: "initial-family",
			fetchImpl: mockFetch,
		});

		client.updateConfig({
			baseUrl: "http://custom-api.cadmus.local/",
			token: "new-token",
			userId: "new-user",
			accountId: "new-account",
			familyId: "new-family",
		});

		await client.sendCommand("bot.list");

		expect(capturedUrl).toBe("http://custom-api.cadmus.local/api/bot/list");
		expect(capturedHeaders.Authorization).toBe("Bearer new-token");
		expect(capturedHeaders["x-user-id"]).toBe("new-user");
		expect(capturedHeaders["x-account-id"]).toBe("new-account");
		expect(capturedHeaders["X-Cadmus-Family-Id"]).toBe("new-family");
	});

	it("6. event subscription and listener management functions properly", () => {
		const client = new CadmusClient();
		const events: ServerEvent[] = [];

		const unsubscribe = client.subscribe((event) => {
			events.push(event);
		});

		expect(typeof unsubscribe).toBe("function");
		unsubscribe();
	});

	it("7. GET query serialization matches encodePayloadQuery and omits undefined", async () => {
		let capturedUrl = "";
		const mockFetch: FetchFunction = async (input) => {
			capturedUrl = String(input);
			return new Response(JSON.stringify({ schedules: [] }));
		};
		const client = new CadmusClient({ fetchImpl: mockFetch });

		const payload = {
			botId: "scribe",
			includeInternal: false,
			tags: ["alpha", "beta"],
			meta: { n: 2, ok: false },
			limit: 3,
			skipped: undefined,
		};
		await client.callRpc("schedule.list", payload);

		const expected = encodePayloadQuery(payload).toString();
		expect(capturedUrl).toBe(`/api/schedule/list?${expected}`);
		expect(capturedUrl).not.toContain("skipped");
		expect(capturedUrl).toContain("includeInternal=false");
		expect(capturedUrl).toContain("tags=alpha");
		expect(capturedUrl).toContain("tags=beta");
		expect(capturedUrl).toContain("limit=3");
	});

	it("8. mutating commands POST the payload object and keep numbers", async () => {
		let capturedUrl = "";
		let capturedBody = "";
		const mockFetch: FetchFunction = async (input, init) => {
			capturedUrl = String(input);
			capturedBody = String(init?.body ?? "");
			expect(init?.method).toBe("POST");
			const headers = init?.headers as Record<string, string>;
			expect(headers["Content-Type"]).toBe("application/json");
			return new Response(
				JSON.stringify({ path: "MEMORY.md", version: 1, content: "Remember." }),
			);
		};
		const client = new CadmusClient({
			baseUrl: "http://api.cadmus.local",
			fetchImpl: mockFetch,
		});

		const result = await client.callRpc("file.write", {
			botId: "scribe",
			path: "MEMORY.md",
			content: "Remember.",
			expectedVersion: 0,
			description: undefined,
		});

		expect(capturedUrl).toBe("http://api.cadmus.local/api/file/write");
		expect(JSON.parse(capturedBody)).toEqual({
			botId: "scribe",
			path: "MEMORY.md",
			content: "Remember.",
			expectedVersion: 0,
		});
		expect(capturedBody).not.toContain('"type"');
		expect(capturedBody).not.toContain('"id"');
		expect(result.ok).toBe(true);
		expect(result.command).toBe("file.write");
		expect(result.result && "version" in result.result).toBe(true);
		if (result.result && "version" in result.result) {
			expect(result.result.version).toBe(1);
		}
	});

	it("9. fetch throws reject with the original error, and non-JSON bodies reject", async () => {
		const failure = new Error("connection refused");
		const offline = new CadmusClient({
			fetchImpl: async () => {
				throw failure;
			},
		});
		await expect(offline.callRpc("bot.list")).rejects.toBe(failure);

		const html = new CadmusClient({
			fetchImpl: async () =>
				new Response("<html>bad gateway</html>", { status: 502 }),
		});
		await expect(html.callRpc("account.get")).rejects.toThrow(SyntaxError);
	});

	it("10. callRpc sends Authorization and never places the token in the /api URL", async () => {
		const secret = "super-secret-header-token";
		const seen: { url: string; authorization: string }[] = [];
		const mockFetch: FetchFunction = async (input, init) => {
			const headers = init?.headers as Record<string, string>;
			seen.push({
				url: String(input),
				authorization: headers.Authorization ?? "",
			});
			return new Response(JSON.stringify({ bots: [], bot: { id: "a" } }));
		};
		const client = new CadmusClient({ token: secret, fetchImpl: mockFetch });

		await client.callRpc("bot.list");
		await client.callRpc("bot.create", { slug: "a", name: "A" });

		expect(seen).toHaveLength(2);
		for (const call of seen) {
			expect(call.authorization).toBe(`Bearer ${secret}`);
			expect(call.url.startsWith("/api/") || call.url.includes("/api/")).toBe(
				true,
			);
			expect(call.url).not.toContain(secret);
			expect(call.url).not.toContain("token=");
		}
		expect(seen[0]?.url).toBe("/api/bot/list");
		expect(seen[1]?.url).toBe("/api/bot/create");
	});
});
