import { getLogger } from "./log.js";
import type { AuthenticatedIdentity } from "./store/admin-interface.js";
import type { Env } from "./types.js";

export interface CachedTokenScope extends AuthenticatedIdentity {
	defaultFamilyId?: string;
	/** Epoch ms of the cache write; stored in KV only, so an L2 hit cannot outlive the write's own TTL in L1. */
	cachedAt?: number;
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
	};

	constructor(
		private readonly env: Partial<Env>,
		private readonly l1TtlMs: number = 60_000,
		private readonly l2TtlSeconds: number = 60,
	) {
		activeCaches.add(new WeakRef(this));
	}

	private tokenFloor = 0;
	private tokenGen = 0;

	/** Changes on every invalidation or floor; read it before a D1 resolve. */
	get tokenGeneration(): number {
		return this.tokenGen;
	}

	/**
	 * Local invalidation floor, used when the exact token hashes could not be
	 * dropped after a committed authority change: clears this isolate's token L1,
	 * rejects every KV entry written at or before now (equal timestamps count as
	 * stale), and makes setToken skip writes whose D1 resolve began earlier.
	 */
	floorTokens(): void {
		this.tokenFloor = Date.now();
		this.tokenGen++;
		this.tokenL1.clear();
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
		};
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
					const { cachedAt, ...scope } = l2Val;
					// Absolute age check on every KV read: KV delete and expiry can
					// lag across locations, so an entry is only trusted for the L2 TTL
					// from its own write time. An entry with no write time (written
					// before this check existed) is a miss and is re-resolved from D1.
					if (
						cachedAt === undefined ||
						cachedAt <= this.tokenFloor ||
						Date.now() - cachedAt >= this.l2TtlSeconds * 1000
					) {
						this.metrics.tokenMisses++;
						return undefined;
					}
					this.metrics.tokenL2Hits++;
					// L1 gets only what is left of the L2 entry's life, so the total
					// from the cache write is the L2 TTL, not L2 plus a fresh L1 TTL.
					const left = Math.min(
						this.l1TtlMs,
						this.l2TtlSeconds * 1000 - (Date.now() - cachedAt),
					);
					if (left > 0) this.tokenL1.set(key, scope, left);
					return scope;
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
		resolvedAtGeneration?: number,
	): Promise<void> {
		// A resolve that began before a floor may carry pre-change authority.
		if (
			resolvedAtGeneration !== undefined &&
			resolvedAtGeneration !== this.tokenGen
		) {
			return;
		}
		const key = makeTokenCacheKey(tokenHash, this.env);
		this.tokenL1.set(key, scope, ttlSeconds * 1000);
		if (this.env.CADMUS_CACHE_KV) {
			try {
				await this.env.CADMUS_CACHE_KV.put(
					key,
					JSON.stringify({ ...scope, cachedAt: Date.now() }),
					{ expirationTtl: Math.max(60, ttlSeconds) },
				);
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
		// A D1 resolve that began before this invalidation may carry the old
		// authority; bump the generation so its setToken is skipped.
		this.tokenGen++;
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
