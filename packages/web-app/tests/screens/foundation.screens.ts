import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { THEMES, type ThemeName } from "../../src/theme/theme.ts";
import { seedBot } from "../support/account.ts";
import { clickByRole, fillByLabel } from "../support/actions.ts";
import { expect, test } from "../support/fixtures.ts";

const OUT_DIR = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../.screens",
);
const WORKER_BASE = "http://127.0.0.1:8799";

type Shot = {
	name: string;
	path: string;
	ready: string;
	prepare?: (page: Page) => Promise<void>;
};

const shots: Shot[] = [
	{
		name: "home",
		path: "/app/#/",
		ready: "Cadmus",
	},
	{
		name: "settings",
		path: "/app/#/settings",
		ready: "Settings",
	},
	{
		name: "sheet",
		path: "/app/#/",
		ready: "Cadmus",
		prepare: async (page) => {
			await clickByRole(page, "button", "Open menu");
			await expect(page.getByRole("dialog")).toBeVisible();
		},
	},
	{
		name: "composer",
		path: "/app/#/",
		ready: "Cadmus",
		prepare: async (page) => {
			await fillByLabel(page, "Message", "line one\nline two\nline three");
		},
	},
	{
		name: "search",
		path: "/app/#/search",
		ready: "Search",
	},
	{
		name: "archive",
		path: "/app/#/settings/archive",
		ready: "Archive",
	},
	{
		name: "chat",
		path: "/app/#/chat/demo",
		ready: "Chat",
	},
	{
		name: "chat-raw",
		path: "/app/#/chat/demo?view=raw",
		ready: "Raw transcript",
	},
	{
		name: "new-task",
		path: "/app/#/new?bot=echo-bot",
		ready: "New task",
	},
	{
		name: "new-bot",
		path: "/app/#/bot/new",
		ready: "New bot",
	},
	{
		name: "bot-memory",
		path: "/app/#/bot/echo-bot/memory",
		ready: "echo-bot",
	},
	{
		name: "schedule",
		path: "/app/#/bot/echo-bot/schedule/daily",
		ready: "Schedule",
	},
];

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

for (const shot of shots) {
	test(shot.name, async ({ page, accountId, baseURL }) => {
		await seedBot(baseURL ?? WORKER_BASE, accountId, "Echo Bot", "echo-bot");
		for (const theme of THEMES) {
			await openThemed(page, shot.path, theme);
			await expect(
				page.getByRole("heading", { name: shot.ready }),
			).toBeVisible();
			if (
				shot.name === "home" ||
				shot.name === "sheet" ||
				shot.name === "composer"
			) {
				await expect(
					page.getByRole("button", { name: "Echo Bot" }),
				).toBeVisible();
			}
			await shot.prepare?.(page);
			await page.screenshot({
				path: resolve(OUT_DIR, `${shot.name}-${theme}.png`),
				animations: "disabled",
			});
		}
	});
}
