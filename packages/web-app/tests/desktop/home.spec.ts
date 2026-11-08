import { seedBot } from "../support/account.ts";
import { clickByRole } from "../support/actions.ts";
import { expect, test } from "../support/fixtures.ts";

test.describe.configure({ mode: "parallel" });

const WORKER_BASE = "http://127.0.0.1:8799";

test("desktop home is the command cockpit", async ({
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
	await expect(page.getByText("1 Bots Online")).toBeVisible();
	await expect(page.getByText("0 Running")).toBeVisible();
	await expect(page.getByText("0 Needs Attention")).toBeVisible();
	await expect(page.getByRole("link", { name: "default" })).toBeVisible();
	await expect(
		page.getByRole("complementary", { name: "Bot fleet and threads" }),
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Active bot fleet" }),
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Live thread feed" }),
	).toBeVisible();
	await expect(page.getByRole("button", { name: "All" })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(page.getByRole("button", { name: "Running" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Needs you" })).toBeVisible();
	await expect(
		page.getByRole("button", { name: "idle Echo Bot", exact: true }),
	).toHaveAttribute("aria-pressed", "true");
	await expect(page.getByText("faux/echo").first()).toBeVisible();
	await expect(page.getByText("0 threads")).toBeVisible();
	await expect(
		page.getByRole("region", { name: "Chat console" }),
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Echo Bot", exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "What can you help with?" }),
	).toBeVisible();
	await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Steer" })).toBeVisible();

	await clickByRole(page, "button", "New thread with Echo Bot");
	await expect(
		page.getByRole("heading", { name: "Echo Bot", exact: true }),
	).toBeVisible();

	await clickByRole(page, "button", "Search");
	await expect(
		page.getByRole("dialog", { name: "Command palette" }),
	).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(
		page.getByRole("dialog", { name: "Command palette" }),
	).toBeHidden();
});

test("command or control 1 switches the selected bot", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	await seedBot(origin, accountId, "Other Bot", "other-bot");
	await page.goto("/");
	const echo = page.getByRole("button", { name: "idle Echo Bot", exact: true });
	const other = page.getByRole("button", {
		name: "idle Other Bot",
		exact: true,
	});
	await expect(echo).toBeVisible();
	await expect(other).toBeVisible();
	const echoFirst = (await echo.getAttribute("aria-pressed")) === "true";
	const first = echoFirst ? echo : other;
	const second = echoFirst ? other : echo;
	const secondName = echoFirst ? "Other Bot" : "Echo Bot";
	const firstName = echoFirst ? "Echo Bot" : "Other Bot";

	await page.keyboard.press("Control+2");
	await expect(second).toHaveAttribute("aria-pressed", "true");
	await expect(
		page.getByRole("heading", { name: secondName, exact: true }),
	).toBeVisible();

	await page.keyboard.press("Control+1");
	await expect(first).toHaveAttribute("aria-pressed", "true");
	await expect(
		page.getByRole("heading", { name: firstName, exact: true }),
	).toBeVisible();
});
