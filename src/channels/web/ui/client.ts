import {
	draftFromRecord,
	knowledgeWriteArgs,
} from "../../../extensions/knowledge-parse.ts";
import {
	type Bot,
	type BotFile,
	banner,
	botId,
	bots,
	busy,
	type Chat,
	type Chip,
	chatKey,
	chats,
	contextPercent,
	filePath,
	files,
	fileText,
	generalTelegram,
	type HarvestNote,
	type Item,
	type KnowledgeRecord,
	knowledgeDraft,
	liveTools,
	type MemoryDraft,
	memoryDraft,
	messages,
	modal,
	narrow,
	notes,
	partial,
	type RawEntry,
	rawEntries,
	rawMode,
	type ScheduleRow,
	saved,
	scheduleId,
	schedules,
	showList,
	tab,
} from "./state.ts";

type StateEvent = {
	busy: boolean;
	messages: Item[];
	partial?: string;
	tools?: Chip[];
	notes?: HarvestNote[];
	contextPercent?: number;
};

let source: EventSource | undefined;

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
	const response = await fetch(path, {
		...init,
		credentials: "same-origin",
		headers: {
			...(init?.body ? { "content-type": "application/json" } : {}),
			...init?.headers,
		},
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
		.then(() => {
			if (botId.value) return loadChats();
		})
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
	if (!body.bots.some((bot) => bot.id === botId.value))
		botId.value = body.bots[0]?.id ?? "";
	if (body.bots.length === 0) modal.value = "create";
}

export async function loadChats(): Promise<void> {
	const body = await api<{ chats: Chat[] }>(
		`/api/bots/${encodeURIComponent(botId.value)}/chats`,
	);
	chats.value = body.chats;
	if (!body.chats.some((chat) => chat.key === chatKey.value))
		chatKey.value = body.chats[0]?.key ?? null;
	if (chatKey.value) watchChat(chatKey.value);
	else closeWatch();
}

export async function openBot(id: string): Promise<void> {
	botId.value = id;
	tab.value = "chats";
	files.value = [];
	filePath.value = null;
	fileText.value = "";
	knowledgeDraft.value = null;
	saved.value = "";
	schedules.value = [];
	scheduleId.value = null;
	await loadChats();
}

export function watchChat(key: string): void {
	chatKey.value = key;
	closeWatch();
	messages.value = [];
	rawEntries.value = [];
	notes.value = [];
	partial.value = "";
	liveTools.value = [];
	busy.value = false;
	contextPercent.value = undefined;
	showList.value = false;
	const events = new EventSource(
		`/api/chats/${encodeURIComponent(key)}/events`,
	);
	source = events;
	events.addEventListener("state", (event) => {
		const data = JSON.parse((event as MessageEvent).data) as StateEvent;
		busy.value = data.busy;
		messages.value = data.messages;
		rememberSnippet(key, data.messages);
		if (rawMode.value) void loadRawEntries(key);
		partial.value = data.partial ?? "";
		liveTools.value = data.tools ?? [];
		if (data.notes) notes.value = data.notes;
		contextPercent.value = data.contextPercent;
	});
	events.addEventListener("harvest", (event) => {
		const note = JSON.parse((event as MessageEvent).data) as HarvestNote;
		if (
			notes.value.some((item) => item.at === note.at && item.when === note.when)
		)
			return;
		notes.value = [...notes.value, note];
	});
	events.addEventListener("delta", (event) => {
		partial.value += (
			JSON.parse((event as MessageEvent).data) as { text: string }
		).text;
	});
	events.addEventListener("tool", (event) => {
		const chip = JSON.parse((event as MessageEvent).data) as Chip;
		liveTools.value = [
			...liveTools.value.filter(
				(tool) => tool.detail?.callId !== chip.detail?.callId,
			),
			chip,
		];
	});
	events.addEventListener("done", () => {
		busy.value = false;
	});
	events.addEventListener("error", (event) => {
		if (!(event instanceof MessageEvent) || !event.data) return;
		try {
			banner.value =
				(JSON.parse(event.data) as { message?: string }).message ??
				"Something went wrong.";
		} catch {
			// A connection error has no JSON body.
		}
	});
}

function rememberSnippet(key: string, items: Item[]): void {
	const opening = items.find((item) => item.type === "user");
	const last = [...items].reverse().find((item) => item.type !== "tool");
	chats.value = chats.value.map((chat) => {
		if (chat.key !== key) return chat;
		return {
			...chat,
			...(opening && opening.type === "user" ? { opening: opening.text } : {}),
			...(last && "text" in last && last.text ? { preview: last.text } : {}),
		};
	});
}

export function closeWatch(): void {
	source?.close();
	source = undefined;
}

export async function createChat(): Promise<void> {
	const body = await api<{ chat: Chat }>(
		`/api/bots/${encodeURIComponent(botId.value)}/chats`,
		{ method: "POST", body: "{}" },
	);
	await loadChats();
	watchChat(body.chat.key);
}

/** Id for one send. `randomUUID` is missing on http:// pages that are not localhost. */
function clientMessageId(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
		"",
	);
}

