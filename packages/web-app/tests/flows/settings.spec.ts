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

async function chooseLeader(page: Page, value: string) {
	await page
		.getByRole("combobox", { name: "Team Leader bot" })
		.evaluate((node, next) => {
			const select = node as HTMLSelectElement;
			const setter = Object.getOwnPropertyDescriptor(
				HTMLSelectElement.prototype,
				"value",
			)?.set;
			setter?.call(select, next);
			select.dispatchEvent(new Event("input", { bubbles: true }));
			select.dispatchEvent(new Event("change", { bubbles: true }));
		}, value);
}

test("team leader select shows and hides Let TL route", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	await seedBot(origin, accountId, "Leader", "leader-bot");
	await watchPosts(page);
	await page.goto("/settings");
	await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
	await expect(
		page.getByRole("combobox", { name: "Team Leader bot" }),
	).toContainText("Leader");
	await chooseLeader(page, "leader-bot");
	await expect
		.poll(async () => {
			const family = await sendAccountRpc<{
				family: { teamLeaderBotId?: string };
			}>(origin, accountId, "family.get");
			return family.family.teamLeaderBotId ?? null;
		})
		.toBe("leader-bot");
	expect((await posted(page, "/api/family/update")).join("\n")).toContain(
		'"teamLeaderBotId":"leader-bot"',
	);
	await page.goto("/new?bot=echo-bot");
	await expect(
		page.getByRole("button", { name: "Let TL route" }),
	).toHaveAttribute("aria-pressed", "true");
	await expect(page.getByRole("button", { name: /To:/ })).toHaveCount(0);
	await page.reload();
	await expect(
		page.getByRole("button", { name: "Let TL route" }),
	).toHaveAttribute("aria-pressed", "true");
	await page.goto("/settings");
	await expect(
		page.getByRole("combobox", { name: "Team Leader bot" }),
	).toContainText("Leader");
	await chooseLeader(page, "");
	await expect
		.poll(async () => {
			const family = await sendAccountRpc<{
				family: { teamLeaderBotId?: string };
			}>(origin, accountId, "family.get");
			return family.family.teamLeaderBotId ?? null;
		})
		.toBe(null);
	expect((await posted(page, "/api/family/update")).join("\n")).toContain(
		'"teamLeaderBotId":null',
	);
	await page.goto("/new?bot=echo-bot");
	await expect(page.getByRole("button", { name: "Let TL route" })).toHaveCount(
		0,
	);
});

test("all schedules toggle sends schedule.update", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	const created = await sendAccountRpc<{ schedule: { id: string } }>(
		origin,
		accountId,
		"schedule.create",
		{
			botId: "echo-bot",
			name: "Morning climate check",
			kind: "cron",
			input: "0 7 * * *",
			text: "Check the climate.",
			target: { mode: "new-chat" },
		},
	);
	await watchPosts(page);
	await page.goto("/settings/schedules");
	await expect(
		page.getByRole("heading", { name: "All schedules" }),
	).toBeVisible();
	await expect(page.getByRole("region", { name: "Echo Bot" })).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Morning climate check" }),
	).toBeVisible();
	await page
		.getByRole("switch", { name: "Pause Morning climate check" })
		.evaluate((node) => {
			(node as HTMLElement).click();
		});
	await expect
		.poll(async () =>
			(await posted(page, "/api/schedule/update")).some(
				(row) =>
					row.includes(created.schedule.id) && row.includes('"enabled":false'),
			),
		)
		.toBe(true);
	const listed = await sendAccountRpc<{
		schedules: Array<{ id: string; enabled: boolean }>;
	}>(origin, accountId, "schedule.list");
	expect(
		listed.schedules.find((schedule) => schedule.id === created.schedule.id)
			?.enabled,
	).toBe(false);
});

test("archive lists a closed chat and opens it without a composer", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	await page.goto("/");
	await expect(page.getByRole("combobox", { name: "Bot" })).toBeVisible();
	await fillByLabel(page, "Message", "Archive from settings");
	await clickByRole(page, "button", "Send");
	await expect(page.getByRole("heading", { name: "New task" })).toBeVisible();
	await expect(page.getByText(/echo\(1\): Archive from settings/)).toBeVisible({
		timeout: 15_000,
	});
	await clickByRole(page, "button", "Chat menu");
	await clickByRole(page, "button", "Archive");
	await expect(page.getByRole("heading", { name: "Cadmus" })).toBeVisible();
	await page.goto("/settings/archive");
	await expect(page.getByRole("heading", { name: "Archive" })).toBeVisible();
	await expect(page.getByRole("region", { name: "Echo Bot" })).toBeVisible();
	await expect(page.getByRole("button", { name: "Unarchive" })).toHaveCount(0);
	await clickByRole(page, "link", "New task");
	await expect(page.getByText("Archived · read-only")).toBeVisible();
	await expect(page.getByRole("textbox", { name: "Message" })).toHaveCount(0);
});

test("sepia theme persists across reload", async ({ page }) => {
	await page.goto("/settings");
	await clickByRole(page, "radio", "Sepia");
	await expect
		.poll(async () =>
			page.evaluate(() => document.documentElement.getAttribute("data-theme")),
		)
		.toBe("sepia");
	await page.reload();
	const themeAtStart = await page.evaluate(() =>
		document.documentElement.getAttribute("data-theme"),
	);
	expect(themeAtStart).toBe("sepia");
});
