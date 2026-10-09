import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type Harness } from "@earendil-works/pi-durable";
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
