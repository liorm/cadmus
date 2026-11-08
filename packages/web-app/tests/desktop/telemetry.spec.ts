import { seedBot } from "../support/account.ts";
import { clickByRole } from "../support/actions.ts";
import { expect, test } from "../support/fixtures.ts";

test.describe.configure({ mode: "parallel" });

const WORKER_BASE = "http://127.0.0.1:8799";

test("telemetry tabs show tools, tasks, and harvest", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	await page.goto("/");

	const telemetry = page.getByRole("complementary", { name: "Telemetry" });
	await expect(telemetry).toBeVisible();
	await expect(telemetry.getByText(/WS:/)).toBeVisible();
	await expect(
		telemetry.getByRole("tab", { name: "Tool stream" }),
	).toHaveAttribute("aria-selected", "true");
	await expect(telemetry.getByText("No tool calls yet.")).toBeVisible();
	await expect(telemetry.getByText("Default tool set")).toBeVisible();

	await clickByRole(page, "tab", "Task plan");
	await expect(
		telemetry.getByText("Select a thread to see tasks."),
	).toBeVisible();

	await clickByRole(page, "button", "What is on your schedule?");
	await expect(
		telemetry.getByText("No task plan for this chat."),
	).toBeVisible();
	await clickByRole(page, "tab", "Tool stream");
	await expect(telemetry.getByText("No tool calls yet.")).toBeVisible();

	await clickByRole(page, "tab", "Memory harvest");
	await expect(
		telemetry.getByRole("link", { name: "Open MEMORY.md" }),
	).toBeVisible();
	await expect(
		telemetry.getByRole("link", { name: "Harvest page" }),
	).toBeVisible();
	await expect(
		telemetry.getByRole("link", { name: "Schedules" }),
	).toBeVisible();

	await clickByRole(page, "link", "Open MEMORY.md");
	await expect(page).toHaveURL(/\/bot\/echo-bot\/doc/);
	await expect(page.getByRole("heading", { name: "MEMORY.md" })).toBeVisible();
});
