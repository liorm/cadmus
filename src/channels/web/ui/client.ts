import {
	banner,
	botId,
	generalTelegram,
	bots,
	busy,
	chatKey,
	chats,
	contextPercent,
	filePath,
	files,
	fileText,
	liveTools,
	messages,
	narrow,
	notes,
	partial,
	scheduleId,
	saved,
	schedules,
	showList,
	tab,
	type Bot,
	type BotFile,
	type Chat,
	type Chip,
	type HarvestNote,
	type Item,
	type ScheduleRow,
} from "./state.ts";

type StateEvent = { busy: boolean; messages: Item[]; partial?: string; tools?: Chip[]; notes?: HarvestNote[]; contextPercent?: number };

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
	const media = window.matchMedia("(max-width: 700px)");
	narrow.value = media.matches;
	media.addEventListener("change", () => {
		narrow.value = media.matches;
	});
	void Promise.all([loadBots(), loadStatus()])
		.then(() => loadChats())
		.catch((error: Error) => {
			banner.value = error.message;
		});
}

async function loadStatus(): Promise<void> {
	const body = await api<{ telegram?: boolean }>("/api/status");
	generalTelegram.value = Boolean(body.telegram);
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
	files.value = [];
	filePath.value = null;
	fileText.value = "";
	saved.value = "";
	schedules.value = [];
	scheduleId.value = null;
	await loadChats();
}

export function watchChat(key: string): void {
	chatKey.value = key;
	closeWatch();
	messages.value = [];
	notes.value = [];
	partial.value = "";
	liveTools.value = [];
	busy.value = false;
	contextPercent.value = undefined;
	showList.value = false;
	const events = new EventSource(`/api/chats/${encodeURIComponent(key)}/events`);
	source = events;
	events.addEventListener("state", (event) => {
		const data = JSON.parse((event as MessageEvent).data) as StateEvent;
		busy.value = data.busy;
		messages.value = data.messages;
		partial.value = data.partial ?? "";
		liveTools.value = data.tools ?? [];
		if (data.notes) notes.value = data.notes;
		contextPercent.value = data.contextPercent;
	});
	events.addEventListener("harvest", (event) => {
		const note = JSON.parse((event as MessageEvent).data) as HarvestNote;
		if (notes.value.some((item) => item.at === note.at && item.when === note.when)) return;
		notes.value = [...notes.value, note];
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

export async function loadFiles(): Promise<void> {
	const body = await api<{ files: BotFile[] }>(`/api/bots/${encodeURIComponent(botId.value)}/files`);
	files.value = body.files;
	if (!body.files.some((file) => file.path === filePath.value)) filePath.value = body.files[0]?.path ?? null;
	if (filePath.value) await openFile(filePath.value);
}

export async function openFile(path: string): Promise<void> {
	filePath.value = path;
	saved.value = "";
	const body = await api<{ text: string }>(`/api/bots/${encodeURIComponent(botId.value)}/files/${encodeURIComponent(path)}`);
	fileText.value = body.text;
}

export async function saveFile(path: string, text: string): Promise<void> {
	await api(`/api/bots/${encodeURIComponent(botId.value)}/files/${encodeURIComponent(path)}`, {
		method: "PUT",
		body: JSON.stringify({ text }),
	});
	fileText.value = text;
	await loadFiles();
	filePath.value = path;
}

export async function loadSchedules(): Promise<void> {
	const body = await api<{ schedules: ScheduleRow[] }>(`/api/bots/${encodeURIComponent(botId.value)}/schedules`);
	schedules.value = body.schedules;
	if (!body.schedules.some((row) => row.id === scheduleId.value)) scheduleId.value = body.schedules[0]?.id ?? null;
}

export async function saveSchedule(row: { id?: string; text: string; kind: "cron" | "when"; cron?: string; when?: number; target: ScheduleRow["target"] }): Promise<void> {
	if (row.id) {
		await api(`/api/schedules/${encodeURIComponent(row.id)}`, { method: "PUT", body: JSON.stringify(row) });
	} else {
		const created = await api<{ schedule: ScheduleRow }>(`/api/bots/${encodeURIComponent(botId.value)}/schedules`, {
			method: "POST",
			body: JSON.stringify(row),
		});
		scheduleId.value = created.schedule.id;
	}
	await loadSchedules();
}

export async function deleteSchedule(id: string): Promise<void> {
	await api(`/api/schedules/${encodeURIComponent(id)}`, { method: "DELETE" });
	scheduleId.value = null;
	await loadSchedules();
}

export async function runSchedule(id: string): Promise<void> {
	await api(`/api/schedules/${encodeURIComponent(id)}/fire`, { method: "POST", body: "{}" });
	await loadChats();
	await loadSchedules();
}

export async function setTelegramToken(token: string | null): Promise<void> {
	const body = await api<{ telegramConfigured: boolean }>(`/api/bots/${encodeURIComponent(botId.value)}/telegram`, {
		method: "PUT",
		body: JSON.stringify({ token }),
	});
	bots.value = bots.value.map((bot) => (bot.id === botId.value ? { ...bot, telegramConfigured: body.telegramConfigured } : bot));
}

export async function renameChat(title: string): Promise<void> {
	const key = chatKey.value;
	if (!key) return;
	await api(`/api/chats/${encodeURIComponent(key)}`, { method: "PATCH", body: JSON.stringify({ title }) });
	chats.value = chats.value.map((chat) => (chat.key === key ? { ...chat, title } : chat));
}

export async function deleteChat(): Promise<void> {
	const key = chatKey.value;
	if (!key) return;
	await api(`/api/chats/${encodeURIComponent(key)}`, { method: "DELETE" });
	chatKey.value = null;
	showList.value = true;
	await loadChats();
}

export async function createBot(input: { name: string; model: string; thinking: string; tools: string[] }): Promise<void> {
	const body = await api<{ bot: Bot }>("/api/bots", { method: "POST", body: JSON.stringify(input) });
	await loadBots();
	await openBot(body.bot.id);
}