export async function loadRawEntries(key = chatKey.value): Promise<void> {
	if (!key) return;
	const body = await api<{ entries: RawEntry[] }>(
		`/api/chats/${encodeURIComponent(key)}/entries`,
	);
	if (chatKey.value !== key) return;
	rawEntries.value = body.entries;
}

export async function showRaw(on: boolean): Promise<void> {
	rawMode.value = on;
	if (on) await loadRawEntries();
}

export async function send(text: string): Promise<void> {
	const key = chatKey.value;
	if (!key) return;
	banner.value = "";
	await api(`/api/chats/${encodeURIComponent(key)}/messages`, {
		method: "POST",
		body: JSON.stringify({ clientMsgId: clientMessageId(), text }),
	});
}

export async function loadFiles(): Promise<void> {
	const body = await api<{ files: BotFile[] }>(
		`/api/bots/${encodeURIComponent(botId.value)}/files`,
	);
	files.value = body.files;
	if (!body.files.some((file) => file.path === filePath.value))
		filePath.value = body.files[0]?.path ?? null;
	if (filePath.value) await openFile(filePath.value);
}

export async function openFile(path: string): Promise<void> {
	filePath.value = path;
	saved.value = "";
	if (path.startsWith("knowledge/")) {
		knowledgeDraft.value = null;
		memoryDraft.value = null;
		fileText.value = "";
		const body = await api<KnowledgeRecord>(
			`/api/bots/${encodeURIComponent(botId.value)}/files/${encodeURIComponent(path)}`,
		);
		knowledgeDraft.value = draftFromRecord(body);
		return;
	}
	if (path === "MEMORY.md") {
		knowledgeDraft.value = null;
		fileText.value = "";
		const body = await api<MemoryDraft & { exists?: boolean }>(
			`/api/bots/${encodeURIComponent(botId.value)}/files/${encodeURIComponent(path)}`,
		);
		memoryDraft.value = { version: body.version, body: body.body };
		return;
	}
	knowledgeDraft.value = null;
	memoryDraft.value = null;
	const body = await api<{ text: string }>(
		`/api/bots/${encodeURIComponent(botId.value)}/files/${encodeURIComponent(path)}`,
	);
	fileText.value = body.text;
}

export async function saveFile(path: string, text: string): Promise<void> {
	await api(
		`/api/bots/${encodeURIComponent(botId.value)}/files/${encodeURIComponent(path)}`,
		{
			method: "PUT",
			body: JSON.stringify({ text }),
		},
	);
	fileText.value = text;
	await loadFiles();
	filePath.value = path;
}

export async function saveMemory(): Promise<void> {
	const draft = memoryDraft.value;
	if (!draft) return;
	const body = await api<MemoryDraft>(
		`/api/bots/${encodeURIComponent(botId.value)}/files/MEMORY.md`,
		{
			method: "PUT",
			body: JSON.stringify({ version: draft.version, body: draft.body }),
		},
	);
	filePath.value = "MEMORY.md";
	memoryDraft.value = { version: body.version, body: body.body };
	await loadFiles();
	filePath.value = "MEMORY.md";
	memoryDraft.value = { version: body.version, body: body.body };
}

export async function saveKnowledge(): Promise<void> {
	const draft = knowledgeDraft.value;
	if (!draft) return;
	const path = `knowledge/${draft.slug}.md`;
	const body = await api<KnowledgeRecord>(
		`/api/bots/${encodeURIComponent(botId.value)}/files/${encodeURIComponent(path)}`,
		{
			method: "PUT",
			body: JSON.stringify(knowledgeWriteArgs(draft)),
		},
	);
	filePath.value = path;
	knowledgeDraft.value = draftFromRecord(body);
	await loadFiles();
	filePath.value = path;
	knowledgeDraft.value = draftFromRecord(body);
}

