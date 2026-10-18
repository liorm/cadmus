import { readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import {
	defineDoc,
	type RegistryReader,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { knowledgeToolNames } from "../channels/bot-catalog.ts";

export const HARVEST_DELAY_MS = 60_000;
/** How long to wait before retrying a harvest that threw. */
export const HARVEST_RETRY_MS = 5_000;
export const HARVEST_TEXT = `Improve knowledge from this chat. This turn is a harvest: persist standing notes; do not chat with the user.

Always persist knowledge. Durable facts, standing instructions, and operational discoveries from this chat must land in MEMORY.md or knowledge/*.md. Do not leave them only in the transcript. Keep those files a single source of truth: accurate, concise, and synchronized with what is true now. Rewrite a file so it matches current reality; do not append a changelog. Call the tools to persist: you may issue several in one turn (memory_read with knowledge_read, then memory_update with knowledge_update). A write that appears only in assistant text does not persist. Do not claim a file was updated unless that tool returned success.

Domain scoping. Standing preferences, voice, and how to operate go in MEMORY.md. Named durable facts about the user or their world (name, home, city, country, people, projects, long notes) go in knowledge/<slug>.md. Put a note in the file whose topic already covers it, or add a new file; do not dump unrelated notes into one file.

A user correction of voice, tone, or how you should operate is always a MEMORY.md write. That includes stop doing X, don't use stage directions, just talk, from now on, remember, keep this, give longer answers, and similar standing instructions. The assistant saying "got it" does not store it. memory_read (missing file returns version 0), then memory_update with that version and the full new body without a --- frontmatter fence. MEMORY.md is the current standing policy: if a new instruction contradicts an old line, drop or rewrite the old line. Do not append stamps such as "User preference:" or "User correction:". Empty body clears it. Do not invent a knowledge slug for a preference.

A one-sentence fact still counts. "I live in Israel" is a knowledge file, not MEMORY.md. knowledge_read the matching slug (a missing file returns version 0), merge into the returned body so the file stays current, then knowledge_update with that version, a one-line description (at most 240 characters), the same category unless it should change, and the full new body without a --- frontmatter fence. Do not update without a read. Do not delete a file unless it should go away.

Keep only notes that will still matter in later conversations. Skip local answers. Do not store one-off questions, encyclopedia trivia, or instance values such as a specific arithmetic result. Prefer the method over the instance: keep that calculations should use code.execute for precision; do not keep the numbers from one sum. A correction of how you should work is knowledge; the answer you gave is not. If nothing qualifies, make no writes.`;

/** Standing harvest instructions plus the delta watermark, when one exists. */
export function harvestPrompt(
	text: string,
	watermark: number | undefined,
): string {
	if (watermark === undefined)
		return `${text}\n\nNothing in this chat has been harvested yet. Treat the whole transcript as new.`;
	return `${text}\n\nTurns through entry ${watermark} are already stored. Write only new facts and preferences introduced after that entry. If nothing new qualifies, make no tool calls.`;
}

export type HarvestFile = { path: string; diff: string };

export type HarvestNote = {
	chatKey: string;
	at: number;
	files: HarvestFile[];
	when: number;
};

export type HarvestNotesState = {
	notes: HarvestNote[];
	/** Last idle entry that finished harvest for this chat, including no-op harvests. */
	completed?: Record<string, number>;
	/** Live wake for this chat. The harvest task reads `until` while it sleeps. */
	armed?: Record<string, { taskId: string; at: number; until: number }>;
};

/** Notes on the parent chat. Not a conversation entry, so later model requests do not see them. */
export const HarvestNotesDoc = defineDoc<HarvestNotesState>({
	kind: "pi-bot.harvest-notes",
	version: 1,
	scope: "session",
	initial: () => ({ notes: [] }),
});

/** Knowledge tools the bot still has switched on. Harvest cannot call anything else. */
export function harvestTools(
	bot: { tools?: readonly string[] } | undefined,
	registry: RegistryReader,
): ToolRegistration[] {
	const knowledge = knowledgeToolNames(registry);
	const allow =
		bot?.tools === undefined ? new Set<string>(knowledge) : new Set(bot.tools);
	return knowledge
		.filter((name) => allow.has(name))
		.map((name) => ({ name }) as ToolRegistration);
}

export function harvestRequestId(chatKey: string, entryId: number): string {
	return `harvest:${chatKey}:${entryId}`;
}

export async function snapshotBot(root: string): Promise<Map<string, string>> {
	const files = new Map<string, string>();
	let rootReal: string;
	try {
		rootReal = await realpath(root);
	} catch {
		return files;
	}
	const soul = await readInside(rootReal, join(root, "SOUL.md"));
	if (soul !== undefined) files.set("SOUL.md", soul);
	const memory = await readInside(rootReal, join(root, "MEMORY.md"));
	if (memory !== undefined) files.set("MEMORY.md", memory);
	let names: string[] = [];
	try {
		names = (await readdir(join(root, "knowledge")))
			.filter((name) => name.endsWith(".md"))
			.sort();
	} catch {
		names = [];
	}
	for (const name of names) {
		const text = await readInside(rootReal, join(root, "knowledge", name));
		if (text !== undefined) files.set(`knowledge/${name}`, text);
	}
	return files;
}

async function readInside(
	rootReal: string,
	path: string,
): Promise<string | undefined> {
	const real = await realpath(path).catch(() => undefined);
	if (!real) return undefined;
	const rel = relative(rootReal, real);
	if (rel.startsWith("..") || isAbsolute(rel)) return undefined;
	return readFile(path, "utf8").catch(() => undefined);
}

export function changedFiles(
	before: Map<string, string>,
	after: Map<string, string>,
): HarvestFile[] {
	const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
	const files: HarvestFile[] = [];
	for (const path of paths) {
		const prior = before.get(path) ?? "";
		const next = after.get(path) ?? "";
		if (prior === next) continue;
		files.push({ path, diff: lineDiff(path, prior, next) });
	}
	return files;
}

/** A short line diff. Large files get a one-line summary instead of a quadratic compare. */
export function lineDiff(path: string, before: string, after: string): string {
	const removed = before.length === 0 ? [] : before.split("\n");
	const added = after.length === 0 ? [] : after.split("\n");
	if (removed.length * added.length > 160_000) {
		return [
			`@@ ${path}`,
			`-${removed.length} lines`,
			`+${added.length} lines`,
		].join("\n");
	}
	const lcs = longestCommon(removed, added);
	const lines = [`@@ ${path}`];
	let i = 0;
	let j = 0;
	for (const shared of lcs) {
		while (i < removed.length && removed[i] !== shared)
			lines.push(`-${removed[i++]}`);
		while (j < added.length && added[j] !== shared)
			lines.push(`+${added[j++]}`);
		if (i < removed.length && removed[i] === shared) i++;
		if (j < added.length && added[j] === shared) j++;
	}
	while (i < removed.length) lines.push(`-${removed[i++]}`);
	while (j < added.length) lines.push(`+${added[j++]}`);
	return lines.join("\n");
}

function longestCommon(left: string[], right: string[]): string[] {
	const rows = left.length + 1;
	const cols = right.length + 1;
	const scores: number[] = new Array(rows * cols).fill(0);
	for (let i = left.length - 1; i >= 0; i--) {
		for (let j = right.length - 1; j >= 0; j--) {
			scores[i * cols + j] =
				left[i] === right[j]
					? (scores[(i + 1) * cols + j + 1] ?? 0) + 1
					: Math.max(
							scores[(i + 1) * cols + j] ?? 0,
							scores[i * cols + j + 1] ?? 0,
						);
		}
	}
	const shared: string[] = [];
	let i = 0;
	let j = 0;
	while (i < left.length && j < right.length) {
		const token = left[i];
		if (token !== undefined && token === right[j]) {
			shared.push(token);
			i++;
			j++;
		} else if (
			(scores[(i + 1) * cols + j] ?? 0) >= (scores[i * cols + j + 1] ?? 0)
		)
			i++;
		else j++;
	}
	return shared;
}
