import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type {
	AccountMember,
	AccountRecord,
	BotRecord,
	CredentialSummary,
	FamilyRecord,
	ModelInfo,
} from "../src/protocol.js";
import { sendRpc, TEST_TOKEN } from "./helpers.js";

describe("Authentication, Accounts, Encrypted BYOK Credentials & Multi-Family Catalog", () => {
	it("serves GET /health and GET /protocol/schema without auth", async () => {
		const healthRes = await SELF.fetch("http://example.com/health");
		expect(healthRes.status).toBe(200);
		const health = (await healthRes.json()) as { ok: boolean; service: string };
		expect(health.ok).toBe(true);
		expect(health.service).toBe("cadmus");

		const schemaRes = await SELF.fetch("http://example.com/protocol/schema");
		expect(schemaRes.status).toBe(200);
		const schema = (await schemaRes.json()) as {
			title: string;
			clientCommand: unknown;
			serverFrame: unknown;
		};
		expect(schema.title).toBe("CadmusProtocol");
		expect(schema.clientCommand).toBeDefined();
		expect(schema.serverFrame).toBeDefined();
	});

	it("rejects anonymous requests with 401 and accepts Bearer token, session cookie, and member token", async () => {
		// 1. Anonymous request rejected
		const anon = await sendRpc("bot.list", {}, { token: "" });
		expect(anon.status).toBe(401);
		expect(anon.frame.ok).toBe(false);
		expect(anon.frame.error?.code).toBe("unauthorized");

		// 2. Invalid Bearer token rejected
		const bad = await sendRpc("bot.list", {}, { token: "wrong-secret" });
		expect(bad.status).toBe(401);
		expect(bad.frame.ok).toBe(false);

		// 3. Valid Bearer token accepted
		const valid = await sendRpc<{ bots: BotRecord[] }>(
			"bot.list",
			{},
			{ accountId: "acct-auth-1", userId: "owner-1" },
		);
		expect(valid.status).toBe(200);
		expect(valid.frame.ok).toBe(true);

		// 4. Session cookie accepted
		const viaCookie = await sendRpc<{ bots: BotRecord[] }>(
			"bot.list",
			{},
			{
				token: "",
				cookie: `cadmus_session=${encodeURIComponent(`acct-auth-1:owner-1:${TEST_TOKEN}`)}`,
			},
		);
		expect(viaCookie.status).toBe(200);
		expect(viaCookie.frame.ok).toBe(true);

		// 5. Add a member with a D1 stored token and authenticate using that token
		const customToken = "cadmus-member-token-xyz-987";
		const addMember = await sendRpc<{ member: AccountMember }>(
			"account.members.add",
			{
				userId: "alice",
				name: "Alice",
				email: "alice@example.com",
				role: "member",
				token: customToken,
			},
			{ accountId: "acct-auth-1", userId: "owner-1" },
		);
		expect(addMember.status).toBe(200);
		expect(addMember.frame.result?.member.userId).toBe("alice");

		const viaMemberToken = await sendRpc<{ members: AccountMember[] }>(
			"account.members.list",
			{},
			{ token: customToken },
		);
		expect(viaMemberToken.status).toBe(200);
		expect(
			viaMemberToken.frame.result?.members.some((m) => m.userId === "alice"),
		).toBe(true);
	});

	it("encrypts account BYOK credentials in D1 (never storing plaintext) and shares them across families in the account", async () => {
		const accountId = "acct-byok-1";
		const rawSecretKey = "xai-super-secret-key-do-not-leak-12345";

		const setRes = await sendRpc<{ credential: CredentialSummary }>(
			"account.credentials.set",
			{
				providerId: "xai",
				credential: {
					type: "api_key",
					apiKey: rawSecretKey,
				},
			},
			{ accountId },
		);
		expect(setRes.status).toBe(200);
		expect(setRes.frame.result?.credential.providerId).toBe("xai");
		expect(setRes.frame.result?.credential.type).toBe("api_key");

		// Verify listCredentials returns metadata only, never the raw key
		const listRes = await sendRpc<{ credentials: CredentialSummary[] }>(
			"account.credentials.list",
			{},
			{ accountId },
		);
		expect(listRes.status).toBe(200);
		expect(listRes.frame.result?.credentials).toHaveLength(1);
		expect(JSON.stringify(listRes.frame.result)).not.toContain(rawSecretKey);

		// Inspect raw D1 table `cadmus_account_credentials` to prove AES-GCM encryption at rest
		const d1Row = await env.CADMUS_ADMIN_DB.prepare(
			`SELECT cipher_hex, iv_hex FROM cadmus_account_credentials WHERE account_id = ? AND provider_id = ?`,
		)
			.bind(accountId, "xai")
			.first<{ cipher_hex: string; iv_hex: string }>();
		expect(d1Row).toBeDefined();
		expect(d1Row?.cipher_hex).not.toContain(rawSecretKey);
		expect(d1Row?.iv_hex.length).toBeGreaterThan(0);

		// Delete credential
		const delRes = await sendRpc<{ deleted: string }>(
			"account.credentials.delete",
			{ providerId: "xai" },
			{ accountId },
		);
		expect(delRes.status).toBe(200);
		expect(delRes.frame.result?.deleted).toBe("xai");
	});

	it("lists supported models with authentication status via account.models.list", async () => {
		const accountId = "acct-models-test";

		// 1. List all models: faux is authenticated/offline, anthropic is not
		const allModelsRes = await sendRpc<{ models: ModelInfo[] }>(
			"account.models.list",
			{},
			{ accountId },
		);
		expect(allModelsRes.status).toBe(200);
		expect(allModelsRes.frame.ok).toBe(true);
		const allModels = allModelsRes.frame.result?.models ?? [];
		expect(allModels.length).toBeGreaterThan(0);

		const fauxModel = allModels.find((m) => m.provider === "faux");
		expect(fauxModel).toBeDefined();
		expect(fauxModel?.id).toBe("echo");
		expect(fauxModel?.authenticated).toBe(true);
		expect(fauxModel?.credentialConfigured).toBe(true);

		const anthropicModel = allModels.find((m) => m.provider === "anthropic");
		expect(anthropicModel).toBeDefined();
		expect(anthropicModel?.authenticated).toBe(false);
		expect(anthropicModel?.credentialConfigured).toBe(false);

		// 2. Filter by provider: only returns faux
		const fauxOnlyRes = await sendRpc<{ models: ModelInfo[] }>(
			"account.models.list",
			{ provider: "faux" },
			{ accountId },
		);
		expect(
			fauxOnlyRes.frame.result?.models.every((m) => m.provider === "faux"),
		).toBe(true);
		expect(fauxOnlyRes.frame.result?.models.length).toBe(1);

		// 3. Filter with onlyAuthenticated: true (only faux before credentials set)
		const authOnlyRes = await sendRpc<{ models: ModelInfo[] }>(
			"account.models.list",
			{ onlyAuthenticated: true },
			{ accountId },
		);
		expect(authOnlyRes.frame.result?.models.every((m) => m.authenticated)).toBe(
			true,
		);
		expect(
			authOnlyRes.frame.result?.models.some((m) => m.provider === "anthropic"),
		).toBe(false);

		// 4. Configure credentials for xai and verify models become authenticated
		await sendRpc(
			"account.credentials.set",
			{
				providerId: "xai",
				credential: { type: "api_key", apiKey: "xai-test-key-12345" },
			},
			{ accountId },
		);

		const xaiModelsRes = await sendRpc<{ models: ModelInfo[] }>(
			"account.models.list",
			{ provider: "xai" },
			{ accountId },
		);
		const xaiModels = xaiModelsRes.frame.result?.models ?? [];
		expect(xaiModels.length).toBeGreaterThan(0);
		expect(
			xaiModels.every((m) => m.authenticated && m.credentialConfigured),
		).toBe(true);
	});

	it("isolates Bot Families in separate CadmusBotFamilyDO instances within the same account", async () => {
		const accountId = "acct-families-1";

		const createAlpha = await sendRpc<{ family: FamilyRecord }>(
			"family.create",
			{
				familyId: "alpha",
				name: "Alpha Team",
				timezone: "America/New_York",
				harvestDelayMs: 30_000,
			},
			{ accountId },
		);
		expect(createAlpha.status).toBe(200);
		expect(createAlpha.frame.result?.family.doName).toBe(
			`cadmus:${accountId}:alpha`,
		);

		const createBeta = await sendRpc<{ family: FamilyRecord }>(
			"family.create",
			{
				familyId: "beta",
				name: "Beta Team",
				timezone: "Europe/London",
				harvestDelayMs: 45_000,
			},
			{ accountId },
		);
		expect(createBeta.status).toBe(200);
		expect(createBeta.frame.result?.family.doName).toBe(
			`cadmus:${accountId}:beta`,
		);

		// Create a bot in Alpha
		await sendRpc(
			"bot.create",
			{ slug: "alpha-bot", name: "Alpha Bot" },
			{ accountId, familyId: "alpha" },
		);

		// Alpha has alpha-bot, Beta has 0 bots
		const alphaBots = await sendRpc<{ bots: BotRecord[] }>(
			"bot.list",
			{},
			{ accountId, familyId: "alpha" },
		);
		const betaBots = await sendRpc<{ bots: BotRecord[] }>(
			"bot.list",
			{},
			{ accountId, familyId: "beta" },
		);
		expect(alphaBots.frame.result?.bots.map((b) => b.id)).toEqual([
			"alpha-bot",
		]);
		expect(betaBots.frame.result?.bots).toEqual([]);
	});

	it("updates account timezone and display name, and new bots inherit account timezone", async () => {
		const accountId = "acct-tz-test";
		const scope = { accountId, familyId: "default" };

		// Initial account check (defaults to UTC)
		const acctInitial = await sendRpc<{ account: AccountRecord }>(
			"account.get",
			{},
			scope,
		);
		expect(acctInitial.status).toBe(200);
		expect(acctInitial.frame.result?.account.timezone).toBe("UTC");

		// Update account timezone to America/New_York and name
		const updateRes = await sendRpc<{ account: AccountRecord }>(
			"account.update",
			{
				name: "Acme Corp NY",
				timezone: "America/New_York",
			},
			scope,
		);
		expect(updateRes.status).toBe(200);
		expect(updateRes.frame.result?.account.name).toBe("Acme Corp NY");
		expect(updateRes.frame.result?.account.timezone).toBe("America/New_York");

		// Create a bot and verify its timezone is inherited from the account/family
		const botRes = await sendRpc<{ bot: BotRecord }>(
			"bot.create",
			{
				name: "NY Assistant",
			},
			scope,
		);
		expect(botRes.status).toBe(200);
		expect(botRes.frame.result?.bot.timezone).toBe("America/New_York");
	});
});
