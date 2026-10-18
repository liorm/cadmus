// kill -9 the real bot process (`bun src/main.ts`) mid-turn, then restart it over the same SQLite storage.

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, Harness, UserEntry } from "@earendil-works/pi-durable";
import { ChatsDoc } from "../../src/channels/chats.ts";
import { createModels } from "../../src/harness/models.ts";
import { buildRegistry } from "../../src/harness/registry.ts";
import { openOwnedStorage } from "../../src/harness/storage.ts";
import { HarvestNotesDoc } from "../../src/harvest/notes.ts";
import { FakeEgress } from "../egress/fake-egress.ts";
import {
	botEnv,
	type Child,
	defined,
	seedBot,
	spawnBun,
	tempHome,
	until,
} from "../support.ts";

let egress: FakeEgress;
const children: Child[] = [];
beforeEach(() => {
	egress = new FakeEgress();
});
afterEach(() => {
	for (const child of children.splice(0)) child.proc.kill("SIGKILL");
	egress.stop();
});

async function startProcess(
	home: string,
	overrides: Record<string, string | undefined> = {},
) {
	await seedBot(home);
	const child = spawnBun(
		["src/main.ts"],
		botEnv(home, {
			WEB_TOKEN: "test-web-token",
			WEB_PORT: "0",
			LOG_LEVEL: "info",
			...overrides,
		}),
		egress,
	);
	children.push(child);
	return child;
}

function userScheduleIds(home: string): string[] {
	const db = new Database(join(home, "schedules.sqlite"), { readonly: true });
	try {
		return db
			.query<{ id: string }, []>(
				"SELECT id FROM schedules WHERE id LIKE 'u-%' ORDER BY id",
			)
			.all()
			.map((row) => row.id);
	} finally {
		db.close();
	}
}

async function waitFor(
	child: Child,
	check: () => boolean | Promise<boolean>,
	what: string,
) {
	try {
		await until(check, what, 20_000);
	} catch (error) {
		throw new Error(
			`${(error as Error).message}\n--- bot output ---\n${child.output()}`,
		);
	}
}

async function botUrl(child: Child): Promise<string> {
	await waitFor(
		child,
		() => /web (http:\/\/[^\s]+)/.test(child.output()),
		"the bot web listener to start",
	);
	const match = /web (http:\/\/[^\s]+)/.exec(child.output());
	return defined(defined(match, "match")[1], "url");
}

async function webChat(url: string): Promise<string> {
	const res = await fetch(`${url}/api/bots/default/chats`, {
		method: "POST",
		headers: {
			authorization: "Bearer test-web-token",
			"content-type": "application/json",
		},
		body: "{}",
	});
	expect(res.status).toBe(201);
	return ((await res.json()) as { chat: { key: string } }).chat.key;
}

async function webPost(
	url: string,
	key: string,
	text: string,
	clientMsgId = `m-${Date.now()}-${Math.random()}`,
) {
	const res = await fetch(
		`${url}/api/chats/${encodeURIComponent(key)}/messages`,
		{
			method: "POST",
			headers: {
				authorization: "Bearer test-web-token",
				"content-type": "application/json",
			},
			body: JSON.stringify({ clientMsgId, text }),
		},
	);
	expect(res.status).toBe(200);
}

async function waitForAnswer(
	child: Child,
	url: string,
	key: string,
	textSubstring: string,
) {
	await waitFor(
		child,
		async () => {
			const res = await fetch(
				`${url}/api/chats/${encodeURIComponent(key)}/messages`,
				{
					headers: { authorization: "Bearer test-web-token" },
				},
			).catch(() => undefined);
			if (!res?.ok) return false;
			const body = (await res.json()) as {
				messages: { type: string; text?: string }[];
			};
			return body.messages.some(
				(m) => m.type === "assistant" && m.text?.includes(textSubstring),
			);
		},
		`reply containing ${textSubstring}`,
	);
}

async function stop(child: Child) {
	child.proc.kill("SIGTERM");
	expect(await child.exited).toBe(0);
}

