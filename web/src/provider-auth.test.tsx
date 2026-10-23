import { describe, expect, it } from "bun:test";
import { renderToString } from "react-dom/server";
import type {
	CommandResultFrame,
	CredentialSummary,
	OAuthFlowRecord,
	OAuthProviderInfo,
} from "../../src/protocol.js";
import { CadmusClient, type FetchFunction } from "./client.js";
import { ProviderAuthModal } from "./components/ProviderAuthModal.js";
import { TopBar } from "./components/TopBar.js";
import { CadmusProvider } from "./context/CadmusContext.js";

const TEST_OAUTH_PROVIDERS: OAuthProviderInfo[] = [
	{
		providerId: "xai",
		name: "xAI (Grok)",
		flowType: "device_code",
		loginLabel: "Sign in with SuperGrok or X Premium",
		isSubscription: true,
	},
	{
		providerId: "anthropic",
		name: "Anthropic (Claude)",
		flowType: "browser_code",
		loginLabel: "Sign in with Claude Pro/Max",
		isSubscription: true,
	},
];

const TEST_CREDENTIALS: CredentialSummary[] = [
	{
		providerId: "openai",
		type: "api_key",
		updatedAt: 1700000000000,
	},
];

function createAuthMockClient(
	options: {
		onRpc?: (type: string, payload?: unknown) => unknown;
		oauthProviders?: OAuthProviderInfo[];
		credentials?: CredentialSummary[];
	} = {},
) {
	const mockFetch: FetchFunction = async (_input, init) => {
		const body = JSON.parse(init?.body as string) as {
			id: string;
			type: string;
			payload?: unknown;
		};
		const type = body.type;
		const payload = body.payload;

		if (options.onRpc) {
			const customRes = options.onRpc(type, payload);
			if (customRes !== undefined) {
				const frame: CommandResultFrame = {
					id: body.id,
					type: "command.result",
					command: type,
					ok: true,
					result: customRes,
				};
				return new Response(JSON.stringify(frame));
			}
		}

		let result: unknown = {};
		if (type === "family.list") {
			result = {
				families: [
					{
						accountId: "acc-test",
						familyId: "fam-test",
						doName: "cadmus:acc-test:fam-test",
						name: "Test Family",
						timezone: "UTC",
						harvestDelayMs: 60000,
						createdAt: 1700000000000,
					},
				],
			};
		} else if (type === "family.get") {
			result = {
				family: {
					accountId: "acc-test",
					familyId: "fam-test",
					doName: "cadmus:acc-test:fam-test",
					name: "Test Family",
					timezone: "UTC",
					harvestDelayMs: 60000,
					createdAt: 1700000000000,
				},
			};
		} else if (type === "bot.list") {
			result = { bots: [] };
		} else if (type === "account.models.list") {
			result = { models: [] };
		} else if (type === "account.oauth.providers") {
			result = { providers: options.oauthProviders ?? TEST_OAUTH_PROVIDERS };
		} else if (type === "account.credentials.list") {
			result = { credentials: options.credentials ?? TEST_CREDENTIALS };
		} else if (type === "account.oauth.start") {
			const req = payload as { providerId: string };
			const flow: OAuthFlowRecord = {
				flowId: "oauth_test_flow_123",
				providerId: req.providerId,
				flowType: "device_code",
				status: "pending",
				userCode: "GROK-7777",
				verificationUri: "https://auth.x.ai/activate",
				verificationUriComplete:
					"https://auth.x.ai/activate?user_code=GROK-7777",
				message: "Open https://auth.x.ai/activate and enter code: GROK-7777",
				updatedAt: Date.now(),
			};
			result = { flow };
		} else if (type === "account.oauth.status") {
			const flow: OAuthFlowRecord = {
				flowId: "oauth_test_flow_123",
				providerId: "xai",
				flowType: "device_code",
				status: "completed",
				updatedAt: Date.now(),
			};
			result = { flow };
		} else if (type === "account.oauth.cancel") {
			result = { cancelled: true };
		} else if (type === "account.credentials.set") {
			const req = payload as { providerId: string };
			result = {
				credential: {
					providerId: req.providerId,
					type: "api_key",
					updatedAt: Date.now(),
				},
			};
		} else if (type === "account.credentials.delete") {
			result = { deleted: true };
		}

		const frame: CommandResultFrame = {
			id: body.id,
			type: "command.result",
			command: type,
			ok: true,
			result,
		};
		return new Response(JSON.stringify(frame));
	};

	return new CadmusClient({
		baseUrl: "",
		userId: "test-user",
		accountId: "acc-test",
		familyId: "fam-test",
		token: "test-token",
		fetchImpl: mockFetch,
	});
}

