import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type {
	CredentialSummary,
	FamilyRecord,
} from "../packages/worker/src/protocol.js";
import {
	clearAesKeyCache,
	toDoName,
} from "../packages/worker/src/store/d1-admin.js";
import { sendRpc, uniqueAccountId } from "./helpers.js";

describe("Credential In-Memory Caching & Cross-DO Cache Busting", () => {
	it("caches decrypted credentials in DO memory and serves subsequent reads from cache", async () => {
		const accountId = uniqueAccountId("cred-cache");
		const familyId = "default";
		const rawKey = "sk-initial-secret-12345";

		// 1. Set credential via RPC
		const setRes = await sendRpc<{ credential: CredentialSummary }>(
			"account.credentials.set",
			{
				providerId: "openai",
				credential: {
					type: "api_key",
					apiKey: rawKey,
				},
			},
			{ accountId, familyId },
		);
		expect(setRes.status).toBe(200);

		// Get DO stub
		const doName = toDoName(accountId, familyId);
		const doId = env.CADMUS_BOT_FAMILY.idFromName(doName);
		const stub = env.CADMUS_BOT_FAMILY.get(doId);

		// Initially after set, local cache was invalidated
		expect(await stub.hasCachedCredential("openai")).toBe(false);

		// First read fetches from D1 and populates cache
		const firstRead = await stub.readCredential("openai");
		expect(firstRead).toBeDefined();
		expect(firstRead?.type).toBe("api_key");
		expect((firstRead as { key: string }).key).toBe(rawKey);
		expect(await stub.hasCachedCredential("openai")).toBe(true);
		expect(await stub.getCredentialCacheSize()).toBe(1);

		// Second read serves from memory cache
		const secondRead = await stub.readCredential("openai");
		expect(secondRead).toEqual(firstRead);

		// Invalidate cache explicitly via RPC method
		await stub.invalidateCredentialCache("openai");
		expect(await stub.hasCachedCredential("openai")).toBe(false);

		// Test internal endpoint invalidation route
		await stub.readCredential("openai");
		expect(await stub.hasCachedCredential("openai")).toBe(true);

		const invRes = await stub.fetch(
			"https://cadmus.internal/__internal/credentials/invalidate",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ providerId: "openai" }),
			},
		);
		expect(invRes.status).toBe(200);
		expect(await stub.hasCachedCredential("openai")).toBe(false);
	});

	it("busts credential cache across all family DOs in the account when credentials change", async () => {
		const accountId = uniqueAccountId("cred-cross-do");

		// 1. Create two families in the same account
		const resAlpha = await sendRpc<{ family: FamilyRecord }>(
			"family.create",
			{
				familyId: "team-alpha",
				name: "Team Alpha",
				timezone: "UTC",
			},
			{ accountId },
		);
		expect(resAlpha.status).toBe(200);

		const resBeta = await sendRpc<{ family: FamilyRecord }>(
			"family.create",
			{
				familyId: "team-beta",
				name: "Team Beta",
				timezone: "UTC",
			},
			{ accountId },
		);
		expect(resBeta.status).toBe(200);

		const stubAlpha = env.CADMUS_BOT_FAMILY.get(
			env.CADMUS_BOT_FAMILY.idFromName(toDoName(accountId, "team-alpha")),
		);
		const stubBeta = env.CADMUS_BOT_FAMILY.get(
			env.CADMUS_BOT_FAMILY.idFromName(toDoName(accountId, "team-beta")),
		);

		// 2. Set initial credential
		await sendRpc(
			"account.credentials.set",
			{
				providerId: "anthropic",
				credential: {
					type: "api_key",
					apiKey: "sk-ant-v1-key",
				},
			},
			{ accountId, familyId: "team-alpha" },
		);

		// 3. Read credential on both DOs -> both caches are populated
		const readAlpha1 = await stubAlpha.readCredential("anthropic");
		const readBeta1 = await stubBeta.readCredential("anthropic");
		expect((readAlpha1 as { key: string }).key).toBe("sk-ant-v1-key");
		expect((readBeta1 as { key: string }).key).toBe("sk-ant-v1-key");

		expect(await stubAlpha.hasCachedCredential("anthropic")).toBe(true);
		expect(await stubBeta.hasCachedCredential("anthropic")).toBe(true);

		// 4. Update credential via family-alpha
		const updateRes = await sendRpc(
			"account.credentials.set",
			{
				providerId: "anthropic",
				credential: {
					type: "api_key",
					apiKey: "sk-ant-v2-updated-key",
				},
			},
			{ accountId, familyId: "team-alpha" },
		);
		expect(updateRes.status).toBe(200);

		// 5. Verify both Alpha and Beta had their in-memory cache busted!
		expect(await stubAlpha.hasCachedCredential("anthropic")).toBe(false);
		expect(await stubBeta.hasCachedCredential("anthropic")).toBe(false);

		// 6. When Beta reads next, it fetches the updated v2 key from D1
		const readBeta2 = await stubBeta.readCredential("anthropic");
		expect((readBeta2 as { key: string }).key).toBe("sk-ant-v2-updated-key");
		expect(await stubBeta.hasCachedCredential("anthropic")).toBe(true);

		// 7. Delete credential via family-beta
		const delRes = await sendRpc(
			"account.credentials.delete",
			{ providerId: "anthropic" },
			{ accountId, familyId: "team-beta" },
		);
		expect(delRes.status).toBe(200);

		// 8. Verify both Alpha and Beta had their cache busted and read returns undefined
		expect(await stubAlpha.hasCachedCredential("anthropic")).toBe(false);
		expect(await stubBeta.hasCachedCredential("anthropic")).toBe(false);

		const readAlphaDeleted = await stubAlpha.readCredential("anthropic");
		const readBetaDeleted = await stubBeta.readCredential("anthropic");
		expect(readAlphaDeleted).toBeUndefined();
		expect(readBetaDeleted).toBeUndefined();
	});

	it("supports clearing and reusing derived AES key cache", () => {
		clearAesKeyCache();
		// Can be called repeatedly without error
		clearAesKeyCache();
	});
});
