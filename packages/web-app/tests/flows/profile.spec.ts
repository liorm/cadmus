import type { Page } from "@playwright/test";
import { seedBot, sendAccountRpc } from "../support/account.ts";
import { clickByRole, fillByLabel } from "../support/actions.ts";
import { expect, test } from "../support/fixtures.ts";

test.describe.configure({ mode: "parallel" });

const WORKER_BASE = "http://127.0.0.1:8799";

async function watchPosts(page: Page) {
	await page.addInitScript(() => {
		const bag = window as unknown as {
			__posts?: Array<{ url: string; body: string }>;
		};
		bag.__posts = [];
		const original = window.fetch.bind(window);
		window.fetch = async (input, init) => {
			const url =
				typeof input === "string"
					? input
					: input instanceof URL
						? input.href
						: input.url;
			const body = typeof init?.body === "string" ? init.body : "";
			bag.__posts?.push({ url, body });
			return original(input, init);
		};
	});
	return {
		async all() {
			return page.evaluate(
				() =>
					(
						window as unknown as {
							__posts?: Array<{ url: string; body: string }>;
						}
					).__posts ?? [],
			);
		},
	};
}

async function choose(page: Page, label: string, value: string): Promise<void> {
	await page.getByLabel(label).evaluate((node, next) => {
		if (!(node instanceof HTMLSelectElement)) return;
		const setter = Object.getOwnPropertyDescriptor(
			HTMLSelectElement.prototype,
			"value",
		)?.set;
		setter?.call(node, next);
		node.dispatchEvent(new Event("change", { bubbles: true }));
	}, value);
}

test("config round-trips model, thinking, and timezone", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	const posts = await watchPosts(page);
	await page.goto("/bot/echo-bot/config");
	await expect(page.getByRole("heading", { name: "Echo Bot" })).toBeVisible();
	await expect(page.getByRole("radio", { name: "Config" })).toBeVisible();
	const model = page.getByLabel("Model");
	await expect(model).toBeVisible();
	const options = await model.locator("option").allTextContents();
	const nextModel = options.find((id) => id !== "faux/echo") ?? "faux/echo";
	await choose(page, "Model", nextModel);
	for (const level of ["Off", "Minimal", "Low", "Medium", "High"]) {
		await clickByRole(page, "radio", level);
	}
	await choose(page, "Timezone", "Asia/Jerusalem");
	await expect
		.poll(async () =>
			(await posts.all()).some(
				(hit) =>
					hit.url.includes("/api/bot/update") &&
					hit.body.includes('"timezone":"Asia/Jerusalem"'),
			),
		)
		.toBe(true);
	await expect
		.poll(async () =>
			(await posts.all()).some(
				(hit) =>
					hit.url.includes("/api/bot/update") &&
					hit.body.includes('"thinking":"high"'),
			),
		)
		.toBe(true);
	await expect
		.poll(async () =>
			(await posts.all()).some(
				(hit) =>
					hit.url.includes("/api/bot/update") &&
					hit.body.includes(`"model":"${nextModel}"`),
			),
		)
		.toBe(true);
	await page.reload();
	await expect(page.getByLabel("Timezone")).toHaveValue("Asia/Jerusalem");
	await expect(page.getByRole("radio", { name: "High" })).toHaveAttribute(
		"data-state",
		"on",
	);
});

test("tool allowlist saves a list and resets to null", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	const posts = await watchPosts(page);
	await page.goto("/bot/echo-bot/config");
	await clickByRole(page, "button", "Tool allowlist");
	await expect(
		page.getByRole("heading", { name: "Tool allowlist" }),
	).toBeVisible();
	await page.getByRole("switch", { name: "memory_read" }).evaluate((node) => {
		(node as HTMLElement).click();
	});
	await clickByRole(page, "button", "Save");
	await expect
		.poll(async () =>
			(await posts.all()).some(
				(hit) =>
					hit.url.includes("/api/bot/update") &&
					hit.body.includes('"tools":[') &&
					!hit.body.includes("memory_read"),
			),
		)
		.toBe(true);
	await clickByRole(page, "button", "Reset to default");
	await expect
		.poll(async () =>
			(await posts.all()).some(
				(hit) =>
					hit.url.includes("/api/bot/update") &&
					hit.body.includes('"tools":null'),
			),
		)
		.toBe(true);
});

test("tools env picker pins an account env", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	const created = await sendAccountRpc<{ env: { envId: string } }>(
		origin,
		accountId,
		"account.toolsEnvs.create",
		{ kind: "just-bash", label: "home-pi" },
	);
	const posts = await watchPosts(page);
	await page.goto("/bot/echo-bot/config");
	await clickByRole(page, "button", "Tools environment");
	await clickByRole(page, "button", "On · home-pi");
	await expect
		.poll(async () =>
			(await posts.all()).some(
				(hit) =>
					hit.url.includes("/api/bot/update") &&
					hit.body.includes('"enabled":true') &&
					hit.body.includes(created.env.envId),
			),
		)
		.toBe(true);
	await expect(page.getByText("On · home-pi")).toBeVisible();
});

