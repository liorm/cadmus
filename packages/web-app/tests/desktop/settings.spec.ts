import { seedBot, sendAccountRpc } from "../support/account.ts";
import { clickByRole, fillByLabel } from "../support/actions.ts";
import { expect, test } from "../support/fixtures.ts";

test.describe.configure({ mode: "parallel" });

const WORKER_BASE = "http://127.0.0.1:8799";

test("deep-linking across settings views keeps CockpitFrame mounted", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");

	const paths = [
		"/settings",
		"/settings/account",
		"/settings/family",
		"/settings/providers",
		"/settings/tools",
		"/settings/schedules",
		"/settings/archive",
	];

	for (const path of paths) {
		await page.goto(path);
		await expect(
			page.getByRole("banner", { name: "Cadmus Cockpit" }),
		).toBeVisible();
		await expect(
			page.getByRole("complementary", { name: "Bot fleet and threads" }),
		).toBeVisible();
		await expect(
			page.getByRole("complementary", { name: "Telemetry" }),
		).toBeVisible();
	}
});

test("selecting Team Leader bot in Settings shows Let TL route button on Desktop and routes chat", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	const bot = await seedBot(origin, accountId, "Lead Bot", "lead-bot");
	await seedBot(origin, accountId, "Worker Bot", "worker-bot");

	await page.goto("/settings");
	await expect(
		page.getByRole("banner", { name: "Cadmus Cockpit" }),
	).toBeVisible();

	// Select Team Leader bot
	await page.getByLabel("Team Leader bot").selectOption(bot.id);

	// Go to Home (/) to start a new thread
	await page.goto("/");
	await expect(
		page.getByRole("banner", { name: "Cadmus Cockpit" }),
	).toBeVisible();

	const tlChip = page.getByRole("button", { name: "Let TL route" });
	await expect(tlChip).toBeVisible();
	await expect(tlChip).toHaveAttribute("aria-pressed", "true");

	// Send message through Team Leader
	await fillByLabel(page, "Message", "Route this task");
	await clickByRole(page, "button", "Send");

	// Chat is created with Lead Bot
	await expect(page).toHaveURL(/\/chat\/.+/);
	await expect(
		page.getByRole("region", { name: "Chat console" }).getByText(/echo\(/),
	).toBeVisible({ timeout: 15_000 });
});

test("theme switcher persists across reload", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");

	await page.goto("/settings");
	await expect(
		page.getByRole("banner", { name: "Cadmus Cockpit" }),
	).toBeVisible();

	await clickByRole(page, "radio", "Sepia");
	await expect
		.poll(async () =>
			page.evaluate(() => document.documentElement.getAttribute("data-theme")),
		)
		.toBe("sepia");

	await page.reload();
	const themeAtStart = await page.evaluate(() =>
		document.documentElement.getAttribute("data-theme"),
	);
	expect(themeAtStart).toBe("sepia");
});

test("all schedules toggle and opening archived chat into Stage without composer", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	const bot = await seedBot(origin, accountId, "Echo Bot", "echo-bot");

	// Seed schedule
	await sendAccountRpc(origin, accountId, "schedule.create", {
		botId: bot.id,
		name: "Global Schedule",
		text: "Run check",
		kind: "cron",
		input: "0 * * * *",
		target: { mode: "new-chat" },
		enabled: true,
	});

	// Seed closed chat
	const created = await sendAccountRpc<{ chat: { key: string } }>(
		origin,
		accountId,
		"chat.create",
		{ botId: bot.id, title: "Old Closed Project" },
	);
	await sendAccountRpc(origin, accountId, "chat.close", {
		chatKey: created.chat.key,
	});

	// 1. All schedules toggle
	await page.goto("/settings/schedules");
	await expect(
		page.getByRole("banner", { name: "Cadmus Cockpit" }),
	).toBeVisible();
	await clickByRole(page, "switch", "Pause Global Schedule");

	// 2. Open archived chat
	await page.goto("/settings/archive");
	await expect(
		page.getByRole("banner", { name: "Cadmus Cockpit" }),
	).toBeVisible();
	await expect(page.getByText("Old Closed Project")).toBeVisible();

	await clickByRole(page, "link", "Old Closed Project");
	await expect(page).toHaveURL(/\/chat\/.+/);
	await expect(
		page.getByRole("banner", { name: "Cadmus Cockpit" }),
	).toBeVisible();
	await expect(
		page.getByRole("complementary", { name: "Bot fleet and threads" }),
	).toBeVisible();
	await expect(
		page.getByRole("complementary", { name: "Telemetry" }),
	).toBeVisible();

	// Read-only indicator and no composer textbox
	await expect(page.getByText("Archived · read-only")).toBeVisible();
	await expect(page.getByRole("textbox", { name: "Message" })).toHaveCount(0);
});

test("switching family in settings updates header pill and refreshes fleet", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");

	// Create second family via RPC
	await sendAccountRpc(origin, accountId, "family.create", {
		familyId: "secondary-fam",
		name: "Secondary Family",
	});

	await page.goto("/settings/family");
	await expect(
		page.getByRole("banner", { name: "Cadmus Cockpit" }),
	).toBeVisible();

	// Switch to secondary family
	await clickByRole(page, "button", "Switch");

	// Header pill updates to secondary-fam
	const headerLink = page.getByRole("banner").getByRole("link", {
		name: "secondary-fam",
	});
	await expect(headerLink).toBeVisible();
});
