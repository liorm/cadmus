import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	type ConversationId,
	defineDoc,
	type Harness,
} from "@earendil-works/pi-durable";

/** One conversation on a bot: a web chat. */
export type ChatRecord = {
	/** `<botId>:web:<id>`. */
	key: string;
	botId?: string;
	/** Set from the web page. Absent until the chat is renamed. */
	title?: string;
	conversationId: ConversationId;
};

export const ChatsDoc = defineDoc<{ items: ChatRecord[]; closed?: string[] }>({
	kind: "pi-bot.chats",
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

export async function listChats(harness: Harness): Promise<ChatRecord[]> {
	return [
		...((await harness.snapshot(ChatsDoc, BACKGROUND_CONTEXT))?.items ?? []),
	];
}

export async function renameChat(
	harness: Harness,
	key: string,
	title: string,
): Promise<ChatRecord | undefined> {
	return harness.commit(async (tx) => {
		const chats = await tx.doc(ChatsDoc);
		const chat = chats.items.find((item) => item.key === key);
		if (!chat) return undefined;
		chat.title = title;
		return { ...chat };
	}, BACKGROUND_CONTEXT);
}

/** Drop the row and refuse the key from here on. The conversation log stays. */
export async function closeChat(
	harness: Harness,
	key: string,
): Promise<boolean> {
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
