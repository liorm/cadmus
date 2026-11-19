import { beforeEach, describe, expect, it } from "bun:test";
import {
	clearAllEdgeCaches,
	EdgeCache,
	getEdgeCache,
	getEnvTag,
	LruCache,
	makeFamilyCacheKey,
	makeTokenCacheKey,
	sha256Hex,
} from "../../src/edge-cache.js";
import { sha256Hex as d1Sha256Hex } from "../../src/store/d1-admin.js";

function uniqueAccountId(prefix = "acct"): string {
	return `${prefix}-${crypto.randomUUID()}`;
}

describe("EdgeCache Pure Unit Helpers & L1 LRU Cache", () => {
	beforeEach(() => {
		EdgeCache.clearAllMemory();
	});

	describe("sha256Hex", () => {
		it("matches standard SHA-256 test vectors", async () => {
			const emptyHash = await sha256Hex("");
			expect(emptyHash).toBe(
				"e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
			);

			const helloHash = await sha256Hex("hello world");
			expect(helloHash).toBe(
				"b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
			);
		});

		it("produces deterministic 64-character lowercase hex strings", async () => {
			const hash1 = await sha256Hex("my-token-12345");
			const hash2 = await sha256Hex("my-token-12345");
			expect(hash1).toBe(hash2);
			expect(hash1).toMatch(/^[0-9a-f]{64}$/);
		});

		it("matches re-exported sha256Hex from d1-admin", async () => {
			const text = "cadmus-security-token-sha256";
			expect(await sha256Hex(text)).toBe(await d1Sha256Hex(text));
		});
	});

	describe("Key derivation & environment namespacing", () => {
		it("determines environment tag from IS_PREVIEW", () => {
			expect(getEnvTag({ IS_PREVIEW: "true" })).toBe("preview");
			expect(getEnvTag({ IS_PREVIEW: "false" })).toBe("prod");
			expect(getEnvTag({})).toBe("prod");
			expect(getEnvTag(undefined)).toBe("prod");
		});

		it("builds versioned, environment-namespaced token cache keys without raw token", async () => {
			const rawToken = "super-secret-user-bearer-token";
			const tokenHash = await sha256Hex(rawToken);

			const prodKey = makeTokenCacheKey(tokenHash, {});
			expect(prodKey).toBe(`cadmus:v1:prod:token:${tokenHash}`);
			expect(prodKey).not.toContain(rawToken);

			const previewKey = makeTokenCacheKey(tokenHash, { IS_PREVIEW: "true" });
			expect(previewKey).toBe(`cadmus:v1:preview:token:${tokenHash}`);
			expect(previewKey).not.toBe(prodKey);
		});

		it("builds versioned, environment-namespaced family cache keys", () => {
			const accountId = uniqueAccountId("acct");
			const prodKey = makeFamilyCacheKey(accountId, "default", {});
			expect(prodKey).toBe(`cadmus:v1:prod:family:${accountId}:default`);

			const previewKey = makeFamilyCacheKey(accountId, "default", {
				IS_PREVIEW: "true",
			});
			expect(previewKey).toBe(`cadmus:v1:preview:family:${accountId}:default`);
			expect(previewKey).not.toBe(prodKey);
		});
	});

	describe("LruCache with TTL", () => {
		it("stores and retrieves values within TTL", () => {
			const cache = new LruCache<string>(10);
			cache.set("k1", "v1", 10_000);
			expect(cache.get("k1")).toBe("v1");
		});

		it("expires entries after TTL elapses", async () => {
			const cache = new LruCache<string>(10);
			cache.set("k1", "v1", 20); // 20ms TTL
			expect(cache.get("k1")).toBe("v1");
			await new Promise((r) => setTimeout(r, 30));
			expect(cache.get("k1")).toBeUndefined();
			expect(cache.size).toBe(0);
		});

		it("evicts oldest items when maxCapacity is reached", () => {
			const cache = new LruCache<string>(3);
			cache.set("a", "1", 10_000);
			cache.set("b", "2", 10_000);
			cache.set("c", "3", 10_000);

			expect(cache.size).toBe(3);

			// Adding a 4th key should evict 'a' (oldest)
			cache.set("d", "4", 10_000);
			expect(cache.size).toBe(3);
			expect(cache.get("a")).toBeUndefined();
			expect(cache.get("b")).toBe("2");
			expect(cache.get("c")).toBe("3");
			expect(cache.get("d")).toBe("4");
		});

		it("updates MRU ordering when getting an item", () => {
			const cache = new LruCache<string>(3);
			cache.set("a", "1", 10_000);
			cache.set("b", "2", 10_000);
			cache.set("c", "3", 10_000);

			// Access 'a' to make it most recently used
			expect(cache.get("a")).toBe("1");

			// Adding 'd' should now evict 'b' (not 'a')
			cache.set("d", "4", 10_000);
			expect(cache.get("b")).toBeUndefined();
			expect(cache.get("a")).toBe("1");
			expect(cache.get("c")).toBe("3");
			expect(cache.get("d")).toBe("4");
		});

		it("deletes and clears entries", () => {
			const cache = new LruCache<string>(5);
			cache.set("x", "10", 10_000);
			cache.set("y", "20", 10_000);
			expect(cache.delete("x")).toBe(true);
			expect(cache.get("x")).toBeUndefined();
			expect(cache.get("y")).toBe("20");

			cache.clear();
			expect(cache.size).toBe(0);
			expect(cache.get("y")).toBeUndefined();
		});
	});

	describe("EdgeCache L1 (in-memory only, no KV)", () => {
		it("caches tokens in L1 and tracks hits/misses", async () => {
			const cache = new EdgeCache({});
			const accountId = uniqueAccountId("acct");
			const rawToken = crypto.randomUUID();
			const tokenHash = await sha256Hex(rawToken);

			expect(await cache.getToken(tokenHash)).toBeUndefined();
			expect(cache.getMetrics().tokenMisses).toBe(1);
			expect(cache.getMetrics().tokenL1Hits).toBe(0);

			await cache.setToken(tokenHash, {
				userId: "user-alice",
				accountId,
				role: "user",
			});

			const cached = await cache.getToken(tokenHash);
			expect(cached).toEqual({
				userId: "user-alice",
				accountId,
				role: "user",
			});
			expect(cache.getMetrics().tokenL1Hits).toBe(1);

			// Invalidate token
			await cache.invalidateToken(rawToken);
			expect(await cache.getToken(tokenHash)).toBeUndefined();
			expect(cache.getMetrics().tokenMisses).toBe(2);
		});

		it("caches family routing in L1 and tracks hits/misses", async () => {
			const cache = new EdgeCache({});
			const accountId = uniqueAccountId("acct");
			expect(await cache.getFamily(accountId, "default")).toBeUndefined();
			expect(cache.getMetrics().familyMisses).toBe(1);

			await cache.setFamily(accountId, "default", {
				accountId,
				familyId: "default",
				name: "Default Family",
				doName: `cadmus:${accountId}:default`,
				timezone: "UTC",
				harvestDelayMs: 60_000,
			});

			const family = await cache.getFamily(accountId, "default");
			expect(family?.doName).toBe(`cadmus:${accountId}:default`);
			expect(cache.getMetrics().familyL1Hits).toBe(1);

			await cache.invalidateFamily(accountId, "default");
			expect(await cache.getFamily(accountId, "default")).toBeUndefined();
			expect(cache.getMetrics().familyMisses).toBe(2);
		});
	});

	describe("EdgeCache L2 (with KV binding)", () => {
		it("populates L1 from L2 KV on cache miss and writes mutations through", async () => {
			const kvStore = new Map<string, string>();
			const mockKv = {
				get: async (key: string, type?: string) => {
					const val = kvStore.get(key);
					if (!val) return null;
					return type === "json" ? JSON.parse(val) : val;
				},
				put: async (
					key: string,
					val: string,
					_opts?: { expirationTtl?: number },
				) => {
					kvStore.set(key, val);
				},
				delete: async (key: string) => {
					kvStore.delete(key);
				},
			} as unknown as KVNamespace;

			const cache = new EdgeCache({ CADMUS_CACHE_KV: mockKv });
			const accountId = uniqueAccountId("acct");
			const rawToken = crypto.randomUUID();
			const tokenHash = await sha256Hex(rawToken);

			// 1. Initial lookup is a miss in both L1 and L2
			expect(await cache.getToken(tokenHash)).toBeUndefined();
			expect(cache.getMetrics().tokenMisses).toBe(1);

			// 2. Set token writes to both L1 and KV
			await cache.setToken(tokenHash, {
				userId: "bob",
				accountId,
				role: "account-admin",
			});
			const expectedKey = makeTokenCacheKey(tokenHash, {});
			expect(kvStore.has(expectedKey)).toBe(true);

			// 3. Clear L1 in-memory to simulate a cold isolate
			EdgeCache.clearAllMemory();

			// 4. Next lookup should hit L2 KV, increment tokenL2Hits, and repopulate L1
			const fromKv = await cache.getToken(tokenHash);
			expect(fromKv?.userId).toBe("bob");
			expect(cache.getMetrics().tokenL2Hits).toBe(1);

			// 5. Subsequent lookup hits L1 (in-memory)
			const fromL1 = await cache.getToken(tokenHash);
			expect(fromL1?.userId).toBe("bob");
			expect(cache.getMetrics().tokenL1Hits).toBe(1);

			// 6. Invalidate deletes from both L1 and KV
			await cache.invalidateToken(tokenHash, true);
			expect(kvStore.has(expectedKey)).toBe(false);
			expect(await cache.getToken(tokenHash)).toBeUndefined();
		});
	});

	describe("EdgeCache Instance Isolation & Memory Clearing", () => {
		it("maintains isolated in-memory L1 caches across instances", async () => {
			const cache1 = new EdgeCache({});
			const cache2 = new EdgeCache({});
			const accountA = uniqueAccountId("acct");
			const accountB = uniqueAccountId("acct");
			const rawToken = crypto.randomUUID();
			const tokenHash = await sha256Hex(rawToken);

			await cache1.setToken(tokenHash, {
				userId: "user-1",
				accountId: accountA,
				role: "user",
			});

			// cache1 has the token in L1
			const fromC1 = await cache1.getToken(tokenHash);
			expect(fromC1?.userId).toBe("user-1");

			// cache2 has separate L1 and does NOT see cache1's token
			const fromC2 = await cache2.getToken(tokenHash);
			expect(fromC2).toBeUndefined();

			// Instance clearMemory clears only cache1
			await cache2.setFamily(accountB, "fam-2", {
				accountId: accountB,
				familyId: "fam-2",
				name: "Family 2",
				doName: `cadmus:${accountB}:fam-2`,
				timezone: "UTC",
				harvestDelayMs: 60_000,
			});
			cache1.clearMemory();
			expect(await cache1.getToken(tokenHash)).toBeUndefined();
			expect(await cache2.getFamily(accountB, "fam-2")).toBeDefined();

			// clearAllEdgeCaches clears all instances
			clearAllEdgeCaches();
			expect(await cache2.getFamily(accountB, "fam-2")).toBeUndefined();
		});

		it("reuses singleton instance for distinct empty env objects in getEdgeCache", () => {
			const cacheA = getEdgeCache({});
			const cacheB = getEdgeCache({});
			expect(cacheA).toBe(cacheB);
		});

		it("reuses instance when keyed by CADMUS_ADMIN_DB in getEdgeCache", () => {
			const mockDb = { name: "mock-d1-db" } as unknown as D1Database;
			const cache1 = getEdgeCache({ CADMUS_ADMIN_DB: mockDb });
			const cache2 = getEdgeCache({
				CADMUS_ADMIN_DB: mockDb,
				IS_PREVIEW: "true",
			});
			expect(cache1).toBe(cache2);
		});
	});
});
