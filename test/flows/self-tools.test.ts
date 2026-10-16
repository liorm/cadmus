// Model self tools through the real main(). Only egress is faked.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { join } from "node:path";
import type { App } from "../../src/app.ts";
import { CHAT, FakeEgress } from "../egress/fake-egress.ts";
import { routeEgress } from "../egress/route.ts";
import {
	defined,
	seedBot,
	settle,
	startBot,
	tempHome,
	until,
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
	egress.xai.release();
	for (const app of apps) await app.stop();
	apps = [];
	unroute();
	egress.stop();
});

async function boot(home: string) {
	await seedBot(home);
	const app = await startBot(home, { WEB_TOKEN: TOKEN, WEB_PORT: "0" });
	apps.push(app);
	if (!app.web) throw new Error("web listener did not start");
	return { app, url: app.web.url };
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

type Listed = {
	id: string;
	kind?: string;
	text: string;
	name?: string;
	cron?: string;
	when?: number;
	target: { mode: string; chatId?: string };
};

async function listed(url: string, botId = "default"): Promise<Listed[]> {
	const body = await json<{ schedules: Listed[] }>(
		url,
		`/api/bots/${botId}/schedules`,
	);
	return body.schedules;
}

function rows(home: string): { id: string; bot_id: string }[] {
	const db = new Database(join(home, "schedules.sqlite"), { readonly: true });
	try {
		return db
			.query<{ id: string; bot_id: string }, []>(
				"SELECT id, bot_id FROM schedules ORDER BY id",
			)
			.all();
	} finally {
		db.close();
	}
}

const xai = () => egress.xai;

describe("self tools", () => {
	it("creates a schedule the page lists, and the row survives a restart", async () => {
		const home = await tempHome();
		const first = await boot(home);
		xai().script.push(
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
		await settle(first.app, egress);
		const offered = JSON.stringify(defined(xai().requests[0], "request").body);
		expect(offered).toContain("schedule_create");
		expect(offered).toContain("schedule_list");
		expect(offered).toContain("schedule_update");
		expect(offered).toContain("schedule_delete");
		const before = await listed(first.url);
		expect(before).toEqual([
			expect.objectContaining({
				text: "Morning check",
				cron: "0 9 * * *",
				target: { mode: "chat", chatId: `default:tg:general:${CHAT}` },
			}),
		]);
		expect(before.some((row) => row.id.startsWith("harvest:"))).toBe(false);
		await first.app.stop();

		const second = await boot(home);
		const after = await listed(second.url);
		expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
		xai().script.push(
			{
				tool: {
					name: "schedule_delete",
					arguments: { id: defined(after[0], "schedule").id },
				},
			},
			{ text: "removed" },
		);
		egress.telegram.push("drop that reminder");
		await until(() => egress.telegram.texts().includes("removed"), "deleted");
		await settle(second.app, egress);
		expect(await listed(second.url)).toEqual([]);
	});

	it("hides other bots' schedules and refuses their chats", async () => {
		const home = await tempHome();
		const { app, url } = await boot(home);
		const created = await json<{ bot: { id: string } }>(url, "/api/bots", {
			method: "POST",
			body: JSON.stringify({
				name: "Persona",
				model: "faux/echo",
				thinking: "",
			}),
		});
		const otherKey = (
			await json<{ chat: { key: string } }>(
				url,
				`/api/bots/${created.bot.id}/chats`,
				{ method: "POST", body: "{}" },
			)
		).chat.key;
		await json(url, `/api/bots/${created.bot.id}/schedules`, {
			method: "POST",
			body: JSON.stringify({
				kind: "cron",
				cron: "15 8 * * *",
				text: "persona-only",
				target: { mode: "chat", chatId: otherKey },
			}),
		});
		xai().script.push(
			{ tool: { name: "schedule_list", arguments: {} } },
			{ text: "listed" },
		);
		egress.telegram.push("what is scheduled?");
		await until(() => egress.telegram.texts().includes("listed"), "list reply");
		await settle(app, egress);
		const listedBody = JSON.stringify(
			defined(xai().requests.at(-1), "request").body,
		);
		expect(listedBody).not.toContain("persona-only");
		const other = (await listed(url, created.bot.id))[0];
		expect(other?.text).toBe("persona-only");
		xai().script.push(
			{
				tool: {
					name: "schedule_delete",
					arguments: { id: defined(other, "other schedule").id },
				},
			},
			{
				tool: {
					name: "schedule_create",
					arguments: {
						text: "steal",
						cron: "0 10 * * *",
						chatId: otherKey,
					},
				},
			},
			{ text: "blocked" },
		);
		egress.telegram.push("take the other bot's schedule");
		await until(() => egress.telegram.texts().includes("blocked"), "blocked");
		await settle(app, egress);
		const follow = xai()
			.requests.slice(-2)
			.map((request) => JSON.stringify(request.body))
			.join("\n");
		expect(follow).toContain("No such schedule.");
		expect(follow).toContain("That chat is not on this bot.");
		expect((await listed(url, created.bot.id)).map((row) => row.text)).toEqual([
			"persona-only",
		]);
		expect(await listed(url)).toEqual([]);
	});

	it("updates this bot's schedule and refuses a harvest id or another bot", async () => {
		const home = await tempHome();
		const { app, url } = await boot(home);
		xai().script.push(
			{
				tool: {
					name: "schedule_create",
					arguments: { text: "Morning check", cron: "0 9 * * *" },
				},
			},
			{ text: "created" },
		);
		egress.telegram.push("remind me each morning");
		await until(() => egress.telegram.texts().includes("created"), "created");
		await settle(app, egress);
		const id = defined((await listed(url))[0], "schedule").id;
		const created = await json<{ bot: { id: string } }>(url, "/api/bots", {
			method: "POST",
			body: JSON.stringify({
				name: "Other",
				model: "faux/echo",
				thinking: "off",
			}),
		});
		const otherKey = (
			await json<{ chat: { key: string } }>(
				url,
				`/api/bots/${created.bot.id}/chats`,
				{ method: "POST", body: "{}" },
			)
		).chat.key;
		await json(url, `/api/bots/${created.bot.id}/schedules`, {
			method: "POST",
			body: JSON.stringify({
				kind: "cron",
				cron: "15 8 * * *",
				text: "persona-only",
				target: { mode: "chat", chatId: otherKey },
			}),
		});
		const otherId = defined((await listed(url, created.bot.id))[0], "other").id;
		xai().script.push(
			{
				tool: {
					name: "schedule_update",
					arguments: {
						id,
						text: "Evening check",
						cron: "30 18 * * *",
						name: "Evening",
						enabled: false,
					},
				},
			},
			{
				tool: {
					name: "schedule_update",
					arguments: { id: "harvest:default:tg:general:1", text: "nope" },
				},
			},
			{
				tool: {
					name: "schedule_update",
					arguments: { id: otherId, text: "stolen" },
				},
			},
			{ text: "updated" },
		);
		egress.telegram.push("move it to the evening and pause it");
		await until(() => egress.telegram.texts().includes("updated"), "updated");
		await settle(app, egress);
		const follow = xai()
			.requests.slice(2)
			.map((request) => JSON.stringify(request.body))
			.join("\n");
		expect(follow).toContain("Evening check");
		expect(follow).toContain("No such schedule.");
		const row = defined((await listed(url))[0], "updated row");
		expect(row).toEqual(
			expect.objectContaining({
				id,
				text: "Evening check",
				cron: "30 18 * * *",
				name: "Evening",
				enabled: false,
			}),
		);
		expect((await listed(url, created.bot.id))[0]?.text).toBe("persona-only");
		expect(rows(home).filter((item) => item.id === id)).toHaveLength(1);
	});

	it("rejects a bad cron and leaves the harvest job untouched", async () => {
		const home = await tempHome();
		const { app, url } = await boot(home);
		egress.telegram.push("hello");
		await until(
			() => egress.telegram.sent.length === 1,
			"a turn to arm harvest",
		);
		await settle(app, egress);
		const db = new Database(join(home, "schedules.sqlite"));
		db.run(
			`INSERT INTO schedules (id, bot_id, kind, cron, when_ms, next_run, text, target_json)
			 VALUES (?, 'default', 'when', NULL, 1, 9999999999999, 'secret-harvest', ?)`,
			["harvest:other-chat", JSON.stringify({ mode: "fork", chatId: "other" })],
		);
		db.close();
		xai().script.push(
			{
				tool: {
					name: "schedule_create",
					arguments: { text: "nope", cron: "tomorrow" },
				},
			},
			{
				tool: {
					name: "schedule_list",
					arguments: {},
				},
			},
			{
				tool: {
					name: "schedule_delete",
					arguments: { id: "harvest:other-chat" },
				},
			},
			{ text: "still hidden" },
		);
		egress.telegram.push("schedule something illegal");
		await until(
			() => egress.telegram.texts().includes("still hidden"),
			"the reply",
		);
		await settle(app, egress);
		const follow = xai()
			.requests.slice(1)
			.map((request) => JSON.stringify(request.body))
			.join("\n");
		expect(follow).toContain("Cron must be five fields.");
		expect(follow).not.toContain("secret-harvest");
		expect(follow).toContain("No such schedule.");
		expect(await listed(url)).toEqual([]);
		expect(rows(home).some((row) => row.id === "harvest:other-chat")).toBe(
			true,
		);
		expect(rows(home).some((row) => row.id.startsWith("u-"))).toBe(false);
	});

	it("creates a one-shot, a new chat, and a silent fork", async () => {
		const home = await tempHome();
		const { app, url } = await boot(home);
		const when = Date.parse("2026-11-02T15:04:00.000Z");
		xai().script.push(
			{
				tool: {
					name: "schedule_create",
					arguments: { text: "Once", when, target: "chat" },
				},
			},
			{
				tool: {
					name: "schedule_create",
					arguments: {
						text: "Open a chat",
						cron: "0 12 * * 1",
						target: "new-chat",
					},
				},
			},
			{
				tool: {
					name: "schedule_create",
					arguments: { text: "Quiet fork", cron: "30 7 * * *", target: "fork" },
				},
			},
			{ text: "three schedules" },
		);
		egress.telegram.push("schedule the three");
		await until(
			() => egress.telegram.texts().includes("three schedules"),
			"the reply",
		);
		await settle(app, egress);
		const follow = xai()
			.requests.slice(1)
			.map((request) => JSON.stringify(request.body))
			.join("\n");
		expect(follow).toContain("Once");
		expect(follow).toContain("Open a chat");
		expect(follow).toContain("Quiet fork");
		const body = await listed(url);
		const byText = new Map(body.map((row) => [row.text, row]));
		expect(byText.get("Once")).toEqual(
			expect.objectContaining({
				kind: "when",
				when,
				target: { mode: "chat", chatId: `default:tg:general:${CHAT}` },
			}),
		);
		expect(byText.get("Open a chat")).toEqual(
			expect.objectContaining({
				kind: "cron",
				cron: "0 12 * * 1",
				target: { mode: "new-chat" },
			}),
		);
		expect(byText.get("Quiet fork")).toEqual(
			expect.objectContaining({
				kind: "cron",
				cron: "30 7 * * *",
				target: { mode: "fork", chatId: `default:tg:general:${CHAT}` },
			}),
		);
		expect(body).toHaveLength(3);
	});

	it("offers only the tools this bot has switched on", async () => {
		const home = await tempHome();
		const { app, url } = await boot(home);
		const current = await json<{
			catalog: { name: string }[];
			enabled: string[];
		}>(url, "/api/bots/default/tools");
		expect(current.enabled).toEqual(current.catalog.map((tool) => tool.name));
		expect(current.enabled).toContain("schedule_update");
		const enabled = current.enabled.filter(
			(name) => name !== "schedule_create" && name !== "read",
		);
		const saved = await json<{ enabled: string[] }>(
			url,
			"/api/bots/default/tools",
			{
				method: "PUT",
				body: JSON.stringify({ enabled }),
			},
		);
		expect(saved.enabled).toEqual(enabled);
		xai().script.push(
			{
				tool: {
					name: "schedule_create",
					arguments: { text: "Nope", cron: "0 9 * * *" },
				},
			},
			{ tool: { name: "web.search", arguments: { query: "pi-bot" } } },
			{ text: "done" },
		);
		egress.telegram.push("search and schedule");
		await until(() => egress.telegram.texts().includes("done"), "the reply");
		await settle(app, egress);
		const bodies = xai().requests.map((request) =>
			JSON.stringify(request.body).replaceAll(" ", ""),
		);
		expect(bodies[0]).not.toContain('"name":"schedule_create"');
		expect(bodies[0]).not.toContain('"name":"read"');
		expect(bodies[0]).toContain('"type":"web_search"');
		expect(bodies[0]).not.toContain('"name":"web.search"');
		expect(bodies[0]).toContain('"name":"schedule_update"');
		const follow = bodies.slice(1).join("\n");
		expect(follow).toContain("Toolschedule_createisnotavailable");
		expect(follow).toContain("web.searchisnotavailableonprovider");
		expect(await listed(url)).toEqual([]);
		const unknown = await call(url, "/api/bots/default/tools", {
			method: "PUT",
			body: JSON.stringify({ enabled: ["bash"] }),
		});
		expect(unknown.status).toBe(422);
	});

	it("blocks a tool that was switched off after the turn admitted it", async () => {
		const home = await tempHome();
		const { app, url } = await boot(home);
		const current = await json<{ enabled: string[] }>(
			url,
			"/api/bots/default/tools",
		);
		xai().hold();
		xai().script.push(
			{
				tool: {
					name: "schedule_create",
					arguments: { text: "Nope", cron: "0 9 * * *" },
				},
			},
			{ text: "blocked" },
		);
		egress.telegram.push("schedule something");
		await until(() => xai().requests.length >= 1, "the admitted model request");
		const offered = JSON.stringify(defined(xai().requests[0], "request").body);
		expect(offered).toContain("schedule_create");
		await json(url, "/api/bots/default/tools", {
			method: "PUT",
			body: JSON.stringify({
				enabled: current.enabled.filter((name) => name !== "schedule_create"),
			}),
		});
		xai().release();
		await until(() => egress.telegram.texts().includes("blocked"), "the reply");
		await settle(app, egress);
		const follow = xai()
			.requests.slice(1)
			.map((request) => JSON.stringify(request.body))
			.join("\n");
		expect(follow).toContain("That tool is off for this bot.");
		expect(await listed(url)).toEqual([]);
	});

	it("clears a stored schedule name when schedule_update is given an empty name", async () => {
		const home = await tempHome();
		const { app, url } = await boot(home);
		xai().script.push(
			{
				tool: {
					name: "schedule_create",
					arguments: { text: "Morning check", cron: "0 9 * * *" },
				},
			},
			{ text: "created" },
		);
		egress.telegram.push("remind me each morning");
		await until(() => egress.telegram.texts().includes("created"), "created");
		await settle(app, egress);
		const id = defined((await listed(url))[0], "schedule").id;
		xai().script.push(
			{
				tool: {
					name: "schedule_update",
					arguments: { id, name: "Morning" },
				},
			},
			{
				tool: {
					name: "schedule_update",
					arguments: { id, name: "" },
				},
			},
			{ text: "cleared" },
		);
		egress.telegram.push("clear the name");
		await until(() => egress.telegram.texts().includes("cleared"), "cleared");
		await settle(app, egress);
		expect((await listed(url))[0]?.name).toBeUndefined();
		const db = new Database(join(home, "schedules.sqlite"), { readonly: true });
		try {
			const name = db
				.query<{ name: string | null }, [string]>(
					"SELECT name FROM schedules WHERE id = ?",
				)
				.get(id);
			expect(name?.name).toBeNull();
		} finally {
			db.close();
		}
	});
});
