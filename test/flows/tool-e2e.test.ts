// Each branch tool, through main(). The model is scripted; the tool and storage are real.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ToolResultEntry } from "@earendil-works/pi-durable";
import type { App } from "../../src/app.ts";
import { listChats } from "../../src/channels/telegram/chats.ts";
import { resetTestClock, setTestClock } from "../../src/clock.ts";
import { FakeEgress } from "../egress/fake-egress.ts";
import { routeEgress } from "../egress/route.ts";
import {
	defined,
	settle,
	startBot,
	tempHome,
	until,
	waitTestClockTicks,
} from "../support.ts";

const TOKEN = "test-web-token";

let egress: FakeEgress;
let unroute: () => void;
let apps: App[] = [];

beforeEach(() => {
	egress = new FakeEgress();
	unroute = routeEgress(egress.url);
});
afterEach(async () => {
	resetTestClock();
	egress.xai.release();
	for (const app of apps) await app.stop();
	apps = [];
	unroute();
	egress.stop();
});

async function boot(home?: string) {
	const dir = home ?? (await tempHome());
	const app = await startBot(dir, {
		WEB_TOKEN: TOKEN,
		WEB_PORT: "0",
		PI_BOT_HARVEST_DELAY_MS: "86400000",
	});
	apps.push(app);
	if (!app.web) throw new Error("web listener did not start");
	return { app, url: app.web.url, home: dir };
}

async function call(url: string, path: string, init: RequestInit = {}) {
	const headers = new Headers(init.headers);
	headers.set("authorization", `Bearer ${TOKEN}`);
	if (init.body && !headers.has("content-type"))
		headers.set("content-type", "application/json");
	return fetch(`${url}${path}`, { ...init, headers });
}

async function json<T>(
	url: string,
	path: string,
	init?: RequestInit,
): Promise<T> {
	const response = await call(url, path, init);
	expect(response.status).toBeLessThan(400);
	return response.json() as Promise<T>;
}

function followUp(): string {
	return egress.xai.requests
		.slice(1)
		.map((request) => JSON.stringify(request.body))
		.join("\n");
}

async function toolResults(app: App) {
	const results: { name: string; isError: boolean; text: string }[] = [];
	for (const chat of await listChats(app.harness)) {
		const conversation = await app.harness.conversation(
			chat.conversationId,
			BACKGROUND_CONTEXT,
		);
		const page = await defined(conversation, "conversation").entries(
			{},
			1000,
			undefined,
			BACKGROUND_CONTEXT,
		);
		for (const entry of page.items) {
			if (!ToolResultEntry.is(entry)) continue;
			const message = entry.model?.[0];
			if (message?.role !== "toolResult") continue;
			results.push({
				name: message.toolName,
				isError: message.isError,
				text: message.content
					.map((part) => (part.type === "text" ? part.text : ""))
					.join(""),
			});
		}
	}
	return results;
}

function scheduleRow(home: string, id: string) {
	const db = new Database(join(home, "schedules.sqlite"), { readonly: true });
	try {
		return db
			.query<
				{ id: string; text: string; enabled: number; name: string | null },
				[string]
			>("SELECT id, text, enabled, name FROM schedules WHERE id = ?")
			.get(id);
	} finally {
		db.close();
	}
}

