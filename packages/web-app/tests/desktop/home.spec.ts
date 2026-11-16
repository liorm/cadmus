import { seedBot, sendAccountRpc } from "../support/account.ts";
import { clickByRole, fillByLabel } from "../support/actions.ts";
import { expect, test } from "../support/fixtures.ts";

// Ordinary user-level journey: signs in through token login with the user-role grants, no master token.
test.use({ signIn: "user" });

test.describe.configure({ mode: "parallel" });

const WORKER_BASE = "http://127.0.0.1:8799";

test("desktop home is the command cockpit", async ({
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
	await expect(page.getByText("1 Bots Online")).toBeVisible();
	await expect(page.getByText("0 Running")).toBeVisible();
	await expect(page.getByText("0 Needs Attention")).toBeVisible();
	await expect(page.getByRole("link", { name: "default" })).toBeVisible();
	await expect(
		page.getByRole("complementary", { name: "Bot fleet and threads" }),
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Active bot fleet" }),
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Live thread feed" }),
	).toBeVisible();
	await expect(page.getByRole("button", { name: "All" })).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(page.getByRole("button", { name: "Running" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Needs you" })).toBeVisible();
	await expect(
		page.getByRole("button", { name: "idle Echo Bot", exact: true }),
	).toHaveAttribute("aria-pressed", "true");
	await expect(page.getByText("faux/echo").first()).toBeVisible();
	await expect(page.getByText("0 threads")).toBeVisible();
	await expect(
		page.getByRole("region", { name: "Chat console" }),
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Echo Bot", exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "What can you help with?" }),
	).toBeVisible();
	await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Steer" })).toBeVisible();

	await clickByRole(page, "button", "New thread with Echo Bot");
	await expect(
		page.getByRole("heading", { name: "Echo Bot", exact: true }),
	).toBeVisible();

	await clickByRole(page, "button", "Search");
	await expect(
		page.getByRole("dialog", { name: "Command palette" }),
	).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(
		page.getByRole("dialog", { name: "Command palette" }),
	).toBeHidden();
});

test("command or control 1 switches the selected bot", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	await seedBot(origin, accountId, "Other Bot", "other-bot");
	await page.goto("/");
	const echo = page.getByRole("button", { name: "idle Echo Bot", exact: true });
	const other = page.getByRole("button", {
		name: "idle Other Bot",
		exact: true,
	});
	await expect(echo).toBeVisible();
	await expect(other).toBeVisible();
	const echoFirst = (await echo.getAttribute("aria-pressed")) === "true";
	const first = echoFirst ? echo : other;
	const second = echoFirst ? other : echo;
	const secondName = echoFirst ? "Other Bot" : "Echo Bot";
	const firstName = echoFirst ? "Echo Bot" : "Other Bot";

	await page.keyboard.press("Control+2");
	await expect(second).toHaveAttribute("aria-pressed", "true");
	await expect(
		page.getByRole("heading", { name: secondName, exact: true }),
	).toBeVisible();

	await page.keyboard.press("Control+1");
	await expect(first).toHaveAttribute("aria-pressed", "true");
	await expect(
		page.getByRole("heading", { name: firstName, exact: true }),
	).toBeVisible();
});

test("empty state to new bot creation inside cockpit stage", async ({
	page,
}) => {
	await page.goto("/");
	await expect(
		page.getByRole("banner", { name: "Cadmus Cockpit" }),
	).toBeVisible();
	await expect(
		page.getByRole("complementary", { name: "Bot fleet and threads" }),
	).toBeVisible();
	await expect(
		page.getByRole("complementary", { name: "Telemetry" }),
	).toBeVisible();

	// The fleet header and the empty state each have a "+ New bot" link to the
	// same route. This test is the empty state, so take that one.
	await clickByRole(page, "link", "+ New bot", {
		within: page.locator(
			"div:has(> p:text-is('No bots yet. Create one to start a thread.'))",
		),
	});
	await expect(
		page.getByRole("banner", { name: "Cadmus Cockpit" }),
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "New bot", exact: true }),
	).toBeVisible();

	await fillByLabel(page, "Name", "Bravo Bot");
	await clickByRole(page, "button", "bot-3");
	await fillByLabel(page, "Soul", "You are Bravo.");
	await clickByRole(page, "button", "Create bot");

	await expect(
		page.getByRole("banner", { name: "Cadmus Cockpit" }),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "idle Bravo Bot", exact: true }),
	).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "Bravo Bot", exact: true }),
	).toBeVisible();
});

