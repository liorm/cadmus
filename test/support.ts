import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SendOptions, TelegramTransport, TgUpdate } from "../src/channels/telegram/transport.ts";
import type { Config } from "../src/config.ts";

export const ALLOWED_USER = 1;
export const CHAT = 100;

export type Sent = { chatId: number; text: string; threadId?: number; messageId: number };

/** In-memory Telegram: queued updates for `getUpdates`, recorded `sendMessage` calls. */
export class FakeTransport implements TelegramTransport {
	readonly updates: TgUpdate[] = [];
	readonly sent: Sent[] = [];
	/** When set, the next `sendMessage` throws after "maybe" reaching Telegram. */
	failNextSend = false;
	/** Ignore the offset: Telegram redelivering everything (e.g. after a lost offset). */
	redeliver = false;
	#nextMessageId = 10_000;

	push(...updates: TgUpdate[]) {
		this.updates.push(...updates);
	}

	async getUpdates(offset: number | undefined, _timeoutSec: number, signal: AbortSignal) {
		for (;;) {
			if (signal.aborted) throw new Error("aborted");
			const ready = this.updates.filter((update) => this.redeliver || offset === undefined || update.update_id >= offset);
			await new Promise((resolve) => setTimeout(resolve, 20));
			if (ready.length) return ready;
		}
	}

	async sendMessage(chatId: number, text: string, options: SendOptions) {
		if (this.failNextSend) {
			this.failNextSend = false;
			throw new Error("network error after write");
		}
		const messageId = this.#nextMessageId++;
		this.sent.push({ chatId, text, messageId, ...(options.threadId === undefined ? {} : { threadId: options.threadId }) });
		return { messageId };
	}

	async username() {
		return "pi_test_bot";
	}
}

export function textUpdate(
	updateId: number,
	text: string,
	options: { chatId?: number; from?: number; messageId?: number; threadId?: number; chatType?: string } = {},
): TgUpdate {
	const chatId = options.chatId ?? CHAT;
	return {
		update_id: updateId,
		message: {
			message_id: options.messageId ?? updateId,
			date: Math.floor(Date.now() / 1000),
			chat: { id: chatId, type: options.chatType ?? (options.threadId === undefined ? "private" : "supergroup") },
			from: { id: options.from ?? ALLOWED_USER, first_name: "Lior", username: "lior" },
			text,
			...(options.threadId === undefined ? {} : { message_thread_id: options.threadId, is_topic_message: true }),
		},
	};
}

export async function tempHome(): Promise<string> {
	return mkdtemp(join(tmpdir(), "pi-bot-test-"));
}

export function testConfig(home: string, overrides: Partial<Config> = {}): Config {
	return {
		home,
		telegram: { allowedUsers: new Set([ALLOWED_USER]), pollTimeoutSec: 0 },
		model: { main: { provider: "faux", modelId: "echo" } },
		timeZone: "Asia/Jerusalem",
		logLevel: "error",
		deliverySweepMs: 0,
		...overrides,
	};
}

export async function until(check: () => boolean | Promise<boolean>, timeoutMs = 15_000, what = "condition") {
	const deadline = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}
