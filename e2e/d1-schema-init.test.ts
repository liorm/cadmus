import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { resetEdgeD1InitCache } from "../packages/worker/src/index.js";
import {
	CADMUS_SCHEMA_VERSION,
	D1AdminStore,
	ensureD1Schema,
	getD1InitStats,
	isD1DatabaseInitialized,
	readSchemaVersion,
	resetD1InitializationCache,
	resetD1InitStats,
	runD1SchemaMigrations,
	wrapD1WithSchemaFallback,
} from "../packages/worker/src/store/d1-admin.js";
import { sendRpc } from "./helpers.js";

describe("D1 Schema Initialization & Isolate Caching (Issue #18)", () => {
	it("(a) fresh D1 self-initializes transparently on the first request", async () => {
		resetEdgeD1InitCache();
		resetD1InitStats();

		const acctId = `fresh-${crypto.randomUUID().slice(0, 8)}`;
		const res = await sendRpc(
			"bot.list",
			{},
			{ accountId: acctId, userId: `user:${acctId}` },
		);

		expect(res.status).toBe(200);
		expect(res.frame.ok).toBe(true);

		// Schema version marker table must exist and hold CADMUS_SCHEMA_VERSION
		const versionRow = await env.CADMUS_ADMIN_DB.prepare(
			"SELECT value FROM cadmus_schema_meta WHERE key = 'version'",
		).first<{ value: string }>();
		expect(versionRow?.value).toBe(String(CADMUS_SCHEMA_VERSION));

		// All core admin tables must be present
		const tables = await env.CADMUS_ADMIN_DB.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'cadmus_%'",
		).all<{ name: string }>();
		const tableNames = tables.results.map((t) => t.name);

		expect(tableNames).toContain("cadmus_accounts");
		expect(tableNames).toContain("cadmus_users");
		expect(tableNames).toContain("cadmus_account_members");
		expect(tableNames).toContain("cadmus_auth_tokens");
		expect(tableNames).toContain("cadmus_account_credentials");
		expect(tableNames).toContain("cadmus_families");
		expect(tableNames).toContain("cadmus_tools_envs");
		expect(tableNames).toContain("cadmus_tools_env_secrets");
		expect(tableNames).toContain("cadmus_schema_meta");
	});

	it("(b) repeated requests in the same isolate do zero initialization round-trips", async () => {
		// Isolate is already initialized from previous request
		expect(isD1DatabaseInitialized(env.CADMUS_ADMIN_DB)).toBe(true);

		resetD1InitStats();

		const schemaQueries: string[] = [];
		const originalPrepare = env.CADMUS_ADMIN_DB.prepare.bind(
			env.CADMUS_ADMIN_DB,
		);

		// Spy on queries at the egress boundary to detect any schema init statements
		env.CADMUS_ADMIN_DB.prepare = (query: string) => {
			if (
				query.includes("cadmus_schema_meta") ||
				query.includes("CREATE TABLE") ||
				query.includes("PRAGMA table_info") ||
				query.includes("ALTER TABLE")
			) {
				schemaQueries.push(query);
			}
			return originalPrepare(query);
		};

		try {
			const acct1 = `warm-1-${crypto.randomUUID().slice(0, 8)}`;
			const res1 = await sendRpc(
				"bot.list",
				{},
				{ accountId: acct1, userId: `user:${acct1}` },
			);
			expect(res1.status).toBe(200);

			const acct2 = `warm-2-${crypto.randomUUID().slice(0, 8)}`;
			const res2 = await sendRpc(
				"bot.list",
				{},
				{ accountId: acct2, userId: `user:${acct2}` },
			);
			expect(res2.status).toBe(200);

			// In-memory stats counter must confirm zero schema checks and migrations
			const stats = getD1InitStats();
			expect(stats.schemaChecks).toBe(0);
			expect(stats.migrationsRun).toBe(0);

			// Egress statement inspector must confirm zero schema/migration SQL dispatched
			expect(schemaQueries).toEqual([]);
		} finally {
			env.CADMUS_ADMIN_DB.prepare = originalPrepare;
		}
	});

	it("(c) init failure does not poison the isolate (subsequent requests retry)", async () => {
		const mockFailingDb = new Proxy(env.CADMUS_ADMIN_DB, {
			get(target, prop, receiver) {
				if (prop === "batch") {
					return async () => {
						throw new Error("Simulated transient D1 database error");
					};
				}
				return Reflect.get(target, prop, receiver);
			},
		});

		// Calling ensureD1Schema on failing db must reject
		await expect(
			ensureD1Schema(mockFailingDb, { force: true }),
		).rejects.toThrow("Simulated transient D1 database error");

		// Isolate cache must NOT retain the failing db as initialized
		expect(isD1DatabaseInitialized(mockFailingDb)).toBe(false);

		// Subsequent attempt with normal working DB succeeds without being poisoned
		await expect(ensureD1Schema(env.CADMUS_ADMIN_DB)).resolves.toBeUndefined();
		expect(isD1DatabaseInitialized(env.CADMUS_ADMIN_DB)).toBe(true);
	});

	it("(e) version-marker upgrade path migrates older schema and updates version", async () => {
		// Set the stored version marker to an older version (0)
		await env.CADMUS_ADMIN_DB.prepare(
			"UPDATE cadmus_schema_meta SET value = '0' WHERE key = 'version'",
		).run();

		// Invalidate isolate cache so ensureD1Schema will re-check
		resetD1InitializationCache(env.CADMUS_ADMIN_DB);
		resetD1InitStats();

		const versionBefore = await readSchemaVersion(env.CADMUS_ADMIN_DB);
		expect(versionBefore).toBe(0);

		// Running ensureD1Schema must detect version < CADMUS_SCHEMA_VERSION, run migration, and update version
		await ensureD1Schema(env.CADMUS_ADMIN_DB);

		const stats = getD1InitStats();
		expect(stats.migrationsRun).toBe(1);

		const versionAfter = await readSchemaVersion(env.CADMUS_ADMIN_DB);
		expect(versionAfter).toBe(CADMUS_SCHEMA_VERSION);
	});

	it("(f) missing table/column fallback transparently recovers and retries operation", async () => {
		const adminStore = new D1AdminStore({ db: env.CADMUS_ADMIN_DB });

		// Drop cadmus_accounts to simulate a missing table at runtime
		await env.CADMUS_ADMIN_DB.prepare(
			"DROP TABLE IF EXISTS cadmus_accounts",
		).run();

		// Calling getAccount on adminStore should intercept 'no such table: cadmus_accounts',
		// trigger ensureD1Schema({ force: true }), re-create tables, and retry successfully
		const account = await adminStore.getAccount("test-missing-fallback");
		expect(account).toBeUndefined();

		// Table must now exist again
		const tableCheck = await env.CADMUS_ADMIN_DB.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cadmus_accounts'",
		).first<{ name: string }>();
		expect(tableCheck?.name).toBe("cadmus_accounts");
	});

	it("(g) concurrent cold-start requests share a single in-flight init", async () => {
		// Drop cadmus_schema_meta to simulate a cold start on an uninitialized/fresh DB
		await env.CADMUS_ADMIN_DB.prepare(
			"DROP TABLE IF EXISTS cadmus_schema_meta",
		).run();

		resetEdgeD1InitCache();
		resetD1InitStats();

		const acct1 = `cold-concur-1-${crypto.randomUUID().slice(0, 8)}`;
		const acct2 = `cold-concur-2-${crypto.randomUUID().slice(0, 8)}`;

		const [res1, res2] = await Promise.all([
			sendRpc("bot.list", {}, { accountId: acct1, userId: `user:${acct1}` }),
			sendRpc("bot.list", {}, { accountId: acct2, userId: `user:${acct2}` }),
		]);

		expect(res1.status).toBe(200);
		expect(res2.status).toBe(200);
		expect(res1.frame.ok).toBe(true);
		expect(res2.frame.ok).toBe(true);

		const stats = getD1InitStats();
		expect(stats.migrationsRun).toBe(1);
		expect(stats.schemaChecks).toBe(1);

		// Also verify subsequent cold-start with up-to-date schema shares single check and does 0 migrations
		resetEdgeD1InitCache();
		resetD1InitStats();

		const acct3 = `cold-concur-3-${crypto.randomUUID().slice(0, 8)}`;
		const acct4 = `cold-concur-4-${crypto.randomUUID().slice(0, 8)}`;

		const [res3, res4] = await Promise.all([
			sendRpc("bot.list", {}, { accountId: acct3, userId: `user:${acct3}` }),
			sendRpc("bot.list", {}, { accountId: acct4, userId: `user:${acct4}` }),
		]);

		expect(res3.status).toBe(200);
		expect(res4.status).toBe(200);

		const stats2 = getD1InitStats();
		expect(stats2.migrationsRun).toBe(0);
		expect(stats2.schemaChecks).toBe(1);
	});

	it("(h) concurrent forced migrations do not fail with duplicate column error", async () => {
		resetEdgeD1InitCache();
		resetD1InitStats();

		// 1. Direct concurrent runD1SchemaMigrations execution against the database
		await expect(
			Promise.all([
				runD1SchemaMigrations(env.CADMUS_ADMIN_DB),
				runD1SchemaMigrations(env.CADMUS_ADMIN_DB),
			]),
		).resolves.toBeDefined();

		// 2. Concurrent ensureD1Schema with force: true
		await expect(
			Promise.all([
				ensureD1Schema(env.CADMUS_ADMIN_DB, { force: true }),
				ensureD1Schema(env.CADMUS_ADMIN_DB, { force: true }),
			]),
		).resolves.toBeDefined();
	});

	it("(j) stmt.raw() handles missing-schema error and retry failure does not poison cache", async () => {
		let cacheInvalidated = false;
		const wrapped = wrapD1WithSchemaFallback(
			env.CADMUS_ADMIN_DB,
			(opts) => ensureD1Schema(env.CADMUS_ADMIN_DB, opts),
			() => {
				cacheInvalidated = true;
				resetD1InitializationCache(env.CADMUS_ADMIN_DB);
			},
		);

		// Drop cadmus_accounts to simulate missing schema
		await env.CADMUS_ADMIN_DB.prepare(
			"DROP TABLE IF EXISTS cadmus_accounts",
		).run();

		// Statement raw() should trigger missing-schema fallback, recover, and succeed
		const rawRows = await wrapped
			.prepare("SELECT count(*) as count FROM cadmus_accounts")
			.raw();
		expect(rawRows).toBeDefined();
		expect(cacheInvalidated).toBe(true);

		// Drop cadmus_accounts again, but simulate migration failure during retry
		await env.CADMUS_ADMIN_DB.prepare(
			"DROP TABLE IF EXISTS cadmus_accounts",
		).run();

		let migrationFailed = false;
		const failingDb = new Proxy(env.CADMUS_ADMIN_DB, {
			get(target, prop, receiver) {
				if (prop === "batch") {
					return async () => {
						migrationFailed = true;
						throw new Error("Simulated D1 migration error during fallback");
					};
				}
				return Reflect.get(target, prop, receiver);
			},
		});

		const failingStore = new D1AdminStore({ db: failingDb });
		await expect(failingStore.getAccount("test-account")).rejects.toThrow(
			"Simulated D1 migration error during fallback",
		);
		expect(migrationFailed).toBe(true);

		// Isolate cache must NOT retain failingDb as initialized
		expect(isD1DatabaseInitialized(failingDb)).toBe(false);
	});

	it("(k) multiple forced inits arriving during unforced cold boot serialize and de-duplicate", async () => {
		resetEdgeD1InitCache();
		resetD1InitStats();

		// Ensure schema is up to date first
		await ensureD1Schema(env.CADMUS_ADMIN_DB);

		// Now reset cache so next ensureD1Schema is a cold-start check
		resetD1InitializationCache(env.CADMUS_ADMIN_DB);
		resetD1InitStats();

		// Start unforced init (cold boot, version check)
		const unforcedPromise = ensureD1Schema(env.CADMUS_ADMIN_DB);

		// Concurrently invoke multiple forced inits while unforced is in flight
		const forcedPromise1 = ensureD1Schema(env.CADMUS_ADMIN_DB, { force: true });
		const forcedPromise2 = ensureD1Schema(env.CADMUS_ADMIN_DB, { force: true });

		await Promise.all([unforcedPromise, forcedPromise1, forcedPromise2]);

		// Unforced init ran 0 migrations (1 version check); the two forced inits serialized and shared exactly 1 migration
		const stats = getD1InitStats();
		expect(stats.migrationsRun).toBe(1);
		expect(isD1DatabaseInitialized(env.CADMUS_ADMIN_DB)).toBe(true);

		// Verify resetD1InitializationCache(db) resets initialized state cleanly
		resetD1InitializationCache(env.CADMUS_ADMIN_DB);
		expect(isD1DatabaseInitialized(env.CADMUS_ADMIN_DB)).toBe(false);
	});
});
