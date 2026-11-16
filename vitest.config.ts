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
		globalSetup: ["./tests/global-setup.ts"],
		include: [
			"e2e/**/*.test.ts",
			"packages/worker/tests/*.test.ts",
			"tests/cli/**/*.test.ts",
			"tests/daemon/**/*.test.ts",
			"tests/web/**/*.test.ts",
		],
		exclude: ["**/node_modules/**", "**/dist/**"],
		coverage: {
			provider: "v8",
			include: [
				"packages/worker/src/**",
				"packages/contract/src/**",
				"packages/contract/generated/**",
			],
			exclude: [
				"packages/worker/tests/**",
				"**/types.ts",
				"**/node_modules/**",
				"**/dist/**",
			],
			reporter: ["text", "json-summary", "html"],
		},
	},
	plugins: [
		cloudflareTest(({ inject }) => ({
			wrangler: { configPath: "./wrangler.jsonc" },
			miniflare: {
				bindings: {
					CADMUS_LOG_LEVEL: "silent",
					CADMUS_PUBLIC_URL: "https://example.com",
					CADMUS_AUTH_SECRET: "test-cadmus-secret",
					CADMUS_ENCRYPTION_KEY: "test-cadmus-encryption-key-32bytes!",
					CADMUS_DEFAULT_TIMEZONE: "UTC",
					CADMUS_HARVEST_DELAY_MS: "200",
					GOOGLE_CLIENT_ID: "test-google-client.apps.googleusercontent.com",
					GOOGLE_CLIENT_SECRET: "test-google-client-secret",
					CADMUS_BOOTSTRAP_SUPER_ADMIN_EMAIL: "boss@example.com",
					CADMUS_DEPLOY_ENV: "test",
					CADMUS_DEV_PASSWORD_LOGIN: "1",
					CADMUS_DEV_PASSWORD_HASH:
						"pbkdf2-sha256$1000$BwcHBwcHBwcHBwcHBwcHBw$vyzvBoini4B-WFTdP9_d8p5hL9Gnc8Kc16iVH9u7rRw",
					CADMUS_HEARTBEAT_MS: "200",
					CADMUS_TASK_MAX_ROUNDS: "2",
					CADMUS_DAEMON_BRIDGE_HOST: inject("daemonBridgeHost"),
					CADMUS_DAEMON_BRIDGE_PORT: String(inject("daemonBridgePort")),
					CADMUS_DAEMON_BRIDGE_EVENT_PORT: String(
						inject("daemonBridgeEventPort"),
					),
					CADMUS_CLI_BRIDGE_PORT: String(inject("cliBridgePort")),
				},
			},
		})),
	],
});
