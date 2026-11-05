import type { Page } from "@playwright/test";
import { seedBot, sendAccountRpc } from "../support/account.ts";
import { clickByRole, fillByLabel } from "../support/actions.ts";
import { expect, test } from "../support/fixtures.ts";

test.describe.configure({ mode: "parallel" });

const WORKER_BASE = "http://127.0.0.1:8799";

async function watchPosts(page: Page) {
	await page.addInitScript(() => {
		const orig = window.fetch.bind(window);
		window.fetch = async (input, init) => {
			const url =
				typeof input === "string"
					? input
					: input instanceof Request
						? input.url
						: String(input);
			const body = typeof init?.body === "string" ? init.body : "";
			const bag = (globalThis as { __cadmusPosts?: string[] }).__cadmusPosts;
			const next = bag ?? [];
			next.push(`${url} ${body}`);
			(globalThis as { __cadmusPosts?: string[] }).__cadmusPosts = next;
			return orig(input, init);
		};
	});
}

async function posted(page: Page, fragment: string): Promise<string[]> {
	const rows = await page.evaluate(() => {
		return (globalThis as { __cadmusPosts?: string[] }).__cadmusPosts ?? [];
	});
	return rows.filter((row) => row.includes(fragment));
}

test("new account: empty home, then create a bot", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await watchPosts(page);
	await page.goto("/app/#/");
	await expect(page.getByRole("heading", { name: "Cadmus" })).toBeVisible();
	await expect(
		page.getByRole("heading", { name: "It's quiet in here." }),
	).toBeVisible();
	await expect(page.getByText("No bots yet")).toBeVisible();
	await expect(page.getByRole("button", { name: "Send" })).toBeDisabled();
	await clickByRole(page, "link", "+ New bot");
	await expect(page.getByRole("heading", { name: "New bot" })).toBeVisible();
	await fillByLabel(page, "Name", "Garden Agent");
	await expect(page.getByText("GA", { exact: true })).toBeVisible();
	await clickByRole(page, "button", "bot-3");
	await fillByLabel(page, "Soul", "Ask before you water.");
	await clickByRole(page, "button", "Create bot");
	await expect(page.getByRole("heading", { name: "Cadmus" })).toBeVisible();
	await expect(
		page.getByRole("region", { name: "Garden Agent" }),
	).toBeVisible();
	const listed = await sendAccountRpc<{
		bots: Array<{ id: string; metadata?: { color?: string } }>;
	}>(origin, accountId, "bot.list");
	expect(listed.bots[0]?.metadata?.color).toBe("bot-3");
	const detail = await sendAccountRpc<{ soul?: string }>(
		origin,
		accountId,
		"bot.get",
		{ botId: listed.bots[0]?.id },
	);
	expect(detail.soul).toContain("Ask before you water.");
	const createBody = (await posted(page, "/api/bot/create")).join("\n");
	expect(createBody).toContain('"name":"Garden Agent"');
	expect(createBody).toContain('"soul":"Ask before you water."');
	expect(createBody).toContain('"color":"bot-3"');
	await expect(page.getByRole("combobox", { name: "Bot" })).toBeEnabled();
});

test("first message chip picks the bot, then hides", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	await seedBot(origin, accountId, "Garden Agent", "garden-agent");
	await watchPosts(page);
	await page.goto("/app/#/new?bot=echo-bot");
	await expect(
		page.getByRole("button", { name: "To: Echo Bot" }),
	).toBeVisible();
	await expect(page.getByRole("button", { name: "Let TL route" })).toHaveCount(
		0,
	);
	await clickByRole(page, "button", "To: Echo Bot");
	await clickByRole(page, "button", "Garden Agent");
	await expect(
		page.getByRole("button", { name: "To: Garden Agent" }),
	).toBeVisible();
	await fillByLabel(page, "Message", "Hello garden");
	await clickByRole(page, "button", "Send");
	await expect(page.getByText(/echo\(1\): Hello garden/)).toBeVisible({
		timeout: 15_000,
	});
	await expect(page.getByRole("button", { name: /To:/ })).toHaveCount(0);
	const listed = await sendAccountRpc<{
		chats: Array<{ botId: string }>;
	}>(origin, accountId, "chat.list");
	expect(listed.chats.some((chat) => chat.botId === "garden-agent")).toBe(true);
	expect((await posted(page, "/api/chat/create")).join("\n")).toContain(
		'"botId":"garden-agent"',
	);
	expect((await posted(page, "/api/turn/submit")).join("\n")).toContain(
		"Hello garden",
	);
});

test("Let TL route creates the chat with the team leader", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	await seedBot(origin, accountId, "Leader", "leader-bot");
	await sendAccountRpc(origin, accountId, "family.update", {
		teamLeaderBotId: "leader-bot",
	});
	await watchPosts(page);
	await page.goto("/app/#/new?bot=echo-bot");
	await expect(
		page.getByRole("button", { name: "Let TL route" }),
	).toBeVisible();
	await clickByRole(page, "button", "Let TL route");
	await expect(
		page.getByRole("button", { name: "Let TL route" }),
	).toHaveAttribute("aria-pressed", "true");
	await fillByLabel(page, "Message", "Route this");
	await clickByRole(page, "button", "Send");
	await expect(page.getByText(/echo\(1\): Route this/)).toBeVisible({
		timeout: 15_000,
	});
	const listed = await sendAccountRpc<{
		chats: Array<{ botId: string }>;
	}>(origin, accountId, "chat.list");
	expect(listed.chats.some((chat) => chat.botId === "leader-bot")).toBe(true);
	expect((await posted(page, "/api/chat/create")).join("\n")).toContain(
		'"botId":"leader-bot"',
	);
});
