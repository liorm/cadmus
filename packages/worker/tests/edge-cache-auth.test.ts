import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
	clearEnsuredMasterUsers,
	EdgeCache,
	getEdgeCache,
	sha256Hex,
} from "../src/edge-cache.js";
import type {
	AccountMember,
	BotRecord,
	FamilyRecord,
} from "../src/protocol.js";
import { D1AdminStore } from "../src/store/d1-admin.js";
import {
	addLegacyMember,
	connectTestWs,
	sendRpc,
	TEST_TOKEN,
	uniqueAccountId,
} from "./helpers.js";

describe("Edge Caching for Tokens and Family DO Routing (Issue #19)", () => {
	beforeEach(() => {
		EdgeCache.clearAllMemory();
		clearEnsuredMasterUsers();
		const cache = getEdgeCache(env);
		cache.resetMetrics();
	});

	it("repeated /rpc with a member token hits D1 auth tokens only once within TTL", async () => {
		const accountId = uniqueAccountId("cache");
		const customToken = crypto.randomUUID();

		// 1. Add member with a token
		const addRes = await addLegacyMember({
			userId: "cached-user-1",
			name: "Cached User",
			role: "member",
			accountId: accountId,
			token: customToken,
		});
		expect(addRes.userId).toBe("cached-user-1");

		// Clear memory cache so we start cold
		EdgeCache.clearAllMemory();
		const edgeCache = getEdgeCache(env);
		edgeCache.resetMetrics();

		// Count D1 queries matching cadmus_auth_tokens
		let d1TokenQueries = 0;
		const originalPrepare = env.CADMUS_ADMIN_DB.prepare.bind(
			env.CADMUS_ADMIN_DB,
		);
		env.CADMUS_ADMIN_DB.prepare = ((query: string) => {
			if (query.includes("SELECT") && query.includes("cadmus_auth_tokens")) {
				d1TokenQueries++;
			}
			return originalPrepare(query);
		}) as typeof env.CADMUS_ADMIN_DB.prepare;

		try {
			// First call with member token -> cache miss, hits D1
			const res1 = await sendRpc<{ bots: BotRecord[] }>(
				"bot.list",
				{},
				{ token: customToken, accountId },
			);
			expect(res1.status).toBe(200);
			expect(res1.frame.ok).toBe(true);
			expect(d1TokenQueries).toBe(1);
			expect(edgeCache.getMetrics().tokenL1Hits).toBe(0);
			expect(edgeCache.getMetrics().tokenMisses).toBe(1);

			// Second call with member token -> cache hit, does NOT query D1
			const res2 = await sendRpc<{ bots: BotRecord[] }>(
				"bot.list",
				{},
				{ token: customToken, accountId },
			);
			expect(res2.status).toBe(200);
			expect(res2.frame.ok).toBe(true);
			expect(d1TokenQueries).toBe(1); // Still 1!
			expect(edgeCache.getMetrics().tokenL1Hits).toBe(1);

			// Third call with member token -> still cache hit, does NOT query D1
			const res3 = await sendRpc<{ bots: BotRecord[] }>(
				"bot.list",
				{},
				{ token: customToken, accountId },
			);
			expect(res3.status).toBe(200);
			expect(res3.frame.ok).toBe(true);
			expect(d1TokenQueries).toBe(1); // Still 1!
			expect(edgeCache.getMetrics().tokenL1Hits).toBe(2);
		} finally {
			env.CADMUS_ADMIN_DB.prepare = originalPrepare;
		}
	});

	it("revoked token is rejected immediately after revocation", async () => {
		const accountId = uniqueAccountId("revoke");
		const customToken = crypto.randomUUID();

		// 1. Add member with token
		await addLegacyMember({
			userId: "revokable-user",
			name: "Revokable User",
			role: "member",
			accountId: accountId,
			token: customToken,
		});

		// 2. Authenticate to populate edge cache
		const res1 = await sendRpc<{ bots: BotRecord[] }>(
			"bot.list",
			{},
			{ token: customToken, accountId },
		);
		expect(res1.status).toBe(200);
		expect(res1.frame.ok).toBe(true);

		// 3. Revoke the token via D1AdminStore.revokeToken
		const edgeCache = getEdgeCache(env);
		const adminStore = new D1AdminStore({
			db: env.CADMUS_ADMIN_DB,
			encryptionKey: env.CADMUS_ENCRYPTION_KEY,
			edgeCache,
		});
		const revoked = await adminStore.revokeToken(customToken);
		expect(revoked).toBe(true);

		// 4. Subsequent request must be rejected (401 Unauthorized)
		const res2 = await sendRpc<{ bots: BotRecord[] }>(
			"bot.list",
			{},
			{ token: customToken, accountId },
		);
		expect(res2.status).toBe(401);
		expect(res2.frame.ok).toBe(false);
	});

	it("master secret fast-path avoids re-upserting account and user in the same isolate", async () => {
		const accountId = uniqueAccountId("master-fastpath");
		const userId = "master-user-1";
		const edgeCache = getEdgeCache(env);

		let accountUpsertQueries = 0;
		const originalPrepare = env.CADMUS_ADMIN_DB.prepare.bind(
			env.CADMUS_ADMIN_DB,
		);
		env.CADMUS_ADMIN_DB.prepare = ((query: string) => {
			if (
				query.includes("INSERT OR IGNORE INTO cadmus_accounts") ||
				query.includes("INSERT OR IGNORE INTO cadmus_users")
			) {
				accountUpsertQueries++;
			}
			return originalPrepare(query);
		}) as typeof env.CADMUS_ADMIN_DB.prepare;

		try {
			// First request with master secret: runs ensureAccountAndUser
			const res1 = await sendRpc<{ bots: BotRecord[] }>(
				"bot.list",
				{},
				{ accountId, userId },
			);
			expect(res1.status).toBe(200);
			expect(res1.frame.ok).toBe(true);
			const queriesAfterFirst = accountUpsertQueries;
			expect(queriesAfterFirst).toBeGreaterThan(0);
			expect(edgeCache.getMetrics().masterFastPathHits).toBe(1);

			// Second request with master secret: isolate memoization skips ensureAccountAndUser
			const res2 = await sendRpc<{ bots: BotRecord[] }>(
				"bot.list",
				{},
				{ accountId, userId },
			);
			expect(res2.status).toBe(200);
			expect(res2.frame.ok).toBe(true);
			expect(accountUpsertQueries).toBe(queriesAfterFirst); // No new upserts!
			expect(edgeCache.getMetrics().masterFastPathHits).toBe(2);

			// Third request with scoped token format: <accountId>:<userId>:<masterSecret>
			const scopedToken = `${accountId}:${userId}:${TEST_TOKEN}`;
			const res3 = await sendRpc<{ bots: BotRecord[] }>(
				"bot.list",
				{},
				{ token: scopedToken, accountId },
			);
			expect(res3.status).toBe(200);
			expect(res3.frame.ok).toBe(true);
			expect(accountUpsertQueries).toBe(queriesAfterFirst); // Still no new upserts!
			expect(edgeCache.getMetrics().masterFastPathHits).toBe(3);
		} finally {
			env.CADMUS_ADMIN_DB.prepare = originalPrepare;
		}
	});

	it("family DO routing cache avoids querying cadmus_families on every RPC call and invalidates on update", async () => {
		const accountId = uniqueAccountId("fam-cache");
		const edgeCache = getEdgeCache(env);

		// First call ensures/fetches the default family and caches routing info
		const res1 = await sendRpc<{ bots: BotRecord[] }>(
			"bot.list",
			{},
			{ accountId },
		);
		expect(res1.status).toBe(200);

		let familySelectQueries = 0;
		const originalPrepare = env.CADMUS_ADMIN_DB.prepare.bind(
			env.CADMUS_ADMIN_DB,
		);
		env.CADMUS_ADMIN_DB.prepare = ((query: string) => {
			if (
				query.includes("SELECT") &&
				query.includes("FROM cadmus_families") &&
				query.includes("WHERE account_id = ?1 AND family_id = ?2")
			) {
				familySelectQueries++;
			}
			return originalPrepare(query);
		}) as typeof env.CADMUS_ADMIN_DB.prepare;

		try {
			// Second call should hit the family routing cache
			const res2 = await sendRpc<{ bots: BotRecord[] }>(
				"bot.list",
				{},
				{ accountId },
			);
			expect(res2.status).toBe(200);
			expect(familySelectQueries).toBe(0);
			expect(edgeCache.getMetrics().familyL1Hits).toBeGreaterThanOrEqual(1);

			// Update family settings -> invalidates cached family routing
			const updateRes = await sendRpc<{ family: FamilyRecord }>(
				"family.update",
				{ name: "Updated Family Name" },
				{ accountId },
			);
			expect(updateRes.status).toBe(200);

			// Reset query counter before res3 to isolate edge routing lookup
			familySelectQueries = 0;

			// After invalidation, next call re-fetches family from D1 and repopulates cache
			const res3 = await sendRpc<{ bots: BotRecord[] }>(
				"bot.list",
				{},
				{ accountId },
			);
			expect(res3.status).toBe(200);
			expect(familySelectQueries).toBe(1);
		} finally {
			env.CADMUS_ADMIN_DB.prepare = originalPrepare;
		}
	});

	it("WebSocket verifies auth only during handshake and frames need no re-verification", async () => {
		const accountId = uniqueAccountId("ws-auth");
		const customToken = crypto.randomUUID();

		await addLegacyMember({
			userId: "ws-user-1",
			name: "WS User",
			role: "member",
			accountId: accountId,
			token: customToken,
		});

		// Connect WebSocket
		const client = await connectTestWs({
			token: customToken,
			accountId,
		});

		try {
			// Send multiple frames over the connected socket
			const f1 = await client.send("bot.list");
			expect(f1.ok).toBe(true);

			const f2 = await client.send("chat.list");
			expect(f2.ok).toBe(true);

			const f3 = await client.send("bot.list");
			expect(f3.ok).toBe(true);
		} finally {
			client.close();
		}
	});

	it("SSE (/events) verifies authentication at stream establishment", async () => {
		const accountId = uniqueAccountId("sse-auth");
		const customToken = crypto.randomUUID();

		await addLegacyMember({
			userId: "sse-user-1",
			name: "SSE User",
			role: "member",
			accountId: accountId,
			token: customToken,
		});

		// 1. Missing token -> 401
		const unauthRes = await SELF.fetch("http://example.com/events", {
			headers: { "x-account-id": accountId },
		});
		expect(unauthRes.status).toBe(401);

		// 2. Valid token -> 200 OK stream established
		const authRes = await SELF.fetch("http://example.com/events", {
			headers: {
				Authorization: `Bearer ${customToken}`,
				"x-account-id": accountId,
			},
		});
		expect(authRes.status).toBe(200);
		expect(authRes.headers.get("content-type")).toContain("text/event-stream");
		await authRes.body?.cancel();
	});

	it("preserves multi-tenant isolation with edge caching", async () => {
		const accountA = uniqueAccountId("tenant-a");
		const accountB = uniqueAccountId("tenant-b");
		const tokenA = crypto.randomUUID();
		const tokenB = crypto.randomUUID();

		await addLegacyMember({
			userId: "user-a",
			name: "User A",
			role: "member",
			accountId: accountA,
			token: tokenA,
		});

		await addLegacyMember({
			userId: "user-b",
			name: "User B",
			role: "member",
			accountId: accountB,
			token: tokenB,
		});

		// Token A resolves only to Account A
		const listA = await sendRpc<{ members: AccountMember[] }>(
			"account.members.list",
			{},
			{ token: tokenA, accountId: accountA },
		);
		expect(listA.status).toBe(200);
		expect(listA.frame.result?.members.some((m) => m.userId === "user-a")).toBe(
			true,
		);
		expect(listA.frame.result?.members.some((m) => m.userId === "user-b")).toBe(
			false,
		);

		// Token B resolves only to Account B
		const listB = await sendRpc<{ members: AccountMember[] }>(
			"account.members.list",
			{},
			{ token: tokenB, accountId: accountB },
		);
		expect(listB.status).toBe(200);
		expect(listB.frame.result?.members.some((m) => m.userId === "user-b")).toBe(
			true,
		);
		expect(listB.frame.result?.members.some((m) => m.userId === "user-a")).toBe(
			false,
		);
	});

	it("supports L2 KV cache read-through and invalidation when KV namespace is bound", async () => {
		const kvMap = new Map<string, string>();
		const mockKv = {
			get: async (key: string, type?: string) => {
				const val = kvMap.get(key);
				if (!val) return null;
				return type === "json" ? JSON.parse(val) : val;
			},
			put: async (
				key: string,
				val: string,
				_opts?: { expirationTtl?: number },
			) => {
				kvMap.set(key, val);
			},
			delete: async (key: string) => {
				kvMap.delete(key);
			},
		} as unknown as KVNamespace;

		const edgeCache = new EdgeCache({ CADMUS_CACHE_KV: mockKv });
		const token = crypto.randomUUID();
		const accountId = uniqueAccountId("kv");
		const tokenHash = await sha256Hex(token);

		// Populate cache
		await edgeCache.setToken(tokenHash, {
			userId: "kv-user",
			accountId,
			role: "account-admin",
		});

		// Verify KV has the entry
		expect(kvMap.size).toBeGreaterThan(0);

		// Clear L1 memory
		EdgeCache.clearAllMemory();

		// Read through from L2 KV
		const resolved = await edgeCache.getToken(tokenHash);
		expect(resolved?.userId).toBe("kv-user");
		expect(edgeCache.getMetrics().tokenL2Hits).toBe(1);

		// Invalidate
		await edgeCache.invalidateToken(tokenHash, true);
		expect(await edgeCache.getToken(tokenHash)).toBeUndefined();
		expect(kvMap.size).toBe(0);
	});

	it("invalidates default families in edge cache when account timezone is updated via updateAccount", async () => {
		const accountId = uniqueAccountId("tz-inval");
		const edgeCache = getEdgeCache(env);
		const adminStore = new D1AdminStore({
			db: env.CADMUS_ADMIN_DB,
			encryptionKey: "test-encryption-key-for-admin-store-tests",
			edgeCache,
		});

		// 1. Ensure account and default families in D1
		await adminStore.ensureAccountAndUser({
			accountId,
			userId: "owner-tz-1",
			timezone: "UTC",
		});
		await adminStore.ensureFamily(accountId, "default");
		await adminStore.ensureFamily(accountId, "default-family");

		// 2. Prime cache with default and default-family routing
		await edgeCache.setFamily(accountId, "default", {
			accountId,
			familyId: "default",
			name: "Default Family",
			doName: `cadmus:${accountId}:default`,
			timezone: "UTC",
			harvestDelayMs: 60_000,
		});
		await edgeCache.setFamily(accountId, "default-family", {
			accountId,
			familyId: "default-family",
			name: "Default Family",
			doName: `cadmus:${accountId}:default-family`,
			timezone: "UTC",
			harvestDelayMs: 60_000,
		});

		expect(await edgeCache.getFamily(accountId, "default")).toBeDefined();
		expect(
			await edgeCache.getFamily(accountId, "default-family"),
		).toBeDefined();

		// 3. Update account timezone
		await adminStore.updateAccount(accountId, { timezone: "America/New_York" });

		// 4. Verify both default families were invalidated from edge cache
		expect(await edgeCache.getFamily(accountId, "default")).toBeUndefined();
		expect(
			await edgeCache.getFamily(accountId, "default-family"),
		).toBeUndefined();

		// 5. Subsequent fetch from adminStore returns the updated timezone
		const updatedDefault = await adminStore.getFamily(accountId, "default");
		expect(updatedDefault?.timezone).toBe("America/New_York");
		const updatedDefaultFam = await adminStore.getFamily(
			accountId,
			"default-family",
		);
		expect(updatedDefaultFam?.timezone).toBe("America/New_York");
	});

	it("primes edge cache when createFamily is called on D1AdminStore", async () => {
		const accountId = uniqueAccountId("prime-family");
		const edgeCache = getEdgeCache(env);
		edgeCache.resetMetrics();

		const adminStore = new D1AdminStore({
			db: env.CADMUS_ADMIN_DB,
			encryptionKey: "test-encryption-key-for-admin-store-tests",
			edgeCache,
		});

		await adminStore.ensureAccountAndUser({
			accountId,
			userId: "owner-prime-1",
		});

		// Create a new family via adminStore
		const created = await adminStore.createFamily(accountId, {
			familyId: "worker-bots",
			name: "Worker Bots",
			timezone: "Asia/Tokyo",
		});
		expect(created.familyId).toBe("worker-bots");

		// Edge cache should already be primed without any separate edgeCache.setFamily call
		const cached = await edgeCache.getFamily(accountId, "worker-bots");
		expect(cached).toBeDefined();
		expect(cached?.familyId).toBe("worker-bots");
		expect(cached?.timezone).toBe("Asia/Tokyo");
		expect(edgeCache.getMetrics().familyL1Hits).toBe(1);
	});

	it("addMember invalidates cached token only after successful batch write", async () => {
		const accountId = uniqueAccountId("member-batch");
		const rawToken = crypto.randomUUID();
		const tokenHash = await sha256Hex(rawToken);
		const edgeCache = getEdgeCache(env);

		const adminStore = new D1AdminStore({
			db: env.CADMUS_ADMIN_DB,
			encryptionKey: "test-encryption-key-for-admin-store-tests",
			edgeCache,
		});

		await adminStore.ensureAccountAndUser({
			accountId,
			userId: "owner-batch-1",
		});

		// 1. Prime cache with an existing token entry
		await edgeCache.setToken(tokenHash, {
			userId: "old-user",
			accountId,
			role: "user",
		});
		expect(await edgeCache.getToken(tokenHash)).toBeDefined();

		// 2. If D1 batch fails, the existing cache entry must NOT be invalidated prematurely
		const originalBatch = env.CADMUS_ADMIN_DB.batch.bind(env.CADMUS_ADMIN_DB);
		env.CADMUS_ADMIN_DB.batch = (() => {
			return Promise.reject(new Error("Simulated D1 batch commit failure"));
		}) as typeof env.CADMUS_ADMIN_DB.batch;

		try {
			await expect(
				adminStore.addMember({
					accountId,
					userId: "new-user",
					rawToken,
				}),
			).rejects.toThrow("Simulated D1 batch commit failure");

			// Cache entry must still be intact because batch aborted
			expect(await edgeCache.getToken(tokenHash)).toBeDefined();
			expect((await edgeCache.getToken(tokenHash))?.userId).toBe("old-user");
		} finally {
			env.CADMUS_ADMIN_DB.batch = originalBatch;
		}

		// 3. When batch succeeds, cache entry is invalidated post-commit
		await adminStore.addMember({
			accountId,
			userId: "new-user",
			rawToken,
		});

		// Cache entry was invalidated
		expect(await edgeCache.getToken(tokenHash)).toBeUndefined();

		// Resolving token via D1 now reflects the newly committed member
		const resolved = await adminStore.resolveToken(rawToken);
		expect(resolved?.userId).toBe("new-user");
	});

	it("account.members.add refuses a caller-chosen token and creates no token row (issue #3)", async () => {
		const accountId = uniqueAccountId("no-token");
		const tokenCount = async (): Promise<number> => {
			const row = await env.CADMUS_ADMIN_DB.prepare(
				"SELECT COUNT(*) AS n FROM cadmus_auth_tokens WHERE account_id = ?1",
			)
				.bind(accountId)
				.first<{ n: number }>();
			return row?.n ?? 0;
		};
		const refused = await sendRpc(
			"account.members.add",
			{
				userId: "token-pusher",
				name: "Token Pusher",
				role: "member",
				token: crypto.randomUUID(),
			} as never,
			{ accountId, userId: "owner-1" },
		);
		expect(refused.frame.ok).toBe(false);
		expect(JSON.stringify(refused.frame)).toContain("token_not_accepted");
		expect(await tokenCount()).toBe(0);

		// Positive control: the same call without a token succeeds and the
		// member exists, still with no token row.
		const accepted = await sendRpc(
			"account.members.add",
			{ userId: "token-free", name: "Token Free", role: "member" },
			{ accountId, userId: "owner-1" },
		);
		expect(accepted.frame.ok).toBe(true);
		expect(await tokenCount()).toBe(0);
	});
});
