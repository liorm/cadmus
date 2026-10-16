// Browser check of the knowledge editor.
// Not part of `bun test` (that root is `test/`). Run with `bun run test:e2e`.
// Locally, skips when Chromium cannot start. In CI, that is a failure.

import { afterAll, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Browser, Page } from "playwright";
import { chromium } from "playwright";
import type { App } from "../src/app.ts";
import { FakeEgress } from "../test/egress/fake-egress.ts";
import { routeEgress } from "../test/egress/route.ts";
import {
	defined,
	seedBot,
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

describe.skipIf(!browser)("knowledge editor", () => {
	let egress: FakeEgress;
	let unroute: () => void;
	let app: App;
	let page: Page;

	it("edits description and body without showing frontmatter", async () => {
		egress = new FakeEgress();
		unroute = routeEgress(egress.url);
		const home = await tempHome();
		await seedBot(home);
		const dir = join(home, "bots", "default", "knowledge");
		await mkdir(dir, { recursive: true });
		await writeFile(
			join(dir, "travel.md"),
			"---\ndescription: Travel notes.\nversion: 1\n---\nkeep me\n",
		);
		app = await startBot(home, { WEB_TOKEN: TOKEN, WEB_PORT: "0" });
		if (!app.web) throw new Error("web listener did not start");
		page = await defined(browser, "browser").newPage();
		await page.goto(`${app.web.url}/?token=${encodeURIComponent(TOKEN)}`);
		await page.getByRole("button", { name: "Knowledge" }).click();
		await page.getByText("travel.md", { exact: true }).click();
		const description = page.getByLabel("Description");
		await description.waitFor();
		expect(await description.inputValue()).toBe("Travel notes.");
		const version = page.getByLabel("Version");
		expect(await version.inputValue()).toBe("1");
		expect(await version.getAttribute("readonly")).not.toBeNull();
		const body = page.locator("textarea.src");
		expect(await body.inputValue()).toBe("keep me\n");
		expect(await body.inputValue()).not.toContain("---");
		await description.fill("Updated travel notes.");
		await body.fill("Lisbon in May.\n");
		await page.getByRole("button", { name: "Save" }).click();
		await until(
			async () => page.getByText("Knowledge updated").isVisible(),
			"the save confirmation",
		);
		expect(await readFile(join(dir, "travel.md"), "utf8")).toBe(
			"---\ndescription: Updated travel notes.\nversion: 2\n---\nLisbon in May.\n",
		);
		await page.close();
		await app.stop();
		unroute();
		egress.stop();
	});
});

afterAll(async () => {
	await browser?.close();
});
