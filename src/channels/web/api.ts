import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import type { Cursor, EntryRecord, Harness } from "@earendil-works/pi-durable";
import { createBot, listBots, updateBot, type BotWrite } from "../bots.ts";
import { hasTelegramAddress, listChats, webChatKey } from "../telegram/chats.ts";
import { handleCommand, parseCommand } from "../telegram/commands.ts";
import type { Deliverer } from "../telegram/deliver.ts";
import type { Config } from "../../config.ts";
import { THINKING_LEVELS, modelRefString, parseModelRef } from "../../harness/models.ts";
import type { BotRuntime } from "../../runtime.ts";
import { chatEventResponse } from "./events.ts";
import { projectEntries } from "./transcript.ts";

const EXTRA_TOOLS = new Set(["web.search", "web.fetch"]);
const WEB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export type WebDeps = {
	config: Config;
	models: MutableModels;
	harness: Harness;
	deliverer: Deliverer;
	ensureRuntime(botId: string): BotRuntime | undefined;
	addRuntime(bot: { id: string; name: string; model: string; thinking: string; tools?: string[]; createdAt: number }): BotRuntime;
};

export async function handleApi(request: Request, deps: WebDeps): Promise<Response> {
	const url = new URL(request.url);
	const path = url.pathname;
	if (path === "/api/status" && request.method === "GET") {
		return Response.json({ model: modelRefString(deps.config.model.main), telegram: Boolean(deps.config.telegram.token) });
	}
	if (path === "/api/bots" && request.method === "GET") return Response.json({ bots: await listBots(deps.harness) });
	if (path === "/api/bots" && request.method === "POST") return create(request, deps);

	const chats = /^\/api\/bots\/([^/]+)\/chats$/.exec(path);
	if (chats?.[1]) {
		const id = decodeURIComponent(chats[1]);
		if (request.method === "GET") return listBotChats(deps, id);
		if (request.method === "POST") return createChat(request, deps, id);
	}
	const one = /^\/api\/bots\/([^/]+)$/.exec(path);
	if (one?.[1] && request.method === "PATCH") return patchBot(request, deps, decodeURIComponent(one[1]));

	const messages = /^\/api\/chats\/([^/]+)\/messages$/.exec(path);
	if (messages?.[1]) {
		const key = decodeURIComponent(messages[1]);
		if (request.method === "GET") return getMessages(deps, key);
		if (request.method === "POST") return postMessage(request, deps, key);
	}
	const events = /^\/api\/chats\/([^/]+)\/events$/.exec(path);
	if (events?.[1] && request.method === "GET") return streamEvents(request, deps, decodeURIComponent(events[1]));

	return Response.json({ error: "Not found." }, { status: 404 });
}

async function create(request: Request, deps: WebDeps): Promise<Response> {
	const body = await readJson(request);
	if (body === undefined) return Response.json({ error: "Expected JSON." }, { status: 400 });
	const parsed = parseBotWrite(body, deps, true);
	if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });
	const created = await createBot(deps.harness, deps.config.home, parsed.write);
	if (!created.ok) return Response.json({ error: created.error }, { status: created.status });
	deps.addRuntime(created.bot);
	return Response.json({ bot: created.bot }, { status: 201 });
}

async function patchBot(request: Request, deps: WebDeps, id: string): Promise<Response> {
	const body = await readJson(request);
	if (body === undefined || !body || typeof body !== "object" || Array.isArray(body)) return Response.json({ error: "Expected JSON." }, { status: 400 });
	const record = body as Record<string, unknown>;
	if (record.name === undefined && record.model === undefined && record.thinking === undefined && record.tools === undefined) {
		return Response.json({ error: "Nothing to update." }, { status: 400 });
	}
	const parsed = parseBotWrite(record, deps, false);
	if (!parsed.ok) return Response.json({ error: parsed.error }, { status: parsed.status });
	const updated = await updateBot(deps.harness, id, parsed.write);
	if (!updated.ok) return Response.json({ error: updated.error }, { status: updated.status });
	deps.ensureRuntime(id)?.refresh(updated.bot);
	return Response.json({ bot: updated.bot });
}

async function listBotChats(deps: WebDeps, id: string): Promise<Response> {
	const runtime = deps.ensureRuntime(id);
	if (!runtime) return Response.json({ error: "No such bot." }, { status: 404 });
	const chats = await runtime.listChats();
	return Response.json({
		chats: chats.map((chat) => ({ key: chat.key, botId: chat.botId, telegram: hasTelegramAddress(chat) })),
	});
}

async function createChat(request: Request, deps: WebDeps, id: string): Promise<Response> {
	const runtime = deps.ensureRuntime(id);
	if (!runtime) return Response.json({ error: "No such bot." }, { status: 404 });
	const body = await readJson(request);
	if (body === undefined) return Response.json({ error: "Expected JSON." }, { status: 400 });
	const requested = body && typeof body === "object" && !Array.isArray(body) ? (body as { chatId?: unknown }).chatId : undefined;
	let chatId: string;
	if (requested === undefined) chatId = newChatId();
	else if (typeof requested === "string" && WEB_ID.test(requested)) chatId = requested;
	else return Response.json({ error: "chatId is not a web chat id." }, { status: 400 });
	const chat = await runtime.createChat(webChatKey(id, chatId));
	return Response.json({ chat: { key: chat.key, botId: chat.botId, telegram: false } }, { status: 201 });
}

