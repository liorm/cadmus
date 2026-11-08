import { seedBot, sendAccountRpc } from "../support/account.ts";
import { clickByRole, fillByLabel } from "../support/actions.ts";
import { expect, test } from "../support/fixtures.ts";

test.describe.configure({ mode: "parallel" });

const WORKER_BASE = "http://127.0.0.1:8799";

test("a starter opens a thread, updates URL, and reload preserves CockpitFrame", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	await page.goto("/");
	await clickByRole(page, "button", "What can you help with?");

	await expect(page).toHaveURL(/\/chat\/.+/);
	const console = page.getByRole("region", { name: "Chat console" });
	await expect(
		console.getByRole("button", {
			name: "What can you help with?",
			exact: true,
		}),
	).toBeVisible();
	await expect(console.getByRole("radio", { name: "Chat" })).toBeChecked();
	await expect(console.getByRole("radio", { name: "Raw" })).toBeVisible();
	await expect(console.getByText(/echo\(/)).toBeVisible({ timeout: 20_000 });

	// Reload to verify CockpitFrame persistence
	await page.reload();
	await expect(
		page.getByRole("banner", { name: "Cadmus Cockpit" }),
	).toBeVisible();
	await expect(
		page.getByRole("complementary", { name: "Bot fleet and threads" }),
	).toBeVisible();
	await expect(
		page.getByRole("complementary", { name: "Telemetry" }),
	).toBeVisible();
	await expect(
		page.getByRole("region", { name: "Chat console" }),
	).toBeVisible();
});

test("inline title rename save and cancel in Stage header persists across reload", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	await page.goto("/");
	await clickByRole(page, "button", "What can you help with?");
	await expect(page).toHaveURL(/\/chat\/.+/);

	const console = page.getByRole("region", { name: "Chat console" });
	const titleBtn = console.getByRole("button", {
		name: "What can you help with?",
		exact: true,
	});
	await expect(titleBtn).toBeVisible();

	// Click to enter rename mode
	await titleBtn.click();
	const titleInput = page.getByRole("textbox", { name: "Chat title" });
	await expect(titleInput).toBeVisible();

	// Cancel rename
	await clickByRole(page, "button", "Cancel rename");
	await expect(titleBtn).toBeVisible();

	// Rename and save
	await titleBtn.click();
	await fillByLabel(page, "Chat title", "Project Brainstorming");
	await clickByRole(page, "button", "Save title");

	await expect(
		console.getByRole("button", {
			name: "Project Brainstorming",
			exact: true,
		}),
	).toBeVisible();

	// Persists across reload
	await page.reload();
	await expect(
		page.getByRole("region", { name: "Chat console" }).getByRole("button", {
			name: "Project Brainstorming",
			exact: true,
		}),
	).toBeVisible();
});

test("per-chat Harvest this chat switch in Stage header persists", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	await page.goto("/");
	await clickByRole(page, "button", "Summarize your memory");
	await expect(page).toHaveURL(/\/chat\/.+/);
	await expect(page.getByText(/echo\(/)).toBeVisible({ timeout: 15_000 });

	const harvestSwitch = page.getByRole("switch", {
		name: "Harvest this chat",
	});
	await expect(harvestSwitch).toBeVisible();
	await expect(harvestSwitch).toHaveAttribute("aria-checked", "true");

	// Toggle harvest off
	await clickByRole(page, "switch", "Harvest this chat");
	await expect(harvestSwitch).toHaveAttribute("aria-checked", "false");

	// Reload and verify persisted off
	await page.reload();
	const reloadedSwitch = page.getByRole("switch", {
		name: "Harvest this chat",
	});
	await expect(reloadedSwitch).toHaveAttribute("aria-checked", "false");
});