/** Read the stopped bot's storage without resuming any work. */
async function inspect(home: string) {
	const { storage, lock } = await openOwnedStorage(home);
	const { registry } = buildRegistry({ home, timeZone: "UTC" });
	const harness = await Harness.open(
		storage,
		{ models: createModels(), registry },
		BACKGROUND_CONTEXT,
	);
	try {
		const chats =
			(await harness.snapshot(ChatsDoc, BACKGROUND_CONTEXT))?.items ?? [];
		const chat = defined(chats[0], "chat");
		const conversation = defined(
			await harness.conversation(chat.conversationId, BACKGROUND_CONTEXT),
			"conversation",
		);
		const entries = (
			await conversation.entries(
				{ order: "ascending" },
				1000,
				undefined,
				BACKGROUND_CONTEXT,
			)
		).items;
		return {
			users: entries.filter((entry) => UserEntry.is(entry)).length,
			answers: entries
				.filter(
					(entry) =>
						AssistantEntry.is(entry) && entry.model?.[0]?.role === "assistant",
				)
				.map((entry) => {
					const msg = entry.model?.[0];
					if (msg?.role !== "assistant") return "";
					return Array.isArray(msg.content)
						? msg.content
								.map((p) => (p.type === "text" ? p.text : ""))
								.join("\n")
								.trim()
						: "";
				})
				.filter(Boolean),
		};
	} finally {
		await harness.close(BACKGROUND_CONTEXT);
		await lock.release();
	}
}