describe("xAI Auth & Credentials Web UI", () => {
	it("1. TopBar includes the AI Providers button", () => {
		const client = createAuthMockClient();
		const html = renderToString(
			<CadmusProvider clientOverride={client}>
				<TopBar />
			</CadmusProvider>,
		);

		expect(html).toContain("🔑 AI Providers");
	});

	it("2. ProviderAuthModal renders provider catalog with xAI OAuth options", () => {
		const client = createAuthMockClient();
		const html = renderToString(
			<CadmusProvider clientOverride={client}>
				<ProviderAuthModal isOpen={true} onClose={() => {}} />
			</CadmusProvider>,
		);

		expect(html).toContain("AI Providers &amp; Authentication");
		expect(html).toContain("xAI (Grok)");
		expect(html).toContain("Recommended");
		expect(html).toContain("Sign in with SuperGrok or X Premium");
		expect(html).toContain("Enter API Key");
	});

	it("3. ProviderAuthModal does not render when isOpen is false", () => {
		const client = createAuthMockClient();
		const html = renderToString(
			<CadmusProvider clientOverride={client}>
				<ProviderAuthModal isOpen={false} onClose={() => {}} />
			</CadmusProvider>,
		);

		expect(html).toBe("");
	});

	it("4. Calls account.oauth.start when initiating xAI login", async () => {
		let oauthStartCalledWith: unknown = null;
		const client = createAuthMockClient({
			onRpc: (type, payload) => {
				if (type === "account.oauth.start") {
					oauthStartCalledWith = payload;
					const flow: OAuthFlowRecord = {
						flowId: "oauth_flow_xai_999",
						providerId: "xai",
						flowType: "device_code",
						status: "pending",
						userCode: "GROK-9999",
						verificationUri: "https://auth.x.ai/activate",
						verificationUriComplete:
							"https://auth.x.ai/activate?user_code=GROK-9999",
						updatedAt: Date.now(),
					};
					return { flow };
				}
				return undefined;
			},
		});

		const res = await client.callRpc<{ flow: OAuthFlowRecord }>(
			"account.oauth.start",
			{ providerId: "xai" },
		);

		expect(res.ok).toBe(true);
		expect(oauthStartCalledWith).toEqual({ providerId: "xai" });
		expect(res.result?.flow.userCode).toBe("GROK-9999");
		expect(res.result?.flow.verificationUri).toBe("https://auth.x.ai/activate");
	});

	it("5. Calls account.credentials.set when saving an API key directly", async () => {
		let credsSetPayload: unknown = null;
		const client = createAuthMockClient({
			onRpc: (type, payload) => {
				if (type === "account.credentials.set") {
					credsSetPayload = payload;
					return {
						credential: {
							providerId: "xai",
							type: "api_key",
							updatedAt: Date.now(),
						},
					};
				}
				return undefined;
			},
		});

		const res = await client.callRpc("account.credentials.set", {
			providerId: "xai",
			credential: { type: "api_key", apiKey: "xai-test-key-abc123" },
		});

		expect(res.ok).toBe(true);
		expect(credsSetPayload).toEqual({
			providerId: "xai",
			credential: { type: "api_key", apiKey: "xai-test-key-abc123" },
		});
	});

	it("6. Calls account.credentials.delete when disconnecting credentials", async () => {
		let deletePayload: unknown = null;
		const client = createAuthMockClient({
			onRpc: (type, payload) => {
				if (type === "account.credentials.delete") {
					deletePayload = payload;
					return { deleted: true };
				}
				return undefined;
			},
		});

		const res = await client.callRpc("account.credentials.delete", {
			providerId: "xai",
		});

		expect(res.ok).toBe(true);
		expect(deletePayload).toEqual({ providerId: "xai" });
	});
});
