import { seedBot, sendAccountRpc } from "../support/account.ts";
import { clickByRole, fillByLabel } from "../support/actions.ts";
import { expect, test } from "../support/fixtures.ts";

test.describe.configure({ mode: "parallel" });

test("deep link to settings and back", async ({ page }) => {
	await page.goto("/app/#/settings");
	await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
	await clickByRole(page, "link", "Back");
	await expect(page.getByRole("heading", { name: "Cadmus" })).toBeVisible();
});

test("theme switch persists across reload with no flash", async ({ page }) => {
	await page.goto("/app/#/settings");
	await clickByRole(page, "radio", "Light");
	await expect
		.poll(async () =>
			page.evaluate(() => document.documentElement.getAttribute("data-theme")),
		)
		.toBe("light");
	await page.reload();
	const themeAtStart = await page.evaluate(() =>
		document.documentElement.getAttribute("data-theme"),
	);
	expect(themeAtStart).toBe("light");
});

test("bottom sheet opens, Esc closes, focus returns", async ({ page }) => {
	await page.goto("/app/#/");
	await clickByRole(page, "button", "Open menu");
	await expect(page.getByRole("dialog")).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(page.getByRole("dialog")).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Open menu" })).toBeFocused();
});

test("composer grows and submits on Send", async ({ page }) => {
	await page.goto("/app/#/");
	const boxBefore = await page
		.getByRole("textbox", { name: "Message" })
		.boundingBox();
	await fillByLabel(
		page,
		"Message",
		"line one\nline two\nline three\nline four",
	);
	const boxAfter = await page
		.getByRole("textbox", { name: "Message" })
		.boundingBox();
	expect((boxAfter?.height ?? 0) >= (boxBefore?.height ?? 0)).toBe(true);
	await clickByRole(page, "button", "Send");
	await expect(page.getByText("Last sent: line one")).toBeVisible();
});

const WORKER_BASE = "http://127.0.0.1:8799";

test("home lists a bot seeded over rpc", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	await page.goto("/app/#/");
	await expect(page.getByRole("button", { name: "Echo Bot" })).toBeVisible();
});

test("composer persists a chat through the worker", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	await page.goto("/app/#/");
	await expect(page.getByRole("button", { name: "Echo Bot" })).toBeVisible();
	await fillByLabel(page, "Message", "Morning notes");
	await clickByRole(page, "button", "Send");
	await expect(
		page.getByRole("navigation", { name: "Chats" }).getByRole("button", {
			name: "Morning notes",
		}),
	).toBeVisible();
	await page.reload();
	await expect(
		page.getByRole("navigation", { name: "Chats" }).getByRole("button", {
			name: "Morning notes",
		}),
	).toBeVisible();
	const listed = await sendAccountRpc<{
		chats: Array<{ title?: string }>;
	}>(origin, accountId, "chat.list");
	expect(listed.chats.some((chat) => chat.title === "Morning notes")).toBe(
		true,
	);
});
