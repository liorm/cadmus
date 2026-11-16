import { seedBot, sendAccountRpc } from "../support/account.ts";
import { clickByRole, fillByLabel } from "../support/actions.ts";
import { expect, test } from "../support/fixtures.ts";
import {
	dropWebSocket,
	installSocketGate,
	restoreWebSocket,
} from "../support/sockets.ts";

// Ordinary user-level journey: signs in through token login with the user-role grants, no master token.
test.use({ signIn: "user" });

test.describe.configure({ mode: "parallel" });

const WORKER_BASE = "http://127.0.0.1:8799";

test("command palette navigates to destinations inside Cockpit Stage without mobile AppShell ejection", async ({
	page,
	accountId,
	baseURL,
}) => {
	// Margin, not a cause fix. Eight palette destinations in one test. Measured
	// on Obscura: about 19 s untraced; with traces on (CI records every
	// attempt) 30.5 s and above, up to 47.2 s, so the 30 s default is too tight.
	// In the hosted Obscura trace most palette clicks spent 2 s timing out on a
	// pointer-intercept before the DOM fallback; real Chrome has none of that.
	// Why tracing adds the extra time, and why Obscura intercepts, is not
	// established. 90 s is about twice the slowest measured run.
	test.setTimeout(90_000);
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
	// "Account" alone also matches "Tool environments account.toolsEnvs".
	await clickByRole(page, "button", "Account account.get", { within: dialog });
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
	// The shortcut is only bound once the signed-in app has rendered.
	await expect(
		page.getByRole("banner", { name: "Cadmus Cockpit" }),
	).toBeVisible();
	await page.keyboard.press("Control+k");
	const dialog = page.getByRole("dialog", { name: "Command palette" });
	await expect(dialog).toBeVisible();

	await fillByLabel(page, "Command filter", "thermo");
	const matchMark = dialog.locator("mark");
	await expect(matchMark).toBeVisible();
	await expect(matchMark).toContainText("Thermo", { ignoreCase: true });

	// Click matching item
	// The sidebar thread row and its Archive button repeat the title.
	await clickByRole(page, "button", "Thermostat control check", {
		within: dialog,
	});
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
