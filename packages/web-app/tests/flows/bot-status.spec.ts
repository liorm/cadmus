import { seedBot } from "../support/account.ts";
import { clickByRole, fillByLabel } from "../support/actions.ts";
import { expect, test } from "../support/fixtures.ts";

test.describe.configure({ mode: "parallel" });

const WORKER_BASE = "http://127.0.0.1:8799";

test("chat header status goes working then idle and opens details", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	await page.goto("/");
	await expect(page.getByRole("combobox", { name: "Bot" })).toBeVisible();
	await fillByLabel(page, "Message", "Hello [[hold:ui-status]]");
	await clickByRole(page, "button", "Send");
	const status = page.getByRole("button", { name: "Bot status" });
	await expect(status).toBeVisible({ timeout: 10_000 });
	await expect(status).toContainText(/Working/);
	await expect(status).toContainText("faux/echo");
	await clickByRole(page, "button", "Stop");
	await expect(status).toContainText(/Idle/);
	await expect(status).toContainText("faux/echo");
	await status.click();
	await expect(page.getByRole("heading", { name: "Bot status" })).toBeVisible();
	await expect(page.getByText("Thinking")).toBeVisible();
	await expect(page.getByText("Tasks")).toBeVisible();
	await expect(page.getByText("Next wake")).toBeVisible();
	await expect(page.getByText("Tools env")).toBeVisible();
	await expect(page.getByText("Token Spend & Cost")).toBeVisible();
	await expect(page.getByTestId("status-tab-chat")).toBeVisible();
	await expect(page.getByTestId("status-tab-bot")).toBeVisible();
	await expect(page.getByText("Total estimated spend")).toBeVisible();
	await expect(page.getByText("By Source")).toBeVisible();
	await page.getByTestId("status-tab-bot").click();
	await expect(page.getByText("Total estimated spend")).toBeVisible();
});
