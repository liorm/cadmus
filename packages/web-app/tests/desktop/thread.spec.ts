import { seedBot } from "../support/account.ts";
import { clickByRole, fillByLabel } from "../support/actions.ts";
import { expect, test } from "../support/fixtures.ts";

test.describe.configure({ mode: "parallel" });

const WORKER_BASE = "http://127.0.0.1:8799";

test("a starter opens a thread and a follow-up is echoed", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	await page.goto("/");
	await clickByRole(page, "button", "What can you help with?");

	const console = page.getByRole("region", { name: "Chat console" });
	await expect(
		console.getByRole("button", {
			name: "What can you help with?",
			exact: true,
		}),
	).toBeVisible();
	await expect(console.getByRole("radio", { name: "Chat" })).toBeChecked();
	await expect(console.getByRole("radio", { name: "Raw" })).toBeVisible();
	await expect(
		console.getByRole("textbox", { name: "Message" }),
	).toHaveAttribute("placeholder", "Add a follow-up...");
	await expect(console.getByText(/echo\(/)).toBeVisible({ timeout: 20_000 });
	await expect(console.getByRole("region", { name: "Live card" })).toHaveCount(
		0,
	);

	await fillByLabel(page, "Message", "Hello");
	await clickByRole(page, "button", "Send");
	await expect(console.getByText(/echo\(.*\): Hello/)).toBeVisible({
		timeout: 20_000,
	});

	await clickByRole(page, "radio", "Raw");
	await expect(console.getByText("Hello").first()).toBeVisible();
	await clickByRole(page, "radio", "Chat");

	await clickByRole(page, "button", "Archive");
	await expect(
		page.getByRole("heading", { name: "Echo Bot", exact: true }),
	).toBeVisible();
	await expect(page.getByText("No threads yet.")).toBeVisible();
});

test("running filter hides an idle thread", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	await page.goto("/");
	await clickByRole(page, "button", "Summarize your memory");
	await expect(
		page.getByRole("region", { name: "Chat console" }).getByText(/echo\(/),
	).toBeVisible({ timeout: 20_000 });
	await expect(page.getByText("0 Running")).toBeVisible();

	await clickByRole(page, "button", "Running");
	await expect(page.getByText("No threads yet.")).toBeVisible();
	await clickByRole(page, "button", "All");
	await expect(page.getByText("Summarize your memory").first()).toBeVisible();
});
