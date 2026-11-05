import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { THEMES, type ThemeName } from "../../src/theme/theme.ts";
import { seedBot, sendAccountRpc } from "../support/account.ts";
import { fillByLabel } from "../support/actions.ts";
import { expect, test } from "../support/fixtures.ts";
import { installSocketGate } from "../support/sockets.ts";

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

test("18-search", async ({ page, accountId, baseURL }) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "HA Agent", "ha-agent");
	await sendAccountRpc(origin, accountId, "chat.create", {
		botId: "ha-agent",
		title: "Tune thermostat schedules",
	});
	await sendAccountRpc(origin, accountId, "chat.create", {
		botId: "ha-agent",
		title: "Living room thermostat check",
	});
	for (const theme of THEMES) {
		await openThemed(page, "/search", theme);
		await fillByLabel(page, "Search", "thermo");
		await expect(page.getByText("2 chats match")).toBeVisible();
		await page.screenshot({
			path: resolve(OUT_DIR, `18-search-${theme}.png`),
			animations: "disabled",
		});
	}
});

test("17-reconnecting", async ({ page, accountId, baseURL }) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "HA Agent", "ha-agent");
	const created = await sendAccountRpc<{ chat: { key: string } }>(
		origin,
		accountId,
		"chat.create",
		{ botId: "ha-agent", title: "Tune thermostat schedules" },
	);
	await sendAccountRpc(origin, accountId, "turn.submit", {
		chatKey: created.chat.key,
		text: "Shift heating schedules 30 min earlier.",
	});
	void sendAccountRpc(origin, accountId, "turn.submit", {
		chatKey: created.chat.key,
		text: "hold please [[hold:ui-busy]]",
	}).catch(() => undefined);
	await installSocketGate(page, { blocked: true });
	for (const theme of THEMES) {
		await openThemed(page, `/chat/${created.chat.key}`, theme);
		await expect(
			page.getByText("Reconnecting… live updates paused"),
		).toBeVisible();
		await expect(page.getByRole("region", { name: "Live card" })).toBeVisible({
			timeout: 15_000,
		});
		await page.screenshot({
			path: resolve(OUT_DIR, `17-reconnecting-${theme}.png`),
			animations: "disabled",
		});
	}
});
