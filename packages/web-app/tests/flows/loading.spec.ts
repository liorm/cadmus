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

test("home and settings show the saved account after load", async ({
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
	await page.goto("/");
	await expect(page.getByRole("region", { name: "Echo Bot" })).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Morning notes", exact: true }),
	).toBeVisible();
	await page.reload();
	await expect(
		page.getByRole("button", { name: "Morning notes", exact: true }),
	).toBeVisible();

	await page.goto("/settings");
	await expect(page.getByRole("link", { name: "Account" })).toBeVisible();
	await expect(page.getByRole("link", { name: "Family" })).toBeVisible();
	await expect(page.getByRole("link", { name: "All schedules" })).toBeVisible();
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

test("archive shows the empty state and keeps it after a reload", async ({
	page,
}) => {
	await page.goto("/settings/archive");
	await expect(page.getByText("No archived chats.")).toBeVisible();
	await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
	await page.reload();
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
			Authorization: "Bearer parked-ui-token",
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
			Authorization: "Bearer parked-ui-token",
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
	await page.goto("/settings/family");
	await expect(page.getByText("Other", { exact: true })).toBeVisible();
	await clickByRole(page, "button", "Switch");
	await clickByRole(page, "link", "Back");
	await clickByRole(page, "link", "Back");
	await expect(page.getByRole("region", { name: "Alpha Bot" })).toHaveCount(0);
	await expect(page.getByRole("region", { name: "Other Bot" })).toBeVisible({
		timeout: 15_000,
	});
	await page.reload();
	await expect(page.getByRole("region", { name: "Other Bot" })).toBeVisible();
	await expect(page.getByRole("region", { name: "Alpha Bot" })).toHaveCount(0);
});
