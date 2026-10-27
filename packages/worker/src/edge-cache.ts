import { getLogger } from "./log.js";
import type { AuthenticatedIdentity } from "./store/admin-interface.js";
import type { Env } from "./types.js";

export interface CachedTokenScope extends AuthenticatedIdentity {
	defaultFamilyId?: string;
}

export interface CachedFamilyRouting {
	accountId: string;
	familyId: string;
	name: string;
	doName: string;
	timezone: string;
	harvestDelayMs: number;
}

export interface EdgeCacheMetrics {
	tokenL1Hits: number;
	tokenL2Hits: number;
	tokenMisses: number;
	familyL1Hits: number;
	familyL2Hits: number;
	familyMisses: number;
	masterFastPathHits: number;
}

/**
 * Computes a hex-encoded SHA-256 hash using Web Crypto subtle API.
 */
export async function sha256Hex(text: string): Promise<string> {
	const data = new TextEncoder().encode(text);
	const hashBuffer = await crypto.subtle.digest("SHA-256", data);
	const hashArray = Array.from(new Uint8Array(hashBuffer));
	return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function getEnvTag(env?: { IS_PREVIEW?: string }): string {
	return env?.IS_PREVIEW === "true" ? "preview" : "prod";
}

export function makeTokenCacheKey(
	tokenHash: string,
	env?: { IS_PREVIEW?: string },
): string {
	const tag = getEnvTag(env);
	return `cadmus:v1:${tag}:token:${tokenHash}`;
}

export function makeFamilyCacheKey(
	accountId: string,
	familyId: string,
	env?: { IS_PREVIEW?: string },
): string {
	const tag = getEnvTag(env);
	return `cadmus:v1:${tag}:family:${accountId}:${familyId}`;
}

interface CacheEntry<T> {
	value: T;
	expiresAt: number;
}

/**
 * Bounded in-memory LRU cache with TTL expiration.
 */
export class LruCache<T> {
	private readonly map = new Map<string, CacheEntry<T>>();

	constructor(private readonly maxCapacity: number = 1000) {}

	get(key: string): T | undefined {
		const entry = this.map.get(key);
		if (!entry) return undefined;
		if (Date.now() > entry.expiresAt) {
			this.map.delete(key);
			return undefined;
		}
		// Move to most recently used position
		this.map.delete(key);
		this.map.set(key, entry);
		return entry.value;
	}

	set(key: string, value: T, ttlMs: number): void {
		if (this.map.has(key)) {
			this.map.delete(key);
		} else if (this.map.size >= this.maxCapacity) {
			const oldestKey = this.map.keys().next().value;
			if (oldestKey !== undefined) {
				this.map.delete(oldestKey);
			}
		}
		this.map.set(key, { value, expiresAt: Date.now() + ttlMs });
	}

	delete(key: string): boolean {
		return this.map.delete(key);
	}

	clear(): void {
		this.map.clear();
	}

	get size(): number {
		return this.map.size;
	}
}

// Isolate-level set of ensured (accountId, userId) pairs for master secret
const ensuredMasterUsers = new LruCache<true>(1000);

export function isMasterUserEnsured(
	accountId: string,
	userId: string,
): boolean {
	return Boolean(ensuredMasterUsers.get(`${accountId}:${userId}`));
}

export function markMasterUserEnsured(
	accountId: string,
	userId: string,
	ttlMs: number = 300_000,
): void {
	ensuredMasterUsers.set(`${accountId}:${userId}`, true, ttlMs);
}

export function clearEnsuredMasterUsers(): void {
	ensuredMasterUsers.clear();
}

const activeCaches = new Set<WeakRef<EdgeCache>>();

export function clearAllEdgeCaches(): void {
	for (const ref of activeCaches) {
		const cache = ref.deref();
		if (cache) {
			cache.clearMemory();
		} else {
			activeCaches.delete(ref);
		}
	}
	ensuredMasterUsers.clear();
}

/**
 * Two-tier Edge Cache:
 * L1: In-memory LRU cache (always on, per-isolate)
 * L2: Cloudflare Workers KV (optional, across isolates)
 */
export class EdgeCache {
	private readonly tokenL1 = new LruCache<CachedTokenScope>(1000);
	private readonly familyL1 = new LruCache<CachedFamilyRouting>(1000);

	private metrics: EdgeCacheMetrics = {
		tokenL1Hits: 0,
		tokenL2Hits: 0,
		tokenMisses: 0,
		familyL1Hits: 0,
		familyL2Hits: 0,
		familyMisses: 0,
		masterFastPathHits: 0,
	};

	constructor(
		private readonly env: Partial<Env>,
		private readonly l1TtlMs: number = 60_000,
		private readonly l2TtlSeconds: number = 60,
	) {
		activeCaches.add(new WeakRef(this));
	}

	clearMemory(): void {
		this.tokenL1.clear();
		this.familyL1.clear();
	}

	static clearAllMemory(): void {
		clearAllEdgeCaches();
	}

	getMetrics(): Readonly<EdgeCacheMetrics> {
		return { ...this.metrics };
	}

	resetMetrics(): void {
		this.metrics = {
			tokenL1Hits: 0,
			tokenL2Hits: 0,
			tokenMisses: 0,
			familyL1Hits: 0,
			familyL2Hits: 0,
			familyMisses: 0,
			masterFastPathHits: 0,
		};
	}

	recordMasterFastPath(): void {
		this.metrics.masterFastPathHits++;
	}

	async getToken(tokenHash: string): Promise<CachedTokenScope | undefined> {
		const key = makeTokenCacheKey(tokenHash, this.env);
		// L1 check
		const l1Val = this.tokenL1.get(key);
		if (l1Val) {
			this.metrics.tokenL1Hits++;
			return l1Val;
		}

		// L2 check
		if (this.env.CADMUS_CACHE_KV) {
			try {
				const l2Val = await this.env.CADMUS_CACHE_KV.get<CachedTokenScope>(
					key,
					"json",
				);
				if (l2Val) {
					this.metrics.tokenL2Hits++;
					this.tokenL1.set(key, l2Val, this.l1TtlMs);
					return l2Val;
				}
			} catch (err) {
				getLogger().warn("error reading token from KV cache", {
					key,
					error: err,
				});
			}
		}

		this.metrics.tokenMisses++;
		return undefined;
	}

	async setToken(
		tokenHash: string,
		scope: CachedTokenScope,
		ttlSeconds: number = this.l2TtlSeconds,
	): Promise<void> {
		const key = makeTokenCacheKey(tokenHash, this.env);
		this.tokenL1.set(key, scope, ttlSeconds * 1000);
		if (this.env.CADMUS_CACHE_KV) {
			try {
				await this.env.CADMUS_CACHE_KV.put(key, JSON.stringify(scope), {
					expirationTtl: Math.max(60, ttlSeconds),
				});
			} catch (err) {
				getLogger().warn("error writing token to KV cache", {
					key,
					error: err,
				});
			}
		}
	}

	async invalidateToken(
		rawTokenOrHash: string,
		isHash: boolean = false,
	): Promise<void> {
		const hash = isHash ? rawTokenOrHash : await sha256Hex(rawTokenOrHash);
		const key = makeTokenCacheKey(hash, this.env);
		this.tokenL1.delete(key);
		if (this.env.CADMUS_CACHE_KV) {
			try {
				await this.env.CADMUS_CACHE_KV.delete(key);
			} catch (err) {
				getLogger().warn("error deleting token from KV cache", {
					key,
					error: err,
				});
			}
		}
	}

	async getFamily(
		accountId: string,
		familyId: string,
	): Promise<CachedFamilyRouting | undefined> {
		const key = makeFamilyCacheKey(accountId, familyId, this.env);
		const l1Val = this.familyL1.get(key);
		if (l1Val) {
			this.metrics.familyL1Hits++;
			return l1Val;
		}

		if (this.env.CADMUS_CACHE_KV) {
			try {
				const l2Val = await this.env.CADMUS_CACHE_KV.get<CachedFamilyRouting>(
					key,
					"json",
				);
				if (l2Val) {
					this.metrics.familyL2Hits++;
					this.familyL1.set(key, l2Val, this.l1TtlMs);
					return l2Val;
				}
			} catch (err) {
				getLogger().warn("error reading family from KV cache", {
					key,
					error: err,
				});
			}
		}

		this.metrics.familyMisses++;
		return undefined;
	}

	async setFamily(
		accountId: string,
		familyId: string,
		routing: CachedFamilyRouting,
		ttlSeconds: number = this.l2TtlSeconds,
	): Promise<void> {
		const key = makeFamilyCacheKey(accountId, familyId, this.env);
		this.familyL1.set(key, routing, ttlSeconds * 1000);
		if (this.env.CADMUS_CACHE_KV) {
			try {
				await this.env.CADMUS_CACHE_KV.put(key, JSON.stringify(routing), {
					expirationTtl: Math.max(60, ttlSeconds),
				});
			} catch (err) {
				getLogger().warn("error writing family to KV cache", {
					key,
					error: err,
				});
			}
		}
	}

	async invalidateFamily(accountId: string, familyId: string): Promise<void> {
		const key = makeFamilyCacheKey(accountId, familyId, this.env);
		this.familyL1.delete(key);
		if (this.env.CADMUS_CACHE_KV) {
			try {
				await this.env.CADMUS_CACHE_KV.delete(key);
			} catch (err) {
				getLogger().warn("error deleting family from KV cache", {
					key,
					error: err,
				});
			}
		}
	}
}

const defaultEmptyEnvKey = {};
const instances = new WeakMap<object, EdgeCache>();

export function getEdgeCache(env: Partial<Env>): EdgeCache {
	const key =
		(env.CADMUS_ADMIN_DB as object) ??
		(Object.keys(env).length === 0 ? defaultEmptyEnvKey : env);
	let cache = instances.get(key);
	if (!cache) {
		cache = new EdgeCache(env);
		instances.set(key, cache);
	}
	return cache;
}
