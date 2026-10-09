import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type AgentChange, type ConversationId, configure, defineDoc, type Harness } from "@earendil-works/pi-durable";
import type { TgMessage } from "./transport.ts";

/** One Telegram chat, or one forum topic of a chat, and the durable conversation it talks to. */
export type ChatRecord = {
	/** `<chatId>` or `<chatId>:<topicId>`. */
	key: string;
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

export function chatKey(address: ChatAddress): string {
	return address.threadId === undefined ? String(address.chatId) : `${address.chatId}:${address.threadId}`;
}

/** Forum topics get their own conversation; plain reply threads stay in the chat's conversation. */
export function addressOf(message: TgMessage): ChatAddress {
	return message.is_topic_message && message.message_thread_id !== undefined
		? { chatId: message.chat.id, threadId: message.message_thread_id }
		: { chatId: message.chat.id };
}

/**
 * Find or create the ownerless conversation of a chat (pi-imessage `chatConversation`). Lookup and creation share one
 * commit, so two messages racing for a new chat still get one conversation.
 */
export async function chatConversation(harness: Harness, agent: AgentChange, address: ChatAddress): Promise<ChatRecord> {
	const key = chatKey(address);
	return harness.commit(async (tx) => {
		const chats = await tx.doc(ChatsDoc);
		const existing = chats.items.find((chat) => chat.key === key);
		if (existing) return { ...existing };
		const conversation = await tx.createConversation({ ownership: { kind: "ownerless" } });
		await configure(tx, conversation.id, agent);
		const record: ChatRecord = {
			key,
			chatId: address.chatId,
			...(address.threadId === undefined ? {} : { threadId: address.threadId }),
			conversationId: conversation.id,
		};
		chats.items.push(record);
		return { ...record };
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
