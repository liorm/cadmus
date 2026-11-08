import { seedBot, sendAccountRpc } from "../support/account.ts";
import { clickByRole } from "../support/actions.ts";
import { expect, test } from "../support/fixtures.ts";

test.describe.configure({ mode: "parallel" });

const WORKER_BASE = "http://127.0.0.1:8799";

test("telemetry links open views inside Cockpit Stage without mobile AppShell ejection", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	await page.goto("/");

	const telemetry = page.getByRole("complementary", { name: "Telemetry" });
	await expect(telemetry).toBeVisible();
	await expect(
		page.getByRole("banner", { name: "Cadmus Cockpit" }),
	).toBeVisible();
	await expect(
		page.getByRole("complementary", { name: "Bot fleet and threads" }),
	).toBeVisible();

	await clickByRole(page, "tab", "Memory harvest");
	await expect(
		telemetry.getByRole("link", { name: "Open MEMORY.md" }),
	).toBeVisible();
	await expect(
		telemetry.getByRole("link", { name: "Harvest page" }),
	).toBeVisible();
	await expect(
		telemetry.getByRole("link", { name: "Schedules" }),
	).toBeVisible();

	// 1. Open MEMORY.md
	await clickByRole(page, "link", "Open MEMORY.md");
	await expect(page).toHaveURL(/\/bot\/echo-bot\/doc/);
	await expect(
		page.getByRole("banner", { name: "Cadmus Cockpit" }),
	).toBeVisible();
	await expect(
		page.getByRole("complementary", { name: "Bot fleet and threads" }),
	).toBeVisible();
	await expect(
		page.getByRole("complementary", { name: "Telemetry" }),
	).toBeVisible();
	await expect(page.getByRole("heading", { name: "MEMORY.md" })).toBeVisible();

	// 2. Open Harvest page
	await clickByRole(page, "tab", "Memory harvest");
	await clickByRole(page, "link", "Harvest page");
	await expect(page).toHaveURL(/\/bot\/echo-bot\/harvest/);
	await expect(
		page.getByRole("banner", { name: "Cadmus Cockpit" }),
	).toBeVisible();
	await expect(
		page.getByRole("complementary", { name: "Bot fleet and threads" }),
	).toBeVisible();
	await expect(
		page.getByRole("complementary", { name: "Telemetry" }),
	).toBeVisible();

	// 3. Open Schedules
	await clickByRole(page, "tab", "Memory harvest");
	await clickByRole(page, "link", "Schedules");
	await expect(page).toHaveURL(/\/bot\/echo-bot\/schedules/);
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
		page.getByRole("radiogroup", { name: "Bot profile tabs" }),
	).toBeVisible();
});

test("live tool execution streams into TelemetryDeck without duplicate fetches", async ({
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
		{ botId: "echo-bot", title: "Telemetry Stream Chat" },
	);
	const chatKey = created.chat.key;

	// Submit turn with knowledge_read and task_add tools
	await sendAccountRpc(origin, accountId, "turn.submit", {
		chatKey,
		text: 'Read doc [tool:knowledge_read {"slug":"overview"}] [tool:task_add {"title":"Review findings","details":"Check review details"}]',
	});

	// Track messages and tasks requests
	const requestedUrls: string[] = [];
	page.on("request", (req) => {
		const url = req.url();
		if (
			url.includes("/api/chat/messages") ||
			url.includes("/api/chat/tasks/list")
		) {
			requestedUrls.push(url);
		}
	});

	await page.goto(`/chat/${chatKey}`);
	await expect(
		page.getByRole("banner", { name: "Cadmus Cockpit" }),
	).toBeVisible();

	const telemetry = page.getByRole("complementary", { name: "Telemetry" });
	await expect(telemetry).toBeVisible();

	// Verify tool stream tab displays tool call
	await expect(telemetry.getByText("knowledge_read")).toBeVisible({
		timeout: 15_000,
	});

	// Verify task plan tab displays added task
	await clickByRole(page, "tab", "Task plan");
	await expect(telemetry.getByText("Review findings")).toBeVisible({
		timeout: 10_000,
	});

	// Verify no duplicate fetches from TelemetryDeck (since ChatSession already loaded them)
	const messagesFetches = requestedUrls.filter((u) =>
		u.includes("/api/chat/messages"),
	).length;
	const tasksFetches = requestedUrls.filter((u) =>
		u.includes("/api/chat/tasks/list"),
	).length;
	expect(messagesFetches).toBe(0);
	expect(tasksFetches).toBe(0);
});
