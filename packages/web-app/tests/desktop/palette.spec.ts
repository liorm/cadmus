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

test("command palette navigates to destinations inside Cockpit Stage without mobile AppShell ejection", async ({
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

	// 1. Settings
	await page.keyboard.press("Control+k");
	const dialog = page.getByRole("dialog", { name: "Command palette" });
	await expect(dialog).toBeVisible();
	await fillByLabel(page, "Command filter", "settings");
	await clickByRole(page, "button", "Settings");
	await expect(dialog).toBeHidden();
	await expect(
		page.getByRole("banner", { name: "Cadmus Cockpit" }),
	).toBeVisible();
	await expect(
		page.getByRole("complementary", { name: "Bot fleet and threads" }),
	).toBeVisible();
	await expect(
		page.getByRole("complementary", { name: "Telemetry" }),
	).toBeVisible();
	await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
	const main = await page.getByRole("main").boundingBox();
	expect(main?.width ?? 0).toBeGreaterThan(650);

	// 2. Archive
	await page.keyboard.press("Control+k");
	await expect(dialog).toBeVisible();
	await fillByLabel(page, "Command filter", "archive");
	await clickByRole(page, "button", "Archive");
	await expect(dialog).toBeHidden();
	await expect(
		page.getByRole("banner", { name: "Cadmus Cockpit" }),
	).toBeVisible();
	await expect(page.getByRole("heading", { name: "Archive" })).toBeVisible();

	// 3. Account
	await page.keyboard.press("Control+k");
	await expect(dialog).toBeVisible();
	await fillByLabel(page, "Command filter", "account");
	await clickByRole(page, "button", "Account");
	await expect(dialog).toBeHidden();
	await expect(
		page.getByRole("banner", { name: "Cadmus Cockpit" }),
	).toBeVisible();
	await expect(page.getByRole("heading", { name: "Account" })).toBeVisible();

	// 4. Family
	await page.keyboard.press("Control+k");
	await expect(dialog).toBeVisible();
	await fillByLabel(page, "Command filter", "family");
	await clickByRole(page, "button", "Family");
	await expect(dialog).toBeHidden();
	await expect(
		page.getByRole("banner", { name: "Cadmus Cockpit" }),
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Family", exact: true }),
	).toBeVisible();

	// 5. Providers
	await page.keyboard.press("Control+k");
	await expect(dialog).toBeVisible();
	await fillByLabel(page, "Command filter", "providers");
	await clickByRole(page, "button", "Providers");
	await expect(dialog).toBeHidden();
	await expect(
		page.getByRole("banner", { name: "Cadmus Cockpit" }),
	).toBeVisible();
	await expect(page.getByRole("heading", { name: "Providers" })).toBeVisible();

	// 6. Tool environments
	await page.keyboard.press("Control+k");
	await expect(dialog).toBeVisible();
	await fillByLabel(page, "Command filter", "tool environments");
	await clickByRole(page, "button", "Tool environments");
	await expect(dialog).toBeHidden();
	await expect(
		page.getByRole("banner", { name: "Cadmus Cockpit" }),
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Tools environments" }),
	).toBeVisible();

	// 7. All schedules
	await page.keyboard.press("Control+k");
	await expect(dialog).toBeVisible();
	await fillByLabel(page, "Command filter", "all schedules");
	await clickByRole(page, "button", "All schedules");
	await expect(dialog).toBeHidden();
	await expect(
		page.getByRole("banner", { name: "Cadmus Cockpit" }),
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "All schedules" }),
	).toBeVisible();

	// 8. New bot
	await page.keyboard.press("Control+k");
	await expect(dialog).toBeVisible();
	await fillByLabel(page, "Command filter", "new bot");
	await clickByRole(page, "button", "New bot");
	await expect(dialog).toBeHidden();
	await expect(
		page.getByRole("banner", { name: "Cadmus Cockpit" }),
	).toBeVisible();
	await expect(page.getByRole("heading", { name: "New bot" })).toBeVisible();

	// 9. Bot Profile tab
	await page.keyboard.press("Control+k");
	await expect(dialog).toBeVisible();
	await fillByLabel(page, "Command filter", "config");
	await clickByRole(page, "button", "Echo Bot · Config");
	await expect(dialog).toBeHidden();
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

test("searching chat titles in command palette highlights matches and opens chat in Stage", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	const bot = await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	await sendAccountRpc(origin, accountId, "chat.create", {
		botId: bot.id,
		title: "Thermostat control check",
	});

	await page.goto("/");
	await page.keyboard.press("Control+k");
	const dialog = page.getByRole("dialog", { name: "Command palette" });
	await expect(dialog).toBeVisible();

	await fillByLabel(page, "Command filter", "thermo");
	const matchMark = dialog.locator("mark");
	await expect(matchMark).toBeVisible();
	await expect(matchMark).toContainText("Thermo", { ignoreCase: true });

	// Click matching item
	await clickByRole(page, "button", "Thermostat control check");
	await expect(
		page.getByRole("banner", { name: "Cadmus Cockpit" }),
	).toBeVisible();
	await expect(
		page.getByRole("complementary", { name: "Bot fleet and threads" }),
	).toBeVisible();
	await expect(
		page.getByRole("complementary", { name: "Telemetry" }),
	).toBeVisible();
	await expect(page).toHaveURL(/\/chat\/.+/);
	await expect(
		page.getByRole("region", { name: "Chat console" }).getByRole("button", {
			name: "Thermostat control check",
			exact: true,
		}),
	).toBeVisible();
});

test("reconnect bar in CockpitFrame pauses live card and flushes offline message on reconnect", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	const bot = await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	const created = await sendAccountRpc<{ chat: { key: string } }>(
		origin,
		accountId,
		"chat.create",
		{ botId: bot.id, title: "Reconnect Test Chat" },
	);
	// Start a held turn
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

	// Drop WebSocket
	await dropWebSocket(page);
	await expect(
		page.getByText("Reconnecting… live updates paused"),
	).toBeVisible();
	await expect(page.getByRole("region", { name: "Live card" })).toHaveAttribute(
		"aria-disabled",
		"true",
	);

	// Queue offline message
	await fillByLabel(page, "Message", "offline note");
	await clickByRole(page, "button", "Send");
	await expect(page.getByText("offline note")).toBeVisible();

	// Restore WebSocket
	await restoreWebSocket(page);
	await expect(page.getByText("Reconnecting… live updates paused")).toHaveCount(
		0,
		{ timeout: 15_000 },
	);
	await clickByRole(page, "button", "Stop");
});
