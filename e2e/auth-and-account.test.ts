import { describe, expect, it } from "vitest";
import {
	type AccountMember,
	type AccountRecord,
	addMemberBearer,
	adminScope,
	type BotRecord,
	type CredentialSummary,
	type FamilyRecord,
	type ModelInfo,
	sendRpc,
	useWorkerFixture,
	workerFetch,
} from "./helpers.js";

const TEST_TOKEN = "rejected-bearer";

describe("Authentication, Accounts, Encrypted BYOK Credentials & Multi-Family Catalog", () => {
	useWorkerFixture();

	it("serves GET /health and GET /protocol/schema without auth", async () => {
		const healthRes = await workerFetch("http://example.com/health");
		expect(healthRes.status).toBe(200);
		const health = (await healthRes.json()) as { ok: boolean; service: string };
		expect(health.ok).toBe(true);
		expect(health.service).toBe("cadmus");

		const schemaRes = await workerFetch("http://example.com/protocol/schema");
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

	it("rejects anonymous requests with 401 and accepts Bearer token and member token, and refuses the session cookie", async () => {
		// 1. Anonymous request rejected
		const anon = await sendRpc("bot.list", {}, { token: "" });
		expect(anon.status).toBe(401);
		expect(anon.frame.ok).toBe(false);
		expect(anon.frame.error?.code).toBe("unauthorized");

		// 2. Invalid Bearer token rejected
		const bad = await sendRpc("bot.list", {}, { token: "wrong-secret" });
		expect(bad.status).toBe(401);
		expect(bad.frame.ok).toBe(false);

		const { accountId, token } = await adminScope();
		const userId = "owner-1";

		// 3. Valid Bearer token accepted
		const valid = await sendRpc<{ bots: BotRecord[] }>(
			"bot.list",
			{},
			{ accountId, token },
		);
		expect(valid.status).toBe(200);
		expect(valid.frame.ok).toBe(true);

		// 4. The cadmus_session cookie is retired as a credential; the same scoped
		// credential in the header is the control.
		const viaCookie = await sendRpc<{ bots: BotRecord[] }>(
			"bot.list",
			{},
			{
				token: "",
				cookie: `cadmus_session=${encodeURIComponent(`${accountId}:${userId}:${TEST_TOKEN}`)}`,
			},
		);
		expect(viaCookie.status).toBe(401);
		const viaScopedHeader = await sendRpc<{ bots: BotRecord[] }>(
			"bot.list",
			{},
			{ token: `${accountId}:${userId}:${TEST_TOKEN}` },
		);
		expect(viaScopedHeader.status).toBe(401);
		expect(viaScopedHeader.frame.ok).toBe(false);

		// 5. Invite a member and authenticate with their dev-password session.
		const member = await addMemberBearer({ accountId });
		expect(member.userId).toBeTruthy();
		expect(member.token.startsWith("cad_at_")).toBe(true);

		const viaMemberToken = await sendRpc<{ members: AccountMember[] }>(
			"account.members.list",
			{},
			{ token: member.token },
		);
		expect(viaMemberToken.status).toBe(200);
		expect(
			viaMemberToken.frame.result?.members.some(
				(m) => m.userId === member.userId,
			),
		).toBe(true);

		// A client-chosen user id is not an identity. The session user is.
		const dev = await adminScope();
		const devRes = await sendRpc<{ members: AccountMember[] }>(
			"account.get",
			{},
			{ token: dev.token, accountId: dev.accountId, userId: "dev" },
		);
		expect(devRes.status).toBe(200);
		expect(devRes.frame.ok).toBe(true);
		expect(
			devRes.frame.result?.members.some((m) => m.userId === dev.userId),
		).toBe(true);
		expect(devRes.frame.result?.members.some((m) => m.userId === "dev")).toBe(
			false,
		);
	});

	it("manages account BYOK credentials without exposing raw keys in list responses", async () => {
		const { accountId, token } = await adminScope();
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
			{ accountId, token },
		);
		expect(setRes.status).toBe(200);
		expect(setRes.frame.result?.credential.providerId).toBe("xai");
		expect(setRes.frame.result?.credential.type).toBe("api_key");

		// Verify listCredentials returns metadata only, never the raw key
		const listRes = await sendRpc<{ credentials: CredentialSummary[] }>(
			"account.credentials.list",
			{},
			{ accountId, token },
		);
		expect(listRes.status).toBe(200);
		expect(listRes.frame.result?.credentials).toHaveLength(1);
		expect(JSON.stringify(listRes.frame.result)).not.toContain(rawSecretKey);

		// Delete credential
		const delRes = await sendRpc<{ deleted: string }>(
			"account.credentials.delete",
			{ providerId: "xai" },
			{ accountId, token },
		);
		expect(delRes.status).toBe(200);
		expect(delRes.frame.result?.deleted).toBe("xai");
	});

	it("lists supported models with authentication status via account.models.list", async () => {
		const { accountId, token } = await adminScope();

		// 1. List all models: faux is authenticated/offline, anthropic is not
		const allModelsRes = await sendRpc<{ models: ModelInfo[] }>(
			"account.models.list",
			{},
			{ accountId, token },
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
			{ accountId, token },
		);
		expect(
			fauxOnlyRes.frame.result?.models.every((m) => m.provider === "faux"),
		).toBe(true);
		expect(fauxOnlyRes.frame.result?.models.length).toBe(1);

		// 3. Filter with onlyAuthenticated: true (only faux before credentials set)
		const authOnlyRes = await sendRpc<{ models: ModelInfo[] }>(
			"account.models.list",
			{ onlyAuthenticated: true },
			{ accountId, token },
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
			{ accountId, token },
		);

		const xaiModelsRes = await sendRpc<{ models: ModelInfo[] }>(
			"account.models.list",
			{ provider: "xai" },
			{ accountId, token },
		);
		const xaiModels = xaiModelsRes.frame.result?.models ?? [];
		expect(xaiModels.length).toBeGreaterThan(0);
		expect(
			xaiModels.every((m) => m.authenticated && m.credentialConfigured),
		).toBe(true);
	});

	it("isolates Bot Families in separate CadmusBotFamilyDO instances within the same account", async () => {
		const { accountId, token } = await adminScope();

		const createAlpha = await sendRpc<{ family: FamilyRecord }>(
			"family.create",
			{
				familyId: "alpha",
				name: "Alpha Team",
				timezone: "America/New_York",
				harvestDelayMs: 30_000,
			},
			{ accountId, token },
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
			{ accountId, token },
		);
		expect(createBeta.status).toBe(200);
		expect(createBeta.frame.result?.family.doName).toBe(
			`cadmus:${accountId}:beta`,
		);

		// Create a bot in Alpha
		await sendRpc(
			"bot.create",
			{ slug: "alpha-bot", name: "Alpha Bot" },
			{ accountId, token, familyId: "alpha" },
		);

		// Alpha has alpha-bot, Beta has 0 bots
		const alphaBots = await sendRpc<{ bots: BotRecord[] }>(
			"bot.list",
			{},
			{ accountId, token, familyId: "alpha" },
		);
		const betaBots = await sendRpc<{ bots: BotRecord[] }>(
			"bot.list",
			{},
			{ accountId, token, familyId: "beta" },
		);
		expect(alphaBots.frame.result?.bots.map((b) => b.id)).toEqual([
			"alpha-bot",
		]);
		expect(betaBots.frame.result?.bots).toEqual([]);
	});

	it("updates account timezone and display name, and new bots inherit account timezone", async () => {
		const { accountId, token } = await adminScope();
		const scope = { accountId, token, familyId: "default" };

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
