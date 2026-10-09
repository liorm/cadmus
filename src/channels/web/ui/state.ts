import { signal } from "@preact/signals";

export type Bot = { id: string; name: string; model: string; thinking: string; tools?: string[]; createdAt: number };
export type Chat = { key: string; botId?: string; telegram: boolean };
export type Item =
	| { type: "user"; id: number; text: string }
	| { type: "assistant"; id: number; text: string }
	| { type: "tool"; id: string; name: string; status: string }
	| { type: "notice"; id: number; text: string };
export type Chip = { name: string; status: string };

export const bots = signal<Bot[]>([]);
export const botId = signal("default");
export const chats = signal<Chat[]>([]);
export const chatKey = signal<string | null>(null);
export const messages = signal<Item[]>([]);
export const partial = signal("");
export const liveTools = signal<Chip[]>([]);
export const busy = signal(false);
export const modal = signal(false);
export const tab = signal<"chats" | "knowledge" | "schedules">("chats");
export const banner = signal("");
export const draft = signal("");

export function selectedBot(): Bot | undefined {
	return bots.value.find((bot) => bot.id === botId.value);
}
