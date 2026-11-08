import { devices, type PlaywrightTestConfig } from "@playwright/test";
import { cadmusPlaywright } from "./tests/support/playwright-shared.ts";

const shared = cadmusPlaywright("./tests/flows");

/**
 * Mobile journeys stay in `tests/flows` on the Pixel 7 device from main.
 * Desktop journeys live in `tests/desktop` at 1440×900. One worker serves both.
 */
const config: PlaywrightTestConfig = {
	...shared,
	projects: [
		{
			name: "mobile",
			testDir: "./tests/flows",
			use: {
				...devices["Pixel 7"],
				browserName: "chromium",
			},
		},
		{
			name: "desktop",
			testDir: "./tests/desktop",
			use: {
				...devices["Desktop Chrome"],
				viewport: { width: 1440, height: 900 },
				browserName: "chromium",
			},
		},
	],
};

export default config;
