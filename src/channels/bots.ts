import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	type ConversationId,
	defineDoc,
	type Harness,
} from "@earendil-works/pi-durable";
import { DEFAULT_SOUL } from "../extensions/default-soul.ts";
import {
	applyKnowledgeWrite,
	formatKnowledge,
	type KnowledgeDoc,
	parseKnowledgeWrite,
	parseSlug,
} from "../extensions/knowledge.ts";
import { formatMemory, parseMemoryWrite } from "../extensions/memory.ts";
import { normalizeEnabled } from "./bot-catalog.ts";
import { slugifyBotName } from "./bot-slug.ts";

export { DEFAULT_BOT_ID } from "./bot-slug.ts";

export type BotRecord = {
	id: string;
	name: string;
	/** `provider/modelId`. */
	model: string;
	/** Thinking level, or `""` when unset. */
	thinking: string;
	/**
	 * Enabled tool names. Omitted means every tool is on.
	 * An empty list means every tool is off.
	 */
	tools?: string[];
	/**
	 * Ownerless conversation that owns this bot's schedule tasks.
	 * Not a chat-directory row, and nothing is delivered from it.
	 */
	rootConversationId?: number;
	createdAt: number;
};

/** What the page is allowed to see. */
export type PublicBot = BotRecord;

export function publicBot(bot: BotRecord): PublicBot {
	return {
		...bot,
		...(bot.tools ? { tools: [...bot.tools] } : {}),
	};
}

export const BotsDoc = defineDoc<{ items: BotRecord[] }>({
	kind: "pi-bot.bots",
	version: 1,
	scope: "session",
	initial: () => ({ items: [] }),
});

export function botDir(home: string, botId: string): string {
	return join(home, "bots", botId);
}

export async function listBots(harness: Harness): Promise<BotRecord[]> {
	return [
		...((await harness.snapshot(BotsDoc, BACKGROUND_CONTEXT))?.items ?? []),
	];
}

/** One knowledge file written with the new bot, at version 0. */
export type BotKnowledgeSeed = {
	slug: string;
	description: string;
	body: string;
	category?: string;
};

export type BotWrite = {
	name: string;
	model: string;
	thinking: string;
	tools?: string[];
	/** Initial `SOUL.md`. Omitted means the default persona. */
	soul?: string;
	/**
	 * When set, this is the id. A taken id or a value that is not a bot slug
	 * fails. Omitted means slugify `name` and add a numeric suffix if needed.
	 */
	id?: string;
	/** Initial `MEMORY.md` body. Omitted means no memory file. */
	memory?: string;
	/** Initial knowledge files. Omitted means an empty `knowledge/` directory. */
	knowledge?: BotKnowledgeSeed[];
};

/** Why an explicit id cannot be used, or `undefined` when it is free. */
export function explicitSlugError(
	id: string,
	taken: ReadonlySet<string>,
): string | undefined {
	if (!parseSlug(id, "bot")) return "Slug is not a bot id.";
	if (taken.has(id)) return "Slug is taken.";
	return undefined;
}

export type BotFailure = { ok: false; status: 422; error: string };
export type BotCreateResult = { ok: true; bot: BotRecord } | BotFailure;
export type BotUpdateResult =
	| { ok: true; bot: BotRecord }
	| BotFailure
	| { ok: false; status: 404; error: string };

/** `base`, or `base-2`, `base-3`, … shortened so the id stays a bot slug. */
export function allocateBotId(
	base: string,
	taken: ReadonlySet<string>,
): string {
	if (!taken.has(base)) return base;
	for (let n = 2; n < 1000; n++) {
		const suffix = `-${n}`;
		const stem = base.slice(0, 32 - suffix.length).replace(/-+$/g, "");
		const id = `${stem}${suffix}`;
		if (stem && !taken.has(id)) return id;
	}
	throw new Error("no free bot id");
}

async function takenBotIds(
	harness: Harness,
	home: string,
): Promise<Set<string>> {
	const taken = new Set((await listBots(harness)).map((bot) => bot.id));
	let names: string[] = [];
	try {
		names = await readdir(join(home, "bots"));
	} catch {
		names = [];
	}
	for (const name of names) {
		try {
			if ((await stat(join(home, "bots", name))).isDirectory()) taken.add(name);
		} catch {
			// A name that vanished between the listing and the stat is not taken.
		}
	}
	return taken;
}

type PreparedBotFiles = {
	soul?: string;
	memory?: string;
	knowledge: { slug: string; doc: KnowledgeDoc }[];
};

/** Check memory and knowledge before any folder write. */
function prepareBotFiles(
	input: BotWrite,
): { ok: true; files: PreparedBotFiles } | BotFailure {
	let memory: string | undefined;
	if (input.memory !== undefined) {
		const parsed = parseMemoryWrite({ version: 0, body: input.memory });
		if (!parsed.ok) return { ok: false, status: 422, error: parsed.error };
		memory = parsed.body;
	}
	const knowledge: PreparedBotFiles["knowledge"] = [];
	const seen = new Set<string>();
	for (const item of input.knowledge ?? []) {
		const slug = parseSlug(item.slug, "knowledge");
		if (!slug)
			return {
				ok: false,
				status: 422,
				error: "The knowledge name is not a legal slug.",
			};
		if (seen.has(slug))
			return {
				ok: false,
				status: 422,
				error: `Knowledge slug ${slug} is repeated.`,
			};
		seen.add(slug);
		const parsed = parseKnowledgeWrite({
			version: 0,
			description: item.description,
			body: item.body,
			...(item.category === undefined ? {} : { category: item.category }),
		});
		if (!parsed.ok) return { ok: false, status: 422, error: parsed.error };
		// `applyKnowledgeWrite` stores the next version. Keep the seed at 0.
		const applied = applyKnowledgeWrite(undefined, parsed.value);
		knowledge.push({ slug, doc: { ...applied, version: 0 } });
	}
	return {
		ok: true,
		files: { soul: input.soul, memory, knowledge },
	};
}