export async function loadSchedules(): Promise<void> {
	const body = await api<{ schedules: ScheduleRow[] }>(
		`/api/bots/${encodeURIComponent(botId.value)}/schedules`,
	);
	schedules.value = body.schedules;
	if (!body.schedules.some((row) => row.id === scheduleId.value))
		scheduleId.value = body.schedules[0]?.id ?? null;
}

export async function saveSchedule(row: {
	id?: string;
	text: string;
	kind: "cron" | "when";
	cron?: string;
	when?: number;
	target: ScheduleRow["target"];
}): Promise<void> {
	if (row.id) {
		await api(`/api/schedules/${encodeURIComponent(row.id)}`, {
			method: "PUT",
			body: JSON.stringify(row),
		});
	} else {
		const created = await api<{ schedule: ScheduleRow }>(
			`/api/bots/${encodeURIComponent(botId.value)}/schedules`,
			{
				method: "POST",
				body: JSON.stringify(row),
			},
		);
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
	await api(`/api/schedules/${encodeURIComponent(id)}/run`, {
		method: "POST",
		body: "{}",
	});
	await loadChats();
	await loadSchedules();
}

export async function setTelegramToken(token: string | null): Promise<void> {
	const body = await api<{ telegramConfigured: boolean }>(
		`/api/bots/${encodeURIComponent(botId.value)}/telegram`,
		{
			method: "PUT",
			body: JSON.stringify({ token }),
		},
	);
	bots.value = bots.value.map((bot) =>
		bot.id === botId.value
			? { ...bot, telegramConfigured: body.telegramConfigured }
			: bot,
	);
}

export async function renameChat(title: string): Promise<void> {
	const key = chatKey.value;
	if (!key) return;
	await api(`/api/chats/${encodeURIComponent(key)}`, {
		method: "PATCH",
		body: JSON.stringify({ title }),
	});
	chats.value = chats.value.map((chat) =>
		chat.key === key ? { ...chat, title } : chat,
	);
}

export async function deleteChat(): Promise<void> {
	const key = chatKey.value;
	if (!key) return;
	await api(`/api/chats/${encodeURIComponent(key)}`, { method: "DELETE" });
	chatKey.value = null;
	showList.value = true;
	await loadChats();
}

export async function loadToolCatalog(): Promise<
	{ group: string; name: string }[]
> {
	const body = await api<{ catalog: { group: string; name: string }[] }>(
		"/api/tools",
	);
	return body.catalog;
}

export async function loadModels(): Promise<
	{ id: string; models: string[] }[]
> {
	const body = await api<{ providers: { id: string; models: string[] }[] }>(
		"/api/models",
	);
	return body.providers;
}

export async function readBotText(path: string): Promise<string> {
	const body = await api<{ text: string }>(
		`/api/bots/${encodeURIComponent(botId.value)}/files/${encodeURIComponent(path)}`,
	);
	return body.text;
}

export async function writeBotText(path: string, text: string): Promise<void> {
	await api(
		`/api/bots/${encodeURIComponent(botId.value)}/files/${encodeURIComponent(path)}`,
		{
			method: "PUT",
			body: JSON.stringify({ text }),
		},
	);
	if (filePath.value === path) fileText.value = text;
}

export async function updateBot(input: {
	name: string;
	model: string;
	thinking: string;
	tools: string[];
}): Promise<void> {
	const body = await api<{ bot: Bot }>(
		`/api/bots/${encodeURIComponent(botId.value)}`,
		{
			method: "PATCH",
			body: JSON.stringify(input),
		},
	);
	bots.value = bots.value.map((bot) =>
		bot.id === body.bot.id ? { ...bot, ...body.bot } : bot,
	);
}

export async function createBot(input: {
	name: string;
	model: string;
	thinking: string;
	tools: string[];
	soul: string;
	token?: string;
}): Promise<void> {
	const { token, ...row } = input;
	const body = await api<{ bot: Bot }>("/api/bots", {
		method: "POST",
		body: JSON.stringify(row),
	});
	await loadBots();
	await openBot(body.bot.id);
	if (token) await setTelegramToken(token);
}
