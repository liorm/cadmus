import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import {
	type ConversationId,
	type Cursor,
	type EntryRecord,
	type Harness,
	LiveDoc,
	type RegistryReader,
} from "@earendil-works/pi-durable";
import type { Config } from "../../config.ts";
import {
	checkModel,
	parseModelRef,
	THINKING_LEVELS,
} from "../../harness/models.ts";
import { resolvedEnabled, syncChatTools } from "../../harness/tool-policy.ts";
import { type HarvestNote, HarvestNotesDoc } from "../../harvest/notes.ts";
import type { BotRuntime } from "../../runtime.ts";
import { parseCron } from "../../schedules/cron.ts";
import {
	type Schedule,
	ScheduleRejected,
	type ScheduleService,
	type ScheduleTarget,
} from "../../schedules/service.ts";

function isHarvestId(id: string): boolean {
	return id.startsWith("harvest:");
}

import {
	isToolName,
	OFFERED_PROVIDERS,
	toolCatalog,
	toolNames,
} from "../bot-catalog.ts";
import {
	type BotWrite,
	createBot,
	listBots,
	publicBot,
	updateBot,
} from "../bots.ts";
import {
	ChatClosed,
	closeChat,
	hasTelegramAddress,
	listChats,
	renameChat,
	webChatKey,
} from "../telegram/chats.ts";
import { handleCommand, parseCommand } from "../telegram/commands.ts";
import type { Deliverer } from "../telegram/deliver.ts";
import { chatEventResponse } from "./events.ts";
import {
	knowledgeSlugFromRel,
	listBotFiles,
	readBotFile,
	readBotKnowledge,
	readBotMemory,
	writeBotFile,
	writeBotKnowledge,
	writeBotMemory,
} from "./files.ts";
import {
	latestTranscriptText,
	openingTranscriptText,
	projectEntries,
	type TranscriptItem,
} from "./transcript.ts";

const WEB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export type WebDeps = {
	config: Config;
	models: MutableModels;
	harness: Harness;
	registry: RegistryReader;
	deliverer: Deliverer;
	ensureRuntime(botId: string): BotRuntime | undefined;
	addRuntime(bot: {
		id: string;
		name: string;
		model: string;
		thinking: string;
		tools?: string[];
		telegramToken?: string;
		createdAt: number;
	}): BotRuntime;
	schedules: ScheduleService;
	/** Store the token and start or stop that bot's getUpdates loop. */
	setTelegramDoor(
		botId: string,
		token: string | null,
	): Promise<{ telegramConfigured: boolean } | undefined>;
};

