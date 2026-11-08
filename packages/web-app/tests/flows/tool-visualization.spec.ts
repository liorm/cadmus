import { seedBot, sendAccountRpc } from "../support/account.ts";
import { clickByRole, fillByLabel } from "../support/actions.ts";
import { expect, test } from "../support/fixtures.ts";

test.describe.configure({ mode: "parallel" });

const WORKER_BASE = "http://127.0.0.1:8799";

test("indeterminate live card has no progress bar", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	await page.goto("/");
	await expect(page.getByRole("combobox", { name: "Bot" })).toBeVisible();
	await fillByLabel(page, "Message", "hold please [[hold:ui-busy]]");
	await clickByRole(page, "button", "Send");

	const liveCard = page.getByRole("region", { name: "Live card" });
	await expect(liveCard).toBeVisible({ timeout: 10_000 });

	// Without taskProgress, no progressbar should be rendered
	await expect(page.getByRole("progressbar")).toHaveCount(0);

	// Stop turn so test cleans up cleanly
	await clickByRole(page, "button", "Stop");
});

test("tool calls expansion and group chat viewer for message_bot", async ({
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
		{ botId: "lead-bot", title: "Tool Inspection Test" },
	);
	const chatKey = created.chat.key;

	// 1. Submit knowledge_read turn via RPC
	await sendAccountRpc(origin, accountId, "turn.submit", {
		chatKey,
		text: 'Check records [tool:knowledge_read {"slug":"notes"}]',
	});

	// 2. Submit message_bot turn via RPC with scripted group-reply
	const groupText =
		'[[group-reply]][tool:end_conversation {"response":"All systems normal"}][[/group-reply]]';
	await sendAccountRpc(origin, accountId, "turn.submit", {
		chatKey,
		text: `Delegate to peer [tool:message_bot {"slug":"peer-bot","topic":"System Status","text":${JSON.stringify(groupText)}}]`,
	});

	// 3. Load chat in browser and verify tools visualization
	await page.goto(`/chat/${chatKey}`);
	await expect(
		page.getByRole("heading", { name: "Tool Inspection Test" }),
	).toBeVisible();

	// Verify knowledge_read tool row and expansion
	const krRow = page.getByRole("button", {
		name: /Ran 1 tool · knowledge_read/,
	});
	await expect(krRow).toBeVisible({ timeout: 15_000 });
	await krRow.click();
	await expect(page.getByTestId("tool-card-knowledge_read")).toBeVisible();

	// Verify message_bot tool row and expansion
	const mbRow = page.getByRole("button", {
		name: /Ran 1 tool · message_bot/,
	});
	await expect(mbRow).toBeVisible({ timeout: 15_000 });
	await mbRow.click();
	const mbCard = page.getByTestId("tool-card-message_bot");
	await expect(mbCard).toBeVisible();

	// Check that View Group Chat button is visible on the message_bot card
	const viewChatBtn = mbCard.getByRole("button", {
		name: /View Group Chat/,
	});
	await expect(viewChatBtn).toBeVisible();

	// Open the group chat sheet
	await viewChatBtn.click();
	await expect(page.getByText("Inter-bot group chat")).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "System Status" }),
	).toBeVisible();
	await expect(page.getByTestId("group-chat-messages")).toBeVisible();
	await expect(page.getByText("Final Resolution")).toBeVisible();
	await expect(
		page.getByText("All systems normal", { exact: true }),
	).toBeVisible();

	// Close the sheet
	await clickByRole(page, "button", "Close");
	await expect(page.getByText("Inter-bot group chat")).not.toBeVisible();
});
