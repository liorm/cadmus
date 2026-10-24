import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		fsModuleCache: false,
		isolate: false,
		include: ["e2e/**/*.test.ts"],
		exclude: [
			"**/node_modules/**",
			"**/dist/**",
			"e2e/contract-conformance.test.ts",
		],
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
