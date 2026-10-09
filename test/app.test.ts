import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message, TranscriptContext } from "@earendil-works/pi-ai";
import { type Harness, UserEntry } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it } from "bun:test";
import { type App, startApp } from "../src/app.ts";
import { type ChatRecord, listChats } from "../src/channels/telegram/chats.ts";
import { DeliveriesDoc } from "../src/channels/telegram/deliver.ts";
import { createModels, echoResponse } from "../src/harness/models.ts";
import { LockHeld } from "../src/harness/storage.ts";
import { silentLogger } from "../src/log.ts";
import { CHAT, FakeTransport, tempHome, testConfig, textUpdate, until } from "./support.ts";

let apps: App[] = [];
afterEach(async () => {
	for (const app of apps) await app.stop();
	apps = [];
});

async function boot(options: { home?: string; poll?: boolean; transport?: FakeTransport; seen?: TranscriptContext[] } = {}) {
	const home = options.home ?? (await tempHome());
	const transport = options.transport ?? new FakeTransport();
	const seen = options.seen;
	const models = createModels((context) => {
		seen?.push(context);
		return echoResponse(context);
	});
	const app = await startApp({ config: testConfig(home), models, transport, log: silentLogger, poll: options.poll ?? false });
	apps.push(app);
	return { app, home, transport };
}

async function chats(harness: Harness): Promise<ChatRecord[]> {
	return listChats(harness);
}

async function userEntries(harness: Harness, chat: ChatRecord) {
	const conversation = await harness.conversation(chat.conversationId, BACKGROUND_CONTEXT);
	const page = await conversation!.entries({ order: "ascending" }, 1000, undefined, BACKGROUND_CONTEXT);
	return page.items.filter((entry) => UserEntry.is(entry));
}

const texts = (transport: FakeTransport) => transport.sent.map((sent) => sent.text);

