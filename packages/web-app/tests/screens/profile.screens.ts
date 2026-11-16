import { resolve } from "node:path";
import { THEMES } from "../../src/theme/theme.ts";
import { seedBot, sendAccountRpc } from "../support/account.ts";
import { clickByRole } from "../support/actions.ts";
import { expect, test } from "../support/fixtures.ts";
import {
	ensureScreensDir,
	openThemed,
	SCREENS_OUT_DIR,
	WORKER_BASE,
} from "../support/screens.ts";

const OUT_DIR = SCREENS_OUT_DIR;

test.beforeAll(() => {
	ensureScreensDir();
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

const PROFILE_SHOTS: Array<{ name: string; path: string; ready: string }> = [
	{
		name: "profile-schedules",
		path: "/bot/echo-bot/schedules",
		ready: "Morning climate check",
	},
	{
		name: "profile-memory",
		path: "/bot/echo-bot/memory",
		ready: "Prefers",
	},
	{
		name: "profile-knowledge",
		path: "/bot/echo-bot/knowledge",
		ready: "heating",
	},
	{
		name: "profile-soul",
		path: "/bot/echo-bot/soul",
		ready: "Calm",
	},
	{
		name: "profile-config",
		path: "/bot/echo-bot/config",
		ready: "Delete bot",
	},
];

test("group-menu", async ({ page, accountId, baseURL }) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedProfile(origin, accountId);
	for (const theme of THEMES) {
		await openThemed(page, "/", theme);
		await expect(
			page.getByRole("button", { name: "Morning notes", exact: true }),
		).toBeVisible();
		await clickByRole(page, "button", "Echo Bot menu");
		await expect(page.getByRole("button", { name: "Profile" })).toBeVisible();
		await page.screenshot({
			path: resolve(OUT_DIR, `group-menu-${theme}.png`),
			animations: "disabled",
		});
	}
});

for (const shot of PROFILE_SHOTS) {
	test(shot.name, async ({ page, accountId, baseURL }) => {
		const origin = baseURL ?? WORKER_BASE;
		await seedProfile(origin, accountId);
		for (const theme of THEMES) {
			await openThemed(page, shot.path, theme);
			await expect(page.getByText(shot.ready).first()).toBeVisible();
			await page.screenshot({
				path: resolve(OUT_DIR, `${shot.name}-${theme}.png`),
				animations: "disabled",
			});
		}
	});
}

test("schedule-edit", async ({ page, accountId, baseURL }) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedProfile(origin, accountId);
	for (const theme of THEMES) {
		await openThemed(page, "/bot/echo-bot/schedules", theme);
		await clickByRole(page, "button", "Morning climate check");
		await expect(page.getByLabel("Schedule name")).toBeVisible();
		await page.screenshot({
			path: resolve(OUT_DIR, `schedule-edit-${theme}.png`),
			animations: "disabled",
		});
	}
});

test("memory-edit", async ({ page, accountId, baseURL }) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedProfile(origin, accountId);
	for (const theme of THEMES) {
		await openThemed(page, "/bot/echo-bot/memory", theme);
		await clickByRole(page, "button", "Edit");
		await expect(page.getByLabel("MEMORY.md source")).toBeVisible();
		await page.screenshot({
			path: resolve(OUT_DIR, `memory-edit-${theme}.png`),
			animations: "disabled",
		});
	}
});

test("soul-edit", async ({ page, accountId, baseURL }) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedProfile(origin, accountId);
	for (const theme of THEMES) {
		await openThemed(page, "/bot/echo-bot/soul", theme);
		await clickByRole(page, "button", "Edit");
		await expect(page.getByLabel("SOUL.md source")).toBeVisible();
		await page.screenshot({
			path: resolve(OUT_DIR, `soul-edit-${theme}.png`),
			animations: "disabled",
		});
	}
});

test("knowledge-doc", async ({ page, accountId, baseURL }) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedProfile(origin, accountId);
	for (const theme of THEMES) {
		await openThemed(
			page,
			"/bot/echo-bot/doc?path=knowledge/heating.md",
			theme,
		);
		await expect(page.getByText("Living room")).toBeVisible();
		await page.screenshot({
			path: resolve(OUT_DIR, `knowledge-doc-${theme}.png`),
			animations: "disabled",
		});
	}
});

test("tool-allowlist", async ({ page, accountId, baseURL }) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedProfile(origin, accountId);
	for (const theme of THEMES) {
		await openThemed(page, "/bot/echo-bot/tools", theme);
		await expect(
			page.getByRole("switch", { name: "memory_read" }),
		).toBeVisible();
		await page.screenshot({
			path: resolve(OUT_DIR, `tool-allowlist-${theme}.png`),
			animations: "disabled",
		});
	}
});

test("harvest", async ({ page, accountId, baseURL }) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedProfile(origin, accountId);
	for (const theme of THEMES) {
		await openThemed(page, "/bot/echo-bot/harvest", theme);
		await expect(page.getByRole("heading", { name: "Harvest" })).toBeVisible();
		await page.screenshot({
			path: resolve(OUT_DIR, `harvest-${theme}.png`),
			animations: "disabled",
		});
	}
});
