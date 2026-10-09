// kill -9 the real bot process (`bun src/main.ts`) mid-turn and mid-send, then restart it over the same SQLite storage.
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, Harness, UserEntry } from "@earendil-works/pi-durable";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { ChatsDoc } from "../../src/channels/telegram/chats.ts";
import { DeliveriesDoc, finalReplyText } from "../../src/channels/telegram/deliver.ts";
import { createModels } from "../../src/harness/models.ts";
import { buildRegistry } from "../../src/harness/registry.ts";
import { openOwnedStorage } from "../../src/harness/storage.ts";
import { FakeEgress } from "../egress/fake-egress.ts";
import { botEnv, type Child, spawnBun, tempHome, until } from "../support.ts";

let egress: FakeEgress;
const children: Child[] = [];
beforeEach(() => {
	egress = new FakeEgress();
});
afterEach(() => {
	for (const child of children.splice(0)) child.proc.kill("SIGKILL");
	egress.stop();
});

function startProcess(home: string) {
	const child = spawnBun(["src/main.ts"], botEnv(home), egress);
	children.push(child);
	return child;
}

async function waitFor(child: Child, check: () => boolean, what: string) {
	try {
		await until(check, what, 20_000);
	} catch (error) {
		throw new Error(`${(error as Error).message}\n--- bot output ---\n${child.output()}`);
	}
}

async function polling(child: Child) {
	const before = egress.telegram.polls;
	await waitFor(child, () => egress.telegram.polls > before, "the bot to poll Telegram");
}

async function stop(child: Child) {
	child.proc.kill("SIGTERM");
	expect(await child.exited).toBe(0);
}

/** Read the stopped bot's storage without resuming any work. */
async function inspect(home: string) {
	const { storage, lock } = await openOwnedStorage(home);
	const { registry } = buildRegistry({ home, timeZone: "UTC" });
	const harness = await Harness.open(storage, { models: createModels(), registry }, BACKGROUND_CONTEXT);
	try {
		const [chat] = (await harness.snapshot(ChatsDoc, BACKGROUND_CONTEXT))!.items;
		const conversation = (await harness.conversation(chat!.conversationId, BACKGROUND_CONTEXT))!;
		const entries = (await conversation.entries({ order: "ascending" }, 1000, undefined, BACKGROUND_CONTEXT)).items;
		const receipts = (await harness.snapshot(DeliveriesDoc, chat!.conversationId, BACKGROUND_CONTEXT))!.receipts;
		return {
			users: entries.filter((entry) => UserEntry.is(entry)).length,
			answers: entries
				.filter((entry) => AssistantEntry.is(entry) && finalReplyText(entry.model?.[0]))
				.map((entry) => ({ text: finalReplyText(entry.model?.[0]), receipt: receipts[String(entry.id)]?.status })),
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
		const first = startProcess(home);
		egress.telegram.push("hello");
		await waitFor(first, () => egress.xai.requests.length === 1, "Grok to be asked");
		// While it runs, the storage has an owner: a second process is refused.
		const intruder = spawnBun(["src/main.ts"], botEnv(home), egress);
		expect(await intruder.exited).toBe(1);
		expect(intruder.output()).toContain("owned by another process");
		first.proc.kill("SIGKILL");
		await first.exited;
		expect(egress.telegram.sendAttempts).toEqual([]);

		egress.xai.hang = false;
		const second = startProcess(home); // takes over the dead pid's owner.lock
		await polling(second);
		egress.telegram.redeliverAll(); // Telegram also sends "hello" again
		await waitFor(second, () => egress.telegram.sent.length === 1, "the resumed reply");
		await waitFor(second, () => egress.telegram.drained(), "the redelivery to be handled");
		await new Promise((resolve) => setTimeout(resolve, 600)); // delivery sweeps run every 200 ms
		await stop(second);

		expect(egress.telegram.texts()).toEqual(["grok(1): hello"]);
		expect(await inspect(home)).toEqual({ users: 1, answers: [{ text: "grok(1): hello", receipt: "sent" }] });
	});

	it("killed while sending the reply: it becomes 'unknown', is never resent, and the next message is answered", async () => {
		const home = await tempHome();
		egress.telegram.hangSend = true;
		const first = startProcess(home);
		egress.telegram.push("first");
		await waitFor(first, () => egress.telegram.sendAttempts.length === 1, "the send attempt");
		first.proc.kill("SIGKILL");
		await first.exited;

		egress.telegram.hangSend = false;
		const second = startProcess(home);
		await polling(second);
		egress.telegram.redeliverAll();
		egress.telegram.push("second");
		await waitFor(second, () => egress.telegram.sent.length === 1, "the reply to the new message");
		await waitFor(second, () => egress.telegram.drained(), "every update to be handled");
		await new Promise((resolve) => setTimeout(resolve, 600));
		egress.telegram.push("/status");
		await waitFor(second, () => egress.telegram.sent.length === 2, "status");
		await stop(second);

		expect(egress.telegram.sendAttempts.map((send) => send.text)).toEqual(["grok(1): first", "grok(2): second", expect.stringContaining("Replies sent: 1, unknown: 1")]);
		expect(second.output()).toContain("may not have been delivered");
		expect(await inspect(home)).toEqual({
			users: 2,
			answers: [
				{ text: "grok(1): first", receipt: "unknown" },
				{ text: "grok(2): second", receipt: "sent" },
			],
		});
	});
});
