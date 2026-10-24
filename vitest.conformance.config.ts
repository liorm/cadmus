import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/**
 * Contract conformance runs once, from `bun run test:conformance`.
 * The default vitest config excludes this file so `bun run test` does not
 * run it a second time. Keep the miniflare bindings identical to vitest.config.ts.
 */
export default defineConfig({
	test: {
		fsModuleCache: false,
		isolate: false,
		include: ["e2e/contract-conformance.test.ts"],
	},
	plugins: [
		cloudflareTest({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				bindings: {
					CADMUS_AUTH_SECRET: "test-cadmus-secret",
					CADMUS_ENCRYPTION_KEY: "test-cadmus-encryption-key-32bytes!",
					CADMUS_DEFAULT_TIMEZONE: "UTC",
					CADMUS_HARVEST_DELAY_MS: "200",
				},
			},
		}),
	],
});