export async function handleApi(
	request: Request,
	deps: WebDeps,
): Promise<Response> {
	const url = new URL(request.url);
	const path = url.pathname;
	if (path === "/api/status" && request.method === "GET") {
		return Response.json({
			telegram: Boolean(deps.config.telegram.token),
		});
	}
	if (path === "/api/bots" && request.method === "GET")
		return Response.json({
			bots: (await listBots(deps.harness)).map(publicBot),
		});
	if (path === "/api/models" && request.method === "GET")
		return Response.json({ providers: offeredModels(deps.models) });
	if (path === "/api/tools" && request.method === "GET")
		return Response.json({ catalog: toolCatalog(deps.registry) });
	if (path === "/api/bots" && request.method === "POST")
		return create(request, deps);

	const chats = /^\/api\/bots\/([^/]+)\/chats$/.exec(path);
	if (chats?.[1]) {
		const id = decodeURIComponent(chats[1]);
		if (request.method === "GET") return listBotChats(deps, id);
		if (request.method === "POST") return createChat(request, deps, id);
	}
	const files = /^\/api\/bots\/([^/]+)\/files$/.exec(path);
	if (files?.[1] && request.method === "GET")
		return listFiles(deps, decodeURIComponent(files[1]));
	const oneFile = /^\/api\/bots\/([^/]+)\/files\/(.+)$/.exec(path);
	if (oneFile?.[1] && oneFile[2]) {
		const id = decodeURIComponent(oneFile[1]);
		const rel = decodeURIComponent(oneFile[2]);
		if (request.method === "GET") return readFileRoute(deps, id, rel);
		if (request.method === "PUT") return writeFileRoute(request, deps, id, rel);
	}
	const schedules = /^\/api\/bots\/([^/]+)\/schedules$/.exec(path);
	if (schedules?.[1]) {
		const id = decodeURIComponent(schedules[1]);
		if (request.method === "GET") return listSchedules(deps, id);
		if (request.method === "POST") return createSchedule(request, deps, id);
	}
	const tools = /^\/api\/bots\/([^/]+)\/tools$/.exec(path);
	if (tools?.[1]) {
		const id = decodeURIComponent(tools[1]);
		if (request.method === "GET") return getBotTools(deps, id);
		if (request.method === "PUT") return putBotTools(request, deps, id);
	}
	const door = /^\/api\/bots\/([^/]+)\/telegram$/.exec(path);
	if (door?.[1] && request.method === "PUT")
		return putTelegram(request, deps, decodeURIComponent(door[1]));

	const one = /^\/api\/bots\/([^/]+)$/.exec(path);
	if (one?.[1] && request.method === "PATCH")
		return patchBot(request, deps, decodeURIComponent(one[1]));

	const schedule = /^\/api\/schedules\/([^/]+)$/.exec(path);
	if (schedule?.[1]) {
		const id = decodeURIComponent(schedule[1]);
		if (request.method === "PUT") return replaceSchedule(request, deps, id);
		if (request.method === "DELETE") return deleteSchedule(deps, id);
	}

	const chat = /^\/api\/chats\/([^/]+)$/.exec(path);
	if (chat?.[1]) {
		const key = decodeURIComponent(chat[1]);
		if (request.method === "PATCH") return patchChat(request, deps, key);
		if (request.method === "DELETE") return deleteChat(deps, key);
	}

	const messages = /^\/api\/chats\/([^/]+)\/messages$/.exec(path);
	if (messages?.[1]) {
		const key = decodeURIComponent(messages[1]);
		if (request.method === "GET") return getMessages(deps, key);
		if (request.method === "POST") return postMessage(request, deps, key);
	}
	const entries = /^\/api\/chats\/([^/]+)\/entries$/.exec(path);
	if (entries?.[1] && request.method === "GET")
		return getEntries(deps, decodeURIComponent(entries[1]));
	const events = /^\/api\/chats\/([^/]+)\/events$/.exec(path);
	if (events?.[1] && request.method === "GET")
		return streamEvents(request, deps, decodeURIComponent(events[1]));

	return Response.json({ error: "Not found." }, { status: 404 });
}

async function create(request: Request, deps: WebDeps): Promise<Response> {
	const body = await readJson(request);
	if (body === undefined)
		return Response.json({ error: "Expected JSON." }, { status: 400 });
	const parsed = parseBotWrite(body, deps, true);
	if (!parsed.ok)
		return Response.json({ error: parsed.error }, { status: parsed.status });
	const unusable = await modelFailure(deps.models, parsed.write.model);
	if (unusable) return Response.json({ error: unusable }, { status: 422 });
	const created = await createBot(
		deps.harness,
		deps.config.home,
		parsed.write,
		toolNames(deps.registry),
	);
	if (!created.ok)
		return Response.json({ error: created.error }, { status: created.status });
	deps.addRuntime(created.bot);
	return Response.json({ bot: publicBot(created.bot) }, { status: 201 });
}

async function patchBot(
	request: Request,
	deps: WebDeps,
	id: string,
): Promise<Response> {
	const body = await readJson(request);
	if (
		body === undefined ||
		!body ||
		typeof body !== "object" ||
		Array.isArray(body)
	)
		return Response.json({ error: "Expected JSON." }, { status: 400 });
	const record = body as Record<string, unknown>;
	if (
		record.name === undefined &&
		record.model === undefined &&
		record.thinking === undefined &&
		record.tools === undefined
	) {
		return Response.json({ error: "Nothing to update." }, { status: 400 });
	}
	const parsed = parseBotWrite(record, deps, false);
	if (!parsed.ok)
		return Response.json({ error: parsed.error }, { status: parsed.status });
	if (parsed.write.model) {
		const unusable = await modelFailure(deps.models, parsed.write.model);
		if (unusable) return Response.json({ error: unusable }, { status: 422 });
	}
	const updated = await updateBot(
		deps.harness,
		id,
		parsed.write,
		toolNames(deps.registry),
	);
	if (!updated.ok)
		return Response.json({ error: updated.error }, { status: updated.status });
	deps.ensureRuntime(id)?.refresh(updated.bot);
	if (parsed.write.tools !== undefined)
		await syncBotChats(deps, id, updated.bot);
	return Response.json({ bot: publicBot(updated.bot) });
}

