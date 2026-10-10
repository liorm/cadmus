// Telegram in → agent (pi-durable + Grok) → Telegram out, through the real main(). Only egress is faked (HTTP).

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	type ConversationId,
	Harness,
	UserEntry,
} from "@earendil-works/pi-durable";
import type { App } from "../../src/app.ts";
import { ChatsDoc, listChats } from "../../src/channels/telegram/chats.ts";
import { createModels } from "../../src/harness/models.ts";
import { buildRegistry } from "../../src/harness/registry.ts";
import { openOwnedStorage } from "../../src/harness/storage.ts";
import { CHAT, FakeEgress, STRANGER } from "../egress/fake-egress.ts";
import { routeEgress } from "../egress/route.ts";
import { defined, settle, startBot, tempHome, until } from "../support.ts";

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

async function boot(
	home?: string,
	overrides: Record<string, string | undefined> = {},
) {
	const app = await startBot(home ?? (await tempHome()), overrides);
	apps.push(app);
	return app;
}

async function userTurns(app: App) {
	let count = 0;
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
		count += page.items.filter((entry) => UserEntry.is(entry)).length;
	}
	return count;
}

const tg = () => egress.telegram;
const xai = () => egress.xai;

describe("chat flows", () => {
	it("a message from Lior gets exactly one Grok reply in the same chat", async () => {
		const app = await boot();
		tg().push("hello");
		await until(() => tg().sent.length === 1, "the reply");
		await settle(app, egress);
		expect(tg().sent).toEqual([
			expect.objectContaining({ chatId: CHAT, text: "grok(1): hello" }),
		]);
		expect(tg().typing).toContain(CHAT);
		expect(xai().requests).toHaveLength(1);
		expect(defined(xai().requests[0], "request").authorization).toBe(
			"Bearer test-api-key",
		);
	});

	it("Telegram redelivering updates never causes a second turn or reply (requestId tg:<chat>:<msg>)", async () => {
		const app = await boot();
		tg().push("one");
		tg().push("two");
		await until(() => tg().sent.length === 2, "two replies");
		tg().redeliverAll();
		await settle(app, egress);
		tg().redeliverAll();
		await settle(app, egress);
		expect(tg().texts()).toEqual(["grok(1): one", "grok(2): two"]);
		expect(xai().requests).toHaveLength(2);
		expect(await userTurns(app)).toBe(2);
	});

	it("/new starts a fresh context; a redelivered /new does not reset again", async () => {
		const app = await boot();
		tg().push("a");
		await until(() => tg().sent.length === 1, "reply a");
		tg().push("b");
		await until(() => tg().sent.length === 2, "reply b");
		tg().push("/new");
		await until(() => tg().sent.length === 3, "/new confirmation");
		tg().push("c");
		await until(() => tg().sent.length === 4, "reply c");
		tg().redeliverAll(); // includes the /new again
		await settle(app, egress);
		tg().push("d");
		await until(() => tg().sent.length === 5, "reply d");
		expect(tg().texts()).toEqual([
			"grok(1): a",
			"grok(2): b",
			"🆕 New conversation started.",
			"grok(1): c",
			"grok(2): d",
		]);
		expect(await userTurns(app)).toBe(4); // old turns stay stored
	});

	it("/stop aborts the answer in progress; the next message is answered", async () => {
		const app = await boot();
		xai().hold();
		tg().push("write me an essay");
		await until(() => xai().requests.length === 1, "Grok to be asked");
		tg().push("/stop");
		await until(() => tg().texts().includes("⏹ Stopped."), "stop confirmation");
		xai().release();
		tg().push("next");
		await until(
			() =>
				tg()
					.texts()
					.some((text) => text.endsWith(": next")),
			"reply to next",
		);
		await settle(app, egress);
		expect(tg().texts()).toEqual(["⏹ Stopped.", "grok(2): next"]);
	});

	it("a message sent while Grok is answering joins the run as a steer and is answered", async () => {
		const app = await boot();
		xai().hold();
		tg().push("first");
		await until(() => xai().requests.length === 1, "first request");
		tg().push("second");
		xai().release();
		await until(
			() =>
				tg()
					.texts()
					.some((text) => text.includes("second")),
			"a reply covering the steer",
		);
		await settle(app, egress);
		const texts = tg().texts();
		expect(new Set(texts).size).toBe(texts.length); // nothing twice
		expect(texts.at(-1)).toBe("grok(2): second");
		expect(await userTurns(app)).toBe(2);
	});

	it("/status reports model, conversation and delivery state; /help lists commands", async () => {
		const app = await boot();
		tg().push("hi");
		await until(() => tg().sent.length === 1, "reply");
		tg().push("/status");
		await until(() => tg().sent.length === 2, "status");
		tg().push("/help@pi_test_bot");
		await until(() => tg().sent.length === 3, "help");
		tg().push("/status@some_other_bot"); // not for us: plain text to the model
		await until(() => tg().sent.length === 4, "reply to foreign command");
		await settle(app, egress);
		const [, status, help, foreign] = tg().texts();
		expect(status).toContain("Model: xai/grok-4.7");
		expect(status).toContain("Busy: no");
		expect(status).toContain("Replies sent: 1, unknown: 0");
		expect(help).toContain("/new");
		expect(foreign).toBe("grok(2): /status@some_other_bot");
	});

	it("ignores users outside TELEGRAM_ALLOWED_USERS without calling Grok", async () => {
		const app = await boot();
		tg().push("let me in", { from: STRANGER });
		await settle(app, egress);
		expect(tg().sent).toEqual([]);
		expect(xai().requests).toEqual([]);
		expect(await listChats(app.harness)).toEqual([]);
	});

	it("each forum topic is its own conversation and replies stay in their topic; group messages carry the sender", async () => {
		const app = await boot();
		tg().push("topic seven", { chatId: -5, threadId: 7 });
		tg().push("topic nine", { chatId: -5, threadId: 9 });
		tg().push("plain group", { chatId: -6 });
		await until(() => tg().sent.length === 3, "three replies");
		await settle(app, egress);
		expect(
			tg()
				.sent.map((sent) => [sent.chatId, sent.threadId, sent.text])
				.sort(),
		).toEqual([
			[-5, 7, "grok(1): [@lior] topic seven"],
			[-5, 9, "grok(1): [@lior] topic nine"],
			[-6, undefined, "grok(1): [@lior] plain group"],
		]);
		expect(
			(await listChats(app.harness)).map((chat) => chat.key).sort(),
		).toEqual([
			"default:tg:general:-5:7",
			"default:tg:general:-5:9",
			"default:tg:general:-6",
		]);
	});

	it("splits answers longer than Telegram's limit into ordered messages", async () => {
		const app = await boot();
		const long = Array.from(
			{ length: 400 },
			(_, i) => `paragraph ${i} ${"lorem ".repeat(4).trim()}`,
		).join("\n\n");
		xai().reply = () => long;
		tg().push("long please");
		await until(() => tg().sent.length >= 3, "chunks");
		await settle(app, egress);
		for (const sent of tg().sent)
			expect(sent.text.length).toBeLessThanOrEqual(4096);
		expect(tg().texts().join("\n\n")).toBe(long);
	});

	it("a model error is reported to the user once, and the chat keeps working", async () => {
		const app = await boot();
		xai().failNext = { status: 400, message: "model exploded" };
		tg().push("break");
		await until(() => tg().sent.length === 1, "error notice");
		tg().push("again");
		await until(() => tg().sent.length === 2, "reply after error");
		await settle(app, egress);
		expect(tg().texts()[0]).toStartWith("⚠️ I couldn't answer that");
		expect(tg().texts()[1]).toEndWith(": again");
	});

	it("a failed Telegram send is recorded 'unknown' and never retried", async () => {
		const app = await boot();
		tg().failNextSend = true;
		tg().push("hello");
		await until(() => tg().sendAttempts.length === 1, "the send attempt");
		await settle(app, egress);
		await new Promise((resolve) => setTimeout(resolve, 600)); // several delivery sweeps (200 ms)
		expect(tg().sendAttempts).toHaveLength(1);
		tg().push("/status");
		await until(() => tg().sent.length === 1, "status");
		expect(tg().texts()[0]).toContain("Replies sent: 0, unknown: 1");
	});

	it("bots/default SOUL.md and SYSTEM.md reach Grok's prompt", async () => {
		const home = await tempHome();
		await mkdir(join(home, "bots", "default"), { recursive: true });
		await writeFile(
			join(home, "bots", "default", "SOUL.md"),
			"You are Pip, Lior's assistant.",
		);
		await writeFile(
			join(home, "bots", "default", "SYSTEM.md"),
			"Lior prefers short answers.",
		);
		await writeFile(
			join(home, "SOUL.md"),
			"This home-root persona must not be read.",
		);
		const app = await boot(home);
		tg().push("hi");
		await until(() => tg().sent.length === 1, "reply");
		await settle(app, egress);
		const request = JSON.stringify(defined(xai().requests[0], "request").body);
		expect(request).toContain("You are Pip, Lior's assistant.");
		expect(request).toContain("Lior prefers short answers.");
		expect(request).not.toContain("This home-root persona must not be read.");
		expect(request).toContain("time zone Asia/Jerusalem");
	});

	it("a home-root SOUL.md and AGENTS.md are copied into bots/default once", async () => {
		const home = await tempHome();
		await writeFile(join(home, "SOUL.md"), "Copied soul.");
		await writeFile(join(home, "AGENTS.md"), "Copied agents.");
		const app = await boot(home);
		expect(
			await readFile(join(home, "bots", "default", "SOUL.md"), "utf8"),
		).toBe("Copied soul.");
		expect(
			await readFile(join(home, "bots", "default", "SYSTEM.md"), "utf8"),
		).toBe("Copied agents.");
		tg().push("hi");
		await until(() => tg().sent.length === 1, "reply");
		await settle(app, egress);
		const request = JSON.stringify(defined(xai().requests[0], "request").body);
		expect(request).toContain("Copied soul.");
		expect(request).toContain("Copied agents.");
	});

	it("a home from before this plan opens the same conversation", async () => {
		const home = await tempHome();
		const { storage, lock } = await openOwnedStorage(home);
		const { registry } = buildRegistry({ home, timeZone: "UTC" });
		const harness = await Harness.open(
			storage,
			{ models: createModels(), registry },
			BACKGROUND_CONTEXT,
		);
		let conversationId: ConversationId;
		try {
			conversationId = await harness.commit(async (tx) => {
				const conversation = await tx.createConversation({
					ownership: { kind: "ownerless" },
				});
				const chats = await tx.doc(ChatsDoc);
				chats.items.push({
					key: String(CHAT),
					chatId: CHAT,
					conversationId: conversation.id,
				});
				return conversation.id;
			}, BACKGROUND_CONTEXT);
		} finally {
			await harness.close(BACKGROUND_CONTEXT);
			await lock.release();
		}
		const app = await boot(home);
		expect(await listChats(app.harness)).toEqual([
			expect.objectContaining({
				key: `default:tg:general:${CHAT}`,
				botId: "default",
				conversationId,
			}),
		]);
		tg().push("still there?");
		await until(() => tg().sent.length === 1, "reply on the migrated chat");
		await settle(app, egress);
		expect(tg().texts()).toEqual(["grok(1): still there?"]);
		expect(
			(await listChats(app.harness)).map((chat) => chat.conversationId),
		).toEqual([conversationId]);
	});

	it("a read of knowledge/people.md returns the file body to the model", async () => {
		const home = await tempHome();
		const dir = join(home, "bots", "default", "knowledge");
		await mkdir(dir, { recursive: true });
		await writeFile(
			join(dir, "people.md"),
			"---\ndescription: People Lior mentions.\n---\n\nLior likes tea.\n",
		);
		const app = await boot(home);
		xai().script.push(
			{ tool: { name: "read", arguments: { path: "knowledge/people.md" } } },
			{ text: "noted" },
		);
		tg().push("who is in the notes?");
		await until(
			() => tg().texts().includes("noted"),
			"the reply after the read",
		);
		await settle(app, egress);
		const first = JSON.stringify(defined(xai().requests[0], "request").body);
		expect(first).toContain("People Lior mentions.");
		expect(first).not.toContain("Lior likes tea.");
		expect(
			JSON.stringify(defined(xai().requests[1], "request").body),
		).toContain("Lior likes tea.");
	});

	it("a path outside the bot folder is refused", async () => {
		const home = await tempHome();
		await writeFile(join(home, "secret.txt"), "outside-secret");
		const app = await boot(home);
		xai().script.push(
			{ tool: { name: "read", arguments: { path: "../../secret.txt" } } },
			{
				tool: { name: "read", arguments: { path: "disk/../../../secret.txt" } },
			},
			{ text: "refused" },
		);
		tg().push("read the secret");
		await until(() => tg().texts().includes("refused"), "the reply");
		await settle(app, egress);
		const followups = xai()
			.requests.slice(1)
			.map((request) => JSON.stringify(request.body))
			.join("\n");
		expect(followups).toContain("Path is outside the bot folder");
		expect(followups).not.toContain("outside-secret");
	});

	it("one user's disk/notes.txt is absent from another's", async () => {
		const home = await tempHome();
		const app = await boot(home, { TELEGRAM_ALLOWED_USERS: "1,2" });
		const eve = { id: 2, first_name: "Eve", username: "eve" };
		xai().script.push(
			{
				tool: {
					name: "write",
					arguments: { path: "disk/notes.txt", content: "secret-1" },
				},
			},
			{ text: "saved" },
		);
		tg().push("save a note");
		await until(() => tg().texts().includes("saved"), "user 1 saved");
		xai().script.push(
			{ tool: { name: "read", arguments: { path: "disk/notes.txt" } } },
			{ text: "read mine" },
		);
		tg().push("read it back");
		await until(() => tg().texts().includes("read mine"), "user 1 read");
		expect(
			JSON.stringify(defined(xai().requests.at(-1), "request").body),
		).toContain("secret-1");
		const mark = xai().requests.length;
		xai().script.push(
			{ tool: { name: "read", arguments: { path: "disk/notes.txt" } } },
			{ tool: { name: "read", arguments: { path: "users/1/disk/notes.txt" } } },
			{ text: "nothing" },
		);
		tg().push("read their note", { from: eve, chatId: 200 });
		await until(() => tg().texts().includes("nothing"), "user 2 done");
		await settle(app, egress);
		for (const request of xai().requests.slice(mark))
			expect(JSON.stringify(request.body)).not.toContain("secret-1");
		expect(
			await readFile(
				join(home, "bots", "default", "users", "1", "disk", "notes.txt"),
				"utf8",
			),
		).toBe("secret-1");
	});

	it("the knowledge index caps at 80 files and warns on unreadable frontmatter", async () => {
		const home = await tempHome();
		const dir = join(home, "bots", "default", "knowledge");
		await mkdir(dir, { recursive: true });
		for (let i = 0; i < 81; i++) {
			const slug = `f${String(i).padStart(2, "0")}`;
			await writeFile(
				join(dir, `${slug}.md`),
				`---\ndescription: desc ${slug}\n---\n\nBODY_${slug}\n`,
			);
		}
		await writeFile(join(dir, "BAD.md"), "no frontmatter\nBODY_BAD\n");
		const app = await boot(home);
		tg().push("hi");
		await until(() => tg().sent.length === 1, "reply");
		await settle(app, egress);
		const request = JSON.stringify(defined(xai().requests[0], "request").body);
		expect(request).toContain("desc f00");
		expect(request).toContain("desc f79");
		expect(request).not.toContain("desc f80");
		expect(request).toContain("1 more");
		expect(request).toContain("knowledge/BAD.md — unreadable frontmatter");
		expect(request).not.toContain("BODY_f00");
		expect(request).not.toContain("BODY_BAD");
	});

	it("restarting keeps the chat's conversation", async () => {
		const home = await tempHome();
		const first = await boot(home);
		tg().push("remember me");
		await until(() => tg().sent.length === 1, "first reply");
		await settle(first, egress);
		await first.stop();
		const second = await boot(home);
		tg().push("still there?");
		await until(() => tg().sent.length === 2, "reply after restart");
		await settle(second, egress);
		expect(tg().texts()).toEqual([
			"grok(1): remember me",
			"grok(2): still there?",
		]);
		expect(xai().requests).toHaveLength(2); // the first message was not re-run
	});
});

