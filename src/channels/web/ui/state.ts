import { signal } from "@preact/signals";

export type Bot = {
	id: string;
	name: string;
	model: string;
	thinking: string;
	tools?: string[];
	createdAt: number;
	telegramConfigured?: boolean;
};
export type Chat = {
	key: string;
	botId?: string;
	telegram: boolean;
	title?: string;
	/** First user message, when the chat has no stored title. */
	opening?: string;
	/** Latest user, assistant, or notice text. */
	preview?: string;
};
export type Item =
	| { type: "user"; id: number; text: string }
	| { type: "assistant"; id: number; text: string }
	| { type: "tool"; id: string; name: string; status: string }
	| { type: "notice"; id: number; text: string };
export type Chip = { name: string; status: string };
export type HarvestNote = {
	at: number;
	when: number;
	files: { path: string; diff: string }[];
};
export type BotFile = {
	path: string;
	description?: string | null;
	valid?: boolean;
	text?: string;
};
export type ScheduleRow = {
	id: string;
	botId: string;
	text: string;
	nextRun?: number;
	target: { mode: "chat" | "new-chat" | "fork"; chatId?: string };
} & ({ kind: "cron"; cron: string } | { kind: "when"; when: number });

/** General env door (`TELEGRAM_BOT_TOKEN`). Separate from a token stored on a bot. */
export const generalTelegram = signal(false);
export const bots = signal<Bot[]>([]);
export const botId = signal("");
export const chats = signal<Chat[]>([]);
export const chatKey = signal<string | null>(null);
export const messages = signal<Item[]>([]);
export type RawEntry = {
	id: number;
	kind: string;
	model?: unknown;
	data?: unknown;
	head?: number;
	edits?: unknown;
	byTaskId?: number;
};
export const rawMode = signal(false);
export const rawEntries = signal<RawEntry[]>([]);
export const notes = signal<HarvestNote[]>([]);
export const partial = signal("");
export const liveTools = signal<Chip[]>([]);
export const busy = signal(false);
export const modal = signal<null | "create" | "edit">(null);
export const tab = signal<"chats" | "knowledge" | "schedules">("chats");
export const banner = signal("");
export const saved = signal("");
export const draft = signal("");
export const contextPercent = signal<number | undefined>(undefined);
export const files = signal<BotFile[]>([]);
export const filePath = signal<string | null>(null);
export const fileText = signal("");
export const schedules = signal<ScheduleRow[]>([]);
export const scheduleId = signal<string | null>(null);
export const narrow = signal(false);
export const showList = signal(true);
export const openNote = signal<number | null>(null);

export function selectedBot(): Bot | undefined {
	return bots.value.find((bot) => bot.id === botId.value);
}
