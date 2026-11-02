import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { resetEdgeD1InitCache } from "../src/index.js";
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
} from "../src/store/d1-admin.js";
import { sendRpc, uniqueAccountId } from "./helpers.js";

async function restoreAdminSchema(): Promise<void> {
	resetD1InitializationCache(env.CADMUS_ADMIN_DB);
	await ensureD1Schema(env.CADMUS_ADMIN_DB, { force: true });
}

describe("D1 Schema Initialization & Isolate Caching (Issue #18)", () => {
	it("(a) fresh D1 self-initializes transparently on the first request", async () => {
		resetEdgeD1InitCache();
		resetD1InitStats();

		const acctId = uniqueAccountId("fresh");
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
		expect(tableNames.some((name) => name.includes("secrets"))).toBe(false);
		expect(tableNames).toContain("cadmus_schema_meta");
	});

	it("(b) repeated requests in the same isolate do zero initialization round-trips", async () => {
		// Warm this isolate here so the zero-round-trip proof does not depend on (a).
		await ensureD1Schema(env.CADMUS_ADMIN_DB);
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
			const acct1 = uniqueAccountId("warm-1");
			const res1 = await sendRpc(
				"bot.list",
				{},
				{ accountId: acct1, userId: `user:${acct1}` },
			);
			expect(res1.status).toBe(200);

			const acct2 = uniqueAccountId("warm-2");
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
		try {
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
		} finally {
			await restoreAdminSchema();
		}
	});

	it("(f) missing table/column fallback transparently recovers and retries operation", async () => {
		const adminStore = new D1AdminStore({ db: env.CADMUS_ADMIN_DB });
		const missingAccountId = uniqueAccountId("missing-fallback");

		try {
			// Drop cadmus_accounts to simulate a missing table at runtime
			await env.CADMUS_ADMIN_DB.prepare(
				"DROP TABLE IF EXISTS cadmus_accounts",
			).run();

			// Calling getAccount on adminStore should intercept 'no such table: cadmus_accounts',
			// trigger ensureD1Schema({ force: true }), re-create tables, and retry successfully
			const account = await adminStore.getAccount(missingAccountId);
			expect(account).toBeUndefined();

			// Table must now exist again
			const tableCheck = await env.CADMUS_ADMIN_DB.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cadmus_accounts'",
			).first<{ name: string }>();
			expect(tableCheck?.name).toBe("cadmus_accounts");
		} finally {
			await restoreAdminSchema();
		}
	});

	it("(g) concurrent cold-start requests share a single in-flight init", async () => {
		try {
			// Drop cadmus_schema_meta to simulate a cold start on an uninitialized/fresh DB
			await env.CADMUS_ADMIN_DB.prepare(
				"DROP TABLE IF EXISTS cadmus_schema_meta",
			).run();

			resetEdgeD1InitCache();
			resetD1InitStats();

			const acct1 = uniqueAccountId("cold-concur-1");
			const acct2 = uniqueAccountId("cold-concur-2");

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

			const acct3 = uniqueAccountId("cold-concur-3");
			const acct4 = uniqueAccountId("cold-concur-4");

			const [res3, res4] = await Promise.all([
				sendRpc("bot.list", {}, { accountId: acct3, userId: `user:${acct3}` }),
				sendRpc("bot.list", {}, { accountId: acct4, userId: `user:${acct4}` }),
			]);

			expect(res3.status).toBe(200);
			expect(res4.status).toBe(200);

			const stats2 = getD1InitStats();
			expect(stats2.migrationsRun).toBe(0);
			expect(stats2.schemaChecks).toBe(1);
		} finally {
			await restoreAdminSchema();
		}
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

		try {
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
			await expect(
				failingStore.getAccount(uniqueAccountId("fallback-fail")),
			).rejects.toThrow("Simulated D1 migration error during fallback");
			expect(migrationFailed).toBe(true);

			// Isolate cache must NOT retain failingDb as initialized
			expect(isD1DatabaseInitialized(failingDb)).toBe(false);
		} finally {
			await restoreAdminSchema();
		}
	});

	it("(k) multiple forced inits arriving during unforced cold boot serialize and de-duplicate", async () => {
		try {
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
			const forcedPromise1 = ensureD1Schema(env.CADMUS_ADMIN_DB, {
				force: true,
			});
			const forcedPromise2 = ensureD1Schema(env.CADMUS_ADMIN_DB, {
				force: true,
			});

			await Promise.all([unforcedPromise, forcedPromise1, forcedPromise2]);

			// Unforced init ran 0 migrations (1 version check); the two forced inits serialized and shared exactly 1 migration
			const stats = getD1InitStats();
			expect(stats.migrationsRun).toBe(1);
			expect(isD1DatabaseInitialized(env.CADMUS_ADMIN_DB)).toBe(true);

			// Verify resetD1InitializationCache(db) resets initialized state cleanly
			resetD1InitializationCache(env.CADMUS_ADMIN_DB);
			expect(isD1DatabaseInitialized(env.CADMUS_ADMIN_DB)).toBe(false);
		} finally {
			await restoreAdminSchema();
		}
	});

	it("(l) drops legacy credential columns and keeps env rows", async () => {
		const accountId = uniqueAccountId("env-migrate");
		const legacy = ["cadmus", "tools", "env", "secrets"].join("_");
		try {
			await ensureD1Schema(env.CADMUS_ADMIN_DB);
			await env.CADMUS_ADMIN_DB.prepare(
				`INSERT INTO cadmus_tools_envs (
          account_id, env_id, kind, label, workspace_path, persist,
          confine_to_workspace, shared_workspace, updated_at
        ) VALUES (?1, 'ld_keep', 'local-daemon', 'Keep', '/work', 1, 0, 0, ?2)`,
			)
				.bind(accountId, 1_700_000_000_000)
				.run();
			await env.CADMUS_ADMIN_DB.prepare(
				"ALTER TABLE cadmus_tools_envs RENAME TO cadmus_tools_envs_old",
			).run();
			await env.CADMUS_ADMIN_DB.prepare(
				`CREATE TABLE cadmus_tools_envs (
          account_id TEXT NOT NULL,
          env_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          label TEXT,
          workspace_path TEXT,
          persist INTEGER NOT NULL DEFAULT 1,
          confine_to_workspace INTEGER NOT NULL DEFAULT 1,
          shared_workspace INTEGER NOT NULL DEFAULT 0,
          secret_id TEXT,
          secret_missing INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (account_id, env_id)
        )`,
			).run();
			await env.CADMUS_ADMIN_DB.prepare(
				`INSERT INTO cadmus_tools_envs (
          account_id, env_id, kind, label, workspace_path, persist,
          confine_to_workspace, shared_workspace, secret_id, secret_missing, updated_at
        )
        SELECT account_id, env_id, kind, label, workspace_path, persist,
          confine_to_workspace, shared_workspace, NULL, 0, updated_at
        FROM cadmus_tools_envs_old`,
			).run();
			await env.CADMUS_ADMIN_DB.prepare(
				"DROP TABLE cadmus_tools_envs_old",
			).run();
			await env.CADMUS_ADMIN_DB.prepare(
				`CREATE TABLE ${legacy} (
          account_id TEXT NOT NULL,
          secret_id TEXT NOT NULL,
          kind TEXT NOT NULL,
          token_hash TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (account_id, secret_id)
        )`,
			).run();
			await env.CADMUS_ADMIN_DB.prepare(
				"UPDATE cadmus_schema_meta SET value = '2' WHERE key = 'version'",
			).run();

			resetD1InitializationCache(env.CADMUS_ADMIN_DB);
			await ensureD1Schema(env.CADMUS_ADMIN_DB);

			const columns = await env.CADMUS_ADMIN_DB.prepare(
				"PRAGMA table_info(cadmus_tools_envs)",
			).all<{ name: string }>();
			const names = columns.results.map((column) => column.name);
			expect(names).toContain("daemon_token_hash");
			expect(names).not.toContain("secret_id");
			expect(names).not.toContain("secret_missing");
			const tables = await env.CADMUS_ADMIN_DB.prepare(
				"SELECT name FROM sqlite_master WHERE type = 'table'",
			).all<{ name: string }>();
			expect(tables.results.some((table) => table.name === legacy)).toBe(false);
			const row = await env.CADMUS_ADMIN_DB.prepare(
				`SELECT label, workspace_path FROM cadmus_tools_envs
         WHERE account_id = ?1 AND env_id = 'ld_keep'`,
			)
				.bind(accountId)
				.first<{ label: string; workspace_path: string }>();
			expect(row).toEqual({ label: "Keep", workspace_path: "/work" });
			expect(await readSchemaVersion(env.CADMUS_ADMIN_DB)).toBe(
				CADMUS_SCHEMA_VERSION,
			);
		} finally {
			await restoreAdminSchema();
		}
	});
});
