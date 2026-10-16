// Web page and API through the real main(). Only egress is faked.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { App } from "../../src/app.ts";
import { listChats } from "../../src/channels/telegram/chats.ts";
import { resetTestClock, setTestClock } from "../../src/clock.ts";
import { CHAT, FakeEgress } from "../egress/fake-egress.ts";
import { routeEgress } from "../egress/route.ts";
import {
	defined,
	seedBot,
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

async function boot(
	home?: string,
	overrides: Record<string, string | undefined> = {},
	options: { seed?: boolean } = {},
) {
	const dir = home ?? (await tempHome());
	if (options.seed !== false) await seedBot(dir);
	const app = await startBot(dir, {
		WEB_TOKEN: TOKEN,
		WEB_PORT: "0",
		...overrides,
	});
	apps.push(app);
	if (!app.web) throw new Error("web listener did not start");
	return { app, home: dir, url: app.web.url };
}

function auth(token = TOKEN): Record<string, string> {
	return { authorization: `Bearer ${token}` };
}

async function call(
	url: string,
	path: string,
	init: RequestInit = {},
	token = TOKEN,
): Promise<Response> {
	const headers = new Headers(init.headers);
	if (token) headers.set("authorization", `Bearer ${token}`);
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

type Item = { type: string; text?: string };

async function messages(url: string, key: string): Promise<Item[]> {
	const body = await json<{ messages: Item[] }>(
		url,
		`/api/chats/${encodeURIComponent(key)}/messages`,
	);
	return body.messages;
}

async function createWebChat(url: string, botId = "default"): Promise<string> {
	const body = await json<{ chat: { key: string } }>(
		url,
		`/api/bots/${botId}/chats`,
		{ method: "POST", body: "{}" },
	);
	return body.chat.key;
}

async function say(
	url: string,
	key: string,
	text: string,
	clientMsgId?: string,
): Promise<void> {
	const id = clientMsgId ?? crypto.randomUUID();
	const response = await call(
		url,
		`/api/chats/${encodeURIComponent(key)}/messages`,
		{
			method: "POST",
			body: JSON.stringify({ clientMsgId: id, text }),
		},
	);
	expect(response.status).toBe(200);
}

async function readStream(
	url: string,
	key: string,
	untilText: string,
): Promise<string> {
	const controller = new AbortController();
	const response = await fetch(
		`${url}/api/chats/${encodeURIComponent(key)}/events`,
		{
			headers: auth(),
			signal: controller.signal,
		},
	);
	expect(response.status).toBe(200);
	expect(response.headers.get("content-type")).toContain("text/event-stream");
	const reader = response.body?.getReader();
	if (!reader) throw new Error("no stream");
	const decoder = new TextDecoder();
	let buffer = "";
	let seen = "";
	const deadline = Date.now() + 15_000;
	try {
		while (Date.now() < deadline) {
			const { done, value } = await reader.read();
			if (value) {
				buffer += decoder.decode(value, { stream: true });
				seen += buffer;
				buffer = "";
			}
			if (seen.includes(untilText)) return seen;
			if (done) break;
		}
	} finally {
		controller.abort();
	}
	throw new Error(`stream did not include ${untilText}\n${seen}`);
}

describe("web channel", () => {
	it("rejects a missing or wrong token and serves status without secrets", async () => {
		const { url } = await boot();
		expect((await call(url, "/api/status", {}, "")).status).toBe(401);
		expect((await call(url, "/api/status", {}, "nope")).status).toBe(401);
		expect(
			(await fetch(`${url}/api/status`, { headers: { cookie: "token=nope" } }))
				.status,
		).toBe(401);
		expect((await fetch(`${url}/`, {})).status).toBe(401);

		const authed = await fetch(`${url}/api/status`, {
			headers: { cookie: `token=${TOKEN}` },
		});
		const body = await authed.json();
		expect(body).toEqual({ telegram: true });
		const encoded = JSON.stringify(body);
		expect(encoded).not.toContain(TOKEN);
		expect(encoded).not.toContain("123:test-token");
		expect(encoded).not.toContain("test-api-key");

		const door = await fetch(`${url}/?token=${TOKEN}`, { redirect: "manual" });
		expect(door.status).toBe(302);
		expect(door.headers.get("set-cookie")).toContain("HttpOnly");
		const page = await call(url, "/");
		const html = await page.text();
		expect(html).toContain("/app.js");
		expect(html).not.toContain("/dev/ui-version");
		const script = await call(url, "/app.js");
		const source = await script.text();
		expect(source).toContain("/help");
		expect(source).not.toContain('"/new"');
		// The composer runs in the browser. randomUUID is absent off localhost
		// on plain HTTP (the listener binds all interfaces). getRandomValues is not.
		expect(source).not.toContain("randomUUID");
		expect(source).toContain("getRandomValues");
	});

	it("rebuilds the page when a UI source changes", async () => {
		const { url } = await boot(undefined, { PI_BOT_DEV: "1" });
		const html = await (await call(url, "/")).text();
		expect(html).toContain("/dev/ui-version");
		const before = await (await call(url, "/dev/ui-version")).text();
		const scriptBefore = await (await call(url, "/app.js")).text();
		const ui = join(import.meta.dir, "../../src/channels/web/ui/main.tsx");
		const stamp = await stat(ui);
		await utimes(ui, stamp.atime, new Date());
		await until(
			async () =>
				(await (await call(url, "/dev/ui-version")).text()) !== before,
			"the web ui to rebuild",
		);
		expect(await (await call(url, "/app.js")).text()).toBe(scriptBefore);
	});

	it("runs the page with no general Telegram token and does not poll Telegram", async () => {
		const { app, url } = await boot(undefined, {
			TELEGRAM_BOT_TOKEN: undefined,
		});
		expect(await json<{ telegram: boolean }>(url, "/api/status")).toEqual({
			telegram: false,
		});
		const key = await createWebChat(url);
		const stream = readStream(url, key, "grok(1): hello");
		await say(url, key, "hello");
		expect(await stream).toContain("grok(1): hello");
		await app.quiesce();
		expect(egress.telegram.polls).toBe(0);
		expect(egress.telegram.sent).toEqual([]);
		expect(await (await call(url, "/app.js")).text()).toContain("/api/status");

		const door = egress.telegramFor("999:door-token");
		const saved = await call(url, "/api/bots/default/telegram", {
			method: "PUT",
			body: JSON.stringify({ token: "999:door-token" }),
		});
		expect(saved.status).toBe(200);
		door.push("from the door");
		await until(() => door.sent.length === 1, "the per-bot door to answer");
		await app.quiesce();
		expect(door.texts()).toEqual(["grok(1): from the door"]);
		expect(egress.telegram.polls).toBe(0);
		expect(egress.telegram.sent).toEqual([]);
	});

	it("streams one reply, and the same clientMsgId does not run again", async () => {
		const { app, url } = await boot();
		const key = await createWebChat(url);
		const stream = readStream(url, key, "grok(1): hello");
		await say(url, key, "hello", "same-id");
		expect(await stream).toContain("grok(1): hello");
		await app.quiesce();
		expect(egress.xai.requests).toHaveLength(1);
		expect(egress.telegram.sent).toEqual([]);

		await say(url, key, "hello", "same-id");
		await app.quiesce();
		expect(egress.xai.requests).toHaveLength(1);
		const transcript = await messages(url, key);
		expect(transcript.filter((item) => item.type === "user")).toHaveLength(1);
		const listed = await json<{
			chats: { key: string; opening?: string; preview?: string }[];
		}>(url, "/api/bots/default/chats");
		const row = listed.chats.find((chat) => chat.key === key);
		expect(row?.opening).toBe("hello");
		expect(row?.preview).toContain("hello");
	});

	it("/new starts a fresh context and /stop aborts the answer", async () => {
		const { app, url } = await boot();
		const key = await createWebChat(url);
		await say(url, key, "a");
		await until(() => egress.xai.requests.length === 1, "first reply");
		await say(url, key, "/new");
		await until(
			async () =>
				(await messages(url, key)).some((item) =>
					item.text?.includes("New conversation"),
				),
			"new notice",
		);
		await say(url, key, "c");
		await until(
			async () =>
				(await messages(url, key)).some((item) => item.text === "grok(1): c"),
			"fresh reply",
		);
		await app.quiesce();

		const formatted = await messages(url, key);
		expect(formatted.some((item) => item.type === "notice")).toBe(true);
		const raw = await json<{ entries: { kind: string; id: number }[] }>(
			url,
			`/api/chats/${encodeURIComponent(key)}/entries`,
		);
		const kinds = raw.entries.map((entry) => entry.kind);
		expect(kinds).toContain("pi.user");
		expect(kinds).toContain("pi.assistant");
		expect(kinds).toContain("pi.reset");
		expect(kinds).toContain("pi-bot.notice");
		expect(raw.entries.length).toBeGreaterThan(formatted.length);
		const missing = await call(url, "/api/chats/no-such/entries");
		expect(missing.status).toBe(404);

		egress.xai.hold();
		await say(url, key, "write me an essay");
		await until(() => egress.xai.requests.length === 3, "essay request");
		await say(url, key, "/stop");
		await until(
			async () =>
				(await messages(url, key)).some((item) =>
					item.text?.includes("Stopped"),
				),
			"stop notice",
		);
		egress.xai.release();
		await say(url, key, "next");
		await until(
			async () =>
				(await messages(url, key)).some((item) =>
					item.text?.endsWith(": next"),
				),
			"reply after stop",
		);
		await app.quiesce();
		expect(egress.telegram.sent).toEqual([]);
	});

	it("two bots with different SOUL.md files produce different prompts", async () => {
		const home = await tempHome();
		const { app, url } = await boot(home);
		const writer = await json<{ bot: { id: string } }>(url, "/api/bots", {
			method: "POST",
			body: JSON.stringify({
				name: "Writer",
				model: "xai/grok-4.7",
				thinking: "",
			}),
		});
		const reader = await json<{ bot: { id: string } }>(url, "/api/bots", {
			method: "POST",
			body: JSON.stringify({
				name: "Reader",
				model: "xai/grok-4.7",
				thinking: "",
			}),
		});
		expect(writer.bot.id).toBe("writer");
		expect(reader.bot.id).toBe("reader");
		const again = await json<{ bot: { id: string } }>(url, "/api/bots", {
			method: "POST",
			body: JSON.stringify({
				name: "Writer",
				model: "xai/grok-4.7",
				thinking: "low",
			}),
		});
		expect(again.bot.id).toBe("writer-2");
		await writeFile(join(home, "bots", "writer", "SOUL.md"), "SOUL-WRITER");
		await writeFile(join(home, "bots", "reader", "SOUL.md"), "SOUL-READER");
		const writerChat = await createWebChat(url, "writer");
		const readerChat = await createWebChat(url, "reader");
		await say(url, writerChat, "hi");
		await say(url, readerChat, "hi");
		await until(() => egress.xai.requests.length === 2, "both prompts");
		await app.quiesce();
		const bodies = egress.xai.requests.map((request) =>
			JSON.stringify(request.body),
		);
		expect(
			bodies.some(
				(body) => body.includes("SOUL-WRITER") && !body.includes("SOUL-READER"),
			),
		).toBe(true);
		expect(
			bodies.some(
				(body) => body.includes("SOUL-READER") && !body.includes("SOUL-WRITER"),
			),
		).toBe(true);
	});

	it("a web message into a Telegram chat sends one reply and shows it on the web", async () => {
		const { app, url } = await boot();
		egress.telegram.push("from telegram");
		await until(() => egress.telegram.sent.length === 1, "telegram reply");
		const key = `default:tg:general:${CHAT}`;
		await say(url, key, "from the web");
		await until(
			() => egress.telegram.sent.length === 2,
			"web-originated reply",
		);
		await settle(app, egress);
		expect(egress.telegram.texts()).toEqual([
			"grok(1): from telegram",
			"grok(2): from the web",
		]);
		const transcript = await messages(url, key);
		expect(
			transcript.some(
				(item) => item.type === "user" && item.text === "from the web",
			),
		).toBe(true);
		expect(
			transcript.some((item) => item.text === "grok(2): from the web"),
		).toBe(true);
		expect(egress.telegram.sent).toHaveLength(2);
	});

	it("telegram and web chats do not cross", async () => {
		const { app, url } = await boot();
		const key = await createWebChat(url);
		egress.telegram.push("from telegram");
		await say(url, key, "from the web");
		await until(
			() =>
				egress.telegram.sent.length === 1 && egress.xai.requests.length === 2,
			"both replies",
		);
		await settle(app, egress);
		expect(egress.telegram.texts()).toEqual(["grok(1): from telegram"]);
		const transcript = await messages(url, key);
		expect(
			transcript.some((item) => item.text === "grok(1): from the web"),
		).toBe(true);
		expect(
			transcript.some((item) => item.text?.includes("from telegram")),
		).toBe(false);
	});

	it("lists xai and faux models and stores a custom SOUL.md", async () => {
		const { url } = await boot();
		const catalog = await json<{
			providers: { id: string; models: string[] }[];
		}>(url, "/api/models");
		expect(catalog.providers.map((provider) => provider.id)).toEqual([
			"xai",
			"faux",
		]);
		expect(
			catalog.providers.find((provider) => provider.id === "xai")?.models,
		).toContain("grok-4.7");
		expect(
			catalog.providers.find((provider) => provider.id === "faux")?.models,
		).toEqual(["echo"]);
		const created = await json<{ bot: { id: string; tools?: string[] } }>(
			url,
			"/api/bots",
			{
				method: "POST",
				body: JSON.stringify({
					name: "Persona",
					model: "faux/echo",
					thinking: "low",
					tools: ["web.fetch"],
					soul: "CUSTOM SOUL\n",
				}),
			},
		);
		const soul = await json<{ text: string }>(
			url,
			`/api/bots/${created.bot.id}/files/SOUL.md`,
		);
		expect(soul.text).toBe("CUSTOM SOUL\n");
		const listed = await json<{ files: { path: string }[] }>(
			url,
			`/api/bots/${created.bot.id}/files`,
		);
		expect(listed.files.map((file) => file.path)).toContain("SOUL.md");
		expect(listed.files.map((file) => file.path)).toContain("MEMORY.md");
		expect(listed.files.map((file) => file.path)).not.toContain("SYSTEM.md");
		const memory = await json<{
			exists: boolean;
			version: number;
			body: string;
		}>(url, `/api/bots/${created.bot.id}/files/MEMORY.md`);
		expect(memory).toEqual({ exists: false, version: 0, body: "" });
		const written = await call(
			url,
			`/api/bots/${created.bot.id}/files/MEMORY.md`,
			{
				method: "PUT",
				body: JSON.stringify({ version: 0, body: "prefer short replies\n" }),
			},
		);
		expect(written.status).toBe(200);
		const stale = await call(
			url,
			`/api/bots/${created.bot.id}/files/MEMORY.md`,
			{
				method: "PUT",
				body: JSON.stringify({ version: 0, body: "nope\n" }),
			},
		);
		expect(stale.status).toBe(422);
		const system = await call(
			url,
			`/api/bots/${created.bot.id}/files/SYSTEM.md`,
		);
		expect(system.status).toBe(400);
		const patched = await call(url, `/api/bots/${created.bot.id}`, {
			method: "PATCH",
			body: JSON.stringify({
				name: "Persona renamed",
				model: "xai/grok-4.7",
				thinking: "high",
				tools: ["web.search"],
			}),
		});
		expect(patched.status).toBe(200);
		egress.telegramFor("123:persona");
		const door = await call(url, `/api/bots/${created.bot.id}/telegram`, {
			method: "PUT",
			body: JSON.stringify({ token: "123:persona" }),
		});
		expect(door.status).toBe(200);
		const bots = await json<{
			bots: {
				id: string;
				name: string;
				model: string;
				tools?: string[];
				telegramConfigured?: boolean;
				telegramToken?: string;
			}[];
		}>(url, "/api/bots");
		const bot = bots.bots.find((item) => item.id === created.bot.id);
		expect(bot?.name).toBe("Persona renamed");
		expect(bot?.model).toBe("xai/grok-4.7");
		expect(bot?.tools).toEqual(["web.search"]);
		expect(bot?.telegramConfigured).toBe(true);
		expect(bot?.telegramToken).toBeUndefined();
		const rejected = await call(url, "/api/bots", {
			method: "POST",
			body: JSON.stringify({
				name: "Files",
				model: "faux/echo",
				thinking: "off",
				tools: ["bash"],
			}),
		});
		expect(rejected.status).toBe(422);
	});

	it("patching a bot does not rewrite the conversation it already has", async () => {
		const { app, url } = await boot();
		const created = await json<{ bot: { id: string } }>(url, "/api/bots", {
			method: "POST",
			body: JSON.stringify({
				name: "Scribe",
				model: "xai/grok-4.7",
				thinking: "off",
				tools: ["web.search"],
			}),
		});
		const first = await createWebChat(url, created.bot.id);
		await say(url, first, "one");
		await until(() => egress.xai.requests.length === 1, "grok reply");
		const patched = await call(url, `/api/bots/${created.bot.id}`, {
			method: "PATCH",
			body: JSON.stringify({ model: "faux/echo" }),
		});
		expect(patched.status).toBe(200);
		await say(url, first, "two");
		await until(
			() => egress.xai.requests.length === 2,
			"old chat stays on grok",
		);
		const second = await createWebChat(url, created.bot.id);
		await say(url, second, "three");
		await until(
			async () =>
				(await messages(url, second)).some(
					(item) => item.text === "echo(1): three",
				),
			"new chat uses echo",
		);
		await app.quiesce();
		expect(egress.xai.requests).toHaveLength(2);

		const renamed = await call(url, "/api/bots/default", {
			method: "PATCH",
			body: JSON.stringify({ name: "Other" }),
		});
		expect(renamed.status).toBe(200);
		const bots = await json<{
			bots: { id: string; name: string; tools?: string[] }[];
		}>(url, "/api/bots");
		expect(bots.bots.find((bot) => bot.id === "default")?.name).toBe("Other");
		expect(bots.bots.find((bot) => bot.id === created.bot.id)?.tools).toEqual([
			"web.search",
		]);
	});

	it("rejects an unknown or unauthenticated model, and a faux bot answers offline", async () => {
		const { url, app } = await boot(
			undefined,
			{ XAI_API_KEY: undefined },
			{ seed: false },
		);
		const unknown = await call(url, "/api/bots", {
			method: "POST",
			body: JSON.stringify({
				name: "Nope",
				model: "xai/grok-0",
				thinking: "",
			}),
		});
		expect(unknown.status).toBe(422);
		expect(await unknown.text()).toMatch(/Unknown model/);
		const naked = await call(url, "/api/bots", {
			method: "POST",
			body: JSON.stringify({
				name: "Needs a key",
				model: "xai/grok-4.7",
				thinking: "",
			}),
		});
		expect(naked.status).toBe(422);
		expect(await naked.text()).toMatch(/XAI_API_KEY/);
		const created = await json<{ bot: { id: string } }>(url, "/api/bots", {
			method: "POST",
			body: JSON.stringify({
				name: "Echo",
				model: "faux/echo",
				thinking: "",
			}),
		});
		const key = await createWebChat(url, created.bot.id);
		await say(url, key, "ping");
		await until(
			async () =>
				(await messages(url, key)).some(
					(item) => item.text === "echo(1): ping",
				),
			"echo reply",
		);
		await app.quiesce();
		expect(egress.xai.requests).toEqual([]);
	});

	it("keeps bots, chats, and transcripts across a restart", async () => {
		const home = await tempHome();
		const first = await boot(home);
		const created = await json<{ bot: { id: string } }>(
			first.url,
			"/api/bots",
			{
				method: "POST",
				body: JSON.stringify({
					name: "Keeper",
					model: "xai/grok-4.7",
					thinking: "",
				}),
			},
		);
		const key = await createWebChat(first.url, created.bot.id);
		await say(first.url, key, "remember me");
		await until(() => egress.xai.requests.length === 1, "reply");
		await first.app.quiesce();
		await first.app.stop();

		const second = await boot(home);
		const bots = await json<{ bots: { id: string }[] }>(
			second.url,
			"/api/bots",
		);
		expect(bots.bots.map((bot) => bot.id)).toContain("keeper");
		const chats = await json<{ chats: { key: string }[] }>(
			second.url,
			"/api/bots/keeper/chats",
		);
		expect(chats.chats.map((chat) => chat.key)).toContain(key);
		const transcript = await messages(second.url, key);
		expect(transcript.some((item) => item.text === "remember me")).toBe(true);
		expect(
			transcript.some((item) => item.text === "grok(1): remember me"),
		).toBe(true);
		await second.app.quiesce();
	});

	it("serves the knowledge editor, schedules, harvest row, and the mobile layout", async () => {
		const { url } = await boot();
		const script = await (await call(url, "/app.js")).text();
		expect(script).toContain("Knowledge updated");
		expect(script).toContain("Can't save");
		expect(script).toContain("Description");
		expect(script).toContain("Version");
		expect(script).toContain("Run now");
		expect(script).toContain("New schedule");
		expect(script).toContain("/status");
		const css = await (await call(url, "/app.css")).text();
		expect(css).toContain("max-width: 700px");
	});

	it("reads and writes knowledge as structured fields, hiding frontmatter", async () => {
		const home = await tempHome();
		const { url } = await boot(home);
		const dir = join(home, "bots", "default", "knowledge");
		await mkdir(dir, { recursive: true });
		const original =
			"---\ndescription: Travel notes.\ncategory: trips\nversion: 2\n---\n\nkeep me\n";
		await writeFile(join(dir, "travel.md"), original);
		const raw = await call(url, "/api/bots/default/files/knowledge/travel.md", {
			method: "PUT",
			body: JSON.stringify({ text: original }),
		});
		expect(raw.status).toBe(400);
		const got = await json<{
			slug: string;
			version: number;
			description: string;
			category?: string;
			body: string;
			text?: string;
		}>(url, "/api/bots/default/files/knowledge/travel.md");
		expect(got).toMatchObject({
			slug: "travel",
			exists: true,
			version: 2,
			description: "Travel notes.",
			category: "trips",
			body: "\nkeep me\n",
		});
		expect(got.text).toBeUndefined();
		expect(JSON.stringify(got)).not.toContain("---");
		const tooLong = await call(
			url,
			"/api/bots/default/files/knowledge/travel.md",
			{
				method: "PUT",
				body: JSON.stringify({
					description: "x".repeat(241),
					body: "changed\n",
					version: 2,
				}),
			},
		);
		expect(tooLong.status).toBe(422);
		expect(await readFile(join(dir, "travel.md"), "utf8")).toBe(original);
		const fenced = await call(
			url,
			"/api/bots/default/files/knowledge/travel.md",
			{
				method: "PUT",
				body: JSON.stringify({
					description: "Travel notes.",
					body: "---\nchanged\n",
					version: 2,
				}),
			},
		);
		expect(fenced.status).toBe(422);
		expect(await fenced.json()).toMatchObject({
			error: expect.stringContaining("frontmatter"),
		});
		expect(await readFile(join(dir, "travel.md"), "utf8")).toBe(original);
		const stale = await call(
			url,
			"/api/bots/default/files/knowledge/travel.md",
			{
				method: "PUT",
				body: JSON.stringify({
					description: "Travel notes.",
					body: "stale\n",
					version: 1,
				}),
			},
		);
		expect(stale.status).toBe(422);
		expect(await readFile(join(dir, "travel.md"), "utf8")).toBe(original);
		const saved = await json<{
			slug: string;
			version: number;
			description: string;
			category?: string;
			body: string;
			created: boolean;
		}>(url, "/api/bots/default/files/knowledge/travel.md", {
			method: "PUT",
			body: JSON.stringify({
				description: "Updated travel notes.",
				body: "Lisbon in May.\n",
				version: 2,
				category: "trips",
			}),
		});
		expect(saved).toMatchObject({
			slug: "travel",
			version: 3,
			description: "Updated travel notes.",
			category: "trips",
			body: "Lisbon in May.\n",
			created: false,
		});
		expect(await readFile(join(dir, "travel.md"), "utf8")).toBe(
			"---\ndescription: Updated travel notes.\ncategory: trips\nversion: 3\n---\nLisbon in May.\n",
		);
		const escaped = await call(url, "/api/bots/default/files/..%2Fsecret.txt", {
			method: "PUT",
			body: JSON.stringify({ text: "nope" }),
		});
		expect(escaped.status).toBe(400);
		expect(await readFile(join(dir, "travel.md"), "utf8")).toBe(
			"---\ndescription: Updated travel notes.\ncategory: trips\nversion: 3\n---\nLisbon in May.\n",
		);
	});

	it("fires a past reminder once, hides harvest rows, and rejects a bad cron", async () => {
		const { app, url } = await boot(undefined, {
			PI_BOT_HARVEST_DELAY_MS: "60000",
		});
		egress.telegram.push("hi");
		await until(() => egress.telegram.sent.length === 1, "the greeting reply");
		await settle(app, egress);
		const key = `default:tg:general:${CHAT}`;
		const created = await call(url, "/api/bots/default/schedules", {
			method: "POST",
			body: JSON.stringify({
				text: "remind the plumber",
				kind: "when",
				when: Date.now() - 1000,
				target: { mode: "chat", chatId: key },
			}),
		});
		expect(created.status).toBe(201);
		await until(
			() =>
				egress.telegram
					.texts()
					.some((text) => text.includes("remind the plumber")),
			"the reminder",
		);
		await settle(app, egress);
		expect(
			egress.telegram
				.texts()
				.filter((text) => text.includes("remind the plumber")),
		).toHaveLength(1);
		const listed = await json<{ schedules: { id: string }[] }>(
			url,
			"/api/bots/default/schedules",
		);
		expect(listed.schedules.some((row) => row.id.startsWith("harvest:"))).toBe(
			false,
		);
		const bad = await call(url, "/api/bots/default/schedules", {
			method: "POST",
			body: JSON.stringify({
				text: "never",
				kind: "cron",
				cron: "not a cron",
				target: { mode: "new-chat" },
			}),
		});
		expect(bad.status).toBe(422);
		const after = await json<{ schedules: { id: string }[] }>(
			url,
			"/api/bots/default/schedules",
		);
		expect(after.schedules.map((row) => row.id)).toEqual(
			listed.schedules.map((row) => row.id),
		);
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(
			egress.telegram
				.texts()
				.filter((text) => text.includes("remind the plumber")),
		).toHaveLength(1);
	});

	it("leaves a paused schedule off the clock and lets put rename or re-enable it", async () => {
		let clock = Date.parse("2026-06-01T09:00:00.000Z");
		setTestClock(() => clock);
		const { app, url } = await boot(undefined, {
			PI_BOT_HARVEST_DELAY_MS: "86400000",
		});
		egress.telegram.push("hi");
		await until(() => egress.telegram.sent.length === 1, "the greeting reply");
		await settle(app, egress);
		const key = `default:tg:general:${CHAT}`;
		const target = { mode: "chat", chatId: key };
		const pausedWhen = clock + 1_000;
		const liveWhen = clock + 5_000;
		const paused = await json<{
			schedule: { id: string; name?: string; enabled?: boolean; text: string };
		}>(url, "/api/bots/default/schedules", {
			method: "POST",
			body: JSON.stringify({
				text: "paused ping",
				name: "Soon",
				enabled: false,
				kind: "when",
				when: pausedWhen,
				target,
			}),
		});
		expect(paused.schedule.name).toBe("Soon");
		expect(paused.schedule.enabled).toBe(false);
		const kept = await json<{
			schedule: { name?: string; enabled?: boolean; text: string };
		}>(url, `/api/schedules/${paused.schedule.id}`, {
			method: "PUT",
			body: JSON.stringify({
				text: "paused ping",
				kind: "when",
				when: pausedWhen,
				target,
			}),
		});
		expect(kept.schedule.name).toBe("Soon");
		expect(kept.schedule.enabled).toBe(false);
		expect(kept.schedule.text).toBe("paused ping");
		await json(url, "/api/bots/default/schedules", {
			method: "POST",
			body: JSON.stringify({
				text: "live ping",
				kind: "when",
				when: liveWhen,
				target,
			}),
		});
		clock = pausedWhen + 1;
		await waitTestClockTicks();
		await app.quiesce();
		expect(
			egress.telegram.texts().some((text) => text.includes("paused ping")),
		).toBe(false);
		expect(
			egress.telegram.texts().some((text) => text.includes("live ping")),
		).toBe(false);
		clock = liveWhen;
		await until(
			() => egress.telegram.texts().some((text) => text.includes("live ping")),
			"the enabled schedule",
		);
		const resumed = await json<{
			schedule: { name?: string; enabled?: boolean; text: string };
		}>(url, `/api/schedules/${paused.schedule.id}`, {
			method: "PUT",
			body: JSON.stringify({
				text: "paused ping",
				name: "",
				enabled: true,
				kind: "when",
				when: pausedWhen,
				target,
			}),
		});
		expect(resumed.schedule.name).toBeUndefined();
		expect(resumed.schedule.enabled).toBeUndefined();
		await until(
			() =>
				egress.telegram.texts().some((text) => text.includes("paused ping")),
			"the re-enabled schedule",
		);
		await settle(app, egress);
	});

	it("records one harvest note that later model requests do not see", async () => {
		const { app, url } = await boot(undefined, {
			PI_BOT_HARVEST_DELAY_MS: "300",
		});
		const key = await createWebChat(url);
		egress.xai.script.push({ text: "noted" });
		egress.xai.script.push(
			{ tool: { name: "knowledge_read", arguments: { slug: "notes" } } },
			{
				tool: {
					name: "knowledge_update",
					arguments: {
						slug: "notes",
						description: "Harvested notes.",
						body: "HARVEST_BODY_LINE\n",
						version: 0,
					},
				},
			},
			{ text: "filed" },
		);
		const stream = readStream(url, key, "event: harvest");
		await say(url, key, "hello harvest");
		const seen = await stream;
		expect(seen).toContain("HARVEST_BODY_LINE");
		expect(egress.telegram.sent).toEqual([]);
		await app.quiesce();
		const before = egress.xai.requests.length;
		await say(url, key, "what changed?");
		await until(() => egress.xai.requests.length > before, "the follow-up");
		await app.quiesce();
		const follow = egress.xai.requests.find((request) =>
			JSON.stringify(request.body).includes("what changed?"),
		);
		expect(follow).toBeDefined();
		const body = JSON.stringify(defined(follow, "follow-up").body);
		expect(body).not.toContain("HARVEST_BODY_LINE");
		expect(body).not.toContain("Improve knowledge from this chat.");
		const harvestRequest = egress.xai.requests.find((request) =>
			JSON.stringify(request.body).includes(
				"Improve knowledge from this chat.",
			),
		);
		const harvestJson = JSON.stringify(
			defined(harvestRequest, "harvest request").body,
		);
		expect(harvestJson).toContain("Skip local answers");
		expect(harvestJson).toContain("code.execute");
		expect(harvestJson).toContain("If nothing qualifies, make no writes");
		const harvestBody = harvestJson.replaceAll(" ", "");
		expect(harvestBody).toContain('"name":"knowledge_read"');
		expect(harvestBody).toContain('"name":"knowledge_update"');
		expect(harvestBody).toContain('"name":"memory_read"');
		expect(harvestBody).toContain('"name":"memory_update"');
		expect(harvestBody).not.toContain('"name":"schedule_create"');
		expect(harvestBody).not.toContain('"name":"web.search"');
		expect(harvestBody).not.toContain('"name":"read"');
		expect(harvestBody).not.toContain('"name":"write"');
		const transcript = await messages(url, key);
		expect(transcript.some((item) => item.type === "harvest")).toBe(true);
		expect(
			transcript.some(
				(item) =>
					item.type === "user" &&
					item.text === "Improve knowledge from this chat.",
			),
		).toBe(false);
	});

	it("records a harvest note when harvest writes MEMORY.md", async () => {
		const { app, url, home } = await boot(undefined, {
			PI_BOT_HARVEST_DELAY_MS: "300",
		});
		const key = await createWebChat(url);
		egress.xai.script.push({ text: "noted" });
		egress.xai.script.push(
			{ tool: { name: "memory_read", arguments: {} } },
			{
				tool: {
					name: "memory_update",
					arguments: { version: 0, body: "prefer emo voice\n" },
				},
			},
			{ text: "filed" },
		);
		const stream = readStream(url, key, "event: harvest");
		await say(url, key, "talk like an emo from now on");
		const seen = await stream;
		expect(seen).toContain("prefer emo voice");
		expect(
			await readFile(join(home, "bots", "default", "MEMORY.md"), "utf8"),
		).toBe("---\nversion: 1\n---\nprefer emo voice\n");
		await app.quiesce();
		const before = egress.xai.requests.length;
		await say(url, key, "hello again");
		await until(() => egress.xai.requests.length > before, "the follow-up");
		await app.quiesce();
		const follow = egress.xai.requests.find((request) =>
			JSON.stringify(request.body).includes("hello again"),
		);
		const body = JSON.stringify(defined(follow, "follow-up").body);
		expect(body).toContain("prefer emo voice");
		expect(body).not.toContain("version: 1");
	});

	it("does not fork the same idle point again after a restart", async () => {
		const home = await tempHome();
		const first = await boot(home, { PI_BOT_HARVEST_DELAY_MS: "200" });
		const key = await createWebChat(first.url);
		egress.xai.script.push({ text: "ok" });
		egress.xai.script.push(
			{ tool: { name: "knowledge_read", arguments: { slug: "notes" } } },
			{
				tool: {
					name: "knowledge_update",
					arguments: {
						slug: "notes",
						description: "Kept.",
						body: "HARVEST_BODY_LINE\n",
						version: 0,
					},
				},
			},
			{ text: "done" },
		);
		await say(first.url, key, "settle once");
		await until(
			() =>
				egress.xai.requests.some((request) =>
					JSON.stringify(request.body).includes(
						"Improve knowledge from this chat.",
					),
				),
			"the harvest turn",
		);
		await first.app.quiesce();
		const count = egress.xai.requests.length;
		await first.app.stop();

		const second = await boot(home, { PI_BOT_HARVEST_DELAY_MS: "200" });
		await new Promise((resolve) => setTimeout(resolve, 300));
		await second.app.quiesce();
		const extra = egress.xai.requests.slice(count);
		expect(
			extra.some((request) =>
				JSON.stringify(request.body).includes(
					"Improve knowledge from this chat.",
				),
			),
		).toBe(false);
	});

	it("fires a when reminder after a restart", async () => {
		const home = await tempHome();
		const first = await boot(home, { PI_BOT_HARVEST_DELAY_MS: "86400000" });
		egress.telegram.push("hi");
		await until(() => egress.telegram.sent.length === 1, "the greeting reply");
		await settle(first.app, egress);
		const key = `default:tg:general:${CHAT}`;
		const when = Date.now() + 800;
		const created = await call(first.url, "/api/bots/default/schedules", {
			method: "POST",
			body: JSON.stringify({
				text: "remind after restart",
				kind: "when",
				when,
				target: { mode: "chat", chatId: key },
			}),
		});
		expect(created.status).toBe(201);
		await first.app.stop();

		const second = await boot(home, { PI_BOT_HARVEST_DELAY_MS: "86400000" });
		await until(
			() =>
				egress.telegram
					.texts()
					.some((text) => text.includes("remind after restart")),
			"the reminder after restart",
		);
		await settle(second.app, egress);
		expect(
			egress.telegram
				.texts()
				.filter((text) => text.includes("remind after restart")),
		).toHaveLength(1);
	}, 15_000);

	it("fires a cron reminder after a restart", async () => {
		let clock = Date.parse("2026-06-01T09:00:00.000Z");
		setTestClock(() => clock);
		const home = await tempHome();
		const first = await boot(home, {
			PI_BOT_HARVEST_DELAY_MS: "86400000",
			PI_BOT_TZ: "UTC",
		});
		egress.telegram.push("hi");
		await until(() => egress.telegram.sent.length === 1, "the greeting reply");
		await settle(first.app, egress);
		const key = `default:tg:general:${CHAT}`;
		const created = await call(first.url, "/api/bots/default/schedules", {
			method: "POST",
			body: JSON.stringify({
				text: "cron after restart",
				kind: "cron",
				cron: "1 9 * * *",
				target: { mode: "chat", chatId: key },
			}),
		});
		expect(created.status).toBe(201);
		await first.app.stop();

		const second = await boot(home, {
			PI_BOT_HARVEST_DELAY_MS: "86400000",
			PI_BOT_TZ: "UTC",
		});
		clock = Date.parse("2026-06-01T09:01:00.000Z");
		await until(
			() =>
				egress.telegram
					.texts()
					.some((text) => text.includes("cron after restart")),
			"the cron after restart",
		);
		await settle(second.app, egress);
		expect(
			egress.telegram
				.texts()
				.filter((text) => text.includes("cron after restart")),
		).toHaveLength(1);
	});

	it("fires a pending harvest after a restart", async () => {
		resetTestClock();
		const home = await tempHome();
		const first = await boot(home, { PI_BOT_HARVEST_DELAY_MS: "400" });
		const key = await createWebChat(first.url);
		egress.xai.script.push({ text: "ok" });
		egress.xai.script.push(
			{ tool: { name: "knowledge_read", arguments: { slug: "notes" } } },
			{
				tool: {
					name: "knowledge_update",
					arguments: {
						slug: "notes",
						description: "Kept.",
						body: "HARVEST_AFTER_RESTART\n",
						version: 0,
					},
				},
			},
			{ text: "done" },
		);
		await say(first.url, key, "settle once");
		await first.app.quiesce();
		expect(
			egress.xai.requests.some((request) =>
				JSON.stringify(request.body).includes(
					"Improve knowledge from this chat.",
				),
			),
		).toBe(false);
		await first.app.stop();

		const second = await boot(home, { PI_BOT_HARVEST_DELAY_MS: "400" });
		await until(
			() =>
				egress.xai.requests.some((request) =>
					JSON.stringify(request.body).includes(
						"Improve knowledge from this chat.",
					),
				),
			"the harvest after restart",
		);
		await second.app.quiesce();
		expect(
			egress.xai.requests.some((request) =>
				JSON.stringify(request.body).includes(
					"Improve knowledge from this chat.",
				),
			),
		).toBe(true);
		const transcript = await messages(second.url, key);
		expect(transcript.some((item) => item.type === "harvest")).toBe(true);
	}, 15_000);

	it("admits the general token and a bot token as separate chats without leaking the token", async () => {
		const { app, url } = await boot();
		const saved = await call(url, "/api/bots/default/telegram", {
			method: "PUT",
			body: JSON.stringify({ token: "999:door-token" }),
		});
		expect(saved.status).toBe(200);
		expect(await saved.json()).toEqual({ telegramConfigured: true });
		const bots = await json<{
			bots: { id: string; telegramConfigured?: boolean }[];
		}>(url, "/api/bots");
		const encoded = JSON.stringify(bots);
		expect(encoded).not.toContain("999:door-token");
		expect(encoded).not.toContain("telegramToken");
		expect(
			bots.bots.find((bot) => bot.id === "default")?.telegramConfigured,
		).toBe(true);

		const door = egress.telegramFor("999:door-token");
		door.push("from the door");
		egress.telegram.push("from general");
		await until(
			() => door.sent.length === 1 && egress.telegram.sent.length === 1,
			"both doors to answer",
		);
		await settle(app, egress);
		const chats = await json<{ chats: { key: string }[] }>(
			url,
			"/api/bots/default/chats",
		);
		const keys = chats.chats.map((chat) => chat.key);
		expect(keys).toContain(`default:tg:general:${CHAT}`);
		expect(keys).toContain(`default:tg:bot:${CHAT}`);
		expect(door.texts()).toEqual(["grok(1): from the door"]);
		expect(egress.telegram.texts()).toEqual(["grok(1): from general"]);
	});

	it("keeps a renamed chat across restart and refuses a deleted one", async () => {
		const home = await tempHome();
		const first = await boot(home);
		const key = await createWebChat(first.url);
		await say(first.url, key, "keep this");
		await until(() => egress.xai.requests.length === 1, "the reply");
		await first.app.quiesce();
		const renamed = await call(
			first.url,
			`/api/chats/${encodeURIComponent(key)}`,
			{
				method: "PATCH",
				body: JSON.stringify({ title: "Lisbon" }),
			},
		);
		expect(renamed.status).toBe(200);
		await first.app.stop();

		const second = await boot(home);
		const chats = await json<{ chats: { key: string; title?: string }[] }>(
			second.url,
			"/api/bots/default/chats",
		);
		expect(chats.chats.find((chat) => chat.key === key)?.title).toBe("Lisbon");
		const conversationId = (await listChats(second.app.harness)).find(
			(chat) => chat.key === key,
		)?.conversationId;
		expect(conversationId).toBeDefined();
		const removed = await call(
			second.url,
			`/api/chats/${encodeURIComponent(key)}`,
			{ method: "DELETE" },
		);
		expect(removed.status).toBe(200);
		const rejected = await call(
			second.url,
			`/api/chats/${encodeURIComponent(key)}/messages`,
			{
				method: "POST",
				body: JSON.stringify({ clientMsgId: "again", text: "still there?" }),
			},
		);
		expect(rejected.status).toBe(404);
		const reopened = await call(second.url, "/api/bots/default/chats", {
			method: "POST",
			body: JSON.stringify({ chatId: key.slice("default:web:".length) }),
		});
		expect(reopened.status).toBe(404);
		const conversation = await second.app.harness.conversation(
			defined(conversationId, "conversation"),
			BACKGROUND_CONTEXT,
		);
		const page = await defined(conversation, "conversation").entries(
			{ order: "ascending" },
			20,
			undefined,
			BACKGROUND_CONTEXT,
		);
		expect(
			page.items.some((entry) => JSON.stringify(entry).includes("keep this")),
		).toBe(true);
		await second.app.quiesce();
	});
});
