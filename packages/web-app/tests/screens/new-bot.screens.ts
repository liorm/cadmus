import { resolve } from "node:path";
import { THEMES } from "../../src/theme/theme.ts";
import { seedBot, sendAccountRpc } from "../support/account.ts";
import { clickByRole, fillByLabel } from "../support/actions.ts";
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
			page.getByRole("button", { name: "Let TL route" }),
		).toHaveAttribute("aria-pressed", "true");
		await expect(page.getByRole("button", { name: /To:/ })).toHaveCount(0);
		await fillByLabel(
			page,
			"Message",
			"Redo the main HA dashboard for the wall tablet.",
		);
		await page.screenshot({
			path: resolve(OUT_DIR, `05-newtask-${theme}.png`),
			animations: "disabled",
		});
		await clickByRole(page, "button", "Let TL route");
		await expect(
			page.getByRole("button", { name: "Let TL route" }),
		).toHaveAttribute("aria-pressed", "false");
		await expect(
			page.getByRole("button", { name: "To: OnePlus HA Agent" }),
		).toBeVisible();
		await page.screenshot({
			path: resolve(OUT_DIR, `05-newtask-pick-${theme}.png`),
			animations: "disabled",
		});
	}
});
