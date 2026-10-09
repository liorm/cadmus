// Web page and API through the real main(). Only egress is faked.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { App } from "../../src/app.ts";
import { CHAT, FakeEgress } from "../egress/fake-egress.ts";
import { routeEgress } from "../egress/route.ts";
import { settle, startBot, tempHome, until } from "../support.ts";

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

async function boot(home?: string, overrides: Record<string, string | undefined> = {}) {
	const app = await startBot(home ?? (await tempHome()), { WEB_TOKEN: TOKEN, WEB_PORT: "0", ...overrides });
	apps.push(app);
	if (!app.web) throw new Error("web listener did not start");
	return { app, home: home ?? "", url: app.web.url };
}

function auth(token = TOKEN): Record<string, string> {
	return { authorization: `Bearer ${token}` };
}

async function call(url: string, path: string, init: RequestInit = {}, token = TOKEN): Promise<Response> {
	const headers = new Headers(init.headers);
	if (token) headers.set("authorization", `Bearer ${token}`);
	if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
	return fetch(`${url}${path}`, { ...init, headers });
}

async function json<T>(url: string, path: string, init?: RequestInit): Promise<T> {
	const response = await call(url, path, init);
	expect(response.status).toBeLessThan(400);
	return response.json() as Promise<T>;
}

type Item = { type: string; text?: string };

async function messages(url: string, key: string): Promise<Item[]> {
	const body = await json<{ messages: Item[] }>(url, `/api/chats/${encodeURIComponent(key)}/messages`);
	return body.messages;
}

async function createWebChat(url: string, botId = "default"): Promise<string> {
	const body = await json<{ chat: { key: string } }>(url, `/api/bots/${botId}/chats`, { method: "POST", body: "{}" });
	return body.chat.key;
}

async function say(url: string, key: string, text: string, clientMsgId?: string): Promise<void> {
	const id = clientMsgId ?? crypto.randomUUID();
	const response = await call(url, `/api/chats/${encodeURIComponent(key)}/messages`, {
		method: "POST",
		body: JSON.stringify({ clientMsgId: id, text }),
	});
	expect(response.status).toBe(200);
}