async function syncBotChats(
	deps: WebDeps,
	id: string,
	bot: { tools?: string[] },
): Promise<void> {
	const chats = (await listChats(deps.harness)).filter(
		(chat) => chat.botId === id,
	);
	for (const chat of chats) {
		// A running turn already admitted its tool list. Leave that list so the
		// tool gate can refuse a call that was offered, and sync on the next submit.
		const live = await deps.harness.snapshot(
			LiveDoc,
			chat.conversationId,
			BACKGROUND_CONTEXT,
		);
		if (live?.run) continue;
		await syncChatTools(deps.harness, chat.conversationId, bot, deps.registry);
	}
}

async function getBotTools(deps: WebDeps, id: string): Promise<Response> {
	const bot = (await listBots(deps.harness)).find((item) => item.id === id);
	if (!bot) return Response.json({ error: "No such bot." }, { status: 404 });
	return Response.json({
		catalog: toolCatalog(deps.registry),
		enabled: resolvedEnabled(bot, deps.registry),
	});
}

async function putBotTools(
	request: Request,
	deps: WebDeps,
	id: string,
): Promise<Response> {
	const body = await readJson(request);
	if (!body || typeof body !== "object" || Array.isArray(body))
		return Response.json({ error: "Expected JSON." }, { status: 400 });
	const enabled = (body as { enabled?: unknown }).enabled;
	if (
		!Array.isArray(enabled) ||
		enabled.some(
			(tool) => typeof tool !== "string" || !isToolName(deps.registry, tool),
		)
	)
		return Response.json({ error: "Unknown tool." }, { status: 422 });
	const updated = await updateBot(
		deps.harness,
		id,
		{ tools: enabled as string[] },
		toolNames(deps.registry),
	);
	if (!updated.ok)
		return Response.json({ error: updated.error }, { status: updated.status });
	deps.ensureRuntime(id)?.refresh(updated.bot);
	await syncBotChats(deps, id, updated.bot);
	return Response.json({
		catalog: toolCatalog(deps.registry),
		enabled: resolvedEnabled(updated.bot, deps.registry),
	});
}

async function listBotChats(deps: WebDeps, id: string): Promise<Response> {
	const runtime = deps.ensureRuntime(id);
	if (!runtime)
		return Response.json({ error: "No such bot." }, { status: 404 });
	const chats = await runtime.listChats();
	const listed = [];
	for (const chat of chats) {
		const snippets = await chatSnippets(deps.harness, chat.conversationId);
		listed.push({
			key: chat.key,
			botId: chat.botId,
			telegram: hasTelegramAddress(chat),
			...(chat.title ? { title: chat.title } : {}),
			...(snippets.opening ? { opening: snippets.opening } : {}),
			...(snippets.preview ? { preview: snippets.preview } : {}),
		});
	}
	return Response.json({ chats: listed });
}

/** First user line and latest visible line, for the chat list. */
async function chatSnippets(
	harness: Harness,
	conversationId: ConversationId,
): Promise<{ opening?: string; preview?: string }> {
	const conversation = await harness.conversation(
		conversationId,
		BACKGROUND_CONTEXT,
	);
	if (!conversation) return {};
	const newest = await conversation.entries(
		{ order: "descending" },
		40,
		undefined,
		BACKGROUND_CONTEXT,
	);
	const oldest = await conversation.entries(
		{ order: "ascending" },
		40,
		undefined,
		BACKGROUND_CONTEXT,
	);
	const preview = oneLine(latestTranscriptText([...newest.items].reverse()));
	const opening = oneLine(openingTranscriptText(oldest.items));
	return {
		...(opening ? { opening } : {}),
		...(preview ? { preview } : {}),
	};
}

function oneLine(text: string | undefined): string | undefined {
	const line = text?.replace(/\s+/g, " ").trim();
	if (!line) return undefined;
	return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}

