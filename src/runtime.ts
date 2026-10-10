import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { configure, type Harness } from "@earendil-works/pi-durable";
import { type BotRecord, botDir } from "./channels/bots.ts";
import { ChatClosed, ChatsDoc, type ChatRecord, listChats, telegramTarget, webChatId } from "./channels/telegram/chats.ts";
import type { Deliverer } from "./channels/telegram/deliver.ts";
import { getLogger } from "./log.ts";
import { parseModelRef, parseThinkingLevel } from "./harness/models.ts";

/**
 * What the poller (and, later, the web channel and the scheduler) call. In-process this is a handle on the
 * single harness. Session services — the lock, the deliverer, the poller — stay outside it.
 */
export interface BotRuntime {
	readonly id: string;
	/** Admit `text` on an existing chat. Resolves once the submission is durable; the answer is delivered in the background. */
	submit(chatId: string, requestId: string, text: string): Promise<void>;
	listChats(): Promise<ChatRecord[]>;
	/** Find or create the chat. `userId` is stored when the row does not have one yet. */
	createChat(chatId: string, options?: { userId?: number }): Promise<ChatRecord>;
	/** Answer watchers started by `submit`. */
	settled(): Promise<void>;
	/** Later edits of the bot row. New chats use them; existing conversations stay as they were. */
	refresh(bot: BotRecord): void;
}

/** Filled in by `startApp` once the schedule service exists. Read at call time. */
export type TurnHooks = {
	/** A newly admitted user message. A duplicate request id does not call this. */
	onInput?(chatKey: string): Promise<void>;
	/** The turn finished and the chat is idle at `entryId`. */
	onSettled?(chatKey: string, entryId: number): Promise<void>;
};

export function createBotRuntime(options: {
	harness: Harness;
	deliverer: Deliverer;
	bot: BotRecord;
	home: string;
	hooks?: TurnHooks;
}): BotRuntime {
	const { harness, deliverer, home } = options;
	let bot = options.bot;
	const pending = new Set<Promise<void>>();

	const track = (work: Promise<void>) => {
		const tracked = work.catch((error) => getLogger().debug("answer watcher ended", { error }));
		pending.add(tracked);
		void tracked.finally(() => pending.delete(tracked));
	};

	return {
		id: bot.id,
		refresh(next) {
			bot = next;
		},
		async listChats() {
			return (await listChats(harness)).filter((chat) => chat.botId === bot.id);
		},
		async createChat(chatId, createOptions) {
			if (!chatId.startsWith(`${bot.id}:`)) throw new Error(`Chat ${chatId} is not on bot ${bot.id}`);
			const web = webChatId(bot.id, chatId);
			const address = web === undefined ? telegramTarget(chatId) : undefined;
			const thinking = parseThinkingLevel(bot.thinking);
			return harness.commit(async (tx) => {
				const chats = await tx.doc(ChatsDoc);
				if ((chats.closed ?? []).includes(chatId)) throw new ChatClosed(chatId);
				const existing = chats.items.find((chat) => chat.key === chatId);
				if (existing) {
					if (existing.userId === undefined && createOptions?.userId !== undefined) existing.userId = createOptions.userId;
					return { ...existing };
				}
				const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
				await configure(tx, conversation.id, {
					model: parseModelRef(bot.model),
					...(thinking ? { thinkingLevel: thinking } : {}),
					cwd: botDir(home, bot.id),
				});
				const record: ChatRecord = {
					key: chatId,
					botId: bot.id,
					...(createOptions?.userId === undefined ? {} : { userId: createOptions.userId }),
					...(address === undefined ? {} : { chatId: address.chatId }),
					...(address?.threadId === undefined ? {} : { threadId: address.threadId }),
					conversationId: conversation.id,
				};
				chats.items.push(record);
				return { ...record };
			}, BACKGROUND_CONTEXT);
		},
		async submit(chatId, requestId, text) {
			const chat = (await listChats(harness)).find((item) => item.key === chatId && item.botId === bot.id);
			if (!chat) throw new Error(`Chat ${chatId} is missing`);
			const conversation = await harness.conversation(chat.conversationId, BACKGROUND_CONTEXT);
			if (!conversation) throw new Error(`Conversation of chat ${chat.key} is missing`);
			const duplicate = await harness.commit(async (tx) => {
				const existing = await tx.submissionByRequest(chat.conversationId, requestId);
				return existing !== undefined;
			}, BACKGROUND_CONTEXT);
			if (!duplicate) await options.hooks?.onInput?.(chat.key);
			const submission = await conversation.submit(
				{ type: "input", content: text, requestId, whenBusy: "steer" },
				BACKGROUND_CONTEXT,
			);
			track(
				(async () => {
					const settled = await submission.wait(BACKGROUND_CONTEXT);
					if (!duplicate) {
						const page = await conversation.entries({ order: "descending" }, 1, undefined, BACKGROUND_CONTEXT);
						const entryId = page.items[0]?.id;
						if (entryId !== undefined) await options.hooks?.onSettled?.(chat.key, entryId);
					}
					if (settled.status === "unanswered" && !/abort|withdraw/i.test(settled.reason ?? "")) {
						const detail = typeof settled.detail === "string" ? settled.detail : settled.detail ? JSON.stringify(settled.detail) : "";
						getLogger().warn(`Input unanswered in chat ${chat.key}: ${settled.reason} ${detail}`);
						await deliverer.notice(
							chat,
							`unanswered:${submission.id}`,
							`⚠️ I couldn't answer that (${settled.reason}${detail ? `: ${detail.slice(0, 500)}` : ""}).`,
						);
					}
					await deliverer.kick(chat);
				})(),
			);
		},
		async settled() {
			while (pending.size) await Promise.all(pending);
		},
	};
}