test("delete bot confirms and leaves the main list", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	const posts = await watchPosts(page);
	await page.goto("/bot/echo-bot/config");
	await clickByRole(page, "button", "Delete bot");
	await expect(
		page.getByText(
			"This also deletes all of its chats, files and schedules. This can't be undone.",
		),
	).toBeVisible();
	await clickByRole(page, "button", "Delete Echo Bot");
	await expect(page.getByRole("heading", { name: "Cadmus" })).toBeVisible();
	await expect(page.getByRole("region", { name: "Echo Bot" })).toHaveCount(0);
	expect(
		(await posts.all()).some((hit) => hit.url.includes("/api/bot/delete")),
	).toBe(true);
});

test("memory edit writes and knowledge delete removes a doc", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	await sendAccountRpc(origin, accountId, "file.write", {
		botId: "echo-bot",
		path: "knowledge/heating.md",
		content: "# Heating\n\nZones.",
		description: "Heating zones",
	});
	const posts = await watchPosts(page);
	await page.goto("/bot/echo-bot/memory");
	await clickByRole(page, "button", "Edit");
	await fillByLabel(page, "MEMORY.md source", "# Memory\n\nDark roast.");
	await expect(page.getByText("Unsaved changes")).toBeVisible();
	await clickByRole(page, "button", "Save");
	await expect
		.poll(async () =>
			(await posts.all()).some(
				(hit) =>
					hit.url.includes("/api/file/write") &&
					hit.body.includes("Dark roast."),
			),
		)
		.toBe(true);
	await page.goto("/bot/echo-bot/knowledge");
	await expect(
		page.getByRole("button", { name: /heating \d+ bytes/ }),
	).toBeVisible();
	await clickByRole(page, "button", "Delete heating");
	await expect
		.poll(async () =>
			(await posts.all()).some(
				(hit) =>
					hit.url.includes("/api/file/delete") &&
					hit.body.includes("knowledge/heating.md"),
			),
		)
		.toBe(true);
	await expect(page.getByText("No knowledge docs.")).toBeVisible();
});

test("schedule toggle sends schedule.update", async ({
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
	const posts = await watchPosts(page);
	await page.goto("/bot/echo-bot/schedules");
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
			(await posts.all()).some(
				(hit) =>
					hit.url.includes("/api/schedule/update") &&
					hit.body.includes(created.schedule.id) &&
					hit.body.includes('"enabled":false'),
			),
		)
		.toBe(true);
});

test("harvest note appears and the chat toggle updates harvest", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await sendAccountRpc(origin, accountId, "family.update", {
		harvestDelayMs: 200,
	});
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	const created = await sendAccountRpc<{ chat: { key: string } }>(
		origin,
		accountId,
		"chat.create",
		{ botId: "echo-bot", title: "Tune thermostat schedules" },
	);
	await sendAccountRpc(origin, accountId, "turn.submit", {
		chatKey: created.chat.key,
		text: "Hello [remember: kids room lights off at 20:00]",
	});
	const posts = await watchPosts(page);
	await page.goto("/bot/echo-bot/harvest");
	await expect(page.getByRole("heading", { name: "Harvest" })).toBeVisible();
	await expect(page.getByText("Tune thermostat schedules")).toBeVisible({
		timeout: 30_000,
	});
	await expect(page.getByText("MEMORY.md +1").first()).toBeVisible();
	await page.getByRole("switch", { name: "Harvest on" }).evaluate((node) => {
		(node as HTMLElement).click();
	});
	await expect
		.poll(async () =>
			(await posts.all()).some(
				(hit) =>
					hit.url.includes("/api/chat/update") &&
					hit.body.includes('"harvest":false'),
			),
		)
		.toBe(true);
});

test("group menu opens profile, archives chats, and sets colour", async ({
	page,
	accountId,
	baseURL,
}) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	await sendAccountRpc(origin, accountId, "chat.create", {
		botId: "echo-bot",
		title: "Morning notes",
	});
	const posts = await watchPosts(page);
	await page.goto("/");
	await expect(
		page.getByRole("button", { name: "Morning notes", exact: true }),
	).toBeVisible();
	await clickByRole(page, "button", "Echo Bot menu");
	await clickByRole(page, "button", "Profile");
	await expect(page.getByRole("radio", { name: "Schedules" })).toBeVisible();
	await page.goto("/");
	await clickByRole(page, "button", "Echo Bot menu");
	await clickByRole(page, "button", "Change colour");
	await clickByRole(page, "button", "bot-3");
	await expect
		.poll(async () =>
			(await posts.all()).some(
				(hit) =>
					hit.url.includes("/api/bot/update") &&
					hit.body.includes('"color":"bot-3"'),
			),
		)
		.toBe(true);
	await clickByRole(page, "button", "Echo Bot menu");
	await clickByRole(page, "button", "Archive all chats");
	await clickByRole(page, "button", "Archive all");
	await expect(
		page.getByRole("button", { name: "Morning notes", exact: true }),
	).toHaveCount(0);
});
