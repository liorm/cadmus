import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type ConversationId, type Harness } from "@earendil-works/pi-durable";
import { DEFAULT_BOT_ID } from "../bots.ts";
import type { TgMessage } from "./transport.ts";

/** One conversation on a bot: a Telegram chat, a forum topic, or a web chat. */
export type ChatRecord = {
	/** `<botId>:tg:<ingress>:<chatId>` or `<botId>:web:<id>`. */
	key: string;
	botId?: string;
	/** Set from the web page. Absent until the chat is renamed. */
	title?: string;
	/** Telegram user id of the person this chat's `disk/` belongs to. Filled from `from.id`. */
	userId?: number;
	/** Absent for a web chat, which has no Telegram address. */
	chatId?: number;
	threadId?: number;
	conversationId: ConversationId;
};

export const ChatsDoc = defineDoc<{ items: ChatRecord[]; closed?: string[] }>({
	kind: "pi-bot.telegram.chats",
	version: 1,
	scope: "session",
	initial: () => ({ items: [] }),
});

/** The chat was deleted. The conversation log is still there; admission is not. */
export class ChatClosed extends Error {
	constructor(key: string) {
		super(`Chat ${key} is closed`);
		this.name = "ChatClosed";
	}
}

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
	return !key.includes(":tg:") && !key.includes(":web:");
}

const WEB_CHAT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** `<botId>:web:<id>`. */
export function webChatKey(botId: string, id: string): string {
	return `${botId}:web:${id}`;
}

/** The id suffix when `key` is a web chat of `botId`. */
export function webChatId(botId: string, key: string): string | undefined {
	const prefix = `${botId}:web:`;
	if (!key.startsWith(prefix)) return undefined;
	const id = key.slice(prefix.length);
	return WEB_CHAT_ID.test(id) ? id : undefined;
}

export function hasTelegramAddress(chat: ChatRecord): chat is ChatRecord & { chatId: number } {
	return typeof chat.chatId === "number";
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

export async function renameChat(harness: Harness, key: string, title: string): Promise<ChatRecord | undefined> {
	return harness.commit(async (tx) => {
		const chats = await tx.doc(ChatsDoc);
		const chat = chats.items.find((item) => item.key === key);
		if (!chat) return undefined;
		chat.title = title;
		return { ...chat };
	}, BACKGROUND_CONTEXT);
}

/** Drop the row and refuse the key from here on. The conversation log stays. */
export async function closeChat(harness: Harness, key: string): Promise<boolean> {
	return harness.commit(async (tx) => {
		const chats = await tx.doc(ChatsDoc);
		const index = chats.items.findIndex((item) => item.key === key);
		if (index < 0) return false;
		chats.items.splice(index, 1);
		const closed = chats.closed ?? [];
		if (!closed.includes(key)) closed.push(key);
		chats.closed = closed;
		return true;
	}, BACKGROUND_CONTEXT);
}

/** Telegram message → user input. Group messages carry the sender so the model can tell people apart. */
export function formatInput(message: TgMessage): string {
	const text = message.text ?? "";
	if (message.chat.type === "private") return text;
	const who = message.from?.username ? `@${message.from.username}` : (message.from?.first_name ?? "someone");
	return `[${who}] ${text}`;
}
