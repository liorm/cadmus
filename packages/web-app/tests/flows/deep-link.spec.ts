import { seedBot } from "../support/account.ts";
import { expect, test } from "../support/fixtures.ts";

test.describe.configure({ mode: "parallel" });

const WORKER_BASE = "http://127.0.0.1:8799";

test("deep link to bot config loads from the worker", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	const response = await page.goto("/bot/echo-bot/config");
	expect(response?.ok()).toBe(true);
	expect(new URL(page.url()).pathname).toBe("/bot/echo-bot/config");
	await expect(page.getByRole("heading", { name: "Echo Bot" })).toBeVisible();
	await expect(page.getByRole("radio", { name: "Config" })).toBeVisible();
	await expect(page.getByLabel("Model")).toBeVisible();
});