test("busy chat: queue, steer, and stop inside Stage", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	await page.goto("/");

	await fillByLabel(page, "Message", "hold please [[hold:ui-busy]]");
	await clickByRole(page, "button", "Send");
	await expect(page).toHaveURL(/\/chat\/.+/);

	const liveCard = page.getByRole("region", { name: "Live card" });
	await expect(liveCard).toBeVisible({ timeout: 15_000 });

	await fillByLabel(page, "Message", "queued follow-up");
	await clickByRole(page, "button", "Send");
	await expect(page.getByText("Queued, runs after this step")).toBeVisible();

	await clickByRole(page, "button", "Steer live");
	await expect(
		page.getByRole("button", { name: "Steer", exact: true }),
	).toHaveAttribute("aria-pressed", "true");

	await fillByLabel(page, "Message", "steer note");
	await clickByRole(page, "button", "Send");
	await expect(
		page.getByRole("button", { name: "Steer", exact: true }),
	).toHaveAttribute("aria-pressed", "false");

	await clickByRole(page, "button", "Stop");
	await expect(liveCard).toHaveCount(0);
});

test("live ChatStatusIndicator in Stage header opens ChatStatusView inside Cockpit", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	await page.goto("/");
	await clickByRole(page, "button", "What can you help with?");
	await expect(page).toHaveURL(/\/chat\/.+/);

	const statusIndicator = page.getByTestId("status-indicator-button");
	await expect(statusIndicator).toBeVisible();
	await expect(statusIndicator).toContainText(/Idle|Working/);

	// Click to open status view
	await statusIndicator.click();
	await expect(
		page.getByRole("banner", { name: "Cadmus Cockpit" }),
	).toBeVisible();
	await expect(
		page.getByRole("complementary", { name: "Bot fleet and threads" }),
	).toBeVisible();
	await expect(
		page.getByRole("complementary", { name: "Telemetry" }),
	).toBeVisible();
	await expect(page.getByText("Token Spend & Cost")).toBeVisible();
	await expect(page.getByRole("tab", { name: "chat" })).toBeVisible();
	await expect(page.getByRole("tab", { name: "bot" })).toBeVisible();
});

test("clicking bot badge/name in Stage header opens Bot Profile in Stage", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	await page.goto("/");
	await clickByRole(page, "button", "What can you help with?");
	await expect(page).toHaveURL(/\/chat\/.+/);

	await clickByRole(page, "button", "Open Echo Bot profile");
	await expect(
		page.getByRole("banner", { name: "Cadmus Cockpit" }),
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Echo Bot", exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("radiogroup", { name: "Bot profile tabs" }),
	).toBeVisible();
});

test("message_bot tool call card opens GroupChatViewerSheet inside Desktop Cockpit", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Lead Bot", "lead-bot");
	await seedBot(origin, accountId, "Peer Bot", "peer-bot");

	const created = await sendAccountRpc<{ chat: { key: string } }>(
		origin,
		accountId,
		"chat.create",
		{ botId: "lead-bot", title: "Inter-bot Test" },
	);
	const chatKey = created.chat.key;

	const groupText =
		'[[group-reply]][tool:end_conversation {"response":"All green"}][[/group-reply]]';
	await sendAccountRpc(origin, accountId, "turn.submit", {
		chatKey,
		text: `Contact peer [tool:message_bot {"slug":"peer-bot","topic":"Desktop Sync","text":${JSON.stringify(groupText)}}]`,
	});

	await page.goto(`/chat/${chatKey}`);
	await expect(
		page.getByRole("banner", { name: "Cadmus Cockpit" }),
	).toBeVisible();

	const toolRow = page.getByRole("button", {
		name: /Ran 1 tool · message_bot/,
	});
	await expect(toolRow).toBeVisible({ timeout: 15_000 });
	await toolRow.click();

	const mbCard = page.getByTestId("tool-card-message_bot");
	await expect(mbCard).toBeVisible();

	await clickByRole(page, "button", "View Group Chat");
	await expect(page.getByText("Inter-bot group chat")).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Desktop Sync" }),
	).toBeVisible();
	await expect(
		page
			.getByTestId("group-chat-messages")
			.getByText("All green", { exact: true }),
	).toBeVisible();
});