describe("telegram ↔ durable conversation", () => {
	it("answers an allowed user once and records a 'sent' receipt", async () => {
		const { app, transport } = await boot();
		await app.poller.handleUpdate(textUpdate(1, "hello"));
		await app.quiesce();
		expect(texts(transport)).toEqual(["echo(1): hello"]);
		const [chat] = await chats(app.harness);
		const receipts = (await app.harness.snapshot(DeliveriesDoc, chat!.conversationId, BACKGROUND_CONTEXT))!.receipts;
		expect(Object.values(receipts).map((receipt) => receipt.status)).toEqual(["sent"]);
	});

	it("deduplicates a redelivered update by requestId tg:<chat>:<msg>", async () => {
		const { app, transport } = await boot();
		const update = textUpdate(1, "hello");
		await app.poller.handleUpdate(update);
		await app.poller.handleUpdate(update);
		await app.quiesce();
		await app.poller.handleUpdate(update); // after the answer, too
		await app.quiesce();
		expect(texts(transport)).toEqual(["echo(1): hello"]);
		const [chat] = await chats(app.harness);
		expect(await userEntries(app.harness, chat!)).toHaveLength(1);
	});

	it("deduplicates through the real poll loop when Telegram redelivers everything", async () => {
		const transport = new FakeTransport();
		transport.redeliver = true;
		const { app } = await boot({ poll: true, transport });
		transport.push(textUpdate(1, "one"), textUpdate(2, "two"));
		await until(() => transport.sent.length >= 2, 15_000, "two replies");
		await new Promise((resolve) => setTimeout(resolve, 300)); // several more redelivery rounds
		await app.quiesce();
		expect(transport.sent.map((sent) => sent.text)).toEqual(["echo(1): one", "echo(2): two"]);
		const [chat] = await chats(app.harness);
		expect(await userEntries(app.harness, chat!)).toHaveLength(2);
	});

	it("/new resets the model's context, and a redelivered /new does not reset again", async () => {
		const { app, transport } = await boot();
		await app.poller.handleUpdate(textUpdate(1, "a"));
		await app.quiesce();
		await app.poller.handleUpdate(textUpdate(2, "b"));
		await app.quiesce();
		const reset = textUpdate(3, "/new");
		await app.poller.handleUpdate(reset);
		await app.quiesce();
		await app.poller.handleUpdate(textUpdate(4, "c"));
		await app.quiesce();
		await app.poller.handleUpdate(reset); // redelivered: ignored
		await app.quiesce();
		await app.poller.handleUpdate(textUpdate(5, "d"));
		await app.quiesce();
		expect(texts(transport)).toEqual([
			"echo(1): a",
			"echo(2): b",
			"🆕 New conversation started.",
			"echo(1): c",
			"echo(2): d",
		]);
		// Older entries stay in storage.
		const [chat] = await chats(app.harness);
		expect(await userEntries(app.harness, chat!)).toHaveLength(4);
	});

	it("ignores users outside TELEGRAM_ALLOWED_USERS", async () => {
		const { app, transport } = await boot();
		await app.poller.handleUpdate(textUpdate(1, "let me in", { from: 999 }));
		await app.quiesce();
		expect(transport.sent).toEqual([]);
		expect(await chats(app.harness)).toEqual([]);
	});

	it("maps each forum topic to its own conversation and replies in that topic", async () => {
		const { app, transport } = await boot();
		await app.poller.handleUpdate(textUpdate(1, "in topic 7", { chatId: -5, threadId: 7 }));
		await app.poller.handleUpdate(textUpdate(2, "in topic 9", { chatId: -5, threadId: 9 }));
		await app.quiesce();
		const all = await chats(app.harness);
		expect(all.map((chat) => chat.key).sort()).toEqual(["-5:7", "-5:9"]);
		expect(new Set(all.map((chat) => chat.conversationId)).size).toBe(2);
		expect(transport.sent.map((sent) => [sent.threadId, sent.text]).sort()).toEqual([
			[7, "echo(1): [@lior] in topic 7"],
			[9, "echo(1): [@lior] in topic 9"],
		]);
	});

	it("a failed send is recorded 'unknown' and never retried", async () => {
		const { app, transport } = await boot();
		transport.failNextSend = true;
		await app.poller.handleUpdate(textUpdate(1, "hello"));
		await app.quiesce();
		await app.deliverer.sweepAll();
		await app.deliverer.idle();
		expect(transport.sent).toEqual([]);
		const [chat] = await chats(app.harness);
		const receipts = (await app.harness.snapshot(DeliveriesDoc, chat!.conversationId, BACKGROUND_CONTEXT))!.receipts;
		expect(Object.values(receipts)).toMatchObject([{ status: "unknown", error: "network error after write" }]);
	});

	it("renders SOUL.md, AGENTS.md and the date line into the system prompt", async () => {
		const home = await tempHome();
		await writeFile(join(home, "SOUL.md"), "You are Pip, Lior's assistant.");
		await writeFile(join(home, "AGENTS.md"), "Lior prefers short answers.");
		const seen: TranscriptContext[] = [];
		const { app } = await boot({ home, seen });
		await app.poller.handleUpdate(textUpdate(1, "hi"));
		await app.quiesce();
		const system = JSON.stringify(seen[0]?.messages.filter((message: Message) => (message.role as string) === "system"));
		expect(system).toContain("You are Pip, Lior's assistant.");
		expect(system).toContain("<agents>");
		expect(system).toContain("Lior prefers short answers.");
		expect(system).toContain("Today is ");
	});

	it("a second app on the same home is refused while the first runs", async () => {
		const { home } = await boot();
		await expect(boot({ home })).rejects.toBeInstanceOf(LockHeld);
	});

	it("restarts cleanly and keeps the chat's conversation", async () => {
		const home = await tempHome();
		const first = await boot({ home });
		await first.app.poller.handleUpdate(textUpdate(1, "remember me"));
		await first.app.quiesce();
		await first.app.stop();
		const transport = new FakeTransport();
		const second = await boot({ home, transport });
		await second.app.poller.handleUpdate(textUpdate(2, "still there?"));
		await second.app.quiesce();
		expect(texts(transport)).toEqual(["echo(2): still there?"]);
		expect((await chats(second.app.harness)).map((chat) => chat.chatId)).toEqual([CHAT]);
	});
});
