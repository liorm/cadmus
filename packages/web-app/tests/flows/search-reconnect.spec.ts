import type { Page } from "@playwright/test";
import { seedBot, sendAccountRpc } from "../support/account.ts";
import { clickByRole, fillByLabel } from "../support/actions.ts";
import { expect, test } from "../support/fixtures.ts";
import {
	dropWebSocket,
	installSocketGate,
	restoreWebSocket,
} from "../support/sockets.ts";

test.describe.configure({ mode: "parallel" });

const WORKER_BASE = "http://127.0.0.1:8799";

test("search filters titles by bot and cancel restores main", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "HA Agent", "ha-agent");
	await seedBot(origin, accountId, "Notes Bot", "notes-bot");
	await sendAccountRpc(origin, accountId, "chat.create", {
		botId: "ha-agent",
		title: "Tune thermostat schedules",
	});
	await sendAccountRpc(origin, accountId, "chat.create", {
		botId: "ha-agent",
		title: "Living room thermostat check",
	});
	await sendAccountRpc(origin, accountId, "chat.create", {
		botId: "notes-bot",
		title: "Grocery list",
	});

	await page.goto("/");
	await expect(page.getByRole("heading", { name: "Cadmus" })).toBeVisible();
	await clickByRole(page, "link", "Search");
	await fillByLabel(page, "Search", "thermo");
	await expect(page.getByText("2 chats match")).toBeVisible();
	const group = page.getByRole("region", { name: "HA Agent" });
	await expect(
		group.getByRole("button", { name: "Tune thermostat schedules" }),
	).toBeVisible();
	await expect(
		group.getByRole("button", { name: "Living room thermostat check" }),
	).toBeVisible();
	await expect(group.locator("mark")).toHaveCount(2);
	await expect(page.getByRole("region", { name: "Notes Bot" })).toHaveCount(0);
	await expect(page.getByText("Searching chat titles")).toBeVisible();
	await clickByRole(page, "button", "Cancel");
	await expect(page.getByRole("heading", { name: "Cadmus" })).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Grocery list", exact: true }),
	).toBeVisible();
});

test.setTimeout(60_000);

test("reconnect pauses the live card and sends one offline message", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "HA Agent", "ha-agent");
	const created = await sendAccountRpc<{ chat: { key: string } }>(
		origin,
		accountId,
		"chat.create",
		{ botId: "ha-agent", title: "Tune thermostat schedules" },
	);
	// The held turn does not return until it is stopped. Do not await it.
	void sendAccountRpc(origin, accountId, "turn.submit", {
		chatKey: created.chat.key,
		text: "hold please [[hold:ui-busy]]",
	}).catch(() => undefined);

	await installSocketGate(page);
	await page.goto(`/chat/${created.chat.key}`);
	await expect(page.getByRole("region", { name: "Live card" })).toBeVisible({
		timeout: 15_000,
	});
	await expect(page.getByText("Reconnecting… live updates paused")).toHaveCount(
		0,
	);

	const downAt = await page.evaluate(() => Date.now());
	await dropWebSocket(page);
	await expect(
		page.getByText("Reconnecting… live updates paused"),
	).toBeVisible();
	await expect(page.getByRole("region", { name: "Live card" })).toHaveAttribute(
		"aria-disabled",
		"true",
	);

	await fillByLabel(page, "Message", "offline note");
	await clickByRole(page, "button", "Send");
	await expect(page.getByText("offline note")).toBeVisible();
	await expect
		.poll(
			async () => {
				const submits = await httpSince(page, downAt, "/api/turn/submit");
				return Date.now() - downAt > 1_200 && submits.length === 0;
			},
			{ timeout: 4_000 },
		)
		.toBe(true);

	const upAt = await page.evaluate(() => Date.now());
	await restoreWebSocket(page);
	await expect(page.getByText("Reconnecting… live updates paused")).toHaveCount(
		0,
		{ timeout: 15_000 },
	);
	await expect
		.poll(
			async () => (await httpSince(page, upAt, "/api/turn/submit")).length,
			{
				timeout: 15_000,
			},
		)
		.toBe(1);
	const submits = await httpSince(page, upAt, "/api/turn/submit");
	expect(submits[0]?.body).toContain("clientMsgId");
	expect(submits[0]?.body).toContain("offline note");
	expect(
		(await httpSince(page, upAt, "/api/chat/messages")).length,
	).toBeGreaterThan(0);
	expect(
		(await httpSince(page, upAt, "/api/chat/status")).length,
	).toBeGreaterThan(0);
	expect(
		(await httpSince(page, upAt, "/api/chat/tasks/list")).length,
	).toBeGreaterThan(0);
	expect(
		(await httpSince(page, upAt, "/api/chat/list")).length,
	).toBeGreaterThan(0);
});

async function httpSince(page: Page, at: number, path: string) {
	return page.evaluate(
		({ since, path: needle }) => {
			const http = (
				window as Window & {
					__cadmusHttp?: Array<{
						url: string;
						body: string;
						at: number;
					}>;
				}
			).__cadmusHttp;
			return (http ?? []).filter(
				(entry) => entry.at >= since && entry.url.includes(needle),
			);
		},
		{ since: at, path },
	);
}