describe("tool results", () => {
	it("schedule_create stores a row and returns it to the model", async () => {
		const home = await tempHome();
		const { app, url } = await boot(home);
		egress.xai.script.push(
			{
				tool: {
					name: "schedule_create",
					arguments: {
						text: "Morning check",
						cron: "0 9 * * *",
					},
				},
			},
			{ text: "created" },
		);
		egress.telegram.push("remind me each morning");
		await until(() => egress.telegram.texts().includes("created"), "the reply");
		await settle(app, egress);
		const listed = await json<{ schedules: { id: string; text: string }[] }>(
			url,
			"/api/bots/default/schedules",
		);
		const row = defined(listed.schedules[0], "schedule");
		expect(row.text).toBe("Morning check");
		expect(scheduleRow(home, row.id)?.text).toBe("Morning check");
		const fed = followUp();
		expect(fed).toContain(row.id);
		expect(fed).toContain("Morning check");
		expect(fed).toContain("0 9 * * *");
	});

	it("schedule_list returns this bot's rows to the model and omits harvest", async () => {
		const home = await tempHome();
		const { app, url } = await boot(home);
		egress.xai.script.push(
			{
				tool: {
					name: "schedule_create",
					arguments: { text: "Listed row", cron: "15 8 * * *" },
				},
			},
			{ text: "created" },
		);
		egress.telegram.push("add one");
		await until(() => egress.telegram.texts().includes("created"), "created");
		await settle(app, egress);
		const id = defined(
			(
				await json<{ schedules: { id: string }[] }>(
					url,
					"/api/bots/default/schedules",
				)
			).schedules[0],
			"schedule",
		).id;
		const db = new Database(join(home, "schedules.sqlite"));
		db.run(
			`INSERT INTO schedules (id, bot_id, kind, cron, when_ms, next_run, text, target_json)
			 VALUES (?, 'default', 'when', NULL, 1, 9999999999999, 'secret-harvest', ?)`,
			["harvest:hidden", JSON.stringify({ mode: "fork", chatId: "other" })],
		);
		db.close();
		egress.xai.script.push(
			{ tool: { name: "schedule_list", arguments: {} } },
			{ text: "listed" },
		);
		egress.telegram.push("what is scheduled?");
		await until(() => egress.telegram.texts().includes("listed"), "listed");
		await settle(app, egress);
		const fed = followUp();
		expect(fed).toContain(id);
		expect(fed).toContain("Listed row");
		expect(fed).not.toContain("secret-harvest");
		expect(fed).not.toContain("harvest:hidden");
		expect(scheduleRow(home, "harvest:hidden")?.text).toBe("secret-harvest");
	});

	it("schedule_update writes the new row and returns it to the model", async () => {
		const home = await tempHome();
		const { app, url } = await boot(home);
		egress.xai.script.push(
			{
				tool: {
					name: "schedule_create",
					arguments: { text: "Morning check", cron: "0 9 * * *" },
				},
			},
			{ text: "created" },
		);
		egress.telegram.push("add one");
		await until(() => egress.telegram.texts().includes("created"), "created");
		await settle(app, egress);
		const id = defined(
			(
				await json<{ schedules: { id: string }[] }>(
					url,
					"/api/bots/default/schedules",
				)
			).schedules[0],
			"schedule",
		).id;
		egress.xai.script.push(
			{
				tool: {
					name: "schedule_update",
					arguments: {
						id,
						text: "Evening check",
						cron: "30 18 * * *",
						name: "Evening",
					},
				},
			},
			{ text: "updated" },
		);
		egress.telegram.push("move it");
		await until(() => egress.telegram.texts().includes("updated"), "updated");
		await settle(app, egress);
		const stored = scheduleRow(home, id);
		expect(stored?.text).toBe("Evening check");
		expect(stored?.name).toBe("Evening");
		const fed = followUp();
		expect(fed).toContain("Evening check");
		expect(fed).toContain("30 18 * * *");
		expect(fed).toContain(id);
	});

	it("schedule_delete removes the row and returns the id to the model", async () => {
		const home = await tempHome();
		const { app, url } = await boot(home);
		egress.xai.script.push(
			{
				tool: {
					name: "schedule_create",
					arguments: { text: "Morning check", cron: "0 9 * * *" },
				},
			},
			{ text: "created" },
		);
		egress.telegram.push("add one");
		await until(() => egress.telegram.texts().includes("created"), "created");
		await settle(app, egress);
		const id = defined(
			(
				await json<{ schedules: { id: string }[] }>(
					url,
					"/api/bots/default/schedules",
				)
			).schedules[0],
			"schedule",
		).id;
		egress.xai.script.push(
			{ tool: { name: "schedule_delete", arguments: { id } } },
			{ text: "removed" },
		);
		egress.telegram.push("drop it");
		await until(() => egress.telegram.texts().includes("removed"), "removed");
		await settle(app, egress);
		expect(scheduleRow(home, id)).toBeNull();
		expect(followUp()).toContain(id);
		const left = await json<{ schedules: { id: string }[] }>(
			url,
			"/api/bots/default/schedules",
		);
		expect(left.schedules).toEqual([]);
	});

	it("a created schedule fires on the test clock, a paused one does not, and re-enabling fires it", async () => {
		let clock = Date.parse("2026-06-01T09:00:00.000Z");
		setTestClock(() => clock);
		const home = await tempHome();
		const { app, url } = await boot(home);
		const when = clock + 1_000;
		egress.xai.script.push(
			{
				tool: {
					name: "schedule_create",
					arguments: { text: "clock ping", when },
				},
			},
			{ text: "armed" },
		);
		egress.telegram.push("ping me shortly");
		await until(() => egress.telegram.texts().includes("armed"), "armed");
		await settle(app, egress);
		const id = defined(
			(
				await json<{ schedules: { id: string }[] }>(
					url,
					"/api/bots/default/schedules",
				)
			).schedules[0],
			"schedule",
		).id;
		egress.xai.script.push(
			{
				tool: {
					name: "schedule_update",
					arguments: { id, enabled: false },
				},
			},
			{ text: "paused" },
		);
		egress.telegram.push("pause it");
		await until(() => egress.telegram.texts().includes("paused"), "paused");
		await settle(app, egress);
		expect(scheduleRow(home, id)?.enabled).toBe(0);
		clock = when + 1;
		await waitTestClockTicks();
		await app.quiesce();
		expect(
			egress.telegram.texts().some((text) => text.includes("clock ping")),
		).toBe(false);
		egress.xai.script.push(
			{
				tool: {
					name: "schedule_update",
					arguments: { id, enabled: true },
				},
			},
			{ text: "resumed clock ping" },
		);
		egress.telegram.push("turn it back on");
		await until(
			() => egress.telegram.texts().some((text) => text.includes("clock ping")),
			"the fire",
		);
		await settle(app, egress);
		const db = new Database(join(home, "schedules.sqlite"), { readonly: true });
		try {
			const fires = db
				.query<{ request_id: string }, []>("SELECT request_id FROM fires")
				.all()
				.map((row) => row.request_id);
			expect(
				fires.filter((requestId) => requestId.startsWith(`sched:${id}:`)),
			).toHaveLength(1);
		} finally {
			db.close();
		}
		expect(scheduleRow(home, id)).toBeNull();
	});

	it("web.search returns mocked xAI results, and an error, to the model", async () => {
		const { app } = await boot();
		egress.xai.script.push(
			{ tool: { name: "web.search", arguments: { query: "pi-bot docs" } } },
			{ text: "searched" },
		);
		egress.telegram.push("search the web");
		await until(() => egress.telegram.texts().includes("searched"), "searched");
		await settle(app, egress);
		expect(egress.webCalls.map((call) => call.path)).toEqual([
			"/v1/web/search",
		]);
		expect(egress.webCalls[0]?.authorization).toBe("Bearer test-api-key");
		expect(egress.webCalls[0]?.body).toEqual({ query: "pi-bot docs" });
		expect(followUp()).toContain("pi-bot docs");
		expect(followUp()).toContain("https://example.com");
		egress.failWebSearch = true;
		egress.xai.script.push(
			{ tool: { name: "web.search", arguments: { query: "again" } } },
			{ text: "failed" },
		);
		egress.telegram.push("search again");
		await until(() => egress.telegram.texts().includes("failed"), "failed");
		await settle(app, egress);
		expect(followUp()).toContain("search down");
		const errored = (await toolResults(app)).filter(
			(result) =>
				result.name === "web.search" && result.text.includes("search down"),
		);
		expect(errored).toEqual([
			expect.objectContaining({ name: "web.search", isError: true }),
		]);
		expect(egress.telegram.texts().at(-1)).toBe("failed");
	});

	it("web.fetch returns mocked page text, and an error, to the model", async () => {
		const { app } = await boot();
		egress.xai.script.push(
			{
				tool: {
					name: "web.fetch",
					arguments: { url: "https://example.com/note" },
				},
			},
			{ text: "fetched" },
		);
		egress.telegram.push("open that page");
		await until(() => egress.telegram.texts().includes("fetched"), "fetched");
		await settle(app, egress);
		expect(egress.webCalls.map((call) => call.path)).toEqual(["/v1/web/fetch"]);
		expect(egress.webCalls[0]?.body).toEqual({
			url: "https://example.com/note",
		});
		expect(followUp()).toContain("fetched-body");
		egress.failWebFetch = true;
		egress.xai.script.push(
			{
				tool: {
					name: "web.fetch",
					arguments: { url: "https://example.com/missing" },
				},
			},
			{ text: "fetch failed" },
		);
		egress.telegram.push("open the missing page");
		await until(
			() => egress.telegram.texts().includes("fetch failed"),
			"fetch failed",
		);
		await settle(app, egress);
		expect(followUp()).toContain("fetch down");
		const errored = (await toolResults(app)).filter(
			(result) =>
				result.name === "web.fetch" && result.text.includes("fetch down"),
		);
		expect(errored).toEqual([
			expect.objectContaining({ name: "web.fetch", isError: true }),
		]);
		expect(egress.telegram.texts().at(-1)).toBe("fetch failed");
	});

	it("GET /api/tools lists every registered tool", async () => {
		const { url } = await boot();
		const body = await json<{ catalog: { name: string; group: string }[] }>(
			url,
			"/api/tools",
		);
		const names = body.catalog.map((tool) => tool.name);
		expect(names).toEqual([
			"read",
			"write",
			"edit",
			"schedule_create",
			"schedule_list",
			"schedule_update",
			"schedule_delete",
			"web.search",
			"web.fetch",
		]);
	});
});
