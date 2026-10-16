// Browser check of the bot dialog tool switches.
// Not part of `bun test` (that root is `test/`). Run with `bun run test:e2e`.
// Locally, skips when Chromium cannot start. In CI, that is a failure.

import { afterAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import type { Browser, Page } from "playwright";
import { chromium } from "playwright";
import type { App } from "../src/app.ts";
import { FakeEgress } from "../test/egress/fake-egress.ts";
import { routeEgress } from "../test/egress/route.ts";
import {
	defined,
	seedBot,
	settle,
	startBot,
	tempHome,
	until,
} from "../test/support.ts";

const TOKEN = "test-web-token";
const CHROME = `${process.env.HOME}/.cache/ms-playwright/chromium-1234/chrome-linux/chrome`;

async function launch(): Promise<Browser | undefined> {
	const options = {
		headless: true,
		args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
	};
	try {
		if (existsSync(CHROME)) {
			return await chromium.launch({ ...options, executablePath: CHROME });
		}
		return await chromium.launch(options);
	} catch (error) {
		if (process.env.CI) {
			throw new Error(`Chromium failed to start in CI: ${error}`, {
				cause: error,
			});
		}
		console.warn(`skipping browser e2e: ${error}`);
		return undefined;
	}
}

const browser = await launch();

describe.skipIf(!browser)("bot dialog tool toggles", () => {
	let egress: FakeEgress;
	let unroute: () => void;
	let app: App;
	let page: Page;

	it("turns web.search off in the dialog, saves, and drops it from the model offer", async () => {
		egress = new FakeEgress();
		unroute = routeEgress(egress.url);
		const home = await tempHome();
		await seedBot(home);
		app = await startBot(home, { WEB_TOKEN: TOKEN, WEB_PORT: "0" });
		if (!app.web) throw new Error("web listener did not start");
		const url = app.web.url;
		page = await defined(browser, "browser").newPage();
		await page.goto(`${url}/?token=${encodeURIComponent(TOKEN)}`);
		await page.getByTitle("Settings").click();
		const row = page.locator("button.tool-row", { hasText: "web.search" });
		await row.waitFor();
		expect(await row.getAttribute("aria-pressed")).toBe("true");
		await row.click();
		expect(await row.getAttribute("aria-pressed")).toBe("false");
		const save = page.getByRole("button", { name: "Save" });
		await until(async () => save.isEnabled(), "save to enable");
		await save.click();
		await until(
			async () => page.getByTitle("Settings").isVisible(),
			"the dialog to close",
		);
		const tools = (await (
			await fetch(`${url}/api/bots/default/tools`, {
				headers: { authorization: `Bearer ${TOKEN}` },
			})
		).json()) as { enabled: string[] };
		expect(tools.enabled).not.toContain("web.search");
		expect(tools.enabled).toContain("web.fetch");
		egress.xai.script.push({ text: "hello back" });
		egress.telegram.push("hello");
		await until(
			() => egress.telegram.texts().includes("hello back"),
			"the reply",
		);
		await settle(app, egress);
		const offered = JSON.stringify(
			defined(egress.xai.requests[0], "request").body,
		).replaceAll(" ", "");
		expect(offered).not.toContain('"name":"web.search"');
		expect(offered).toContain('"name":"web.fetch"');
		expect(egress.telegram.texts()).toContain("hello back");
		await page.close();
		await app.stop();
		unroute();
		egress.stop();
	});
});

afterAll(async () => {
	await browser?.close();
});