async function createChat(
	request: Request,
	deps: WebDeps,
	id: string,
): Promise<Response> {
	const runtime = deps.ensureRuntime(id);
	if (!runtime)
		return Response.json({ error: "No such bot." }, { status: 404 });
	const body = await readJson(request);
	if (body === undefined)
		return Response.json({ error: "Expected JSON." }, { status: 400 });
	const requested =
		body && typeof body === "object" && !Array.isArray(body)
			? (body as { chatId?: unknown }).chatId
			: undefined;
	let chatId: string;
	if (requested === undefined) chatId = newChatId();
	else if (typeof requested === "string" && WEB_ID.test(requested))
		chatId = requested;
	else
		return Response.json(
			{ error: "chatId is not a web chat id." },
			{ status: 400 },
		);
	try {
		const chat = await runtime.createChat(webChatKey(id, chatId));
		return Response.json(
			{
				chat: {
					key: chat.key,
					botId: chat.botId,
					telegram: false,
					...(chat.title ? { title: chat.title } : {}),
				},
			},
			{ status: 201 },
		);
	} catch (error) {
		if (error instanceof ChatClosed)
			return Response.json({ error: "No such chat." }, { status: 404 });
		throw error;
	}
}

async function conversationEntries(
	deps: WebDeps,
	key: string,
): Promise<EntryRecord[] | undefined> {
	const chat = (await listChats(deps.harness)).find((item) => item.key === key);
	if (!chat) return undefined;
	const conversation = await deps.harness.conversation(
		chat.conversationId,
		BACKGROUND_CONTEXT,
	);
	if (!conversation) return undefined;
	const entries: EntryRecord[] = [];
	let cursor: Cursor | undefined;
	do {
		const page = await conversation.entries(
			{ order: "ascending" },
			200,
			cursor,
			BACKGROUND_CONTEXT,
		);
		entries.push(...page.items);
		cursor = page.next;
	} while (cursor);
	return entries;
}

async function getMessages(deps: WebDeps, key: string): Promise<Response> {
	const entries = await conversationEntries(deps, key);
	if (!entries)
		return Response.json({ error: "No such chat." }, { status: 404 });
	const notes = (
		(await deps.harness.snapshot(HarvestNotesDoc, BACKGROUND_CONTEXT))?.notes ??
		[]
	).filter((note) => note.chatKey === key);
	return Response.json({
		messages: mergeTimeline(projectEntries(entries), notes),
	});
}

/** Every stored entry, including system, reset, and tool-result rows the chat view omits. */
async function getEntries(deps: WebDeps, key: string): Promise<Response> {
	const entries = await conversationEntries(deps, key);
	if (!entries)
		return Response.json({ error: "No such chat." }, { status: 404 });
	return Response.json({ entries });
}

async function postMessage(
	request: Request,
	deps: WebDeps,
	key: string,
): Promise<Response> {
	const body = await readJson(request);
	if (
		body === undefined ||
		!body ||
		typeof body !== "object" ||
		Array.isArray(body)
	)
		return Response.json({ error: "Expected JSON." }, { status: 400 });
	const record = body as { clientMsgId?: unknown; text?: unknown };
	const clientMsgId =
		typeof record.clientMsgId === "string" ? record.clientMsgId.trim() : "";
	if (!clientMsgId || clientMsgId.length > 128 || /\s/.test(clientMsgId))
		return Response.json({ error: "clientMsgId is missing." }, { status: 400 });
	if (typeof record.text !== "string" || !record.text.trim())
		return Response.json({ error: "text is missing." }, { status: 400 });
	const chat = (await listChats(deps.harness)).find((item) => item.key === key);
	if (!chat?.botId)
		return Response.json({ error: "No such chat." }, { status: 404 });
	const runtime = deps.ensureRuntime(chat.botId);
	if (!runtime)
		return Response.json({ error: "No such chat." }, { status: 404 });
	const requestId = `${chat.key}:${clientMsgId}`;
	const command = parseCommand(record.text);
	if (command) {
		await handleCommand(command, {
			harness: deps.harness,
			deliverer: deps.deliverer,
			chat,
			requestKey: requestId,
		});
		return Response.json({ ok: true });
	}
	await runtime.submit(chat.key, requestId, record.text);
	return Response.json({ ok: true });
}

