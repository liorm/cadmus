import { resolve } from "node:path";
import { THEMES } from "../../src/theme/theme.ts";
import { seedBot, sendAccountRpc } from "../support/account.ts";
import { fillByLabel } from "../support/actions.ts";
import { expect, test } from "../support/fixtures.ts";
import {
	ensureScreensDir,
	openThemed,
	SCREENS_OUT_DIR,
	WORKER_BASE,
} from "../support/screens.ts";
import { installSocketGate } from "../support/sockets.ts";

const OUT_DIR = SCREENS_OUT_DIR;

test.beforeAll(() => {
	ensureScreensDir();
});

test("18-search", async ({ page, accountId, baseURL }) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "HA Agent", "ha-agent");
	await sendAccountRpc(origin, accountId, "chat.create", {
		botId: "ha-agent",
		title: "Tune thermostat schedules",
	});
	await sendAccountRpc(origin, accountId, "chat.create", {
		botId: "ha-agent",
		title: "Living room thermostat check",
	});
	for (const theme of THEMES) {
		await openThemed(page, "/search", theme);
		await fillByLabel(page, "Search", "thermo");
		await expect(page.getByText("2 chats match")).toBeVisible();
		await page.screenshot({
			path: resolve(OUT_DIR, `18-search-${theme}.png`),
			animations: "disabled",
		});
	}
});

test("17-reconnecting", async ({ page, accountId, baseURL }) => {
	const origin = baseURL ?? WORKER_BASE;
	await seedBot(origin, accountId, "HA Agent", "ha-agent");
	const created = await sendAccountRpc<{ chat: { key: string } }>(
		origin,
		accountId,
		"chat.create",
		{ botId: "ha-agent", title: "Tune thermostat schedules" },
	);
	await sendAccountRpc(origin, accountId, "turn.submit", {
		chatKey: created.chat.key,
		text: "Shift heating schedules 30 min earlier.",
	});
	void sendAccountRpc(origin, accountId, "turn.submit", {
		chatKey: created.chat.key,
		text: "hold please [[hold:ui-busy]]",
	}).catch(() => undefined);
	await installSocketGate(page, { blocked: true });
	for (const theme of THEMES) {
		await openThemed(page, `/chat/${created.chat.key}`, theme);
		await expect(
			page.getByText("Reconnecting… live updates paused"),
		).toBeVisible();
		await expect(page.getByRole("region", { name: "Live card" })).toBeVisible({
			timeout: 15_000,
		});
		await page.screenshot({
			path: resolve(OUT_DIR, `17-reconnecting-${theme}.png`),
			animations: "disabled",
		});
	}
});
