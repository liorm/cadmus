import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type Harness } from "@earendil-works/pi-durable";
import { slugifyBotName } from "./bot-slug.ts";
import { DEFAULT_SOUL } from "../extensions/identity.ts";
import { type ModelConfig, modelRefString } from "../harness/models.ts";

/** The Telegram bot that exists today. Created on first start; this step never removes or renames it. */
export const DEFAULT_BOT_ID = "default";

export type BotRecord = {
	id: string;
	name: string;
	/** `provider/modelId`. */
	model: string;
	/** Thinking level, or `""` when the env left it unset. */
	thinking: string;
	/** Extra tool names such as `web.search`. Stored only; `read`, `write`, and `edit` are always on. */
	tools?: string[];
	createdAt: number;
};

export const BotsDoc = defineDoc<{ items: BotRecord[] }>({
	kind: "pi-bot.bots",
	version: 1,
	scope: "session",
	initial: () => ({ items: [] }),
});

/** Standing ops seeded into `SYSTEM.md`. Knowledge bodies stay out of the prompt; this tells the model to open files. */
export const SYSTEM_SEED = `Knowledge lives in knowledge/<slug>.md. Every file starts with a one-line description frontmatter (required, at most 240 characters). Put new facts in the file whose description already covers them, or add a new file. Do not edit SOUL.md or SYSTEM.md unless the user asks.`;

export function botDir(home: string, botId: string): string {
	return join(home, "bots", botId);
}

async function readOptional(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return undefined;
	}
}

async function exists(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * Make sure `bots/default/` exists. A missing directory copies home-root `SOUL.md` and `AGENTS.md` when they are
 * there, and seeds whichever of the two is not. An existing directory is left as it is. `knowledge/` is created
 * either way.
 */
export async function ensureDefaultBotFiles(home: string): Promise<void> {
	const dir = botDir(home, DEFAULT_BOT_ID);
	const existed = await exists(dir);
	await mkdir(join(dir, "knowledge"), { recursive: true });
	if (existed) return;
	const soul = await readOptional(join(home, "SOUL.md"));
	const agents = await readOptional(join(home, "AGENTS.md"));
	await writeFile(join(dir, "SOUL.md"), soul ?? `${DEFAULT_SOUL}\n`);
	await writeFile(join(dir, "SYSTEM.md"), agents ?? `${SYSTEM_SEED}\n`);
}

/** Insert `default` on first start. Later starts refresh its model and thinking from env; other rows stay. */
export async function ensureDefaultBotDoc(harness: Harness, model: ModelConfig): Promise<void> {
	const modelId = modelRefString(model.main);
	const thinking = model.thinkingLevel ?? "";
	await harness.commit(async (tx) => {
		const bots = await tx.doc(BotsDoc);
		const existing = bots.items.find((bot) => bot.id === DEFAULT_BOT_ID);
		if (existing) {
			existing.model = modelId;
			existing.thinking = thinking;
			return;
		}
		bots.items.push({ id: DEFAULT_BOT_ID, name: "Default", model: modelId, thinking, createdAt: Date.now() });
	}, BACKGROUND_CONTEXT);
}

export async function listBots(harness: Harness): Promise<BotRecord[]> {
	return [...((await harness.snapshot(BotsDoc, BACKGROUND_CONTEXT))?.items ?? [])];
}

export type BotWrite = {
	name: string;
	model: string;
	thinking: string;
	tools?: string[];
};

export type BotFailure = { ok: false; status: 422; error: string };
export type BotCreateResult = { ok: true; bot: BotRecord } | BotFailure;
export type BotUpdateResult = { ok: true; bot: BotRecord } | BotFailure | { ok: false; status: 404; error: string };

/** `base`, or `base-2`, `base-3`, … shortened so the id stays a bot slug. */
export function allocateBotId(base: string, taken: ReadonlySet<string>): string {
	if (!taken.has(base)) return base;
	for (let n = 2; n < 1000; n++) {
		const suffix = `-${n}`;
		const stem = base.slice(0, 32 - suffix.length).replace(/-+$/g, "");
		const id = `${stem}${suffix}`;
		if (stem && !taken.has(id)) return id;
	}
	throw new Error("no free bot id");
}

async function takenBotIds(harness: Harness, home: string): Promise<Set<string>> {
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

async function writeNewBotFiles(home: string, id: string): Promise<void> {
	const dir = botDir(home, id);
	await mkdir(join(dir, "knowledge"), { recursive: true });
	await writeFile(join(dir, "SOUL.md"), `${DEFAULT_SOUL}\n`);
	await writeFile(join(dir, "SYSTEM.md"), `${SYSTEM_SEED}\n`);
}

/**
 * Slugify `name`, write the folder, then commit the row. A failed write commits nothing.
 * A failed commit deletes the folder this call created.
 */
export async function createBot(harness: Harness, home: string, input: BotWrite): Promise<BotCreateResult> {
	const base = slugifyBotName(input.name);
	if (!base) return { ok: false, status: 422, error: "Name does not make a slug." };
	const id = allocateBotId(base, await takenBotIds(harness, home));
	const dir = botDir(home, id);
	try {
		await writeNewBotFiles(home, id);
	} catch (error) {
		await rm(dir, { recursive: true, force: true });
		throw error;
	}
	const record: BotRecord = {
		id,
		name: input.name.trim(),
		model: input.model,
		thinking: input.thinking,
		...(input.tools && input.tools.length > 0 ? { tools: input.tools } : {}),
		createdAt: Date.now(),
	};
	try {
		await harness.commit(async (tx) => {
			const bots = await tx.doc(BotsDoc);
			if (bots.items.some((bot) => bot.id === id)) throw new Error(`Bot ${id} already exists`);
			bots.items.push(record);
		}, BACKGROUND_CONTEXT);
	} catch (error) {
		await rm(dir, { recursive: true, force: true });
		throw error;
	}
	return { ok: true, bot: record };
}

/** Update the row only. Does not reconfigure conversations that already exist. */
export async function updateBot(harness: Harness, id: string, patch: Partial<BotWrite>): Promise<BotUpdateResult> {
	const name = patch.name?.trim();
	if (patch.name !== undefined && !name) return { ok: false, status: 422, error: "Name is empty." };
	return harness.commit(async (tx) => {
		const bots = await tx.doc(BotsDoc);
		const bot = bots.items.find((item) => item.id === id);
		if (!bot) return { ok: false, status: 404, error: "No such bot." };
		if (name !== undefined && name !== bot.name) {
			if (id === DEFAULT_BOT_ID) return { ok: false, status: 422, error: "The default bot cannot be renamed." };
			bot.name = name;
		}
		if (patch.model !== undefined) bot.model = patch.model;
		if (patch.thinking !== undefined) bot.thinking = patch.thinking;
		if (patch.tools !== undefined) {
			if (patch.tools.length === 0) delete bot.tools;
			else bot.tools = patch.tools;
		}
		return { ok: true, bot: { ...bot, ...(bot.tools ? { tools: [...bot.tools] } : {}) } };
	}, BACKGROUND_CONTEXT);
}
