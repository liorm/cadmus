import { seedBot, sendAccountRpc } from "../support/account.ts";
import {
	chooseTimezone,
	clickByRole,
	fillByLabel,
} from "../support/actions.ts";
import { expect, test } from "../support/fixtures.ts";

test.describe.configure({ mode: "parallel" });

const WORKER_BASE = "http://127.0.0.1:8799";

test("deep-linking across bot views keeps CockpitFrame mounted in Stage", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");

	const paths = [
		"/bot/echo-bot/config",
		"/bot/echo-bot/schedules",
		"/bot/echo-bot/memory",
		"/bot/echo-bot/knowledge",
		"/bot/echo-bot/soul",
		"/bot/echo-bot/tools",
		"/bot/echo-bot/harvest",
		"/bot/echo-bot/doc?path=MEMORY.md",
		"/bot/echo-bot/schedule/new",
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

test("config tab updates thinking level, timezone, and deletes bot", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");

	await page.goto("/bot/echo-bot/config");
	await expect(
		page.getByRole("banner", { name: "Cadmus Cockpit" }),
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Echo Bot", exact: true }),
	).toBeVisible();

	// Update thinking level
	await clickByRole(page, "radio", "Medium");
	await expect(page.getByRole("radio", { name: "Medium" })).toBeChecked();

	// Update timezone
	await chooseTimezone(page, "Timezone", "Asia/Jerusalem", "keyboard");

	// Delete bot
	await clickByRole(page, "button", "Delete bot");
	await clickByRole(page, "button", "Delete Echo Bot");

	await expect(page).toHaveURL(/\/$/);
	await expect(
		page.getByRole("banner", { name: "Cadmus Cockpit" }),
	).toBeVisible();
	await expect(page.getByText("No bots yet")).toBeVisible();
});

test("schedules tab creates, edits, toggles, and deletes a schedule inside Stage", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");

	await page.goto("/bot/echo-bot/schedules");
	await expect(
		page.getByRole("banner", { name: "Cadmus Cockpit" }),
	).toBeVisible();

	// Create new schedule
	await clickByRole(page, "button", "New schedule");
	await expect(
		page.getByRole("banner", { name: "Cadmus Cockpit" }),
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "New schedule" }),
	).toBeVisible();

	await fillByLabel(page, "Schedule name", "Hourly Check");
	await fillByLabel(page, "Schedule prompt", "Perform status review");
	await clickByRole(page, "button", "Save");

	// Redirects back to schedules list in Stage
	await expect(
		page.getByRole("banner", { name: "Cadmus Cockpit" }),
	).toBeVisible();
	await expect(page.getByText("Hourly Check")).toBeVisible();

	// Toggle schedule enabled switch
	await clickByRole(page, "switch", "Hourly Check");

	// Open schedule to delete
	await clickByRole(page, "button", "Hourly Check");
	await expect(
		page.getByRole("banner", { name: "Cadmus Cockpit" }),
	).toBeVisible();
	await expect(page.getByRole("heading", { name: "Schedule" })).toBeVisible();

	await clickByRole(page, "button", "Delete");

	await expect(
		page.getByRole("banner", { name: "Cadmus Cockpit" }),
	).toBeVisible();
	await expect(page.getByText("Hourly Check")).toHaveCount(0);
});

test("memory, soul, and knowledge editing inside Stage", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");

	// Add knowledge doc via RPC
	await sendAccountRpc(origin, accountId, "file.write", {
		botId: "echo-bot",
		path: "knowledge/guidelines.md",
		content: "# Architecture Guidelines\n\nAlways persist state cleanly.",
		description: "Guidelines for architecture",
	});

	// 1. Memory view and edit
	await page.goto("/bot/echo-bot/memory");
	await expect(
		page.getByRole("banner", { name: "Cadmus Cockpit" }),
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Echo Bot", exact: true }),
	).toBeVisible();

	await clickByRole(page, "button", "Edit");
	await fillByLabel(
		page,
		"MEMORY.md source",
		"# Core Memory\nUser prefers concise replies.",
	);
	await clickByRole(page, "button", "Save");
	await expect(page.getByText("User prefers concise replies.")).toBeVisible();

	// 2. Soul view and edit
	await clickByRole(page, "radio", "Soul");
	await expect(
		page.getByRole("banner", { name: "Cadmus Cockpit" }),
	).toBeVisible();
	await clickByRole(page, "button", "Edit");
	await fillByLabel(
		page,
		"SOUL.md source",
		"# Persona\nSharp technical partner.",
	);
	await clickByRole(page, "button", "Save");
	await expect(page.getByText("Sharp technical partner.")).toBeVisible();

	// 3. Knowledge view and delete
	await clickByRole(page, "radio", "Knowledge");
	await expect(
		page.getByRole("banner", { name: "Cadmus Cockpit" }),
	).toBeVisible();
	await expect(page.getByText("guidelines")).toBeVisible();

	// Delete doc via Delete button on row
	await clickByRole(page, "button", "Delete guidelines");
	await expect(page.getByText("No knowledge docs.")).toBeVisible();
});