async function streamEvents(
	request: Request,
	deps: WebDeps,
	key: string,
): Promise<Response> {
	const chat = (await listChats(deps.harness)).find((item) => item.key === key);
	if (!chat) return Response.json({ error: "No such chat." }, { status: 404 });
	return chatEventResponse(
		deps.harness,
		chat.conversationId,
		chat.key,
		request.signal,
		deps.models,
	);
}

async function listFiles(deps: WebDeps, id: string): Promise<Response> {
	if (!deps.ensureRuntime(id))
		return Response.json({ error: "No such bot." }, { status: 404 });
	const files = await listBotFiles(deps.config.home, id);
	if (!files) return Response.json({ error: "No such bot." }, { status: 404 });
	return Response.json({ files });
}

async function readFileRoute(
	deps: WebDeps,
	id: string,
	rel: string,
): Promise<Response> {
	if (!deps.ensureRuntime(id))
		return Response.json({ error: "No such bot." }, { status: 404 });
	if (rel === "MEMORY.md") {
		const file = await readBotMemory(deps.config.home, id);
		if (!file.ok)
			return Response.json({ error: file.error }, { status: file.status });
		return Response.json(file.record);
	}
	const slug = knowledgeSlugFromRel(rel);
	if (slug) {
		const file = await readBotKnowledge(deps.config.home, id, slug);
		if (!file.ok)
			return Response.json({ error: file.error }, { status: file.status });
		return Response.json(file.record);
	}
	const file = await readBotFile(deps.config.home, id, rel);
	if (!file.ok)
		return Response.json({ error: file.error }, { status: file.status });
	return Response.json({ text: file.text });
}

async function writeFileRoute(
	request: Request,
	deps: WebDeps,
	id: string,
	rel: string,
): Promise<Response> {
	if (!deps.ensureRuntime(id))
		return Response.json({ error: "No such bot." }, { status: 404 });
	const body = await readJson(request);
	if (!body || typeof body !== "object" || Array.isArray(body))
		return Response.json({ error: "Expected JSON." }, { status: 400 });
	const record = body as Record<string, unknown>;
	if (rel === "MEMORY.md") {
		if (typeof record.text === "string")
			return Response.json(
				{ error: "MEMORY.md writes take body and version." },
				{ status: 400 },
			);
		const written = await writeBotMemory(deps.config.home, id, record);
		if (!written.ok)
			return Response.json(
				{ error: written.error },
				{ status: written.status },
			);
		return Response.json(written.record);
	}
	const slug = knowledgeSlugFromRel(rel);
	if (slug) {
		if (typeof record.text === "string")
			return Response.json(
				{ error: "Knowledge writes take description, body, and version." },
				{ status: 400 },
			);
		const written = await writeBotKnowledge(deps.config.home, id, slug, record);
		if (!written.ok)
			return Response.json(
				{ error: written.error },
				{ status: written.status },
			);
		return Response.json(written.record);
	}
	if (typeof record.text !== "string")
		return Response.json({ error: "Expected JSON." }, { status: 400 });
	const written = await writeBotFile(deps.config.home, id, rel, record.text);
	if (!written.ok)
		return Response.json({ error: written.error }, { status: written.status });
	return Response.json({ ok: true });
}

async function listSchedules(deps: WebDeps, id: string): Promise<Response> {
	if (!deps.ensureRuntime(id))
		return Response.json({ error: "No such bot." }, { status: 404 });
	const schedules = (await deps.schedules.list(id)).filter(
		(schedule) => !isHarvestId(schedule.id),
	);
	return Response.json({ schedules });
}

