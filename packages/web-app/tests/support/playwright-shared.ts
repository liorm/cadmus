import {
	defineConfig,
	devices,
	type PlaywrightTestConfig,
} from "@playwright/test";
import { parseEngine } from "./engine.ts";

const engine = parseEngine();
const baseURL = process.env.CADMUS_TEST_BASE_URL ?? "http://127.0.0.1:8799";

/** Shared worker, viewport, and engine setup for flow tests and screenshots. */
export function cadmusPlaywright(
	testDir: string,
	overrides: PlaywrightTestConfig = {},
): PlaywrightTestConfig {
	return defineConfig({
		testDir,
		fullyParallel: true,
		forbidOnly: Boolean(process.env.CI),
		retries: 0,
		workers: process.env.CI ? 2 : undefined,
		globalSetup: "./tests/support/global-setup.ts",
		globalTeardown: "./tests/support/global-teardown.ts",
		use: {
			baseURL,
			...devices["Pixel 7"],
			browserName: "chromium",
		},
		webServer: {
			command:
				"bun run --cwd ../.. web-app:build && bunx wrangler dev --port 8799",
			url: `${baseURL}/health`,
			reuseExistingServer: !process.env.CI,
			timeout: 180_000,
		},
		metadata: { engine },
		...overrides,
	});
}
