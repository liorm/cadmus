import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type Harness } from "@earendil-works/pi-durable";
import { getLogger } from "../../log.ts";
import type { BotRuntime } from "../../runtime.ts";
import { addressOf, chatKey, formatInput } from "./chats.ts";
import { handleCommand, parseCommand } from "./commands.ts";
import type { Deliverer } from "./deliver.ts";
import type { TelegramTransport, TgUpdate } from "./transport.ts";

/** Next `getUpdates` offset. Advanced only after an update's effects are durably admitted. */
export const TelegramCursorDoc = defineDoc<{ offset?: number }>({
	kind: "pi-bot.telegram.cursor",
	version: 1,
	scope: "session",
	initial: () => ({}),
});

/** Stable, per-message dedupe key: a redelivered update maps to the same durable submission. */
export function requestIdOf(chatId: number, messageId: number): string {
	return `tg:${chatId}:${messageId}`;
}

export type PollerOptions = {
	harness: Harness;
	/** Plain text is admitted only through this runtime. The general token talks to `default`. */
	runtime: BotRuntime;
	transport: TelegramTransport;
	deliverer: Deliverer;
	allowedUsers: ReadonlySet<number>;
	pollTimeoutSec: number;
};

export class TelegramPoller {
	#username?: string;

	private readonly options: PollerOptions;

	constructor(options: PollerOptions) {
		this.options = options;
	}

	/** Long-poll until `signal` aborts. Errors back off exponentially (1 s → 30 s). */
	async run(signal: AbortSignal): Promise<void> {
		const { harness, transport } = this.options;
		this.#username = await transport.username?.().catch(() => undefined);
		let backoff = 1000;
		while (!signal.aborted) {
			try {
				const offset = (await harness.snapshot(TelegramCursorDoc, BACKGROUND_CONTEXT))?.offset;
				const updates = await transport.getUpdates(offset, this.options.pollTimeoutSec, signal);
				for (const update of updates) {
					if (signal.aborted) break;
					await this.handleUpdate(update);
					await harness.commit(async (tx) => {
						const cursor = await tx.doc(TelegramCursorDoc);
						if (cursor.offset === undefined || cursor.offset <= update.update_id) cursor.offset = update.update_id + 1;
					}, BACKGROUND_CONTEXT);
				}
				backoff = 1000;
			} catch (error) {
				if (signal.aborted) break;
				getLogger().error(`Telegram polling failed; retrying in ${backoff} ms`, { error });
				await new Promise((resolve) => setTimeout(resolve, backoff));
				backoff = Math.min(backoff * 2, 30_000);
			}
		}
	}

	/** Wait for every answer watcher `submit` started. */
	async settled(): Promise<void> {
		await this.options.runtime.settled();
	}

	/**
	 * Admit one update. Safe to call again for the same update: input is deduplicated by `requestId`, commands by
	 * `CommandsDoc`, replies by `DeliveriesDoc` receipts.
	 */
	async handleUpdate(update: TgUpdate): Promise<void> {
		const { harness, transport, deliverer, allowedUsers, runtime } = this.options;
		const message = update.message;
		if (!message?.text) return;
		const from = message.from;
		if (!from || from.is_bot || !allowedUsers.has(from.id)) {
			getLogger().warn(`Ignoring message from non-allowed user ${from?.id ?? "?"} in chat ${message.chat.id}`);
			return;
		}
		const chat = await runtime.createChat(chatKey(runtime.id, addressOf(message), "general"), { userId: from.id });
		const requestId = requestIdOf(message.chat.id, message.message_id);

		const command = parseCommand(message.text, this.#username);
		if (command) {
			await handleCommand(command, { harness, deliverer, chat, requestKey: requestId });
			return;
		}

		void transport.sendTyping?.(chat.chatId, chat.threadId === undefined ? {} : { threadId: chat.threadId }).catch(() => {});
		await runtime.submit(chat.key, requestId, formatInput(message));
	}
}
