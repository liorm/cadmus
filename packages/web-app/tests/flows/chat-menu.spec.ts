import type { Page } from "@playwright/test";
import { seedBot, sendAccountRpc } from "../support/account.ts";
import { chooseOption, clickByRole, fillByLabel } from "../support/actions.ts";
import { expect, test } from "../support/fixtures.ts";

test.describe.configure({ mode: "parallel" });

const WORKER_BASE = "http://127.0.0.1:8799";

async function openChat(
	page: Page,
	origin: string,
	accountId: string,
	title = "Tune thermostat schedules",
) {
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	const created = await sendAccountRpc<{ chat: { key: string } }>(
		origin,
		accountId,
		"chat.create",
		{ botId: "echo-bot", title },
	);
	const chatKey = created.chat.key;
	await sendAccountRpc(origin, accountId, "turn.submit", {
		chatKey,
		text: "Hello",
	});
	await page.goto(`/chat/${chatKey}`);
	await expect(page.getByRole("heading", { name: title })).toBeVisible();
	return chatKey;
}

test("harvest toggle persists through chat.update", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	const updates: string[] = [];
	page.on("request", (request) => {
		if (
			request.method() === "POST" &&
			request.url().includes("/api/chat/update")
		) {
			updates.push(request.url());
		}
	});
	const chatKey = await openChat(page, origin, accountId);
	await clickByRole(page, "button", "Chat menu");
	await expect(
		page.getByRole("switch", { name: "Harvest this chat" }),
	).toHaveAttribute("aria-checked", "true");
	await page.keyboard.press("Escape");
	await expect(
		page.getByRole("switch", { name: "Harvest this chat" }),
	).toHaveCount(0);
	await clickByRole(page, "button", "Chat menu");
	await clickByRole(page, "button", "Cancel");
	await expect(
		page.getByRole("switch", { name: "Harvest this chat" }),
	).toHaveCount(0);
	await clickByRole(page, "button", "Chat menu");
	await clickByRole(page, "switch", "Harvest this chat");
	await expect.poll(() => updates.length).toBeGreaterThan(0);
	const updated = await sendAccountRpc<{ chat: { harvest?: boolean } }>(
		origin,
		accountId,
		"chat.get",
		{ chatKey },
	);
	expect(updated.chat.harvest).toBe(false);
	await page.reload();
	await clickByRole(page, "button", "Chat menu");
	await expect(
		page.getByRole("switch", { name: "Harvest this chat" }),
	).toHaveAttribute("aria-checked", "false");
	await clickByRole(page, "button", "Open bot profile");
	await expect(page.getByRole("heading", { name: "Echo Bot" })).toBeVisible();
});

test("raw transcript requests entries and shows role labels", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	const chatKey = await openChat(page, origin, accountId);
	await sendAccountRpc(origin, accountId, "turn.submit", {
		chatKey,
		text: '[tool:task_add {"title":"Contract","details":"seed"}]',
	});
	await page.reload();
	const entries: string[] = [];
	page.on("request", (request) => {
		if (request.url().includes("/api/chat/entries"))
			entries.push(request.url());
	});
	await clickByRole(page, "button", "Chat menu");
	await clickByRole(page, "button", "View raw transcript");
	await expect.poll(() => entries.length).toBeGreaterThan(0);
	await expect(page.getByText("user", { exact: true }).first()).toBeVisible();
	await expect(
		page.getByText("assistant", { exact: true }).first(),
	).toBeVisible();
	await expect(
		page.getByText("tool_call", { exact: true }).first(),
	).toBeVisible({
		timeout: 15_000,
	});
	await expect(page.getByText(/"title": "Contract"/)).toBeVisible();
	await chooseOption(page, "Transcript view", "Chat");
	await expect(
		page.getByRole("heading", { name: "Tune thermostat schedules" }),
	).toBeVisible();
});

test("archive closes the chat and reopening is read-only", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	const closes: string[] = [];
	page.on("request", (request) => {
		if (
			request.method() === "POST" &&
			request.url().includes("/api/chat/close")
		) {
			closes.push(request.postData() ?? "");
		}
	});
	const chatKey = await openChat(page, origin, accountId, "Archive me");
	await clickByRole(page, "button", "Chat menu");
	await clickByRole(page, "button", "Archive");
	await expect.poll(() => closes.length).toBeGreaterThan(0);
	await expect(page.getByRole("heading", { name: "Cadmus" })).toBeVisible();
	await page.goto(`/chat/${chatKey}`);
	await expect(page.getByText("Archived · read-only")).toBeVisible();
	await expect(page.getByRole("textbox", { name: "Message" })).toHaveCount(0);
	await expect(page.getByRole("region", { name: "Live card" })).toHaveCount(0);
	await clickByRole(page, "button", "Chat menu");
	await expect(page.getByRole("button", { name: "Rename" })).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Archive" })).toHaveCount(0);
	await expect(
		page.getByRole("button", { name: "View raw transcript" }),
	).toBeVisible();
});

test("rename saves with the check and cancel sends nothing", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	const renames: string[] = [];
	page.on("request", (request) => {
		if (
			request.method() === "POST" &&
			request.url().includes("/api/chat/rename")
		) {
			renames.push(request.url());
		}
	});
	const chatKey = await openChat(page, origin, accountId, "Old title");
	await clickByRole(page, "button", "Chat menu");
	await clickByRole(page, "button", "Rename");
	await fillByLabel(page, "Chat title", "Discarded title");
	await clickByRole(page, "button", "Cancel rename");
	expect(renames).toEqual([]);
	await expect(page.getByRole("heading", { name: "Old title" })).toBeVisible();
	await clickByRole(page, "button", "Chat menu");
	await clickByRole(page, "button", "Rename");
	await fillByLabel(page, "Chat title", "Thermostat weekday");
	await clickByRole(page, "button", "Save title");
	await expect.poll(() => renames.length).toBeGreaterThan(0);
	const renamed = await sendAccountRpc<{ chat: { title?: string } }>(
		origin,
		accountId,
		"chat.get",
		{ chatKey },
	);
	expect(renamed.chat.title).toBe("Thermostat weekday");
	await clickByRole(page, "link", "Back");
	await expect(
		page.getByRole("button", { name: "Thermostat weekday", exact: true }),
	).toBeVisible();
});
