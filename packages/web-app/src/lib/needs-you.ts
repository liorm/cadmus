import { chatTitle } from "./format-time";

export type ChatLike = {
	key: string;
	botId: string;
	title?: string;
	closed?: boolean;
	createdAt: number;
};

export type ChatLiveSlice = {
	busy?: boolean;
	failedReason?: string;
	lastUserText?: string;
	lastBotText?: string;
	lastBotAt?: number;
};

export type NeedsYouItem = {
	kind: "failed" | "unread";
	chatKey: string;
	botId: string;
	title: string;
	preview?: string;
	reason?: string;
	lastUserText?: string;
	at: number;
};

export function needsYou(
	chats: ChatLike[],
	states: Record<string, ChatLiveSlice>,
	lastSeen: Record<string, number>,
): NeedsYouItem[] {
	const items: NeedsYouItem[] = [];
	for (const chat of chats) {
		if (chat.closed) continue;
		const state = states[chat.key] ?? {};
		const title = chatTitle(chat, state.lastUserText);
		if (state.failedReason) {
			items.push({
				kind: "failed",
				chatKey: chat.key,
				botId: chat.botId,
				title,
				reason: state.failedReason,
				lastUserText: state.lastUserText,
				at: state.lastBotAt ?? chat.createdAt,
			});
			continue;
		}
		const seen = lastSeen[chat.key];
		const botAt = state.lastBotAt;
		if (botAt !== undefined && (seen === undefined || botAt > seen)) {
			items.push({
				kind: "unread",
				chatKey: chat.key,
				botId: chat.botId,
				title,
				preview: state.lastBotText,
				at: botAt,
			});
		}
	}
	items.sort((a, b) => b.at - a.at);
	return items;
}
