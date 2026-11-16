import { resolve } from "node:path";
import { THEMES } from "../../src/theme/theme.ts";
import { seedBot, sendAccountRpc } from "../support/account.ts";
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

async function seedSettings(origin: string, accountId: string) {
	await sendAccountRpc(origin, accountId, "account.update", {
		name: "Household",
		timezone: "Asia/Jerusalem",
	});
	await seedBot(origin, accountId, "IT Agent", "it-agent");
	await seedBot(origin, accountId, "HA Agent", "ha-agent");
	await sendAccountRpc(origin, accountId, "bot.update", {
		botId: "it-agent",
		metadata: { color: "bot-4" },
	});
	await sendAccountRpc(origin, accountId, "bot.update", {
		botId: "ha-agent",
		metadata: { color: "bot-3" },
	});
	await sendAccountRpc(origin, accountId, "family.update", {
		name: "Household",
		teamLeaderBotId: "it-agent",
	});
	await sendAccountRpc(origin, accountId, "schedule.create", {
		botId: "it-agent",
		name: "Patch check",
		kind: "cron",
		input: "0 3 * * 1",
		text: "Check patches.",
		target: { mode: "new-chat" },
	});
	await sendAccountRpc(origin, accountId, "schedule.create", {
		botId: "ha-agent",
		name: "Morning climate check",
		kind: "cron",
		input: "0 7 * * *",
		text: "Check the climate.",
		target: { mode: "new-chat" },
	});
	const created = await sendAccountRpc<{ chat: { key: string } }>(
		origin,
		accountId,
		"chat.create",
		{ botId: "it-agent", title: "Patch router firmware" },
	);
	await sendAccountRpc(origin, accountId, "chat.close", {
		chatKey: created.chat.key,
	});
	return created.chat.key;
}

test("15-settings", async ({ page, accountId, baseURL }) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedSettings(origin, accountId);
	for (const theme of THEMES) {
		await openThemed(page, "/settings", theme);
		await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
		await expect(
			page.getByRole("link", { name: /Household.*2 bots/ }),
		).toBeVisible();
		await expect(
			page.getByRole("link", { name: "All schedules" }),
		).toBeVisible();
		await page.screenshot({
			path: resolve(OUT_DIR, `15-settings-${theme}.png`),
			animations: "disabled",
		});
	}
});

test("15b-all-schedules", async ({ page, accountId, baseURL }) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedSettings(origin, accountId);
	for (const theme of THEMES) {
		await openThemed(page, "/settings/schedules", theme);
		await expect(
			page.getByRole("heading", { name: "All schedules" }),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Patch check" }),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Morning climate check" }),
		).toBeVisible();
		await page.screenshot({
			path: resolve(OUT_DIR, `15b-all-schedules-${theme}.png`),
			animations: "disabled",
		});
	}
});

test("16-archive", async ({ page, accountId, baseURL }) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedSettings(origin, accountId);
	for (const theme of THEMES) {
		await openThemed(page, "/settings/archive", theme);
		await expect(page.getByRole("heading", { name: "Archive" })).toBeVisible();
		await expect(
			page.getByRole("link", { name: "Patch router firmware" }),
		).toBeVisible();
		await page.screenshot({
			path: resolve(OUT_DIR, `16-archive-${theme}.png`),
			animations: "disabled",
		});
	}
});
