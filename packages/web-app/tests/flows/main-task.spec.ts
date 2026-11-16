import { seedBot, sendAccountRpc } from "../support/account.ts";
import { clickByRole, fillByLabel, swipeLeft } from "../support/actions.ts";
import { expect, test } from "../support/fixtures.ts";

// Ordinary user-level journey: signs in through token login with the user-role grants, no master token.
test.use({ signIn: "user" });

test.describe.configure({ mode: "parallel" });

const WORKER_BASE = "http://127.0.0.1:8799";

async function postedBodies(page: import("@playwright/test").Page) {
	const bodies: Array<{ url: string; body: string }> = [];
	page.on("request", async (request) => {
		if (request.method() !== "POST") return;
		const url = request.url();
		if (!url.includes("/api/turn/")) return;
		bodies.push({ url, body: request.postData() ?? "" });
	});
	return bodies;
}

test("create and stream: row spinner, live card, final reply", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	await page.goto("/");
	await expect(page.getByRole("combobox", { name: "Bot" })).toBeVisible();
	await fillByLabel(page, "Message", "Hello");
	await clickByRole(page, "button", "Send");
	await expect(page.getByText(/echo\(1\): Hello/)).toBeVisible({
		timeout: 15_000,
	});
	await clickByRole(page, "link", "Back");
	await expect(
		page.getByRole("navigation", { name: "Bots" }).getByRole("button", {
			name: "Hello",
			exact: true,
		}),
	).toBeVisible();
});

test("busy chat: queue, steer, stop", async ({ page, accountId, baseURL }) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	const posts = await postedBodies(page);
	await page.goto("/");
	await expect(page.getByRole("combobox", { name: "Bot" })).toBeVisible();
	await fillByLabel(page, "Message", "hold please [[hold:ui-busy]]");
	await clickByRole(page, "button", "Send");
	await expect(page.getByRole("region", { name: "Live card" })).toBeVisible({
		timeout: 10_000,
	});
	await fillByLabel(page, "Message", "queued follow-up");
	await clickByRole(page, "button", "Send");
	await expect(page.getByText("Queued, runs after this step")).toBeVisible();
	await clickByRole(page, "button", "Steer live");
	await expect(
		page.getByRole("button", { name: "Steer", exact: true }),
	).toHaveAttribute("aria-pressed", "true");
	await fillByLabel(page, "Message", "steer now");
	await clickByRole(page, "button", "Send");
	await expect(
		page.getByRole("button", { name: "Steer", exact: true }),
	).toHaveAttribute("aria-pressed", "false");
	await clickByRole(page, "button", "Stop");
	await expect(page.getByRole("region", { name: "Live card" })).toHaveCount(0);
	if (posts.length > 0) {
		expect(
			posts.some(
				(entry) =>
					entry.url.includes("/api/turn/submit") &&
					entry.body.includes('"whenBusy":"queue"'),
			),
		).toBe(true);
		expect(
			posts.some(
				(entry) =>
					entry.url.includes("/api/turn/steer") ||
					entry.body.includes('"whenBusy":"steer"'),
			),
		).toBe(true);
		expect(
			posts.some((entry) => entry.url.includes("/api/turn/interrupt")),
		).toBe(true);
	}
});

test("unread reply shows a dot and a Needs-you entry", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	await page.goto("/");
	await expect(page.getByRole("combobox", { name: "Bot" })).toBeVisible();
	await fillByLabel(page, "Message", "Hello");
	await clickByRole(page, "button", "Send");
	await expect(page.getByText(/echo\(1\): Hello/)).toBeVisible({
		timeout: 15_000,
	});
	await clickByRole(page, "link", "Back");
	const listed = await sendAccountRpc<{ chats: Array<{ key: string }> }>(
		origin,
		accountId,
		"chat.list",
	);
	const chatKey = listed.chats[0]?.key;
	expect(chatKey).toBeTruthy();
	await sendAccountRpc(origin, accountId, "turn.submit", {
		chatKey,
		text: "Second ping",
	});
	await page.reload();
	await expect(page.getByRole("heading", { name: /Needs you/ })).toBeVisible({
		timeout: 15_000,
	});
	await expect(
		page.getByRole("status", { name: "Unread" }).first(),
	).toBeVisible();
	// The Needs-you entry is labelled exactly with the chat title; the thread
	// row's name also carries the last message.
	await clickByRole(page, "button", "Hello", { exact: true });
	await expect(page.getByText(/new/)).toBeVisible();
	await clickByRole(page, "link", "Back");
	await expect(page.getByRole("heading", { name: /Needs you/ })).toHaveCount(0);
});

test("failed turn Retry resubmits", async ({ page, accountId, baseURL }) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	await page.goto("/");
	await expect(page.getByRole("combobox", { name: "Bot" })).toBeVisible();
	await fillByLabel(page, "Message", "fail me [[hold:ui-fail]]");
	await clickByRole(page, "button", "Send");
	await expect(page.getByRole("region", { name: "Live card" })).toBeVisible({
		timeout: 10_000,
	});
	await clickByRole(page, "button", "Stop");
	await clickByRole(page, "link", "Back");
	await expect(page.getByRole("button", { name: "Retry" }).first()).toBeVisible(
		{ timeout: 15_000 },
	);
	await clickByRole(page, "button", "Retry", {
		within: page.getByRole("region", { name: "Echo Bot" }),
	});
	await expect(
		page.getByRole("status", { name: "Running" }).first(),
	).toBeVisible({ timeout: 15_000 });
});

test("archive and collapse persist", async ({ page, accountId, baseURL }) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	await sendAccountRpc(origin, accountId, "chat.create", {
		botId: "echo-bot",
		title: "Archive me",
	});
	await page.goto("/");
	await expect(
		page.getByRole("button", { name: "Archive me", exact: true }),
	).toBeVisible();
	await swipeLeft(page, "Archive me");
	await page.getByRole("button", { name: "Archive chat Archive me" }).click();
	await expect(
		page.getByRole("button", { name: "Archive me", exact: true }),
	).toHaveCount(0);
	const listed = await sendAccountRpc<{
		chats: Array<{ title?: string; closed?: boolean }>;
	}>(origin, accountId, "chat.list");
	expect(
		listed.chats.some(
			(chat) => chat.title === "Archive me" && chat.closed === true,
		) || !listed.chats.some((chat) => chat.title === "Archive me"),
	).toBe(true);
	await clickByRole(page, "button", "Collapse Echo Bot");
	await page.reload();
	await expect(
		page.getByRole("button", { name: "Expand Echo Bot" }),
	).toBeVisible();
});