async function createSchedule(
	request: Request,
	deps: WebDeps,
	id: string,
): Promise<Response> {
	if (!deps.ensureRuntime(id))
		return Response.json({ error: "No such bot." }, { status: 404 });
	const parsed = await parseScheduleBody(request, deps, id);
	if (!parsed.ok)
		return Response.json({ error: parsed.error }, { status: parsed.status });
	const schedule = {
		...parsed.schedule,
		id: `u-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
	};
	try {
		return Response.json(
			{ schedule: await saveSchedule(deps, schedule) },
			{ status: 201 },
		);
	} catch (error) {
		if (error instanceof ScheduleRejected)
			return Response.json({ error: error.message }, { status: 422 });
		throw error;
	}
}

async function replaceSchedule(
	request: Request,
	deps: WebDeps,
	id: string,
): Promise<Response> {
	if (isHarvestId(id))
		return Response.json({ error: "No such schedule." }, { status: 404 });
	const existing = (await deps.schedules.list()).find((item) => item.id === id);
	if (!existing)
		return Response.json({ error: "No such schedule." }, { status: 404 });
	const parsed = await parseScheduleBody(request, deps, existing.botId);
	if (!parsed.ok)
		return Response.json({ error: parsed.error }, { status: parsed.status });
	const schedule = { ...parsed.schedule, id };
	if (!parsed.hasName) schedule.name = existing.name;
	if (!parsed.hasEnabled) schedule.enabled = existing.enabled;
	try {
		return Response.json({
			schedule: await saveSchedule(deps, schedule, "replace"),
		});
	} catch (error) {
		if (error instanceof ScheduleRejected)
			return Response.json({ error: error.message }, { status: 422 });
		throw error;
	}
}

/**
 * A one-shot whose time has passed fires as soon as it is saved, and the row
 * is gone before a later read. The response is the row that was written.
 */
async function saveSchedule(
	deps: WebDeps,
	schedule: Schedule,
	ifExists?: "replace",
): Promise<Schedule> {
	const nextRun = deps.schedules.nextRun(schedule);
	await deps.schedules.put(
		{ ...schedule, nextRun },
		ifExists ? { ifExists, nextRun } : { nextRun },
	);
	return presentSchedule({ ...schedule, nextRun });
}

function presentSchedule(schedule: Schedule): Schedule {
	const name = schedule.name?.trim() ? schedule.name.trim() : undefined;
	return {
		...schedule,
		...(name ? { name } : { name: undefined }),
		...(schedule.enabled === false
			? { enabled: false }
			: { enabled: undefined }),
	};
}

async function deleteSchedule(deps: WebDeps, id: string): Promise<Response> {
	if (isHarvestId(id))
		return Response.json({ error: "No such schedule." }, { status: 404 });
	const existing = (await deps.schedules.list()).find((item) => item.id === id);
	if (!existing)
		return Response.json({ error: "No such schedule." }, { status: 404 });
	await deps.schedules.remove(id);
	return Response.json({ ok: true });
}

async function putTelegram(
	request: Request,
	deps: WebDeps,
	id: string,
): Promise<Response> {
	const body = await readJson(request);
	if (
		!body ||
		typeof body !== "object" ||
		Array.isArray(body) ||
		!("token" in body)
	)
		return Response.json({ error: "Expected JSON." }, { status: 400 });
	const token = (body as { token: unknown }).token;
	if (token !== null && typeof token !== "string")
		return Response.json({ error: "Expected JSON." }, { status: 400 });
	const door = await deps.setTelegramDoor(
		id,
		token === null || token.trim() === "" ? null : token.trim(),
	);
	if (!door) return Response.json({ error: "No such bot." }, { status: 404 });
	return Response.json(door);
}

async function patchChat(
	request: Request,
	deps: WebDeps,
	key: string,
): Promise<Response> {
	const body = await readJson(request);
	if (!body || typeof body !== "object" || Array.isArray(body))
		return Response.json({ error: "Expected JSON." }, { status: 400 });
	const title = (body as { title?: unknown }).title;
	if (typeof title !== "string" || !title.trim() || title.trim().length > 120)
		return Response.json({ error: "Title is missing." }, { status: 422 });
	const chat = await renameChat(deps.harness, key, title.trim());
	if (!chat) return Response.json({ error: "No such chat." }, { status: 404 });
	return Response.json({ chat: { key: chat.key, title: chat.title } });
}

async function deleteChat(deps: WebDeps, key: string): Promise<Response> {
	const closed = await closeChat(deps.harness, key);
	if (!closed)
		return Response.json({ error: "No such chat." }, { status: 404 });
	return Response.json({ ok: true });
}

function mergeTimeline(
	messages: TranscriptItem[],
	notes: HarvestNote[],
): Array<
	| TranscriptItem
	| { type: "harvest"; at: number; files: HarvestNote["files"]; when: number }
> {
	const pending = [...notes].sort((left, right) => left.when - right.when);
	const merged: Array<
		| TranscriptItem
		| { type: "harvest"; at: number; files: HarvestNote["files"]; when: number }
	> = [];
	for (const message of messages) {
		merged.push(message);
		if (typeof message.id !== "number") continue;
		const ready = pending.filter((note) => note.at === message.id);
		for (const note of ready)
			merged.push({
				type: "harvest",
				at: note.at,
				files: note.files,
				when: note.when,
			});
		for (const note of ready) pending.splice(pending.indexOf(note), 1);
	}
	for (const note of pending)
		merged.push({
			type: "harvest",
			at: note.at,
			files: note.files,
			when: note.when,
		});
	return merged;
}

type ScheduleBody = {
	botId: string;
	text: string;
	target: ScheduleTarget;
	name?: string;
	enabled?: boolean;
} & ({ kind: "cron"; cron: string } | { kind: "when"; when: number });

async function parseScheduleBody(
	request: Request,
	deps: WebDeps,
	botId: string,
): Promise<
	| {
			ok: true;
			schedule: ScheduleBody;
			hasName: boolean;
			hasEnabled: boolean;
	  }
	| { ok: false; status: 400 | 422; error: string }
> {
	const body = await readJson(request);
	if (!body || typeof body !== "object" || Array.isArray(body))
		return { ok: false, status: 400, error: "Expected JSON." };
	const record = body as Record<string, unknown>;
	if (typeof record.text !== "string" || !record.text.trim())
		return { ok: false, status: 400, error: "Message is missing." };
	const target = parseTarget(record.target);
	if (!target.ok) return target;
	const chosen = target.target;
	if (chosen.mode !== "new-chat") {
		const chat = (await listChats(deps.harness)).find(
			(item) => item.key === chosen.chatId && item.botId === botId,
		);
		if (!chat)
			return { ok: false, status: 422, error: "That chat is not on this bot." };
	}
	const extras = readScheduleExtras(record);
	if (!extras.ok) return extras;
	if (record.kind === "cron") {
		if (typeof record.cron !== "string" || !parseCron(record.cron))
			return { ok: false, status: 422, error: "Cron must be five fields." };
		return {
			ok: true,
			hasName: extras.hasName,
			hasEnabled: extras.hasEnabled,
			schedule: {
				botId,
				kind: "cron",
				cron: record.cron.trim(),
				text: record.text,
				target: chosen,
				...extras.fields,
			},
		};
	}
	if (record.kind === "when") {
		const when =
			typeof record.when === "number" ? record.when : Number(record.when);
		if (!Number.isFinite(when))
			return { ok: false, status: 422, error: "When is not a time." };
		return {
			ok: true,
			hasName: extras.hasName,
			hasEnabled: extras.hasEnabled,
			schedule: {
				botId,
				kind: "when",
				when,
				text: record.text,
				target: chosen,
				...extras.fields,
			},
		};
	}
	return { ok: false, status: 422, error: "Kind must be cron or when." };
}

/** `name` and `enabled` are optional. An empty name clears. Omitted keys stay unset here. */
function readScheduleExtras(record: Record<string, unknown>):
	| {
			ok: true;
			hasName: boolean;
			hasEnabled: boolean;
			fields: { name?: string; enabled?: boolean };
	  }
	| { ok: false; status: 400 | 422; error: string } {
	const fields: { name?: string; enabled?: boolean } = {};
	let hasName = false;
	let hasEnabled = false;
	if ("name" in record && record.name !== undefined) {
		hasName = true;
		if (typeof record.name !== "string")
			return { ok: false, status: 400, error: "Name is not text." };
		const name = record.name.trim();
		if (name.length > 80)
			return { ok: false, status: 422, error: "Name is too long." };
		if (name) fields.name = name;
	}
	if ("enabled" in record && record.enabled !== undefined) {
		hasEnabled = true;
		if (typeof record.enabled !== "boolean")
			return {
				ok: false,
				status: 422,
				error: "Enabled must be true or false.",
			};
		fields.enabled = record.enabled;
	}
	return { ok: true, hasName, hasEnabled, fields };
}

function parseTarget(
	value: unknown,
):
	| { ok: true; target: ScheduleTarget }
	| { ok: false; status: 422; error: string } {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return { ok: false, status: 422, error: "Target is missing." };
	const record = value as { mode?: unknown; chatId?: unknown; at?: unknown };
	const at =
		typeof record.at === "number" && Number.isFinite(record.at)
			? record.at
			: undefined;
	if (record.mode === "new-chat")
		return { ok: true, target: { mode: "new-chat" } };
	if (
		(record.mode === "chat" || record.mode === "fork") &&
		typeof record.chatId === "string" &&
		record.chatId
	) {
		return {
			ok: true,
			target: {
				mode: record.mode,
				chatId: record.chatId,
				...(at === undefined ? {} : { at }),
			},
		};
	}
	return { ok: false, status: 422, error: "Target is missing." };
}

function newChatId(): string {
	return crypto.randomUUID().replaceAll("-", "").slice(0, 12);
}

type ParsedWrite =
	| { ok: true; write: Partial<BotWrite> & BotWrite }
	| { ok: true; write: Partial<BotWrite> }
	| { ok: false; status: 400 | 422; error: string };

function parseBotWrite(
	body: unknown,
	deps: WebDeps,
	creating: true,
):
	| { ok: true; write: BotWrite }
	| { ok: false; status: 400 | 422; error: string };
function parseBotWrite(
	body: unknown,
	deps: WebDeps,
	creating: false,
):
	| { ok: true; write: Partial<BotWrite> }
	| { ok: false; status: 400 | 422; error: string };
function parseBotWrite(
	body: unknown,
	deps: WebDeps,
	creating: boolean,
): ParsedWrite {
	if (!body || typeof body !== "object" || Array.isArray(body))
		return { ok: false, status: 400, error: "Expected JSON." };
	const record = body as Record<string, unknown>;
	const write: Partial<BotWrite> = {};
	if (creating || record.name !== undefined) {
		if (typeof record.name !== "string" || !record.name.trim())
			return { ok: false, status: 400, error: "Name is missing." };
		write.name = record.name;
	}
	if (creating || record.model !== undefined) {
		if (
			typeof record.model !== "string" ||
			!knownModel(deps.models, record.model)
		)
			return { ok: false, status: 422, error: "Unknown model." };
		write.model = record.model;
	}
	if (creating || record.thinking !== undefined) {
		if (typeof record.thinking !== "string")
			return { ok: false, status: 400, error: "Thinking is missing." };
		if (
			record.thinking !== "" &&
			!(THINKING_LEVELS as readonly string[]).includes(record.thinking)
		) {
			return { ok: false, status: 422, error: "Unknown thinking level." };
		}
		write.thinking = record.thinking;
	}
	if (creating && record.soul !== undefined) {
		if (typeof record.soul !== "string")
			return { ok: false, status: 400, error: "SOUL.md is missing." };
		write.soul = record.soul;
	}
	if (record.tools !== undefined) {
		if (
			!Array.isArray(record.tools) ||
			record.tools.some(
				(tool) => typeof tool !== "string" || !isToolName(deps.registry, tool),
			)
		) {
			return { ok: false, status: 422, error: "Unknown tool." };
		}
		write.tools = [...new Set(record.tools as string[])];
	}
	return { ok: true, write: write as BotWrite };
}

function offeredModels(models: MutableModels): {
	id: string;
	models: string[];
}[] {
	return OFFERED_PROVIDERS.flatMap((id) => {
		const found = models.getModels(id).map((model) => model.id);
		return found.length > 0 ? [{ id, models: found }] : [];
	});
}

/** `undefined` when the model can be used. Otherwise the message `checkModel` would throw. */
async function modelFailure(
	models: MutableModels,
	ref: string,
): Promise<string | undefined> {
	try {
		await checkModel(models, parseModelRef(ref, "model"));
		return undefined;
	} catch (error) {
		return (error as Error).message;
	}
}

function knownModel(models: MutableModels, ref: string): boolean {
	try {
		const parsed = parseModelRef(ref, "model");
		return models.getModel(parsed.provider, parsed.modelId) !== undefined;
	} catch {
		return false;
	}
}

async function readJson(request: Request): Promise<unknown> {
	const text = await request.text();
	if (!text) return {};
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return undefined;
	}
}