describe("model switching", () => {
	it("changing PI_MODEL between restarts moves existing chats to the new model, keeping their history", async () => {
		const home = await tempHome();
		const offline = await boot(home, {
			PI_MODEL: "faux/echo",
			XAI_API_KEY: undefined,
		});
		tg().push("before");
		await until(() => tg().sent.length === 1, "echo reply");
		await settle(offline, egress);
		await offline.stop();
		const grok = await boot(home);
		tg().push("after");
		await until(() => tg().sent.length === 2, "grok reply");
		await settle(grok, egress);
		expect(tg().texts()).toEqual(["echo(1): before", "grok(2): after"]);
	});
});

describe("startup guards", () => {
	it("one owner per data dir: a second bot is refused, and so is a lock held from another host", async () => {
		const home = await tempHome();
		await boot(home);
		await expect(startBot(home)).rejects.toThrow(/owned by another process/);
		const other = await tempHome();
		await writeFile(
			join(other, "owner.lock"),
			`4242 not-${hostname()} 2026-01-01T00:00:00Z\n`,
		);
		await expect(startBot(other)).rejects.toThrow(/owned by another process/);
	});

	it("refuses to start with no door, with an unknown model, or without Grok credentials", async () => {
		await expect(
			startBot(await tempHome(), { TELEGRAM_BOT_TOKEN: undefined }),
		).rejects.toThrow(/TELEGRAM_BOT_TOKEN or WEB_TOKEN/);
		await expect(
			startBot(await tempHome(), { PI_MODEL: "xai/grok-0" }),
		).rejects.toThrow(/Unknown model xai\/grok-0/);
		await expect(
			startBot(await tempHome(), { PI_MODEL: undefined }),
		).rejects.toThrow(/PI_MODEL is required/);
		await expect(
			startBot(await tempHome(), { XAI_API_KEY: undefined }),
		).rejects.toThrow(/XAI_API_KEY.*bun run login xai/);
	});

	it("runs offline with PI_MODEL=faux/echo (smoke mode)", async () => {
		const app = await boot(undefined, {
			PI_MODEL: "faux/echo",
			XAI_API_KEY: undefined,
		});
		tg().push("ping");
		await until(() => tg().sent.length === 1, "echo");
		await settle(app, egress);
		expect(tg().texts()).toEqual(["echo(1): ping"]);
		expect(xai().requests).toEqual([]);
	});
});
