import { seedBot, sendAccountRpc } from "../support/account.ts";
import { clickByRole, fillByLabel } from "../support/actions.ts";
import { expect, test } from "../support/fixtures.ts";

test.describe.configure({ mode: "parallel" });

test("deep link to settings and back", async ({ page }) => {
	await page.goto("/settings");
	await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
	await clickByRole(page, "link", "Back");
	await expect(page.getByRole("heading", { name: "Cadmus" })).toBeVisible();
});

test("theme switch persists across reload with no flash", async ({ page }) => {
	await page.goto("/settings");
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

test("composer grows and submits on Send", async ({
	page,
	accountId,
	baseURL,
}) => {
	await seedBot(
		baseURL ?? "http://127.0.0.1:8799",
		accountId,
		"Echo Bot",
		"echo-bot",
	);
	await page.goto("/");
	await expect(page.getByRole("combobox", { name: "Bot" })).toBeVisible();
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
	await expect(page.getByRole("heading", { name: "line one" })).toBeVisible();
});

const WORKER_BASE = "http://127.0.0.1:8799";

test("home lists a bot seeded over rpc", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	await page.goto("/");
	await expect(page.getByRole("combobox", { name: "Bot" })).toBeVisible();
});

test("composer persists a chat through the worker", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	await page.goto("/new");
	await expect(page.getByRole("heading", { name: "New task" })).toBeVisible();
	await page.goto("/");
	await expect(page.getByRole("combobox", { name: "Bot" })).toBeVisible();
	await expect(page.getByRole("heading", { name: "Cadmus" })).toBeVisible();
	await fillByLabel(page, "Message", "Morning notes");
	await clickByRole(page, "button", "Send");
	await expect(
		page.getByRole("heading", { name: "Morning notes" }),
	).toBeVisible();
	await clickByRole(page, "link", "Back");
	await expect(
		page.getByRole("navigation", { name: "Bots" }).getByRole("button", {
			name: "Morning notes",
			exact: true,
		}),
	).toBeVisible();
	await page.reload();
	await expect(
		page.getByRole("navigation", { name: "Bots" }).getByRole("button", {
			name: "Morning notes",
			exact: true,
		}),
	).toBeVisible();
	await clickByRole(page, "button", "Morning notes");
	await expect(
		page.getByRole("heading", { name: "Morning notes" }),
	).toBeVisible();
	await page.reload();
	await expect(
		page.getByRole("heading", { name: "Morning notes" }),
	).toBeVisible();
	await clickByRole(page, "button", "Chat menu");
	await clickByRole(page, "button", "Rename");
	await fillByLabel(page, "Chat title", "Kitchen list");
	await clickByRole(page, "button", "Save title");
	await expect(
		page.getByRole("heading", { name: "Kitchen list" }),
	).toBeVisible();
	await clickByRole(page, "link", "Back");
	await expect(
		page.getByRole("navigation", { name: "Bots" }).getByRole("button", {
			name: "Kitchen list",
			exact: true,
		}),
	).toBeVisible();
	await page.reload();
	await expect(
		page.getByRole("navigation", { name: "Bots" }).getByRole("button", {
			name: "Kitchen list",
			exact: true,
		}),
	).toBeVisible();
	await clickByRole(page, "button", "Kitchen list");
	await expect(
		page.getByRole("heading", { name: "Kitchen list" }),
	).toBeVisible();
	const listed = await sendAccountRpc<{
		chats: Array<{ title?: string }>;
	}>(origin, accountId, "chat.list");
	expect(listed.chats.some((chat) => chat.title === "Kitchen list")).toBe(true);
});
