import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type Harness } from "@earendil-works/pi-durable";
import { DEFAULT_SOUL } from "../extensions/identity.ts";
import { normalizeEnabled } from "./bot-catalog.ts";
import { slugifyBotName } from "./bot-slug.ts";

/**
 * Id the general Telegram door (`TELEGRAM_BOT_TOKEN`) admits on.
 * Nothing creates this row. It exists when a bot was named so its slug is `default`, or when an older home already had one.
 */
export const DEFAULT_BOT_ID = "default";

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
	/** Optional second Telegram door. Never returned by `GET /api/bots` and never placed in a prompt. */
	telegramToken?: string;
	createdAt: number;
};

/** What the page is allowed to see. The Telegram token stays on the stored row. */
export type PublicBot = Omit<BotRecord, "telegramToken"> & {
	telegramConfigured: boolean;
};

export function publicBot(bot: BotRecord): PublicBot {
	const { telegramToken: _token, ...rest } = bot;
	return {
		...rest,
		...(rest.tools ? { tools: [...rest.tools] } : {}),
		telegramConfigured: Boolean(bot.telegramToken),
	};
}

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

export async function listBots(harness: Harness): Promise<BotRecord[]> {
	return [
		...((await harness.snapshot(BotsDoc, BACKGROUND_CONTEXT))?.items ?? []),
	];
}

export type BotWrite = {
	name: string;
	model: string;
	thinking: string;
	tools?: string[];
	/** Initial `SOUL.md`. Omitted means the default persona. */
	soul?: string;
};

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

async function writeNewBotFiles(
	home: string,
	id: string,
	soul?: string,
): Promise<void> {
	const dir = botDir(home, id);
	await mkdir(join(dir, "knowledge"), { recursive: true });
	await writeFile(join(dir, "SOUL.md"), soul ?? `${DEFAULT_SOUL}\n`);
	await writeFile(join(dir, "SYSTEM.md"), `${SYSTEM_SEED}\n`);
}

/**
 * Slugify `name`, write the folder, then commit the row. A failed write commits nothing.
 * A failed commit deletes the folder this call created.
 */
export async function createBot(
	harness: Harness,
	home: string,
	input: BotWrite,
): Promise<BotCreateResult> {
	const base = slugifyBotName(input.name);
	if (!base)
		return { ok: false, status: 422, error: "Name does not make a slug." };
	const id = allocateBotId(base, await takenBotIds(harness, home));
	const dir = botDir(home, id);
	try {
		await writeNewBotFiles(home, id, input.soul);
	} catch (error) {
		await rm(dir, { recursive: true, force: true });
		throw error;
	}
	const tools = normalizeEnabled(input.tools);
	const record: BotRecord = {
		id,
		name: input.name.trim(),
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
			bots.items.push(record);
		}, BACKGROUND_CONTEXT);
	} catch (error) {
		await rm(dir, { recursive: true, force: true });
		throw error;
	}
	return { ok: true, bot: record };
}

/** Store or clear the per-bot Telegram token. Returns the full row, token included. */
export async function setTelegramToken(
	harness: Harness,
	id: string,
	token: string | null,
): Promise<BotRecord | undefined> {
	return harness.commit(async (tx) => {
		const bots = await tx.doc(BotsDoc);
		const bot = bots.items.find((item) => item.id === id);
		if (!bot) return undefined;
		if (token) bot.telegramToken = token;
		else delete bot.telegramToken;
		return { ...bot, ...(bot.tools ? { tools: [...bot.tools] } : {}) };
	}, BACKGROUND_CONTEXT);
}

/** Update the row only. Does not reconfigure conversations that already exist. */
export async function updateBot(
	harness: Harness,
	id: string,
	patch: Partial<BotWrite>,
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
			const tools = normalizeEnabled(patch.tools);
			if (tools === undefined) delete bot.tools;
			else bot.tools = tools;
		}
		return {
			ok: true,
			bot: { ...bot, ...(bot.tools ? { tools: [...bot.tools] } : {}) },
		};
	}, BACKGROUND_CONTEXT);
}
