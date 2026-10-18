import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	type Conversation,
	type ConversationView,
	configure,
	type Harness,
	type LiveState,
	type RegistryReader,
} from "@earendil-works/pi-durable";
import { type BotRecord, botDir } from "./channels/bots.ts";
import {
	ChatClosed,
	type ChatRecord,
	ChatsDoc,
	listChats,
	telegramTarget,
	webChatId,
} from "./channels/telegram/chats.ts";
import type { Deliverer } from "./channels/telegram/deliver.ts";
import { parseModelRef, parseThinkingLevel } from "./harness/models.ts";
import { agentToolChange, syncChatTools } from "./harness/tool-policy.ts";
import { armHarvest, cancelHarvest } from "./harvest/run.ts";
import { chatFields, getLogger } from "./log.ts";
import type { AppServices } from "./services.ts";

/** Warn if a turn produces no visible answer (text or tool) within this time. */
export const STUCK_CHAT_MS = 10_000;

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
	createChat(
		chatId: string,
		options?: { userId?: number },
	): Promise<ChatRecord>;
	/** Answer watchers started by `submit`. */
	settled(): Promise<void>;
	/** Later edits of the bot row. New chats use them; existing conversations stay as they were. */
	refresh(bot: BotRecord): void;
}

export function createBotRuntime(options: {
	harness: Harness;
	registry: RegistryReader;
	deliverer: Deliverer;
	bot: BotRecord;
	home: string;
	services: AppServices;
}): BotRuntime {
	const { harness, registry, deliverer, home, services } = options;
	let bot = options.bot;
	const pending = new Set<Promise<void>>();

	const track = (work: Promise<void>) => {
		const tracked = work.catch((error) =>
			getLogger().debug("answer watcher ended", { error }),
		);
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
			if (!chatId.startsWith(`${bot.id}:`))
				throw new Error(`Chat ${chatId} is not on bot ${bot.id}`);
			const web = webChatId(bot.id, chatId);
			const address = web === undefined ? telegramTarget(chatId) : undefined;
			const thinking = parseThinkingLevel(bot.thinking);
			const tools = agentToolChange(bot, registry);
			return harness.commit(async (tx) => {
				const chats = await tx.doc(ChatsDoc);
				if ((chats.closed ?? []).includes(chatId)) throw new ChatClosed(chatId);
				const existing = chats.items.find((chat) => chat.key === chatId);
				if (existing) {
					if (
						existing.userId === undefined &&
						createOptions?.userId !== undefined
					)
						existing.userId = createOptions.userId;
					return { ...existing };
				}
				const conversation = await tx.createConversation({
					ownership: { kind: "ownerless" },
				});
				await configure(tx, conversation.id, {
					model: parseModelRef(bot.model),
					...(thinking ? { thinkingLevel: thinking } : {}),
					cwd: botDir(home, bot.id),
					...(tools === null ? {} : { tools }),
				});
				const record: ChatRecord = {
					key: chatId,
					botId: bot.id,
					...(createOptions?.userId === undefined
						? {}
						: { userId: createOptions.userId }),
					...(address === undefined ? {} : { chatId: address.chatId }),
					...(address?.threadId === undefined
						? {}
						: { threadId: address.threadId }),
					conversationId: conversation.id,
				};
				chats.items.push(record);
				return { ...record };
			}, BACKGROUND_CONTEXT);
		},
		async submit(chatId, requestId, text) {
			const chat = (await listChats(harness)).find(
				(item) => item.key === chatId && item.botId === bot.id,
			);
			if (!chat) throw new Error(`Chat ${chatId} is missing`);
			const conversation = await harness.conversation(
				chat.conversationId,
				BACKGROUND_CONTEXT,
			);
			if (!conversation)
				throw new Error(`Conversation of chat ${chat.key} is missing`);
			const duplicate = await harness.commit(async (tx) => {
				const existing = await tx.submissionByRequest(
					chat.conversationId,
					requestId,
				);
				return existing !== undefined;
			}, BACKGROUND_CONTEXT);
			const log = getLogger().child(
				chatFields(chat, { requestId, bot: bot.id }),
			);
			if (!duplicate) await cancelHarvest(services, chat.key);
			await syncChatTools(harness, chat.conversationId, bot, registry);
			const submission = await conversation.submit(
				{ type: "input", content: text, requestId, whenBusy: "steer" },
				BACKGROUND_CONTEXT,
			);
			if (duplicate) log.debug("duplicate input ignored");
			else log.debug("chat input admitted", { chars: text.length });
			track(
				(async () => {
					const stopWatch = duplicate
						? undefined
						: await armStuckWatch(conversation, log);
					try {
						const settled = await submission.wait(BACKGROUND_CONTEXT);
						if (!duplicate) {
							const page = await conversation.entries(
								{ order: "descending" },
								1,
								undefined,
								BACKGROUND_CONTEXT,
							);
							const entryId = page.items[0]?.id;
							if (entryId !== undefined)
								await armHarvest(services, {
									botId: bot.id,
									chatKey: chat.key,
									entryId: entryId as unknown as number,
								});
						}
						if (
							settled.status === "unanswered" &&
							!/abort|withdraw/i.test(settled.reason ?? "")
						) {
							const detail =
								typeof settled.detail === "string"
									? settled.detail
									: settled.detail
										? JSON.stringify(settled.detail)
										: "";
							log.warn("input unanswered", {
								reason: settled.reason,
								detail,
							});
							await deliverer.notice(
								chat,
								`unanswered:${submission.id}`,
								`⚠️ I couldn't answer that (${settled.reason}${detail ? `: ${detail.slice(0, 500)}` : ""}).`,
							);
						} else if (!duplicate)
							log.debug("chat turn settled", { status: settled.status });
						await deliverer.kick(chat);
					} finally {
						stopWatch?.();
					}
				})(),
			);
		},
		async settled() {
			while (pending.size) await Promise.all(pending);
		},
	};
}

/** True once the model has started returning text or a tool call. */
export function answerHasStarted(view: ConversationView): boolean {
	const live = view.docs["pi.live"] as LiveState | undefined;
	const message = live?.generation?.message as
		| { content?: unknown }
		| undefined;
	const content = message?.content;
	if (!Array.isArray(content)) return false;
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const typed = part as { type?: string; text?: unknown };
		if (typed.type === "text" && typeof typed.text === "string" && typed.text)
			return true;
		if (typed.type === "toolCall" || typed.type === "serverTool") return true;
	}
	return false;
}

async function armStuckWatch(
	conversation: Conversation,
	log: ReturnType<typeof getLogger>,
): Promise<() => void> {
	const handle = await conversation.watch(BACKGROUND_CONTEXT);
	let started = answerHasStarted(handle.value);
	if (!started) {
		handle.start(async (value) => {
			if (answerHasStarted(value)) started = true;
		});
	}
	const timer = setTimeout(() => {
		if (!started)
			log.warn("chat stuck: no answer started", { waitMs: STUCK_CHAT_MS });
	}, STUCK_CHAT_MS);
	timer.unref?.();
	return () => {
		clearTimeout(timer);
		void handle.stop();
	};
}
