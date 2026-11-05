import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { THEMES, type ThemeName } from "../../src/theme/theme.ts";
import { seedBot, sendAccountRpc } from "../support/account.ts";
import { fillByLabel } from "../support/actions.ts";
import { expect, test } from "../support/fixtures.ts";

const OUT_DIR = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../.screens",
);
const WORKER_BASE = "http://127.0.0.1:8799";

async function openThemed(page: Page, path: string, theme: ThemeName) {
	await page.goto(path);
	await page.evaluate((themeName) => {
		sessionStorage.setItem("cadmus.screenshot.theme", themeName);
		localStorage.setItem("cadmus.theme", themeName);
	}, theme);
	await page.reload();
	await expect
		.poll(async () =>
			page.evaluate(() => document.documentElement.getAttribute("data-theme")),
		)
		.toBe(theme);
}

test.beforeAll(() => {
	mkdirSync(OUT_DIR, { recursive: true });
});

test.beforeEach(async ({ page }) => {
	await page.addInitScript(() => {
		const theme = sessionStorage.getItem("cadmus.screenshot.theme");
		if (theme) localStorage.setItem("cadmus.theme", theme);
	});
});

test("01-empty", async ({ page }) => {
	for (const theme of THEMES) {
		await openThemed(page, "/", theme);
		await expect(
			page.getByRole("heading", { name: "It's quiet in here." }),
		).toBeVisible();
		await page.screenshot({
			path: resolve(OUT_DIR, `01-empty-${theme}.png`),
			animations: "disabled",
		});
	}
});

test("02-newbot", async ({ page }) => {
	for (const theme of THEMES) {
		await openThemed(page, "/bot/new", theme);
		await expect(page.getByRole("heading", { name: "New bot" })).toBeVisible();
		await fillByLabel(page, "Name", "Garden Agent");
		await expect(page.getByText("GA", { exact: true })).toBeVisible();
		await page.screenshot({
			path: resolve(OUT_DIR, `02-newbot-${theme}.png`),
			animations: "disabled",
		});
	}
});

test("05-newtask", async ({ page, accountId, baseURL }) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "OnePlus HA Agent", "ha-agent");
	await seedBot(origin, accountId, "Leader", "leader-bot");
	await sendAccountRpc(origin, accountId, "family.update", {
		teamLeaderBotId: "leader-bot",
	});
	for (const theme of THEMES) {
		await openThemed(page, "/new?bot=ha-agent", theme);
		await expect(
			page.getByRole("button", { name: "To: OnePlus HA Agent" }),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Let TL route" }),
		).toBeVisible();
		await fillByLabel(
			page,
			"Message",
			"Redo the main HA dashboard for the wall tablet.",
		);
		await page.screenshot({
			path: resolve(OUT_DIR, `05-newtask-${theme}.png`),
			animations: "disabled",
		});
	}
});
