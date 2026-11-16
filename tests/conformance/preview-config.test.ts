import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repoRoot = resolve(__dirname, "../..");
const PRODUCTION_D1_ID = "1ae99680-9dab-4883-8449-4a7dd0f53212";
const PREVIEW_D1_ID = "5c25c5bf-879d-4a5b-a31f-ba6d8a3c85a8";
const PREVIEW_D1_NAME = "cadmus-admin-staging";

function stripJsonComments(jsonString: string): string {
	return jsonString.replace(
		/\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g,
		(m, g) => (g ? "" : m),
	);
}

function loadWranglerConfig() {
	const raw = readFileSync(resolve(repoRoot, "wrangler.jsonc"), "utf8");
	return JSON.parse(stripJsonComments(raw));
}

describe("wrangler preview config", () => {
	const config = loadWranglerConfig();

	it("enables preview_urls and sets preview_database_id on production D1 binding", () => {
		expect(config.name).toBe("cadmus");
		expect(config.env).toBeUndefined();
		expect(config.preview_urls).toBe(true);
		expect(config.keep_vars).toBe(true);
		expect(config.d1_databases[0]).toEqual(
			expect.objectContaining({
				binding: "CADMUS_ADMIN_DB",
				database_name: "cadmus-admin",
				database_id: PRODUCTION_D1_ID,
				preview_database_id: PREVIEW_D1_ID,
			}),
		);
	});

	it("configures preview D1, Durable Objects, and preview vars inside previews block", () => {
		const previews = config.previews;
		expect(previews).toBeDefined();
		expect(previews.d1_databases[0]).toEqual(
			expect.objectContaining({
				binding: "CADMUS_ADMIN_DB",
				database_name: PREVIEW_D1_NAME,
				database_id: PREVIEW_D1_ID,
			}),
		);
		expect(previews.durable_objects.bindings).toEqual([
			{
				name: "CADMUS_BOT_FAMILY",
				class_name: "CadmusBotFamilyDO",
			},
			{
				name: "CADMUS_ENV",
				class_name: "CadmusEnvDO",
			},
			{
				name: "CADMUS_AUTH_LIMITER",
				class_name: "CadmusAuthLimiterDO",
			},
		]);
		expect(previews.vars).toEqual(
			expect.objectContaining({
				IS_PREVIEW: "true",
				CADMUS_AUTH_SECRET: "dev-cadmus-secret",
				CADMUS_ENCRYPTION_KEY: "dev-cadmus-encryption-key-32bytes!",
				CADMUS_DEFAULT_TIMEZONE: "UTC",
				CADMUS_HARVEST_DELAY_MS: "60000",
				CADMUS_LOG_LEVEL: "debug",
			}),
		);
	});

	it("has deploy:preview script in package.json", () => {
		const pkg = JSON.parse(
			readFileSync(resolve(repoRoot, "package.json"), "utf8"),
		);
		expect(pkg.scripts["deploy:preview"]).toBe("wrangler preview");
	});

	it("ensures KV namespace bindings (if defined) have isolated preview namespaces", () => {
		const topLevelKv = (config.kv_namespaces ?? []) as Array<{
			binding: string;
			id: string;
		}>;
		const previewKv = (config.previews?.kv_namespaces ?? []) as Array<{
			binding: string;
			id: string;
		}>;
		const cacheKv = topLevelKv.find((kv) => kv.binding === "CADMUS_CACHE_KV");
		if (cacheKv) {
			const previewCacheKv = previewKv.find(
				(kv) => kv.binding === "CADMUS_CACHE_KV",
			);
			expect(previewCacheKv).toBeDefined();
			expect(previewCacheKv?.id).toBeDefined();
			expect(previewCacheKv?.id).not.toBe(cacheKv.id);
		}
	});

	it("declares the auth rate limits and the lockout Durable Object in production and previews (issue #3 phase 8)", () => {
		const limits = (block: {
			ratelimits: {
				name: string;
				namespace_id: string;
				simple: { limit: number; period: number };
			}[];
		}) =>
			Object.fromEntries(
				block.ratelimits.map((r) => [
					r.name,
					`${r.simple.limit}/${r.simple.period}s`,
				]),
			);
		expect(limits(config)).toEqual({
			CADMUS_AUTH_RATELIMIT: "20/60s",
			CADMUS_AUTH_REFRESH_RATELIMIT: "120/60s",
			CADMUS_AUTH_RPC_RATELIMIT: "60/60s",
		});
		expect(limits(config.previews)).toEqual(limits(config));
		// A namespace id names one limiter, so production and previews must not share it.
		const ids = [...config.ratelimits, ...config.previews.ratelimits].map(
			(r: { namespace_id: string }) => r.namespace_id,
		);
		expect(new Set(ids).size).toBe(ids.length);
		expect(config.durable_objects.bindings).toContainEqual({
			name: "CADMUS_AUTH_LIMITER",
			class_name: "CadmusAuthLimiterDO",
		});
		expect(config.migrations.at(-1)).toEqual({
			tag: "v5",
			new_sqlite_classes: ["CadmusAuthLimiterDO"],
		});
	});
});
