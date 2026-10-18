// Internal bot tools through the real main(). Only egress is faked.

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { App } from "../../src/app.ts";
import { parseKnowledge } from "../../src/extensions/knowledge.ts";
import { parseMemory } from "../../src/extensions/memory.ts";
import { FakeEgress } from "../egress/fake-egress.ts";
import { routeEgress } from "../egress/route.ts";
import {
	createWebChat,
	seedBot,
	sendWebMessage,
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

function bodies(): string[] {
	return egress.xai.requests.map((request) => JSON.stringify(request.body));
}

function childRequests(): string[] {
	return bodies().filter(
		(body) =>
			body.includes("Catalog:") || body.includes("is not a catalog slug"),
	);
}

async function waitForReply(
	url: string,
	key: string,
	match: string,
): Promise<void> {
	await until(async () => {
		const res = await call(
			url,
			`/api/chats/${encodeURIComponent(key)}/messages`,
		);
		if (!res.ok) return false;
		const body = (await res.json()) as {
			messages: { type: string; text?: string }[];
		};
		return body.messages.some(
			(m) => m.type !== "user" && m.text?.includes(match),
		);
	}, `reply containing "${match}"`);
}

describe("internal tools", () => {
	it("creates a bot from the caller model and effort, then refuses a taken or illegal slug", async () => {
		const home = await tempHome();
		await seedBot(home, { thinking: "high" });
		const { url } = await boot(home);
		const chatKey = await createWebChat(url);
		egress.xai.script.push(
			{
				tool: {
					name: "create_bot",
					arguments: {
						name: "Librarian",
						slug: "librarian",
						soul: "Keeps the shelves.\n",
						memory: "Prefer short notes.",
						knowledge: [
							{
								slug: "hours",
								description: "Opening hours",
								body: "Nine to five.",
							},
						],
					},
				},
			},
			{ text: "created" },
			{
				tool: {
					name: "create_bot",
					arguments: {
						name: "Librarian",
						slug: "librarian",
						soul: "Again.\n",
					},
				},
			},
			{ text: "taken" },
			{
				tool: {
					name: "create_bot",
					arguments: {
						name: "Nope",
						slug: "Bad Slug",
						soul: "No.\n",
					},
				},
			},
			{ text: "illegal" },
		);
		await sendWebMessage(url, chatKey, "make a librarian");
		await waitForReply(url, chatKey, "created");
		await settle(apps[0] as App, egress);
		const listed = await json<{
			bots: { id: string; model: string; thinking: string; name: string }[];
		}>(url, "/api/bots");
		expect(listed.bots).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "librarian",
					name: "Librarian",
					model: "xai/grok-4.7",
					thinking: "high",
				}),
			]),
		);
		expect(
			await readFile(join(home, "bots", "librarian", "SOUL.md"), "utf8"),
		).toBe("Keeps the shelves.\n");
		expect(
			parseMemory(
				await readFile(join(home, "bots", "librarian", "MEMORY.md"), "utf8"),
			),
		).toEqual({ version: 0, body: "Prefer short notes." });
		expect(
			parseKnowledge(
				await readFile(
					join(home, "bots", "librarian", "knowledge", "hours.md"),
					"utf8",
				),
			),
		).toMatchObject({
			version: 0,
			description: "Opening hours",
			body: "Nine to five.",
		});

		await sendWebMessage(url, chatKey, "make it again");
		await waitForReply(url, chatKey, "taken");
		await sendWebMessage(url, chatKey, "bad slug");
		await waitForReply(url, chatKey, "illegal");
		await settle(apps[0] as App, egress);
		const follow = bodies().join("\n");
		expect(follow).toContain("Slug is taken.");
		expect(follow).toContain("Slug is not a bot id.");
		const after = await json<{ bots: { id: string }[] }>(url, "/api/bots");
		expect(after.bots.filter((bot) => bot.id === "librarian")).toHaveLength(1);

		egress.xai.script.push({ text: "hello back" });
		const opened = await call(url, "/api/bots/librarian/chats", {
			method: "POST",
			body: "{}",
		});
		expect(opened.status).toBe(201);
		const chat = (await opened.json()) as { chat: { key: string } };
		const posted = await call(
			url,
			`/api/chats/${encodeURIComponent(chat.chat.key)}/messages`,
			{
				method: "POST",
				body: JSON.stringify({ clientMsgId: "m1", text: "hello" }),
			},
		);
		expect(posted.status).toBe(200);
		await settle(apps[0] as App, egress);
		const messages = await json<{ messages: { text?: string }[] }>(
			url,
			`/api/chats/${encodeURIComponent(chat.chat.key)}/messages`,
		);
		expect(
			messages.messages.some((message) => message.text === "hello back"),
		).toBe(true);
	});

	it("returns a catalog slug, retrying once when the first reply is misspelled", async () => {
		const home = await tempHome();
		await seedBot(home);
		await seedBot(home, { name: "Researcher" });
		await writeFile(
			join(home, "bots", "researcher", "SOUL.md"),
			"Finds papers.\n",
		);
		const { url } = await boot(home);
		const chatKey = await createWebChat(url);
		egress.xai.script.push(
			{
				tool: {
					name: "search_bot",
					arguments: { description: "the one that finds papers" },
				},
			},
			{ text: "resercher" },
			{ text: "researcher" },
			{ text: "found" },
		);
		await sendWebMessage(url, chatKey, "who finds papers?");
		await waitForReply(url, chatKey, "found");
		await settle(apps[0] as App, egress);
		const children = childRequests();
		expect(children).toHaveLength(2);
		expect(children[0]).toContain("Finds papers.");
		expect(children[0]).not.toContain('"name":"search_bot"');
		expect(children[0]).not.toContain('"name":"create_bot"');
		expect(children[1]).toContain("is not a catalog slug");
		expect(children[1]).toContain("resercher");
		expect(bodies().join("\n")).toContain('{\\"slug\\":\\"researcher\\"}');
	});

	it("returns null for an empty reply and after three invalid slugs", async () => {
		const home = await tempHome();
		await seedBot(home);
		const { url } = await boot(home);
		const chatKey = await createWebChat(url);
		egress.xai.script.push(
			{
				tool: {
					name: "search_bot",
					arguments: { description: "a billing bot" },
				},
			},
			{ text: "" },
			{ text: "empty" },
			{
				tool: {
					name: "search_bot",
					arguments: { description: "a missing bot" },
				},
			},
			{ text: "nope" },
			{ text: "still-nope" },
			{ text: "also-nope" },
			{ text: "gave-up" },
		);
		await sendWebMessage(url, chatKey, "any billing bot?");
		await waitForReply(url, chatKey, "empty");
		expect(bodies().join("\n")).toContain('{\\"slug\\":null}');
		expect(childRequests()).toHaveLength(1);

		await sendWebMessage(url, chatKey, "try a missing one");
		await waitForReply(url, chatKey, "gave-up");
		await settle(apps[0] as App, egress);
		const retries = childRequests().filter((body) =>
			body.includes("is not a catalog slug"),
		);
		expect(retries).toHaveLength(2);
		const results =
			bodies()
				.join("\n")
				.match(/\{\\"slug\\":null\}/g) ?? [];
		expect(results.length).toBeGreaterThanOrEqual(2);
	});

	it("message_bot throws and does not start another model pass", async () => {
		const home = await tempHome();
		await seedBot(home);
		const { url } = await boot(home);
		const chatKey = await createWebChat(url);
		egress.xai.script.push(
			{
				tool: {
					name: "message_bot",
					arguments: { slug: "researcher", text: "hello" },
				},
			},
			{ text: "cannot" },
		);
		await sendWebMessage(url, chatKey, "tell the researcher");
		await waitForReply(url, chatKey, "cannot");
		await settle(apps[0] as App, egress);
		expect(bodies().join("\n")).toContain("message_bot is not implemented.");
		expect(childRequests()).toHaveLength(0);
		expect(egress.xai.requests).toHaveLength(2);
	});
});
