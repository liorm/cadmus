// kill -9 tests against a real child process (test/fixtures/bot-process.ts) over SQLite storage.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AssistantEntry, Harness, UserEntry } from "@earendil-works/pi-durable";
import { describe, expect, it } from "bun:test";
import { ChatsDoc } from "../src/channels/telegram/chats.ts";
import { DeliveriesDoc, finalReplyText } from "../src/channels/telegram/deliver.ts";
import { createModels } from "../src/harness/models.ts";
import { buildRegistry } from "../src/harness/registry.ts";
import { LockHeld, openOwnedStorage } from "../src/harness/storage.ts";
import { textUpdate, until } from "./support.ts";

const FIXTURE = join(import.meta.dirname, "fixtures", "bot-process.ts");

type Event = { type: string; pid: number; [key: string]: unknown };

class Fixture {
	readonly dir: string;
	readonly home: string;
	constructor(dir: string) {
		this.dir = dir;
		this.home = join(dir, "home");
	}
	static async create() {
		return new Fixture(await mkdtemp(join(tmpdir(), "pi-bot-crash-")));
	}
	setUpdates(updates: unknown[]) {
		writeFileSync(join(this.dir, "updates.json"), JSON.stringify(updates));
	}
	lines<T>(file: string): T[] {
		const path = join(this.dir, file);
		return existsSync(path)
			? readFileSync(path, "utf8")
					.split("\n")
					.filter(Boolean)
					.map((line) => JSON.parse(line) as T)
			: [];
	}
	sends() {
		return this.lines<{ chatId: number; text: string; pid: number }>("sends.jsonl");
	}
	events(pid?: number) {
		return this.lines<Event>("events.jsonl").filter((event) => pid === undefined || event.pid === pid);
	}
	start(env: Record<string, string> = {}) {
		const child = spawn(process.execPath, [FIXTURE], {
			env: { ...process.env, FIXTURE_DIR: this.dir, PI_BOT_HOME: this.home, ...env },
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		child.stdout!.on("data", (chunk) => (output += chunk));
		child.stderr!.on("data", (chunk) => (output += chunk));
		const exited = new Promise<number | null>((resolve) => child.on("exit", (code, signal) => resolve(signal ? -1 : code)));
		return { child, exited, output: () => output };
	}
	async waitFor(child: ChildProcess, type: string, timeoutMs = 20_000, output?: () => string) {
		try {
			await until(() => this.events(child.pid).some((event) => event.type === type), timeoutMs, `event ${type}`);
		} catch (error) {
			throw new Error(`${(error as Error).message}\nchild output:\n${output?.() ?? ""}`);
		}
		return this.events(child.pid).find((event) => event.type === type)!;
	}
	/** Open the (unlocked) storage after the child is gone, without resuming any work. */
	async inspect() {
		const { storage, lock } = await openOwnedStorage(this.home);
		const { registry } = buildRegistry({ home: this.home, timeZone: "UTC" });
		const harness = await Harness.open(storage, { models: createModels(), registry }, BACKGROUND_CONTEXT);
		try {
			const [chat] = (await harness.snapshot(ChatsDoc, BACKGROUND_CONTEXT))!.items;
			const conversation = (await harness.conversation(chat!.conversationId, BACKGROUND_CONTEXT))!;
			const entries = (await conversation.entries({ order: "ascending" }, 1000, undefined, BACKGROUND_CONTEXT)).items;
			const deliveries = (await harness.snapshot(DeliveriesDoc, chat!.conversationId, BACKGROUND_CONTEXT))!;
			const answers = entries
				.filter((entry) => AssistantEntry.is(entry))
				.map((entry) => ({ id: entry.id, text: finalReplyText(entry.model?.[0]) }))
				.filter((answer) => answer.text);
			return {
				users: entries.filter((entry) => UserEntry.is(entry)).length,
				answers: answers.map((answer) => ({ ...answer, receipt: deliveries.receipts[String(answer.id)]?.status })),
			};
		} finally {
			await harness.close(BACKGROUND_CONTEXT);
			await lock.release();
		}
	}
}

async function stop(run: ReturnType<Fixture["start"]>) {
	run.child.kill("SIGTERM");
	expect(await run.exited).toBe(0);
}

describe("crash recovery (kill -9)", () => {
	it("kill -9 mid-turn, restart: the turn resumes, the reply is sent exactly once, redelivery is deduped", async () => {
		const fx = await Fixture.create();
		fx.setUpdates([textUpdate(1, "hello")]);

		const first = fx.start({ FAUX_MODE: "hang" });
		await fx.waitFor(first.child, "model-call", 20_000, first.output); // the model is mid-answer
		// While it runs, a second owner is refused.
		await expect(openOwnedStorage(fx.home)).rejects.toBeInstanceOf(LockHeld);
		first.child.kill("SIGKILL");
		await first.exited;
		expect(fx.sends()).toEqual([]);

		// Restart with a working model; Telegram redelivers the same update (offset ignored).
		const second = fx.start({ REDELIVER: "1" });
		const ready = await fx.waitFor(second.child, "ready", 20_000, second.output);
		expect(ready.unknown).toEqual([]);
		await until(() => fx.sends().length >= 1, 20_000, "the resumed reply");
		await new Promise((resolve) => setTimeout(resolve, 1500)); // several delivery sweeps
		await stop(second);

		expect(fx.sends().map((send) => send.text)).toEqual(["echo(1): hello"]);
		const state = await fx.inspect();
		expect(state.users).toBe(1);
		expect(state.answers).toEqual([expect.objectContaining({ text: "echo(1): hello", receipt: "sent" })]);
	});

	it("kill -9 mid-send, restart: the interrupted reply becomes 'unknown' and is never resent", async () => {
		const fx = await Fixture.create();
		fx.setUpdates([textUpdate(1, "first")]);

		const first = fx.start({ HANG_SEND: "1" });
		await fx.waitFor(first.child, "send-hang", 20_000, first.output); // sendMessage was called, never returned
		first.child.kill("SIGKILL");
		await first.exited;
		expect(fx.sends().map((send) => send.text)).toEqual(["echo(1): first"]);

		// Restart; Telegram redelivers update 1 and brings a new message.
		fx.setUpdates([textUpdate(1, "first"), textUpdate(2, "second")]);
		const second = fx.start({ REDELIVER: "1" });
		const ready = await fx.waitFor(second.child, "ready", 20_000, second.output);
		expect(ready.unknown).toEqual([expect.objectContaining({ chat: "100" })]);
		await until(() => fx.sends().length >= 2, 20_000, "the reply to the new message");
		await new Promise((resolve) => setTimeout(resolve, 1500)); // several delivery sweeps
		await stop(second);

		expect(fx.sends().map((send) => send.text)).toEqual(["echo(1): first", "echo(2): second"]);
		const state = await fx.inspect();
		expect(state.users).toBe(2);
		expect(state.answers).toEqual([
			expect.objectContaining({ text: "echo(1): first", receipt: "unknown" }),
			expect.objectContaining({ text: "echo(2): second", receipt: "sent" }),
		]);
	});
});
