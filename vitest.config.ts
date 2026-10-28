import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

/**
 * Each Vitest worker starts its own miniflare, with its own D1, KV, and
 * Durable Object storage. Files on one worker still share that workerd, so
 * tests provision accounts with `uniqueAccountId`.
 * `maxWorkers: 2` is the measured choice on a 2-vCPU runner (faster than 1
 * and 3). It is explicit so a larger machine does not pick a different pool.
 * `bun run test:conformance` reuses this config and names one file.
 * `bun run check:all` runs e2e only after the static stages, inside `bun run test`.
 * `CADMUS_HEARTBEAT_MS` is a test override. Production leaves it unset (30s).
 */
export default defineConfig({
	test: {
		fsModuleCache: false,
		isolate: false,
		fileParallelism: true,
		maxWorkers: 2,
		globalSetup: ["./e2e/global-setup.ts"],
		include: ["e2e/**/*.test.ts"],
		exclude: ["**/node_modules/**", "**/dist/**"],
	},
	plugins: [
		cloudflareTest(({ inject }) => ({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				bindings: {
					CADMUS_AUTH_SECRET: "test-cadmus-secret",
					CADMUS_ENCRYPTION_KEY: "test-cadmus-encryption-key-32bytes!",
					CADMUS_DEFAULT_TIMEZONE: "UTC",
					CADMUS_HARVEST_DELAY_MS: "200",
					CADMUS_HEARTBEAT_MS: "200",
					CADMUS_DAEMON_BRIDGE_HOST: inject("daemonBridgeHost"),
					CADMUS_DAEMON_BRIDGE_PORT: String(inject("daemonBridgePort")),
					CADMUS_DAEMON_BRIDGE_EVENT_PORT: String(
						inject("daemonBridgeEventPort"),
					),
				},
			},
		})),
	],
});
