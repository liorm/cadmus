import { seedBot } from "../support/account.ts";
import { clickByRole, fillByLabel } from "../support/actions.ts";
import { expect, test } from "../support/fixtures.ts";

test.describe.configure({ mode: "parallel" });

const WORKER_BASE = "http://127.0.0.1:8799";

test("command palette reaches settings and archive at desktop width", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	await page.goto("/");
	await expect(
		page.getByRole("banner", { name: "Cadmus Cockpit" }),
	).toBeVisible();

	await page.keyboard.press("Control+k");
	const dialog = page.getByRole("dialog", { name: "Command palette" });
	await expect(dialog).toBeVisible();
	await fillByLabel(page, "Command filter", "settings");
	await clickByRole(page, "button", "Settings");
	await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
	const main = await page.getByRole("main").boundingBox();
	expect(main?.width ?? 0).toBeGreaterThan(700);

	await page.keyboard.press("Control+k");
	await expect(dialog).toBeVisible();
	await fillByLabel(page, "Command filter", "archive");
	await clickByRole(page, "button", "Archive");
	await expect(page.getByRole("heading", { name: "Archive" })).toBeVisible();

	await clickByRole(page, "link", "Back");
	await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
	await clickByRole(page, "link", "Back");
	await expect(
		page.getByRole("banner", { name: "Cadmus Cockpit" }),
	).toBeVisible();
});

test("palette opens a chat inside the cockpit", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	await page.goto("/");
	await clickByRole(page, "button", "What can you help with?");
	await expect(page.getByText("What can you help with?").first()).toBeVisible();

	await clickByRole(page, "button", "New thread with Echo Bot");
	await expect(
		page.getByRole("heading", { name: "Echo Bot", exact: true }),
	).toBeVisible();

	await page.keyboard.press("Control+k");
	await fillByLabel(page, "Command filter", "what can you help");
	await clickByRole(page, "button", "What can you help with?");
	await expect(
		page.getByRole("banner", { name: "Cadmus Cockpit" }),
	).toBeVisible();
	await expect(
		page
			.getByRole("region", { name: "Chat console" })
			.getByRole("button", { name: "What can you help with?", exact: true }),
	).toBeVisible();
	await expect(page).toHaveURL(/\/$/);
});
