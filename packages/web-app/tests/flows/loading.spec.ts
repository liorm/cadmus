import { seedBot, sendAccountRpc } from "../support/account.ts";
import { clickByRole } from "../support/actions.ts";
import { expect, test } from "../support/fixtures.ts";
import {
	dropWebSocket,
	installSocketGate,
	restoreWebSocket,
} from "../support/sockets.ts";

test.describe.configure({ mode: "parallel" });

const WORKER_BASE = "http://127.0.0.1:8799";

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

test("slow home and settings avoid false settled copy", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	const created = await sendAccountRpc<{ chat: { key: string } }>(
		origin,
		accountId,
		"chat.create",
		{ botId: "echo-bot" },
	);
	await sendAccountRpc(origin, accountId, "turn.submit", {
		chatKey: created.chat.key,
		text: "Morning notes",
	});
	let slowChat = true;
	let slowAccount = true;
	await page.route("**/api/chat/get**", async (route) => {
		if (slowChat) await delay(1_200);
		await route.continue().catch(() => undefined);
	});
	await page.route("**/api/account/get**", async (route) => {
		if (slowAccount) await delay(1_200);
		await route.continue().catch(() => undefined);
	});
	await page.goto("/");
	await expect(page.getByRole("region", { name: "Echo Bot" })).toBeVisible();
	await expect(page.getByRole("button", { name: "New task" })).toHaveCount(0);
	await expect(page.getByRole("heading", { name: /Needs you/ })).toHaveCount(0);
	await expect(
		page.getByRole("status", { name: "Loading needs you" }),
	).toBeVisible();
	slowChat = false;
	await expect(
		page.getByRole("button", { name: "Morning notes", exact: true }),
	).toBeVisible();

	await page.goto("/settings");
	await expect(page.getByRole("link", { name: "Account" })).toBeVisible();
	await expect(page.getByRole("link", { name: "Family" })).toBeVisible();
	await expect(page.getByRole("link", { name: "All schedules" })).toBeVisible();
	await expect(page.getByText("None connected", { exact: true })).toHaveCount(
		0,
	);
	await expect(page.getByText("No schedules yet", { exact: true })).toHaveCount(
		0,
	);
	await expect(page.getByText("0 members", { exact: true })).toHaveCount(0);
	slowAccount = false;
	await page.reload();
	await expect(page.getByRole("link", { name: /^Account / })).toBeVisible();
});

test("empty archive, schedules, knowledge, and needs you after a successful load", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	const bot = await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	await page.goto("/settings/archive");
	await expect(page.getByText("No archived chats.")).toBeVisible();
	await page.goto("/settings/schedules");
	await expect(page.getByText("No schedules yet.")).toBeVisible();
	await page.goto(`/bot/${bot.id}/knowledge`);
	await expect(page.getByText("No knowledge docs.")).toBeVisible();
	await page.goto("/");
	await expect(page.getByRole("region", { name: "Echo Bot" })).toBeVisible();
	await expect(page.getByRole("heading", { name: /Needs you/ })).toHaveCount(0);
});

test("archive load error retries", async ({ page }) => {
	await page.route("**/api/chat/list**", (route) => route.abort());
	await page.goto("/settings/archive");
	await expect(page.getByText("No archived chats.")).toHaveCount(0);
	await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
	await page.unroute("**/api/chat/list**");
	await clickByRole(page, "button", "Retry");
	await expect(page.getByText("No archived chats.")).toBeVisible();
});

test("same-scope refresh keeps the previous chat title", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	const created = await sendAccountRpc<{ chat: { key: string } }>(
		origin,
		accountId,
		"chat.create",
		{ botId: "echo-bot" },
	);
	await sendAccountRpc(origin, accountId, "turn.submit", {
		chatKey: created.chat.key,
		text: "Keep this title",
	});
	await installSocketGate(page);
	await page.goto("/");
	await expect(
		page.getByRole("button", { name: "Keep this title", exact: true }),
	).toBeVisible();
	await page.route("**/api/chat/get**", async (route) => {
		await delay(1_500);
		await route.continue().catch(() => undefined);
	});
	await dropWebSocket(page);
	await restoreWebSocket(page);
	await expect(
		page.getByRole("button", { name: "Keep this title", exact: true }),
	).toBeVisible();
	await expect(page.getByRole("button", { name: "New task" })).toHaveCount(0);
});

test("family switch drops the previous bot", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Alpha Bot", "alpha-bot");
	await fetch(`${origin}/rpc`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: "Bearer dev-cadmus-secret",
			"x-account-id": accountId,
			"x-user-id": "owner",
			"x-cadmus-family-id": "default",
		},
		body: JSON.stringify({
			id: `ui-${crypto.randomUUID()}`,
			type: "family.create",
			payload: { familyId: "other", name: "Other" },
		}),
	});
	await fetch(`${origin}/rpc`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: "Bearer dev-cadmus-secret",
			"x-account-id": accountId,
			"x-user-id": "owner",
			"x-cadmus-family-id": "other",
		},
		body: JSON.stringify({
			id: `ui-${crypto.randomUUID()}`,
			type: "bot.create",
			payload: { slug: "other-bot", name: "Other Bot", model: "faux/echo" },
		}),
	});
	await page.goto("/");
	await expect(page.getByRole("region", { name: "Alpha Bot" })).toBeVisible();
	await page.route("**/api/bot/list**", async (route) => {
		await delay(1_800);
		await route.continue().catch(() => undefined);
	});
	await page.goto("/settings/family");
	await clickByRole(page, "button", "Switch");
	await clickByRole(page, "link", "Back");
	await clickByRole(page, "link", "Back");
	await expect(page.getByRole("region", { name: "Alpha Bot" })).toHaveCount(0);
	await expect(page.getByRole("region", { name: "Other Bot" })).toBeVisible({
		timeout: 15_000,
	});
});