async function writeNewBotFiles(
	home: string,
	id: string,
	files: PreparedBotFiles,
): Promise<void> {
	const dir = botDir(home, id);
	await mkdir(join(dir, "knowledge"), { recursive: true });
	await writeFile(join(dir, "SOUL.md"), files.soul ?? `${DEFAULT_SOUL}\n`);
	if (files.memory !== undefined) {
		await writeFile(
			join(dir, "MEMORY.md"),
			formatMemory({ version: 0, body: files.memory }),
		);
	}
	for (const item of files.knowledge) {
		await writeFile(
			join(dir, "knowledge", `${item.slug}.md`),
			formatKnowledge(item.doc),
		);
	}
}

/** Remove a folder this call created when the row was not stored. */
async function discardUnstoredFolder(
	harness: Harness,
	home: string,
	id: string,
): Promise<void> {
	const stored = (await listBots(harness)).some((bot) => bot.id === id);
	if (stored) return;
	await rm(botDir(home, id), { recursive: true, force: true });
}

/**
 * Slugify `name`, write the folder, then commit the row. A failed write commits nothing.
 * A failed commit deletes the folder this call created.
 */
export async function createBot(
	harness: Harness,
	home: string,
	input: BotWrite,
	all: readonly string[] = [],
): Promise<BotCreateResult> {
	const name = input.name.trim();
	if (!name) return { ok: false, status: 422, error: "Name is empty." };
	const prepared = prepareBotFiles(input);
	if (!prepared.ok) return prepared;
	let id: string;
	if (input.id !== undefined) {
		const taken = new Set((await listBots(harness)).map((bot) => bot.id));
		const error = explicitSlugError(input.id, taken);
		if (error) return { ok: false, status: 422, error };
		id = input.id;
	} else {
		const base = slugifyBotName(name);
		if (!base)
			return { ok: false, status: 422, error: "Name does not make a slug." };
		id = allocateBotId(base, await takenBotIds(harness, home));
	}
	try {
		await writeNewBotFiles(home, id, prepared.files);
	} catch (error) {
		await discardUnstoredFolder(harness, home, id);
		throw error;
	}
	const tools = normalizeEnabled(input.tools, all);
	const record: BotRecord = {
		id,
		name,
		model: input.model,
		thinking: input.thinking,
		...(tools === undefined ? {} : { tools }),
		createdAt: Date.now(),
	};
	try {
		await harness.commit(async (tx) => {
			const bots = await tx.doc(BotsDoc);
			if (bots.items.some((bot) => bot.id === id))
				throw new Error(`Bot ${id} already exists`);
			const root = await tx.createConversation({
				ownership: { kind: "ownerless" },
			});
			record.rootConversationId = root.id as unknown as number;
			bots.items.push(record);
		}, BACKGROUND_CONTEXT);
	} catch (error) {
		await discardUnstoredFolder(harness, home, id);
		throw error;
	}
	return { ok: true, bot: record };
}

/**
 * The bot's root conversation. A row written before roots existed gets one
 * on the call that first needs it, in the same commit that stores the id.
 */
export async function ensureBotRoot(
	harness: Harness,
	botId: string,
): Promise<ConversationId | undefined> {
	const existing = (await listBots(harness)).find((bot) => bot.id === botId);
	if (!existing) return undefined;
	if (existing.rootConversationId !== undefined)
		return existing.rootConversationId as ConversationId;
	return harness.commit(async (tx) => {
		const bots = await tx.doc(BotsDoc);
		const bot = bots.items.find((item) => item.id === botId);
		if (!bot) return undefined;
		if (bot.rootConversationId !== undefined)
			return bot.rootConversationId as ConversationId;
		const root = await tx.createConversation({
			ownership: { kind: "ownerless" },
		});
		bot.rootConversationId = root.id as unknown as number;
		return root.id;
	}, BACKGROUND_CONTEXT);
}

/** Update the row only. Does not reconfigure conversations that already exist. */
export async function updateBot(
	harness: Harness,
	id: string,
	patch: Partial<BotWrite>,
	all: readonly string[] = [],
): Promise<BotUpdateResult> {
	const name = patch.name?.trim();
	if (patch.name !== undefined && !name)
		return { ok: false, status: 422, error: "Name is empty." };
	return harness.commit(async (tx) => {
		const bots = await tx.doc(BotsDoc);
		const bot = bots.items.find((item) => item.id === id);
		if (!bot) return { ok: false, status: 404, error: "No such bot." };
		if (name !== undefined && name !== bot.name) bot.name = name;
		if (patch.model !== undefined) bot.model = patch.model;
		if (patch.thinking !== undefined) bot.thinking = patch.thinking;
		if (patch.tools !== undefined) {
			const tools = normalizeEnabled(patch.tools, all);
			if (tools === undefined) delete bot.tools;
			else bot.tools = tools;
		}
		return {
			ok: true,
			bot: { ...bot, ...(bot.tools ? { tools: [...bot.tools] } : {}) },
		};
	}, BACKGROUND_CONTEXT);
}
