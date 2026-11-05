import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { THEMES, type ThemeName } from "../../src/theme/theme.ts";
import { seedBot, sendAccountRpc } from "../support/account.ts";
import { clickByRole } from "../support/actions.ts";
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

async function seedProfile(origin: string, accountId: string) {
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	await sendAccountRpc(origin, accountId, "bot.update", {
		botId: "echo-bot",
		timezone: "Asia/Jerusalem",
		thinking: "medium",
		metadata: { color: "bot-4" },
	});
	await sendAccountRpc(origin, accountId, "schedule.create", {
		botId: "echo-bot",
		name: "Morning climate check",
		kind: "cron",
		input: "0 7 * * *",
		text: "Check the climate.",
		target: { mode: "new-chat" },
	});
	await sendAccountRpc(origin, accountId, "file.write", {
		botId: "echo-bot",
		path: "MEMORY.md",
		content: [
			"# Memory",
			"",
			"Prefers **dark** roast.",
			"",
			"## Layout",
			"",
			"- Wall tablet in the hall",
			"- Kitchen display",
			"",
			"```ts",
			'const roast = "dark";',
			"```",
		].join("\n"),
	});
	await sendAccountRpc(origin, accountId, "file.write", {
		botId: "echo-bot",
		path: "SOUL.md",
		content: [
			"# Soul",
			"",
			"Calm, brief, and local.",
			"",
			"## Voice",
			"",
			"Keep answers **short**.",
			"",
			"- Prefer local facts",
			"- Stay kind",
			"",
			"```ts",
			'export const tone = "calm";',
			"```",
		].join("\n"),
	});
	await sendAccountRpc(origin, accountId, "file.write", {
		botId: "echo-bot",
		path: "knowledge/heating.md",
		content: "# Heating\n\nLiving room target `21C`.",
		description: "Heating zones",
	});
	await sendAccountRpc(origin, accountId, "chat.create", {
		botId: "echo-bot",
		title: "Morning notes",
	});
}

test("group menu and profile screens", async ({ page, accountId, baseURL }) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedProfile(origin, accountId);
	const shots: Array<{ name: string; path: string; ready: string }> = [
		{
			name: "profile-schedules",
			path: "/app/#/bot/echo-bot/schedules",
			ready: "Morning climate check",
		},
		{
			name: "profile-memory",
			path: "/app/#/bot/echo-bot/memory",
			ready: "Prefers",
		},
		{
			name: "profile-knowledge",
			path: "/app/#/bot/echo-bot/knowledge",
			ready: "heating",
		},
		{
			name: "profile-soul",
			path: "/app/#/bot/echo-bot/soul",
			ready: "Calm",
		},
		{
			name: "profile-config",
			path: "/app/#/bot/echo-bot/config",
			ready: "Delete bot",
		},
	];
	for (const theme of THEMES) {
		await openThemed(page, "/app/#/", theme);
		await expect(
			page.getByRole("button", { name: "Morning notes", exact: true }),
		).toBeVisible();
		await clickByRole(page, "button", "Echo Bot menu");
		await expect(page.getByRole("button", { name: "Profile" })).toBeVisible();
		await page.screenshot({
			path: resolve(OUT_DIR, `group-menu-${theme}.png`),
			animations: "disabled",
		});
		for (const shot of shots) {
			await openThemed(page, shot.path, theme);
			await expect(page.getByText(shot.ready).first()).toBeVisible();
			await page.screenshot({
				path: resolve(OUT_DIR, `${shot.name}-${theme}.png`),
				animations: "disabled",
			});
		}
		await openThemed(page, "/app/#/bot/echo-bot/schedules", theme);
		await clickByRole(page, "button", "Morning climate check");
		await expect(page.getByLabel("Schedule name")).toBeVisible();
		await page.screenshot({
			path: resolve(OUT_DIR, `schedule-edit-${theme}.png`),
			animations: "disabled",
		});
		await openThemed(page, "/app/#/bot/echo-bot/memory", theme);
		await clickByRole(page, "button", "Edit");
		await expect(page.getByLabel("MEMORY.md source")).toBeVisible();
		await page.screenshot({
			path: resolve(OUT_DIR, `memory-edit-${theme}.png`),
			animations: "disabled",
		});
		await openThemed(page, "/app/#/bot/echo-bot/soul", theme);
		await clickByRole(page, "button", "Edit");
		await page.screenshot({
			path: resolve(OUT_DIR, `soul-edit-${theme}.png`),
			animations: "disabled",
		});
		await openThemed(
			page,
			"/app/#/bot/echo-bot/doc?path=knowledge/heating.md",
			theme,
		);
		await expect(page.getByText("Living room")).toBeVisible();
		await page.screenshot({
			path: resolve(OUT_DIR, `knowledge-doc-${theme}.png`),
			animations: "disabled",
		});
		await openThemed(page, "/app/#/bot/echo-bot/tools", theme);
		await expect(
			page.getByRole("switch", { name: "memory_read" }),
		).toBeVisible();
		await page.screenshot({
			path: resolve(OUT_DIR, `tool-allowlist-${theme}.png`),
			animations: "disabled",
		});
		await openThemed(page, "/app/#/bot/echo-bot/harvest", theme);
		await expect(page.getByRole("heading", { name: "Harvest" })).toBeVisible();
		await page.screenshot({
			path: resolve(OUT_DIR, `harvest-${theme}.png`),
			animations: "disabled",
		});
	}
});
