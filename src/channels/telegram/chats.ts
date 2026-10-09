import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type ConversationId, type Harness } from "@earendil-works/pi-durable";
import { DEFAULT_BOT_ID } from "../bots.ts";
import type { TgMessage } from "./transport.ts";

/** One Telegram chat, or one forum topic of a chat, and the durable conversation it talks to. */
export type ChatRecord = {
	/** `<botId>:tg:<ingress>:<chatId>` or with `:<threadId>`. */
	key: string;
	botId?: string;
	/** Telegram user id of the person this chat's `disk/` belongs to. Filled from `from.id`. */
	userId?: number;
	chatId: number;
	threadId?: number;
	conversationId: ConversationId;
};

export const ChatsDoc = defineDoc<{ items: ChatRecord[] }>({
	kind: "pi-bot.telegram.chats",
	version: 1,
	scope: "session",
	initial: () => ({ items: [] }),
});

export type ChatAddress = { chatId: number; threadId?: number };

export type TelegramIngress = "general" | "bot";

/** `default:tg:general:<chatId>` or `default:tg:general:<chatId>:<threadId>`. */
export function chatKey(botId: string, address: ChatAddress, ingress: TelegramIngress = "general"): string {
	const thread = address.threadId === undefined ? "" : `:${address.threadId}`;
	return `${botId}:tg:${ingress}:${address.chatId}${thread}`;
}

/** Chat id and topic encoded in a Telegram chat key. */
export function telegramTarget(key: string): ChatAddress {
	const match = /:tg:(?:general|bot):(-?\d+)(?::(\d+))?$/.exec(key);
	if (!match?.[1]) throw new Error(`Not a Telegram chat key: ${key}`);
	const chatId = Number(match[1]);
	return match[2] === undefined ? { chatId } : { chatId, threadId: Number(match[2]) };
}

/** A key from before bot prefixes: `<chatId>` or `<chatId>:<threadId>`. */
export function isLegacyChatKey(key: string): boolean {
	return !key.includes(":tg:");
}

/** Forum topics get their own conversation; plain reply threads stay in the chat's conversation. */
export function addressOf(message: TgMessage): ChatAddress {
	return message.is_topic_message && message.message_thread_id !== undefined
		? { chatId: message.chat.id, threadId: message.message_thread_id }
		: { chatId: message.chat.id };
}

/**
 * One commit: old keys become `default:tg:general:…` and gain `botId: "default"`. The conversation id stays.
 */
export async function migrateLegacyChats(harness: Harness): Promise<void> {
	await harness.commit(async (tx) => {
		const chats = await tx.doc(ChatsDoc);
		for (const chat of chats.items) {
			if (!isLegacyChatKey(chat.key)) continue;
			chat.key = `${DEFAULT_BOT_ID}:tg:general:${chat.key}`;
			chat.botId = DEFAULT_BOT_ID;
		}
	}, BACKGROUND_CONTEXT);
}

export async function listChats(harness: Harness): Promise<ChatRecord[]> {
	return [...((await harness.snapshot(ChatsDoc, BACKGROUND_CONTEXT))?.items ?? [])];
}

/** Telegram message → user input. Group messages carry the sender so the model can tell people apart. */
export function formatInput(message: TgMessage): string {
	const text = message.text ?? "";
	if (message.chat.type === "private") return text;
	const who = message.from?.username ? `@${message.from.username}` : (message.from?.first_name ?? "someone");
	return `[${who}] ${text}`;
}
