import { banner, botId, bots, busy, chatKey, chats, liveTools, messages, partial, tab, type Bot, type Chat, type Chip, type Item } from "./state.ts";

type StateEvent = { busy: boolean; messages: Item[]; partial?: string; tools?: Chip[] };

let source: EventSource | undefined;

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(path, {
		...init,
		credentials: "same-origin",
		headers: { ...(init?.body ? { "content-type": "application/json" } : {}), ...init?.headers },
	});
	const body = (await response.json().catch(() => ({}))) as { error?: string };
	if (!response.ok) throw new Error(body.error ?? response.statusText);
	return body as T;
}

let booted = false;

export function boot(): void {
	if (booted) return;
	booted = true;
	void loadBots()
		.then(() => loadChats())
		.catch((error: Error) => {
			banner.value = error.message;
		});
}

export async function loadBots(): Promise<void> {
	const body = await api<{ bots: Bot[] }>("/api/bots");
	bots.value = body.bots;
	if (!body.bots.some((bot) => bot.id === botId.value)) botId.value = body.bots[0]?.id ?? "default";
}

export async function loadChats(): Promise<void> {
	const body = await api<{ chats: Chat[] }>(`/api/bots/${encodeURIComponent(botId.value)}/chats`);
	chats.value = body.chats;
	if (!body.chats.some((chat) => chat.key === chatKey.value)) chatKey.value = body.chats[0]?.key ?? null;
	if (chatKey.value) watchChat(chatKey.value);
	else closeWatch();
}

export async function openBot(id: string): Promise<void> {
	botId.value = id;
	tab.value = "chats";
	await loadChats();
}

export function watchChat(key: string): void {
	chatKey.value = key;
	closeWatch();
	messages.value = [];
	partial.value = "";
	liveTools.value = [];
	busy.value = false;
	const events = new EventSource(`/api/chats/${encodeURIComponent(key)}/events`);
	source = events;
	events.addEventListener("state", (event) => {
		const data = JSON.parse((event as MessageEvent).data) as StateEvent;
		busy.value = data.busy;
		messages.value = data.messages;
		partial.value = data.partial ?? "";
		liveTools.value = data.tools ?? [];
	});
	events.addEventListener("delta", (event) => {
		partial.value += (JSON.parse((event as MessageEvent).data) as { text: string }).text;
	});
	events.addEventListener("tool", (event) => {
		const chip = JSON.parse((event as MessageEvent).data) as Chip;
		liveTools.value = [...liveTools.value.filter((tool) => tool.name !== chip.name), chip];
	});
	events.addEventListener("done", () => {
		busy.value = false;
	});
	events.addEventListener("error", (event) => {
		if (!(event instanceof MessageEvent) || !event.data) return;
		try {
			banner.value = (JSON.parse(event.data) as { message?: string }).message ?? "Something went wrong.";
		} catch {
			// A connection error has no JSON body.
		}
	});
}

export function closeWatch(): void {
	source?.close();
	source = undefined;
}

export async function createChat(): Promise<void> {
	const body = await api<{ chat: Chat }>(`/api/bots/${encodeURIComponent(botId.value)}/chats`, { method: "POST", body: "{}" });
	await loadChats();
	watchChat(body.chat.key);
}

export async function send(text: string): Promise<void> {
	const key = chatKey.value;
	if (!key) return;
	banner.value = "";
	await api(`/api/chats/${encodeURIComponent(key)}/messages`, {
		method: "POST",
		body: JSON.stringify({ clientMsgId: crypto.randomUUID(), text }),
	});
}

export async function createBot(input: { name: string; model: string; thinking: string; tools: string[] }): Promise<void> {
	const body = await api<{ bot: Bot }>("/api/bots", { method: "POST", body: JSON.stringify(input) });
	await loadBots();
	await openBot(body.bot.id);
}
