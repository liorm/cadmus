import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type AgentChange, defineDoc, type Harness } from "@earendil-works/pi-durable";
import { getLogger } from "../../log.ts";
import { addressOf, type ChatRecord, chatConversation, formatInput } from "./chats.ts";
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
	transport: TelegramTransport;
	deliverer: Deliverer;
	agent: AgentChange;
	allowedUsers: ReadonlySet<number>;
	pollTimeoutSec: number;
};

export class TelegramPoller {
	readonly #pending = new Set<Promise<void>>();
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

	/** Wait for every answer watcher started by this poller (tests, shutdown). */
	async settled(): Promise<void> {
		while (this.#pending.size) await Promise.all(this.#pending);
	}

	/**
	 * Admit one update. Safe to call again for the same update: input is deduplicated by `requestId`, commands by
	 * `CommandsDoc`, replies by `DeliveriesDoc` receipts.
	 */
	async handleUpdate(update: TgUpdate): Promise<void> {
		const { harness, transport, deliverer, agent, allowedUsers } = this.options;
		const message = update.message;
		if (!message?.text) return;
		const from = message.from;
		if (!from || from.is_bot || !allowedUsers.has(from.id)) {
			getLogger().warn(`Ignoring message from non-allowed user ${from?.id ?? "?"} in chat ${message.chat.id}`);
			return;
		}
		const chat = await chatConversation(harness, agent, addressOf(message));
		const requestId = requestIdOf(message.chat.id, message.message_id);

		const command = parseCommand(message.text, this.#username);
		if (command) {
			await handleCommand(command, { harness, deliverer, chat, requestKey: requestId });
			return;
		}

		const conversation = await harness.conversation(chat.conversationId, BACKGROUND_CONTEXT);
		if (!conversation) throw new Error(`Conversation of chat ${chat.key} is missing`);
		// A message during a run joins it as a steer, placed after the current tool round.
		const submission = await conversation.submit(
			{ type: "input", content: formatInput(message), requestId, whenBusy: "steer" },
			BACKGROUND_CONTEXT,
		);
		void transport
			.sendTyping?.(chat.chatId, chat.threadId === undefined ? {} : { threadId: chat.threadId })
			.catch(() => {});
		this.#track(this.#afterAnswer(chat, submission.id, () => submission.wait(BACKGROUND_CONTEXT)));
	}

	async #afterAnswer(
		chat: ChatRecord,
		submissionId: number,
		wait: () => Promise<{ status: string; reason?: string; detail?: unknown }>,
	): Promise<void> {
		const { deliverer } = this.options;
		const settled = await wait();
		if (settled.status === "unanswered" && !/abort|withdraw/i.test(settled.reason ?? "")) {
			const detail = typeof settled.detail === "string" ? settled.detail : settled.detail ? JSON.stringify(settled.detail) : "";
			getLogger().warn(`Input unanswered in chat ${chat.key}: ${settled.reason} ${detail}`);
			await deliverer.notice(chat, `unanswered:${submissionId}`, `⚠️ I couldn't answer that (${settled.reason}${detail ? `: ${detail.slice(0, 500)}` : ""}).`);
		}
		await deliverer.kick(chat);
	}

	#track(work: Promise<void>) {
		const tracked = work.catch((error) => getLogger().debug("answer watcher ended", { error }));
		this.#pending.add(tracked);
		void tracked.finally(() => this.#pending.delete(tracked));
	}
}
