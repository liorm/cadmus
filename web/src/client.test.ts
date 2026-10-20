import { describe, expect, it } from "bun:test";
import type {
	CommandResultFrame,
	ProtocolErrorEvent,
	ServerEvent,
} from "../../src/protocol.js";
import { CadmusClient, type FetchFunction } from "./client.js";

describe("CadmusClient", () => {
	it("1. callRpc acts as a true HTTP POST /rpc request-response with correct headers and payload", async () => {
		let capturedUrl = "";
		let capturedOptions: RequestInit | undefined;

		const mockFetch: FetchFunction = async (input, init) => {
			capturedUrl = String(input);
			capturedOptions = init;
			const body = JSON.parse(init?.body as string);

			const responseFrame: CommandResultFrame = {
				id: body.id,
				type: "command.result",
				command: body.type,
				ok: true,
				result: {
					family: {
						accountId: "default-account",
						familyId: "default",
						doName: "cadmus:default-account:default",
						name: "Default Family",
						timezone: "UTC",
						harvestDelayMs: 60000,
						createdAt: Date.now(),
					},
				},
			};

			return new Response(JSON.stringify(responseFrame), {
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

		expect(capturedUrl).toBe("/rpc");
		expect(capturedOptions?.method).toBe("POST");

		const headers = capturedOptions?.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer dev-cadmus-secret");
		expect(headers["Content-Type"]).toBe("application/json");
		expect(headers["x-user-id"]).toBe("dev");
		expect(headers["x-account-id"]).toBe("default-account");
		expect(headers["X-Cadmus-Family-Id"]).toBe("default");

		const parsedBody = JSON.parse(capturedOptions?.body as string);
		expect(parsedBody.type).toBe("family.get");
		expect(parsedBody.payload).toEqual({ familyId: "default" });
		expect(typeof parsedBody.id).toBe("string");

		expect(result.ok).toBe(true);
		expect(result.id).toBe(parsedBody.id);
		expect(result.command).toBe("family.get");
		expect(
			(result.result as { family: { familyId: string } }).family.familyId,
		).toBe("default");
	});

	it("2. concurrent callRpc calls resolve independently via their own HTTP responses without correlation state", async () => {
		const mockFetch: FetchFunction = async (_input, init) => {
			const body = JSON.parse(init?.body as string);

			if (body.type === "bot.list") {
				// Artificial delay to verify resolution order independence
				await new Promise((r) => setTimeout(r, 20));
				const responseFrame: CommandResultFrame = {
					id: body.id,
					type: "command.result",
					command: "bot.list",
					ok: true,
					result: { bots: [{ id: "bot-1", name: "Cadmus Assistant" }] },
				};
				return new Response(JSON.stringify(responseFrame));
			}

			if (body.type === "chat.list") {
				const responseFrame: CommandResultFrame = {
					id: body.id,
					type: "command.result",
					command: "chat.list",
					ok: true,
					result: {
						chats: [
							{
								key: "main",
								botId: "bot-1",
								conversationId: 1,
								createdAt: Date.now(),
								title: "General",
							},
						],
					},
				};
				return new Response(JSON.stringify(responseFrame));
			}

			return new Response(
				JSON.stringify({
					id: body.id,
					type: "command.result",
					command: body.type,
					ok: true,
				}),
			);
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
		expect(
			(botsResult.result as { bots: Array<{ id: string }> }).bots[0]?.id,
		).toBe("bot-1");

		expect(chatsResult.ok).toBe(true);
		expect(chatsResult.command).toBe("chat.list");
		expect(
			(chatsResult.result as { chats: Array<{ key: string }> }).chats[0]?.key,
		).toBe("main");
	});

	it("3. callRpc converts a protocol.error HTTP response frame into { ok: false, error } CommandResultFrame", async () => {
		const mockFetch: FetchFunction = async (_input, init) => {
			const body = JSON.parse(init?.body as string);
			const errorFrame: ProtocolErrorEvent = {
				id: body.id,
				type: "protocol.error",
				payload: {
					code: "UNAUTHORIZED",
					message: "Invalid or expired token",
				},
			};
			return new Response(JSON.stringify(errorFrame), { status: 401 });
		};

		const client = new CadmusClient({
			fetchImpl: mockFetch,
		});

		const result = await client.callRpc("bot.list");

		expect(result.ok).toBe(false);
		expect(result.type).toBe("command.result");
		expect(result.command).toBe("bot.list");
		expect(result.error).toEqual({
			code: "UNAUTHORIZED",
			message: "Invalid or expired token",
		});
	});

	it("4. updating setFamilyId('team-alpha') updates the X-Cadmus-Family-Id header on subsequent callRpc calls", async () => {
		let capturedFamilyHeader = "";

		const mockFetch: FetchFunction = async (_input, init) => {
			const headers = init?.headers as Record<string, string>;
			capturedFamilyHeader = headers["X-Cadmus-Family-Id"] ?? "";
			const body = JSON.parse(init?.body as string);
			return new Response(
				JSON.stringify({
					id: body.id,
					type: "command.result",
					command: body.type,
					ok: true,
					result: {},
				}),
			);
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
			const body = JSON.parse(init?.body as string);
			return new Response(
				JSON.stringify({
					id: body.id,
					type: "command.result",
					command: body.type,
					ok: true,
					result: {},
				}),
			);
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
			baseUrl: "http://custom-api.cadmus.local",
			token: "new-token",
			userId: "new-user",
			accountId: "new-account",
			familyId: "new-family",
		});

		await client.sendCommand("bot.list");

		expect(capturedUrl).toBe("http://custom-api.cadmus.local/rpc");
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

		// Listeners can be registered and unregistered cleanly
		expect(typeof unsubscribe).toBe("function");
		unsubscribe();
	});
});
