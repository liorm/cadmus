import { seedBot, sendAccountRpc } from "../support/account.ts";
import { expect, test } from "../support/fixtures.ts";

test.describe.configure({ mode: "parallel" });

const WORKER_BASE = "http://127.0.0.1:8799";

const SOUL = `# Soul

Calm, brief, and local.

## Voice

Keep answers **short**.

- Prefer local facts
- Stay kind

\`\`\`ts
export const tone = "calm";
\`\`\`

<script>window.__soul_xss = 1</script>
`;

const MEMORY = `# Memory

User likes **dark** roast.

## Layout

- Wall tablet in the hall
- Kitchen display

\`\`\`ts
const roast = "dark";
\`\`\`

<img src=x onerror="window.__mem_xss=1">
`;

const CHAT_MD = `
# Status

Use **bold** labels.

## Next

- Check the hall tablet
- Log the roast

\`\`\`ts
const roast = "dark";
\`\`\`

<script>window.__chat_xss = 1</script>
`;

async function assertMarkdownSurface(
	page: import("@playwright/test").Page,
	root: import("@playwright/test").Locator,
) {
	await expect(root.getByRole("heading", { level: 1 }).first()).toBeVisible();
	await expect(root.getByRole("heading", { level: 2 }).first()).toBeVisible();
	await expect(root.locator("strong").first()).toBeVisible();
	await expect(root.locator("li").first()).toBeVisible();
	await expect(root.locator("pre code").first()).toBeVisible();
	await expect
		.poll(async () =>
			root.locator("pre .hljs-keyword, pre .hljs-string").count(),
		)
		.toBeGreaterThan(0);
	expect(await root.locator("script").count()).toBe(0);
	expect(await page.locator("img[src='x']").count()).toBe(0);
}

test("soul, memory, and chat render markdown without executing HTML", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	await sendAccountRpc(origin, accountId, "file.write", {
		botId: "echo-bot",
		path: "SOUL.md",
		content: SOUL,
	});
	await sendAccountRpc(origin, accountId, "file.write", {
		botId: "echo-bot",
		path: "MEMORY.md",
		content: MEMORY,
	});
	const created = await sendAccountRpc<{ chat: { key: string } }>(
		origin,
		accountId,
		"chat.create",
		{ botId: "echo-bot", title: "Markdown notes" },
	);
	await sendAccountRpc(origin, accountId, "turn.submit", {
		chatKey: created.chat.key,
		text: CHAT_MD,
	});

	await page.goto("/app/#/bot/echo-bot/soul");
	await expect(page.getByRole("heading", { name: "Soul" })).toBeVisible();
	await assertMarkdownSurface(page, page.locator(".cadmus-md").first());
	expect(
		await page.evaluate(
			() => (window as unknown as { __soul_xss?: number }).__soul_xss,
		),
	).toBeUndefined();

	await page.goto("/app/#/bot/echo-bot/memory");
	await expect(page.getByRole("heading", { name: "Memory" })).toBeVisible();
	await assertMarkdownSurface(page, page.locator(".cadmus-md").first());
	expect(
		await page.evaluate(
			() => (window as unknown as { __mem_xss?: number }).__mem_xss,
		),
	).toBeUndefined();

	await page.goto(`/app/#/chat/${created.chat.key}`);
	await expect(
		page.getByRole("heading", { name: "Status" }).first(),
	).toBeVisible({ timeout: 15_000 });
	await assertMarkdownSurface(page, page.locator(".cadmus-md").last());
	expect(
		await page.evaluate(
			() => (window as unknown as { __chat_xss?: number }).__chat_xss,
		),
	).toBeUndefined();
});