describe("crash recovery (kill -9)", () => {
	it("killed while Grok is answering: the turn resumes after restart and is answered exactly once", async () => {
		const home = await tempHome();
		egress.xai.hang = true;
		const first = await startProcess(home);
		const url1 = await botUrl(first);
		const key = await webChat(url1);
		await webPost(url1, key, "hello");
		await waitFor(
			first,
			() => egress.xai.requests.length === 1,
			"Grok to be asked",
		);
		// While it runs, the storage has an owner: a second process is refused.
		const intruder = spawnBun(["src/main.ts"], botEnv(home), egress);
		expect(await intruder.exited).toBe(1);
		expect(intruder.output()).toContain("owned by another process");
		first.proc.kill("SIGKILL");
		await first.exited;

		egress.xai.hang = false;
		const second = await startProcess(home); // takes over the dead pid's owner.lock
		const url2 = await botUrl(second);
		await waitForAnswer(second, url2, key, "hello");
		await stop(second);

		expect(await inspect(home)).toEqual({
			users: 1,
			answers: ["grok(1): hello"],
		});
	});

	it("killed during a web reply: restart answers once and the same clientMsgId does not duplicate", async () => {
		const home = await tempHome();
		await seedBot(home);
		const token = "test-web-token";
		const headers = {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
		};
		const listen = () => {
			const probe = Bun.serve({ port: 0, fetch: () => new Response("no") });
			const port = probe.port;
			probe.stop(true);
			return port;
		};
		const port = listen();
		const base = `http://127.0.0.1:${port}`;
		egress.xai.hang = true;
		const first = spawnBun(
			["src/main.ts"],
			botEnv(home, {
				WEB_TOKEN: token,
				WEB_PORT: String(port),
				LOG_LEVEL: "info",
			}),
			egress,
		);
		children.push(first);
		await waitFor(
			first,
			() => /web http:\/\//.test(first.output()),
			"the bot web listener to start",
		);
		const created = await fetch(`${base}/api/bots/default/chats`, {
			method: "POST",
			headers,
			body: "{}",
		});
		expect(created.status).toBe(201);
		const key = ((await created.json()) as { chat: { key: string } }).chat.key;
		const posted = await fetch(
			`${base}/api/chats/${encodeURIComponent(key)}/messages`,
			{
				method: "POST",
				headers,
				body: JSON.stringify({ clientMsgId: "crash-1", text: "hello" }),
			},
		);
		expect(posted.status).toBe(200);
		await waitFor(
			first,
			() => egress.xai.requests.length === 1,
			"Grok to be asked",
		);
		first.proc.kill("SIGKILL");
		await first.exited;

		egress.xai.hang = false;
		const nextPort = listen();
		const second = spawnBun(
			["src/main.ts"],
			botEnv(home, {
				WEB_TOKEN: token,
				WEB_PORT: String(nextPort),
				LOG_LEVEL: "info",
			}),
			egress,
		);
		children.push(second);
		const nextBase = `http://127.0.0.1:${nextPort}`;
		await waitFor(
			second,
			() => /web http:\/\//.test(second.output()),
			"the restarted bot web listener to start",
		);
		await waitFor(
			second,
			async () => {
				const response = await fetch(
					`${nextBase}/api/chats/${encodeURIComponent(key)}/messages`,
					{ headers },
				).catch(() => undefined);
				if (!response?.ok) return false;
				const body = (await response.json()) as {
					messages: { type: string; text?: string }[];
				};
				return body.messages.some((item) => item.text === "grok(1): hello");
			},
			"the resumed reply",
		);
		const again = await fetch(
			`${nextBase}/api/chats/${encodeURIComponent(key)}/messages`,
			{
				method: "POST",
				headers,
				body: JSON.stringify({ clientMsgId: "crash-1", text: "hello" }),
			},
		);
		expect(again.status).toBe(200);
		await new Promise((resolve) => setTimeout(resolve, 600));
		const transcript = (await (
			await fetch(`${nextBase}/api/chats/${encodeURIComponent(key)}/messages`, {
				headers,
			})
		).json()) as {
			messages: { type: string; text?: string }[];
		};
		expect(
			transcript.messages.filter((item) => item.type === "user"),
		).toHaveLength(1);
		expect(
			transcript.messages.filter((item) => item.text === "grok(1): hello"),
		).toHaveLength(1);
		await stop(second);
	});

	it("killed after schedule_create commits: replay returns that row and does not insert another", async () => {
		const home = await tempHome();
		const sentinel = join(home, "stall");
		const first = await startProcess(home, {
			PI_BOT_STALL_SCHEDULE: "tx",
			PI_BOT_STALL_SENTINEL: sentinel,
		});
		const url1 = await botUrl(first);
		const key = await webChat(url1);
		egress.xai.script.push(
			{
				tool: {
					name: "schedule_create",
					arguments: { text: "Morning check", cron: "0 9 * * *" },
				},
			},
			{ text: "created" },
		);
		await webPost(url1, key, "remind me");
		await waitFor(
			first,
			() => existsSync(sentinel),
			"the schedule write to stall",
		);
		const inserted = userScheduleIds(home);
		expect(inserted).toHaveLength(1);
		first.proc.kill("SIGKILL");
		await first.exited;

		const second = await startProcess(home);
		const url2 = await botUrl(second);
		await waitForAnswer(second, url2, key, "created");
		await stop(second);
		expect(userScheduleIds(home)).toEqual(inserted);
		const follow = egress.xai.requests
			.slice(1)
			.map((request) => JSON.stringify(request.body))
			.join("\n");
		expect(follow).toContain(defined(inserted[0], "schedule id"));
		expect(follow).not.toContain("Schedule was not stored.");
	}, 20_000);

	it("killed after schedule_delete removes the row: replay returns the deleted id", async () => {
		const home = await tempHome();
		const created = await startProcess(home);
		const url0 = await botUrl(created);
		const key = await webChat(url0);
		egress.xai.script.push(
			{
				tool: {
					name: "schedule_create",
					arguments: { text: "Morning check", cron: "0 9 * * *" },
				},
			},
			{ text: "created" },
		);
		await webPost(url0, key, "remind me");
		await waitForAnswer(created, url0, key, "created");
		await stop(created);
		const id = defined(userScheduleIds(home)[0], "schedule id");

		const sentinel = join(home, "stall");
		const first = await startProcess(home, {
			PI_BOT_STALL_SCHEDULE: "run",
			PI_BOT_STALL_SENTINEL: sentinel,
		});
		const url1 = await botUrl(first);
		egress.xai.script.push(
			{ tool: { name: "schedule_delete", arguments: { id } } },
			{ text: "removed" },
		);
		await webPost(url1, key, "drop it");
		await waitFor(first, () => existsSync(sentinel), "the delete to stall");
		expect(userScheduleIds(home)).toEqual([]);
		first.proc.kill("SIGKILL");
		await first.exited;

		const second = await startProcess(home);
		const url2 = await botUrl(second);
		await waitForAnswer(second, url2, key, "removed");
		await stop(second);
		expect(userScheduleIds(home)).toEqual([]);
		const follow = JSON.stringify(
			defined(egress.xai.requests.at(-1), "follow-up").body,
		);
		expect(follow).toContain(id);
		expect(follow).not.toContain("No such schedule.");
	}, 20_000);

	it("killed after schedule_update commits: replay returns that row and does not write another", async () => {
		const home = await tempHome();
		const created = await startProcess(home);
		const url0 = await botUrl(created);
		const key = await webChat(url0);
		egress.xai.script.push(
			{
				tool: {
					name: "schedule_create",
					arguments: { text: "Morning check", cron: "0 9 * * *" },
				},
			},
			{ text: "created" },
		);
		await webPost(url0, key, "remind me");
		await waitForAnswer(created, url0, key, "created");
		await stop(created);
		const id = defined(userScheduleIds(home)[0], "schedule id");

		const sentinel = join(home, "stall");
		const first = await startProcess(home, {
			PI_BOT_STALL_SCHEDULE: "run",
			PI_BOT_STALL_SENTINEL: sentinel,
		});
		const url1 = await botUrl(first);
		egress.xai.script.push(
			{
				tool: {
					name: "schedule_update",
					arguments: { id, text: "Evening check", cron: "30 18 * * 1" },
				},
			},
			{ text: "updated" },
		);
		await webPost(url1, key, "move it");
		await waitFor(first, () => existsSync(sentinel), "the update to stall");
		first.proc.kill("SIGKILL");
		await first.exited;

		const second = await startProcess(home);
		const url2 = await botUrl(second);
		await waitForAnswer(second, url2, key, "updated");
		await stop(second);
		expect(userScheduleIds(home)).toEqual([id]);
		const db = new Database(join(home, "schedules.sqlite"), { readonly: true });
		try {
			const row = db
				.query<{ text: string; cron: string }, [string]>(
					"SELECT text, cron FROM schedules WHERE id = ?",
				)
				.get(id);
			expect(row?.text).toBe("Evening check");
			expect(row?.cron).toBe("30 18 * * 1");
		} finally {
			db.close();
		}
		const follow = egress.xai.requests
			.slice(1)
			.map((request) => JSON.stringify(request.body))
			.join("\n");
		expect(follow).toContain("Evening check");
		expect(follow).toContain("30 18 * * 1");
		expect(follow).not.toContain("No such schedule.");
	}, 20_000);

	it("killed during harvest: restart finishes that idle point once", async () => {
		const home = await tempHome();
		const first = await startProcess(home, {
			PI_BOT_HARVEST_DELAY_MS: "200",
		});
		const url1 = await botUrl(first);
		const key = await webChat(url1);
		await webPost(url1, key, "remember the red mug");
		await waitForAnswer(first, url1, key, "remember the red mug");
		egress.xai.hang = true;
		await waitFor(
			first,
			() =>
				egress.xai.requests.some((request) =>
					JSON.stringify(request.body).includes(
						"Improve knowledge from this chat.",
					),
				),
			"harvest to start",
		);
		first.proc.kill("SIGKILL");
		await first.exited;

		egress.xai.hang = false;
		egress.xai.script.push(
			{ tool: { name: "knowledge_read", arguments: { slug: "notes" } } },
			{
				tool: {
					name: "knowledge_update",
					arguments: {
						slug: "notes",
						description: "Kept.",
						body: "red mug\n",
						version: 0,
					},
				},
			},
			{ text: "done" },
		);
		const second = await startProcess(home, {
			PI_BOT_HARVEST_DELAY_MS: "200",
		});
		const notesPath = join(home, "bots", "default", "knowledge", "notes.md");
		await waitFor(second, () => existsSync(notesPath), "harvested knowledge");
		await new Promise((resolve) => setTimeout(resolve, 600));
		await stop(second);
		expect(await readFile(notesPath, "utf8")).toContain("red mug");
		const { storage, lock } = await openOwnedStorage(home);
		const { registry } = buildRegistry({ home, timeZone: "UTC" });
		const harness = await Harness.open(
			storage,
			{ models: createModels(), registry },
			BACKGROUND_CONTEXT,
		);
		try {
			const notes = await harness.snapshot(HarvestNotesDoc, BACKGROUND_CONTEXT);
			expect(notes?.notes).toEqual([
				expect.objectContaining({
					files: [expect.objectContaining({ path: "knowledge/notes.md" })],
				}),
			]);
			expect(Object.keys(notes?.completed ?? {})).toHaveLength(1);
		} finally {
			await harness.close(BACKGROUND_CONTEXT);
			await lock.release();
		}
	}, 20_000);
});
