import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import { THEMES, type ThemeName } from "../../src/theme/theme.ts";
import { seedBot, sendAccountRpc } from "../support/account.ts";
import { clickByRole, fillByLabel } from "../support/actions.ts";
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

async function seedMain(origin: string, accountId: string) {
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	await sendAccountRpc(origin, accountId, "chat.create", {
		botId: "echo-bot",
		title: "Morning notes",
	});
}

test("main", async ({ page, accountId, baseURL }) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedMain(origin, accountId);
	for (const theme of THEMES) {
		await openThemed(page, "/app/#/", theme);
		await expect(page.getByRole("heading", { name: "Cadmus" })).toBeVisible();
		await expect(page.getByRole("combobox", { name: "Bot" })).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Morning notes", exact: true }),
		).toBeVisible();
		await page.screenshot({
			path: resolve(OUT_DIR, `main-${theme}.png`),
			animations: "disabled",
		});
	}
});

test("main-swipe", async ({ page, accountId, baseURL }) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedMain(origin, accountId);
	for (const theme of THEMES) {
		await openThemed(page, "/app/#/", theme);
		await expect(
			page.getByRole("button", { name: "Morning notes", exact: true }),
		).toBeVisible();
		await page
			.locator("button[aria-label='Archive chat Morning notes']")
			.evaluate((node) => {
				const row = node.parentElement?.querySelector("div[style]");
				if (row instanceof HTMLElement) {
					row.style.transform = "translateX(-88px)";
				}
			});
		await page.screenshot({
			path: resolve(OUT_DIR, `main-swipe-${theme}.png`),
			animations: "disabled",
		});
	}
});

test("new-task", async ({ page, accountId, baseURL }) => {
	await seedBot(baseURL ?? WORKER_BASE, accountId, "Echo Bot", "echo-bot");
	for (const theme of THEMES) {
		await openThemed(page, "/app/#/new?bot=echo-bot", theme);
		await expect(page.getByRole("heading", { name: "New task" })).toBeVisible();
		await fillByLabel(
			page,
			"Message",
			"Redo the dashboard for the wall tablet.",
		);
		await page.screenshot({
			path: resolve(OUT_DIR, `new-task-${theme}.png`),
			animations: "disabled",
		});
	}
});

test("task", async ({ page, accountId, baseURL }) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	const created = await sendAccountRpc<{ chat: { key: string } }>(
		origin,
		accountId,
		"chat.create",
		{ botId: "echo-bot", title: "Tune thermostat schedules" },
	);
	await sendAccountRpc(origin, accountId, "turn.submit", {
		chatKey: created.chat.key,
		text: "Hello",
	});
	for (const theme of THEMES) {
		await openThemed(page, `/app/#/chat/${created.chat.key}`, theme);
		await expect(
			page.getByRole("heading", { name: "Tune thermostat schedules" }),
		).toBeVisible();
		await page.screenshot({
			path: resolve(OUT_DIR, `task-${theme}.png`),
			animations: "disabled",
		});
	}
});

test("task-queued", async ({ page, accountId, baseURL }) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	await page.goto("/app/#/");
	await fillByLabel(page, "Message", "stay busy [[hold:screen-queue]]");
	await clickByRole(page, "button", "Send");
	await expect(page.getByRole("region", { name: "Live card" })).toBeVisible({
		timeout: 15_000,
	});
	await fillByLabel(
		page,
		"Message",
		"Also keep the bathroom schedule unchanged.",
	);
	await clickByRole(page, "button", "Send");
	await expect(page.getByText("Queued, runs after this step")).toBeVisible();
	for (const theme of THEMES) {
		await page.evaluate((themeName) => {
			sessionStorage.setItem("cadmus.screenshot.theme", themeName);
			localStorage.setItem("cadmus.theme", themeName);
			document.documentElement.setAttribute("data-theme", themeName);
		}, theme);
		await page.screenshot({
			path: resolve(OUT_DIR, `task-queued-${theme}.png`),
			animations: "disabled",
		});
	}
});

test("task-collapsed", async ({ page, accountId, baseURL }) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	await page.goto("/app/#/");
	await fillByLabel(page, "Message", "stay busy [[hold:screen-collapse]]");
	await clickByRole(page, "button", "Send");
	await expect(page.getByRole("region", { name: "Live card" })).toBeVisible({
		timeout: 15_000,
	});
	await clickByRole(page, "button", "Collapse live card");
	for (const theme of THEMES) {
		await page.evaluate((themeName) => {
			document.documentElement.setAttribute("data-theme", themeName);
		}, theme);
		await page.screenshot({
			path: resolve(OUT_DIR, `task-collapsed-${theme}.png`),
			animations: "disabled",
		});
	}
});