async function readStream(url: string, key: string, untilText: string): Promise<string> {
	const controller = new AbortController();
	const response = await fetch(`${url}/api/chats/${encodeURIComponent(key)}/events`, {
		headers: auth(),
		signal: controller.signal,
	});
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
		expect((await fetch(url + "/api/status", { headers: { cookie: "token=nope" } })).status).toBe(401);
		expect((await fetch(url + "/", {})).status).toBe(401);

		const authed = await fetch(url + "/api/status", { headers: { cookie: `token=${TOKEN}` } });
		const body = await authed.json();
		expect(body).toEqual({ model: "xai/grok-4.7", telegram: true });
		const encoded = JSON.stringify(body);
		expect(encoded).not.toContain(TOKEN);
		expect(encoded).not.toContain("123:test-token");
		expect(encoded).not.toContain("test-api-key");

		const door = await fetch(`${url}/?token=${TOKEN}`, { redirect: "manual" });
		expect(door.status).toBe(302);
		expect(door.headers.get("set-cookie")).toContain("HttpOnly");
		const page = await call(url, "/");
		expect(await page.text()).toContain("/app.js");
		const script = await call(url, "/app.js");
		expect(await script.text()).toContain("/new");
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
	});

	it("/new starts a fresh context and /stop aborts the answer", async () => {
		const { app, url } = await boot();
		const key = await createWebChat(url);
		await say(url, key, "a");
		await until(() => egress.xai.requests.length === 1, "first reply");
		await say(url, key, "/new");
		await until(async () => (await messages(url, key)).some((item) => item.text?.includes("New conversation")), "new notice");
		await say(url, key, "c");
		await until(async () => (await messages(url, key)).some((item) => item.text === "grok(1): c"), "fresh reply");
		await app.quiesce();

		egress.xai.hold();
		await say(url, key, "write me an essay");
		await until(() => egress.xai.requests.length === 3, "essay request");
		await say(url, key, "/stop");
		await until(async () => (await messages(url, key)).some((item) => item.text?.includes("Stopped")), "stop notice");
		egress.xai.release();
		await say(url, key, "next");
		await until(async () => (await messages(url, key)).some((item) => item.text?.endsWith(": next")), "reply after stop");
		await app.quiesce();
		expect(egress.telegram.sent).toEqual([]);
	});

	it("two bots with different SOUL.md files produce different prompts", async () => {
		const home = await tempHome();
		const { app, url } = await boot(home);
		const writer = await json<{ bot: { id: string } }>(url, "/api/bots", {
			method: "POST",
			body: JSON.stringify({ name: "Writer", model: "xai/grok-4.7", thinking: "" }),
		});
		const reader = await json<{ bot: { id: string } }>(url, "/api/bots", {
			method: "POST",
			body: JSON.stringify({ name: "Reader", model: "xai/grok-4.7", thinking: "" }),
		});
		expect(writer.bot.id).toBe("writer");
		expect(reader.bot.id).toBe("reader");
		const again = await json<{ bot: { id: string } }>(url, "/api/bots", {
			method: "POST",
			body: JSON.stringify({ name: "Writer", model: "xai/grok-4.7", thinking: "low" }),
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
		const bodies = egress.xai.requests.map((request) => JSON.stringify(request.body));
		expect(bodies.some((body) => body.includes("SOUL-WRITER") && !body.includes("SOUL-READER"))).toBe(true);
		expect(bodies.some((body) => body.includes("SOUL-READER") && !body.includes("SOUL-WRITER"))).toBe(true);
	});

	it("a web message into a Telegram chat sends one reply and shows it on the web", async () => {
		const { app, url } = await boot();
		egress.telegram.push("from telegram");
		await until(() => egress.telegram.sent.length === 1, "telegram reply");
		const key = `default:tg:general:${CHAT}`;
		await say(url, key, "from the web");
		await until(() => egress.telegram.sent.length === 2, "web-originated reply");
		await settle(app, egress);
		expect(egress.telegram.texts()).toEqual(["grok(1): from telegram", "grok(2): from the web"]);
		const transcript = await messages(url, key);
		expect(transcript.some((item) => item.type === "user" && item.text === "from the web")).toBe(true);
		expect(transcript.some((item) => item.text === "grok(2): from the web")).toBe(true);
		expect(egress.telegram.sent).toHaveLength(2);
	});

	it("telegram and web chats do not cross", async () => {
		const { app, url } = await boot();
		const key = await createWebChat(url);
		egress.telegram.push("from telegram");
		await say(url, key, "from the web");
		await until(() => egress.telegram.sent.length === 1 && egress.xai.requests.length === 2, "both replies");
		await settle(app, egress);
		expect(egress.telegram.texts()).toEqual(["grok(1): from telegram"]);
		const transcript = await messages(url, key);
		expect(transcript.some((item) => item.text === "grok(1): from the web")).toBe(true);
		expect(transcript.some((item) => item.text?.includes("from telegram"))).toBe(false);
	});

	it("patching a bot does not rewrite the conversation it already has", async () => {
		const { app, url } = await boot();
		const created = await json<{ bot: { id: string } }>(url, "/api/bots", {
			method: "POST",
			body: JSON.stringify({ name: "Scribe", model: "xai/grok-4.7", thinking: "off", tools: ["web.search"] }),
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
		await until(() => egress.xai.requests.length === 2, "old chat stays on grok");
		const second = await createWebChat(url, created.bot.id);
		await say(url, second, "three");
		await until(async () => (await messages(url, second)).some((item) => item.text === "echo(1): three"), "new chat uses echo");
		await app.quiesce();
		expect(egress.xai.requests).toHaveLength(2);

		const renamed = await call(url, "/api/bots/default", { method: "PATCH", body: JSON.stringify({ name: "Other" }) });
		expect(renamed.status).toBe(422);
		const bots = await json<{ bots: { id: string; name: string; tools?: string[] }[] }>(url, "/api/bots");
		expect(bots.bots.find((bot) => bot.id === "default")?.name).toBe("Default");
		expect(bots.bots.find((bot) => bot.id === created.bot.id)?.tools).toEqual(["web.search"]);
	});

	it("keeps bots, chats, and transcripts across a restart", async () => {
		const home = await tempHome();
		const first = await boot(home);
		const created = await json<{ bot: { id: string } }>(first.url, "/api/bots", {
			method: "POST",
			body: JSON.stringify({ name: "Keeper", model: "xai/grok-4.7", thinking: "" }),
		});
		const key = await createWebChat(first.url, created.bot.id);
		await say(first.url, key, "remember me");
		await until(() => egress.xai.requests.length === 1, "reply");
		await first.app.quiesce();
		await first.app.stop();

		const second = await boot(home);
		const bots = await json<{ bots: { id: string }[] }>(second.url, "/api/bots");
		expect(bots.bots.map((bot) => bot.id)).toContain("keeper");
		const chats = await json<{ chats: { key: string }[] }>(second.url, "/api/bots/keeper/chats");
		expect(chats.chats.map((chat) => chat.key)).toContain(key);
		const transcript = await messages(second.url, key);
		expect(transcript.some((item) => item.text === "remember me")).toBe(true);
		expect(transcript.some((item) => item.text === "grok(1): remember me")).toBe(true);
		await second.app.quiesce();
	});
});