test("fleet deck bot card actions menu: profile, change colour, archive all chats", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	const bot = await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	await sendAccountRpc(origin, accountId, "chat.create", {
		botId: bot.id,
		title: "Thread 1",
	});
	await sendAccountRpc(origin, accountId, "chat.create", {
		botId: bot.id,
		title: "Thread 2",
	});

	await page.goto("/");
	await expect(page.getByText("2 threads")).toBeVisible();

	// Open bot menu via ⋯ button
	await clickByRole(page, "button", "Echo Bot menu");
	const sheet = page.getByRole("dialog", { name: "Echo Bot" });
	await expect(sheet).toBeVisible();

	// Change color to bot-5
	await clickByRole(page, "button", "Change colour");
	await clickByRole(page, "button", "bot-5");
	await expect(
		page.getByRole("dialog", { name: "Change colour" }),
	).toBeHidden();
	await expect(sheet).toBeHidden();

	// Open Profile in Stage
	await clickByRole(page, "button", "Echo Bot menu");
	await clickByRole(page, "button", "Profile");
	await expect(
		page.getByRole("banner", { name: "Cadmus Cockpit" }),
	).toBeVisible();
	await expect(
		page.getByRole("radiogroup", { name: "Bot profile tabs" }),
	).toBeVisible();

	// Archive all chats
	await clickByRole(page, "button", "Echo Bot menu");
	await clickByRole(page, "button", "Archive all chats");
	await clickByRole(page, "button", "Archive all");
	await expect(page.getByText("0 threads")).toBeVisible();
});

test("unread reply shows unread dot on thread row and increments needs attention", async ({
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
		{ botId: bot.id, title: "Unread Thread" },
	);
	await sendAccountRpc(origin, accountId, "turn.submit", {
		chatKey: created.chat.key,
		text: "ping",
	});

	await page.goto("/");
	await expect(
		page.getByRole("banner", { name: "Cadmus Cockpit" }),
	).toBeVisible();
	await expect(page.getByText("1 Needs Attention")).toBeVisible();

	const threadFeed = page.getByRole("region", { name: "Live thread feed" });
	await expect(
		threadFeed.getByRole("status", { name: "Unread" }),
	).toBeVisible();

	// Filter by Needs you
	await clickByRole(page, "button", "Needs you");
	await expect(threadFeed.getByText("Unread Thread")).toBeVisible();

	// Selecting thread clears unread
	// "Unread Thread" alone also matches the "Archive Unread Thread" button. The
	// row's accessible name (hosted log) is "Unread Thread Unread Echo Bot": the
	// title, the unread status, then the bot name.
	await clickByRole(page, "button", "Unread Thread Unread Echo Bot", {
		within: threadFeed,
	});
	await expect(threadFeed.getByRole("status", { name: "Unread" })).toHaveCount(
		0,
	);
});

test("quick archive action on thread row in fleet deck and retry button resubmits", async ({
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
		{ botId: bot.id, title: "Failing Chat" },
	);

	// Start a turn and stop it to make it retryable
	await page.goto(`/chat/${created.chat.key}`);
	await fillByLabel(page, "Message", "fail me [[hold:ui-fail]]");
	await clickByRole(page, "button", "Send");
	await expect(page.getByRole("region", { name: "Live card" })).toBeVisible({
		timeout: 10_000,
	});
	await clickByRole(page, "button", "Stop");

	await page.goto("/");
	await expect(page.getByRole("button", { name: "Retry" }).first()).toBeVisible(
		{
			timeout: 15_000,
		},
	);
	await clickByRole(page, "button", "Retry");

	// Create another chat to test quick archive
	await sendAccountRpc(origin, accountId, "chat.create", {
		botId: bot.id,
		title: "Quick Archive Target",
	});
	await page.reload();

	await expect(page.getByText("Quick Archive Target")).toBeVisible();
	await clickByRole(page, "button", "Archive Quick Archive Target");
	await expect(page.getByText("Quick Archive Target")).toHaveCount(0);
});
