import { existsSync, readFileSync } from "node:fs";
import { type Browser, test as base } from "@playwright/test";
import { MASTER_TOKEN, provisionAccount, uniqueAccountId } from "./account.ts";
import { captureCoverage } from "./coverage.ts";
import { CDP_URL_FILE, parseEngine } from "./engine.ts";

function cdpUrl(): string | undefined {
	if (process.env.CADMUS_TEST_CDP_URL) return process.env.CADMUS_TEST_CDP_URL;
	if (existsSync(CDP_URL_FILE)) {
		return readFileSync(CDP_URL_FILE, "utf8").trim() || undefined;
	}
	return undefined;
}

const WORKER_BASE = "http://127.0.0.1:8799";

export const test = base.extend<{ accountId: string }, { browser: Browser }>({
	page: async ({ page }, use, info) => {
		await use(page);
		await captureCoverage(page, info.testId);
	},
	accountId: [
		async ({ baseURL, page }, use) => {
			const accountId = uniqueAccountId();
			await provisionAccount(baseURL ?? WORKER_BASE, accountId);
			await page.addInitScript(
				(cfg) => {
					localStorage.setItem("cadmus.dev.config", JSON.stringify(cfg));
				},
				{
					accountId,
					userId: "owner",
					familyId: "default",
					token: MASTER_TOKEN,
				},
			);
			await use(accountId);
		},
		{ auto: true },
	],
	// Worker-scoped so we never touch Playwright's built-in `browser` fixture.
	// That fixture launches a local Chromium before the test body runs.
	browser: [
		async ({ playwright, launchOptions }, use) => {
			if (parseEngine() === "chrome") {
				const launched = await playwright.chromium.launch(launchOptions);
				await use(launched);
				await launched.close();
				return;
			}
			const cdp = cdpUrl();
			if (!cdp) {
				throw new Error(
					"CDP URL missing. Start Obscura or Lightpanda, or pass --engine=chrome.",
				);
			}
			const connected = await playwright.chromium.connectOverCDP(cdp);
			await use(connected);
			await connected.close();
		},
		{ scope: "worker", timeout: 0 },
	],
});

export { expect } from "@playwright/test";
