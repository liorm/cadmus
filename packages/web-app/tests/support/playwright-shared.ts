import { availableParallelism } from "node:os";
import {
	defineConfig,
	devices,
	type PlaywrightTestConfig,
} from "@playwright/test";
import { parseEngine } from "./engine.ts";
import { prepareHarnessRun } from "./harness-env-file.ts";

const engine = parseEngine();
const baseURL = process.env.CADMUS_TEST_BASE_URL ?? "http://127.0.0.1:8799";

// Only the explicit real-session runs (the Chrome passkeys-real CI step, or a
// local run that sets this) start the server with the test-only entry that
// serves the typed session and read operations. Every other run starts the
// unchanged server and creates nothing. The per-run token lives in this
// process's environment and in a private env file that harness-env-file.ts
// creates once per run and global-teardown.ts removes.
const realSessionHarness = process.env.CADMUS_REAL_SESSION_HARNESS === "1";
if (realSessionHarness) prepareHarnessRun();

// Local-only. wrangler.jsonc keeps CADMUS_DEPLOY_ENV=production and never
// sets CADMUS_DEV_PASSWORD_*, so this override exists only on the test server.
// The hash is for the password `cadmus-playwright-dev` (1000 PBKDF2 rounds).
// Single quotes stop the shell from expanding `$` in the hash.
const DEV_PASSWORD_HASH =
	"pbkdf2-sha256$1000$BwcHBwcHBwcHBwcHBwcHBw$MLMr4QjaXgE1WBPr41dCQ-PdWaQjvF56G3iiWCe2kIU";

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

const TEST_SERVER_VARS = [
	"CADMUS_PUBLIC_URL:http://localhost:8799",
	"CADMUS_DEV_PASSWORD_LOGIN:1",
	`CADMUS_DEV_PASSWORD_HASH:${DEV_PASSWORD_HASH}`,
	"CADMUS_DEPLOY_ENV:test",
	"CADMUS_BOOTSTRAP_SUPER_ADMIN_EMAIL:boss@example.com",
	// Fake client so /auth/providers lists Google. Tests never call Google.
	"GOOGLE_CLIENT_ID:playwright-google-client",
	"GOOGLE_CLIENT_SECRET:playwright-google-secret",
	// Test-only rate-limit & boot-retry knobs (ignored in production).
	"CADMUS_AUTH_RATE_LIMIT_WINDOW_MS:15000",
	"CADMUS_BOOT_REFRESH_RETRY_MS:200",
	"CADMUS_BOOT_REFRESH_RETRIES:2",
]
	.map((entry) => `--var=${shellQuote(entry)}`)
	.join(" ");

const SERVER_COMMAND = realSessionHarness
	? // The positional script replaces the config's `main` for this run only.
		// `--env-file` binds only the token file's keys (not the process
		// environment); the path comes from the environment, so neither it nor
		// the token is on this command line.
		`bun run --cwd ../.. web-app:build && bun tests/support/test-server.ts ../worker/tests/harness/real-session-worker.ts --env-file "$CADMUS_HARNESS_ENV_FILE" --inspector-port 9299 ${TEST_SERVER_VARS}`
	: `bun run --cwd ../.. web-app:build && bun tests/support/test-server.ts --inspector-port 9299 ${TEST_SERVER_VARS}`;

/** Shared worker, viewport, and engine setup for flow tests and screenshots. */
export function cadmusPlaywright(
	testDir: string,
	overrides: PlaywrightTestConfig = {},
): PlaywrightTestConfig {
	const cores = Math.max(1, availableParallelism());
	return defineConfig({
		testDir,
		fullyParallel: true,
		forbidOnly: Boolean(process.env.CI),
		// CI runs wrangler dev and Obscura on a 2-core runner; a different UI test
		// times out under load on most failing main runs. One retry keeps the
		// gate while Playwright still reports the test as flaky.
		retries: process.env.CI ? 1 : 0,
		workers: process.env.CI ? 2 : cores,
		globalSetup: "./tests/support/global-setup.ts",
		globalTeardown: "./tests/support/global-teardown.ts",
		use: {
			baseURL,
			...devices["Pixel 7"],
			browserName: "chromium",
			// A retry that passes hides the first failure. In CI, keep the trace
			// of every failed attempt, including one a retry rescues, so the job
			// can upload it. Passing attempts leave nothing behind.
			trace: process.env.CI ? "retain-on-failure" : "off",
		},
		webServer: {
			command: SERVER_COMMAND,
			url: `${baseURL}/health`,
			reuseExistingServer: !process.env.CI,
			timeout: 180_000,
		},
		metadata: { engine },
		...overrides,
	});
}
