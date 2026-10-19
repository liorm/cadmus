import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
	CredentialSummary,
	OAuthFlowRecord,
	OAuthProviderInfo,
} from "../src/protocol.js";
import { connectTestWs, sendRpc } from "./helpers.js";

describe("Generic OAuth Protocol & xAI Device Code Flow", () => {
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		// Intercept outbound calls to xAI OAuth endpoints while passing through all other requests
		globalThis.fetch = async (
			input: string | URL | Request,
			init?: RequestInit,
		): Promise<Response> => {
			const urlStr =
				typeof input === "string"
					? input
					: input instanceof URL
						? input.toString()
						: input.url;

			if (urlStr.includes("auth.x.ai/oauth2/device/code")) {
				return new Response(
					JSON.stringify({
						device_code: "xai-mock-device-code-12345",
						user_code: "GROK-7777",
						verification_uri: "https://auth.x.ai/activate",
						verification_uri_complete:
							"https://auth.x.ai/activate?user_code=GROK-7777",
						expires_in: 600,
						interval: 0.05, // fast polling for tests
					}),
					{
						status: 200,
						headers: { "Content-Type": "application/json" },
					},
				);
			}

			if (urlStr.includes("auth.x.ai/oauth2/token")) {
				// Read body to check grant_type
				const bodyText =
					typeof init?.body === "string"
						? init.body
						: init?.body instanceof URLSearchParams
							? init.body.toString()
							: "";

				if (bodyText.includes("device_code")) {
					return new Response(
						JSON.stringify({
							access_token: "xai-oauth-access-token-live-abc",
							refresh_token: "xai-oauth-refresh-token-live-xyz",
							expires_in: 3600,
							token_type: "Bearer",
						}),
						{
							status: 200,
							headers: { "Content-Type": "application/json" },
						},
					);
				}

				if (bodyText.includes("refresh_token")) {
					return new Response(
						JSON.stringify({
							access_token: "xai-oauth-access-token-refreshed",
							refresh_token: "xai-oauth-refresh-token-refreshed",
							expires_in: 3600,
							token_type: "Bearer",
						}),
						{
							status: 200,
							headers: { "Content-Type": "application/json" },
						},
					);
				}
			}

			return originalFetch(input, init);
		};
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("discovers available OAuth providers including xAI with device_code flowType", async () => {
		const res = await sendRpc<{ providers: OAuthProviderInfo[] }>(
			"account.oauth.providers",
			{},
			{ accountId: "acct-oauth-discover" },
		);

		expect(res.status).toBe(200);
		expect(res.frame.ok).toBe(true);
		expect(res.frame.result).toBeDefined();
		if (!res.frame.result) throw new Error("expected result");

		const { providers } = res.frame.result;
		expect(Array.isArray(providers)).toBe(true);

		const xai = providers.find((p) => p.providerId === "xai");
		expect(xai).toBeDefined();
		expect(xai?.flowType).toBe("device_code");
		expect(xai?.isSubscription).toBe(true);
		expect(xai?.name).toContain("xAI");
		expect(xai?.loginLabel).toBe("Sign in with SuperGrok or X Premium");
	});

	it("runs the xAI device-code flow, stores encrypted OAuth credentials in D1, and updates account", async () => {
		const accountId = "acct-oauth-flow-1";

		// 1. Start OAuth flow
		const startRes = await sendRpc<{ flow: OAuthFlowRecord }>(
			"account.oauth.start",
			{ providerId: "xai" },
			{ accountId },
		);

		expect(startRes.status).toBe(200);
		expect(startRes.frame.ok).toBe(true);
		expect(startRes.frame.result).toBeDefined();
		if (!startRes.frame.result) throw new Error("expected start result");

		const { flow } = startRes.frame.result;
		expect(flow.flowId).toMatch(/^oauth_/);
		expect(flow.providerId).toBe("xai");
		expect(flow.flowType).toBe("device_code");
		expect(flow.userCode).toBe("GROK-7777");
		expect(flow.verificationUri).toBe("https://auth.x.ai/activate");
		expect(flow.verificationUriComplete).toBe(
			"https://auth.x.ai/activate?user_code=GROK-7777",
		);

		// 2. Wait slightly for background poll to resolve & persist
		let statusRes = await sendRpc<{ flow: OAuthFlowRecord }>(
			"account.oauth.status",
			{ flowId: flow.flowId },
			{ accountId },
		);

		const deadline = Date.now() + 2500;
		while (
			Date.now() < deadline &&
			statusRes.frame.result?.flow.status !== "completed"
		) {
			await new Promise((r) => setTimeout(r, 100));
			statusRes = await sendRpc<{ flow: OAuthFlowRecord }>(
				"account.oauth.status",
				{ flowId: flow.flowId },
				{ accountId },
			);
		}

		expect(statusRes.frame.result?.flow.status).toBe("completed");
		expect(statusRes.frame.result?.flow.credential?.providerId).toBe("xai");
		expect(statusRes.frame.result?.flow.credential?.type).toBe("oauth");

		// 3. Verify credentials list returns OAuth credential
		const credsRes = await sendRpc<{ credentials: CredentialSummary[] }>(
			"account.credentials.list",
			{},
			{ accountId },
		);
		expect(credsRes.status).toBe(200);
		const xaiCred = credsRes.frame.result?.credentials.find(
			(c) => c.providerId === "xai",
		);
		expect(xaiCred).toBeDefined();
		expect(xaiCred?.type).toBe("oauth");

		// 4. Inspect D1 database: check that cred_type is 'oauth' and encrypted
		const d1Row = await env.CADMUS_ADMIN_DB.prepare(
			`SELECT cred_type, cipher_hex, iv_hex FROM cadmus_account_credentials WHERE account_id = ? AND provider_id = ?`,
		)
			.bind(accountId, "xai")
			.first<{ cred_type: string; cipher_hex: string; iv_hex: string }>();

		expect(d1Row).toBeDefined();
		expect(d1Row?.cred_type).toBe("oauth");
		expect(d1Row?.cipher_hex).not.toContain("xai-oauth-access-token");
		expect(d1Row?.iv_hex.length).toBeGreaterThan(0);
	});

	it("broadcasts account.oauth.event and account.event frames over WebSocket", async () => {
		const accountId = "acct-oauth-ws";
		const testWs = await connectTestWs({ accountId });

		try {
			const startRes = await testWs.send<{ flow: OAuthFlowRecord }>(
				"account.oauth.start",
				{ providerId: "xai" },
			);

			expect(startRes.ok).toBe(true);
			expect(startRes.result?.flow.userCode).toBe("GROK-7777");

			// Wait for completion event in WebSocket event stream (device-code poller waits >= 1s)
			const wsDeadline = Date.now() + 2500;
			while (
				Date.now() < wsDeadline &&
				!testWs.events.some(
					(e) =>
						e.type === "account.oauth.event" &&
						(e.payload as OAuthFlowRecord).status === "completed",
				)
			) {
				await new Promise((r) => setTimeout(r, 100));
			}

			const oauthEvents = testWs.events.filter(
				(e) => e.type === "account.oauth.event",
			);
			expect(oauthEvents.length).toBeGreaterThan(0);

			const completedEvent = oauthEvents.find(
				(e) =>
					e.type === "account.oauth.event" &&
					(e.payload as OAuthFlowRecord).status === "completed",
			);
			expect(completedEvent).toBeDefined();

			const accountEvents = testWs.events.filter(
				(e) =>
					e.type === "account.event" &&
					(e.payload as { action: string }).action === "credential.set",
			);
			expect(accountEvents.length).toBeGreaterThan(0);
		} finally {
			testWs.close();
		}
	});

	it("cancels an in-flight OAuth flow when requested", async () => {
		const accountId = "acct-oauth-cancel";

		// Set up endpoint that hangs (does not return token immediately)
		globalThis.fetch = async (
			input: string | URL | Request,
			init?: RequestInit,
		): Promise<Response> => {
			const urlStr = typeof input === "string" ? input : input.toString();
			if (urlStr.includes("auth.x.ai/oauth2/device/code")) {
				return new Response(
					JSON.stringify({
						device_code: "xai-mock-hang-code",
						user_code: "HANG-9999",
						verification_uri: "https://auth.x.ai/activate",
						expires_in: 600,
						interval: 5,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (urlStr.includes("auth.x.ai/oauth2/token")) {
				// Returns authorization_pending
				return new Response(
					JSON.stringify({ error: "authorization_pending" }),
					{ status: 400, headers: { "Content-Type": "application/json" } },
				);
			}
			return originalFetch(input, init);
		};

		const startRes = await sendRpc<{ flow: OAuthFlowRecord }>(
			"account.oauth.start",
			{ providerId: "xai" },
			{ accountId },
		);

		expect(startRes.frame.ok).toBe(true);
		expect(startRes.frame.result).toBeDefined();
		if (!startRes.frame.result) throw new Error("expected start result");
		const flowId = startRes.frame.result.flow.flowId;

		// Cancel the flow
		const cancelRes = await sendRpc<{
			flow: OAuthFlowRecord;
			cancelled: boolean;
		}>("account.oauth.cancel", { flowId }, { accountId });

		expect(cancelRes.status).toBe(200);
		expect(cancelRes.frame.ok).toBe(true);
		expect(cancelRes.frame.result?.cancelled).toBe(true);
		expect(cancelRes.frame.result?.flow.status).toBe("cancelled");

		// Status query also shows cancelled
		const statusRes = await sendRpc<{ flow: OAuthFlowRecord }>(
			"account.oauth.status",
			{ flowId },
			{ accountId },
		);
		expect(statusRes.frame.result?.flow.status).toBe("cancelled");
	});

	it("rejects unknown OAuth providers cleanly with an error frame", async () => {
		const res = await sendRpc<{ flow: OAuthFlowRecord }>(
			"account.oauth.start",
			{ providerId: "unknown-provider-xyz" },
			{ accountId: "acct-oauth-err" },
		);

		expect(res.status).toBe(400);
		expect(res.frame.ok).toBe(false);
		expect(res.frame.error?.message).toContain("not found");
	});
});