async function getMessages(deps: WebDeps, key: string): Promise<Response> {
	const chat = (await listChats(deps.harness)).find((item) => item.key === key);
	if (!chat) return Response.json({ error: "No such chat." }, { status: 404 });
	const conversation = await deps.harness.conversation(chat.conversationId, BACKGROUND_CONTEXT);
	if (!conversation) return Response.json({ error: "No such chat." }, { status: 404 });
	const entries: EntryRecord[] = [];
	let cursor: Cursor | undefined;
	do {
		const page = await conversation.entries({ order: "ascending" }, 200, cursor, BACKGROUND_CONTEXT);
		entries.push(...page.items);
		cursor = page.next;
	} while (cursor);
	return Response.json({ messages: projectEntries(entries) });
}

async function postMessage(request: Request, deps: WebDeps, key: string): Promise<Response> {
	const body = await readJson(request);
	if (body === undefined || !body || typeof body !== "object" || Array.isArray(body)) return Response.json({ error: "Expected JSON." }, { status: 400 });
	const record = body as { clientMsgId?: unknown; text?: unknown };
	const clientMsgId = typeof record.clientMsgId === "string" ? record.clientMsgId.trim() : "";
	if (!clientMsgId || clientMsgId.length > 128 || /\s/.test(clientMsgId)) return Response.json({ error: "clientMsgId is missing." }, { status: 400 });
	if (typeof record.text !== "string" || !record.text.trim()) return Response.json({ error: "text is missing." }, { status: 400 });
	const chat = (await listChats(deps.harness)).find((item) => item.key === key);
	if (!chat?.botId) return Response.json({ error: "No such chat." }, { status: 404 });
	const runtime = deps.ensureRuntime(chat.botId);
	if (!runtime) return Response.json({ error: "No such chat." }, { status: 404 });
	const requestId = `${chat.key}:${clientMsgId}`;
	const command = parseCommand(record.text);
	if (command) {
		await handleCommand(command, { harness: deps.harness, deliverer: deps.deliverer, chat, requestKey: requestId });
		return Response.json({ ok: true });
	}
	await runtime.submit(chat.key, requestId, record.text);
	return Response.json({ ok: true });
}

async function streamEvents(request: Request, deps: WebDeps, key: string): Promise<Response> {
	const chat = (await listChats(deps.harness)).find((item) => item.key === key);
	if (!chat) return Response.json({ error: "No such chat." }, { status: 404 });
	return chatEventResponse(deps.harness, chat.conversationId, request.signal);
}

function newChatId(): string {
	return crypto.randomUUID().replaceAll("-", "").slice(0, 12);
}

type ParsedWrite = { ok: true; write: Partial<BotWrite> & BotWrite } | { ok: true; write: Partial<BotWrite> } | { ok: false; status: 400 | 422; error: string };

function parseBotWrite(body: unknown, deps: WebDeps, creating: true): { ok: true; write: BotWrite } | { ok: false; status: 400 | 422; error: string };
function parseBotWrite(body: unknown, deps: WebDeps, creating: false): { ok: true; write: Partial<BotWrite> } | { ok: false; status: 400 | 422; error: string };
function parseBotWrite(body: unknown, deps: WebDeps, creating: boolean): ParsedWrite {
	if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, status: 400, error: "Expected JSON." };
	const record = body as Record<string, unknown>;
	const write: Partial<BotWrite> = {};
	if (creating || record.name !== undefined) {
		if (typeof record.name !== "string" || !record.name.trim()) return { ok: false, status: 400, error: "Name is missing." };
		write.name = record.name;
	}
	if (creating || record.model !== undefined) {
		if (typeof record.model !== "string" || !knownModel(deps.models, record.model)) return { ok: false, status: 422, error: "Unknown model." };
		write.model = record.model;
	}
	if (creating || record.thinking !== undefined) {
		if (typeof record.thinking !== "string") return { ok: false, status: 400, error: "Thinking is missing." };
		if (record.thinking !== "" && !(THINKING_LEVELS as readonly string[]).includes(record.thinking)) {
			return { ok: false, status: 422, error: "Unknown thinking level." };
		}
		write.thinking = record.thinking;
	}
	if (record.tools !== undefined) {
		if (!Array.isArray(record.tools) || record.tools.some((tool) => typeof tool !== "string" || !EXTRA_TOOLS.has(tool))) {
			return { ok: false, status: 422, error: "Unknown tool." };
		}
		write.tools = [...new Set(record.tools as string[])];
	}
	return { ok: true, write: write as BotWrite };
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