test("task-scrolled", async ({ page, accountId, baseURL }) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	const created = await sendAccountRpc<{ chat: { key: string } }>(
		origin,
		accountId,
		"chat.create",
		{ botId: "echo-bot", title: "Tune thermostat schedules" },
	);
	await sendAccountRpc(origin, accountId, "turn.submit", {
		chatKey: created.chat.key,
		text: "First line of a long thread",
	});
	await page.goto(`/app/#/chat/${created.chat.key}`);
	await fillByLabel(page, "Message", "stay busy [[hold:screen-scroll]]");
	await clickByRole(page, "button", "Send");
	await expect(page.getByRole("region", { name: "Live card" })).toBeVisible({
		timeout: 15_000,
	});
	await page.locator("#chat-scroller").evaluate((node) => {
		const el = node as HTMLElement;
		const pad = document.createElement("div");
		pad.style.height = "1200px";
		el.insertBefore(pad, el.firstChild);
		el.scrollTop = 0;
		el.dispatchEvent(new Event("scroll"));
	});
	await expect
		.poll(async () =>
			page.locator("#chat-scroller").evaluate((node) => {
				const el = node as HTMLElement;
				return el.scrollTop < 40 && el.scrollHeight > el.clientHeight + 40;
			}),
		)
		.toBe(true);
	await expect(page.getByRole("button", { name: "Jump to live" })).toBeVisible({
		timeout: 10_000,
	});
	for (const theme of THEMES) {
		await page.evaluate((themeName) => {
			document.documentElement.setAttribute("data-theme", themeName);
		}, theme);
		await page.screenshot({
			path: resolve(OUT_DIR, `task-scrolled-${theme}.png`),
			animations: "disabled",
		});
	}
});

test("chat-menu", async ({ page, accountId, baseURL }) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	const created = await sendAccountRpc<{ chat: { key: string } }>(
		origin,
		accountId,
		"chat.create",
		{ botId: "echo-bot", title: "Tune thermostat schedules" },
	);
	await sendAccountRpc(origin, accountId, "turn.submit", {
		chatKey: created.chat.key,
		text: "Hello",
	});
	for (const theme of THEMES) {
		await openThemed(page, `/app/#/chat/${created.chat.key}`, theme);
		await clickByRole(page, "button", "Chat menu");
		await expect(
			page.getByRole("button", { name: "View raw transcript" }),
		).toBeVisible();
		await page.screenshot({
			path: resolve(OUT_DIR, `chat-menu-${theme}.png`),
			animations: "disabled",
		});
		await page.keyboard.press("Escape");
	}
});

test("raw-transcript", async ({ page, accountId, baseURL }) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	const created = await sendAccountRpc<{ chat: { key: string } }>(
		origin,
		accountId,
		"chat.create",
		{ botId: "echo-bot", title: "Tune thermostat schedules" },
	);
	await sendAccountRpc(origin, accountId, "turn.submit", {
		chatKey: created.chat.key,
		text: "Hello",
	});
	for (const theme of THEMES) {
		await openThemed(page, `/app/#/chat/${created.chat.key}?view=raw`, theme);
		await expect(page.getByText("user", { exact: true }).first()).toBeVisible();
		await page.screenshot({
			path: resolve(OUT_DIR, `raw-transcript-${theme}.png`),
			animations: "disabled",
		});
	}
});

test("archived-chat", async ({ page, accountId, baseURL }) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	const created = await sendAccountRpc<{ chat: { key: string } }>(
		origin,
		accountId,
		"chat.create",
		{ botId: "echo-bot", title: "Tune thermostat schedules" },
	);
	await sendAccountRpc(origin, accountId, "turn.submit", {
		chatKey: created.chat.key,
		text: "Hello",
	});
	await sendAccountRpc(origin, accountId, "chat.close", {
		chatKey: created.chat.key,
	});
	for (const theme of THEMES) {
		await openThemed(page, `/app/#/chat/${created.chat.key}`, theme);
		await expect(page.getByText("Archived · read-only")).toBeVisible();
		await page.screenshot({
			path: resolve(OUT_DIR, `archived-chat-${theme}.png`),
			animations: "disabled",
		});
	}
});

test("task-rename", async ({ page, accountId, baseURL }) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	const created = await sendAccountRpc<{ chat: { key: string } }>(
		origin,
		accountId,
		"chat.create",
		{ botId: "echo-bot", title: "Tune thermostat schedules" },
	);
	await sendAccountRpc(origin, accountId, "turn.submit", {
		chatKey: created.chat.key,
		text: "Hello",
	});
	for (const theme of THEMES) {
		await openThemed(page, `/app/#/chat/${created.chat.key}`, theme);
		await clickByRole(page, "button", "Chat menu");
		await clickByRole(page, "button", "Rename");
		await fillByLabel(page, "Chat title", "Thermostat: weekday");
		await page.screenshot({
			path: resolve(OUT_DIR, `task-rename-${theme}.png`),
			animations: "disabled",
		});
		await clickByRole(page, "button", "Cancel rename");
	}
});

test("settings", async ({ page, accountId, baseURL }) => {
	await seedBot(baseURL ?? WORKER_BASE, accountId, "Echo Bot", "echo-bot");
	for (const theme of THEMES) {
		await openThemed(page, "/app/#/settings", theme);
		await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
		await page.screenshot({
			path: resolve(OUT_DIR, `settings-${theme}.png`),
			animations: "disabled",
		});
	}
});
