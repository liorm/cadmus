import { readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	type Conversation,
	defineDoc,
	type EntryId,
	type Harness,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { KNOWLEDGE_TOOLS } from "../channels/bot-catalog.ts";
import { BotsDoc, botDir } from "../channels/bots.ts";
import { listChats } from "../channels/telegram/chats.ts";
import type { Schedule, ScheduleService } from "./service.ts";

export const HARVEST_DELAY_MS = 60_000;
export const HARVEST_TEXT = `Improve knowledge from this chat. Keep only notes that will still matter in later conversations: user preferences, standing instructions, working methods, names and durable facts about the user or their work, and corrections of how you should operate. Skip local answers. Do not store one-off questions, encyclopedia trivia, or instance values such as a specific arithmetic result. Prefer the method over the instance: keep that calculations should use code.execute for precision; do not keep the numbers from one sum. A correction of how you should work is knowledge; the answer you gave is not. If nothing qualifies, make no writes. For each note worth keeping, knowledge_read the matching slug (a missing file returns version 0), merge it into the returned body, then knowledge_update with that version, a one-line description (at most 240 characters), the same category unless it should change, and the full new body without a --- frontmatter fence. Put a note in the file whose description already covers that topic, or add a new file; do not append unrelated notes to an existing file. Do not update without a read. Do not delete a file unless it should go away.`;

export type HarvestFile = { path: string; diff: string };

export type HarvestNote = {
	chatKey: string;
	at: number;
	files: HarvestFile[];
	when: number;
};

/** Notes on the parent chat. Not a conversation entry, so later model requests do not see them. */
export const HarvestNotesDoc = defineDoc<{ notes: HarvestNote[] }>({
	kind: "pi-bot.harvest-notes",
	version: 1,
	scope: "session",
	initial: () => ({ notes: [] }),
});

export function harvestId(chatKey: string): string {
	return `harvest:${chatKey}`;
}

export function isHarvestId(id: string): boolean {
	return id.startsWith("harvest:");
}

/** Knowledge tools the bot still has switched on. Harvest cannot call anything else. */
export function harvestTools(
	bot: { tools?: readonly string[] } | undefined,
): ToolRegistration[] {
	const allow =
		bot?.tools === undefined
			? new Set<string>(KNOWLEDGE_TOOLS)
			: new Set(bot.tools);
	return KNOWLEDGE_TOOLS.filter((name) => allow.has(name)).map(
		(name) => ({ name }) as ToolRegistration,
	);
}

/** Arm the idle fork. The same rested entry only moves the wake. */
export async function armHarvest(
	schedules: ScheduleService,
	input: {
		botId: string;
		chatKey: string;
		entryId: number;
		delayMs: number;
		now?: number;
	},
): Promise<void> {
	const now = input.now ?? Date.now();
	const id = harvestId(input.chatKey);
	const existing = (await schedules.list(input.botId)).find(
		(row) => row.id === id,
	);
	const same =
		existing?.target.mode === "fork" &&
		existing.target.chatId === input.chatKey &&
		existing.target.at === input.entryId;
	if (same) {
		await schedules.reschedule(id, { when: now + input.delayMs });
		return;
	}
	await schedules.put(
		{
			id,
			botId: input.botId,
			kind: "when",
			when: now + input.delayMs,
			text: HARVEST_TEXT,
			target: { mode: "fork", chatId: input.chatKey, at: input.entryId },
		},
		{ ifExists: "replace" },
	);
}

/**
 * Fork the chat, let the child edit the bot folder, and leave a note on the parent when files changed.
 * The child is not a chat and nothing is delivered.
 */
export async function runHarvest(options: {
	harness: Harness;
	home: string;
	schedule: Schedule;
	requestId: string;
}): Promise<void> {
	const target = options.schedule.target;
	if (target.mode !== "fork") return;
	const chat = (await listChats(options.harness)).find(
		(item) =>
			item.key === target.chatId && item.botId === options.schedule.botId,
	);
	if (!chat) return;
	const parent = await options.harness.conversation(
		chat.conversationId,
		BACKGROUND_CONTEXT,
	);
	if (!parent) return;
	const at = await resolveEntry(parent, target.at);
	if (at === undefined) return;
	const root = botDir(options.home, options.schedule.botId);
	const before = await snapshotBot(root);
	const child = await parent.fork(
		at,
		{ ownership: { kind: "ownerless" } },
		BACKGROUND_CONTEXT,
	);
	const bots = await options.harness.snapshot(BotsDoc, BACKGROUND_CONTEXT);
	const bot = bots?.items.find((item) => item.id === options.schedule.botId);
	await child.configure({ tools: harvestTools(bot) }, BACKGROUND_CONTEXT);
	const submission = await child.submit(
		{
			type: "input",
			content: options.schedule.text,
			requestId: options.requestId,
			whenBusy: "steer",
		},
		BACKGROUND_CONTEXT,
	);
	await submission.wait(BACKGROUND_CONTEXT);
	await child.waitForIdle(BACKGROUND_CONTEXT);
	const after = await snapshotBot(root);
	const files = changedFiles(before, after);
	if (files.length === 0) return;
	const note: HarvestNote = { chatKey: chat.key, at, files, when: Date.now() };
	await options.harness.commit(async (tx) => {
		const notes = await tx.doc(HarvestNotesDoc);
		notes.notes.push(note);
	}, BACKGROUND_CONTEXT);
}

async function resolveEntry(
	conversation: Conversation,
	at: number | undefined,
): Promise<EntryId | undefined> {
	if (at !== undefined) return at as EntryId;
	const page = await conversation.entries(
		{ order: "descending" },
		1,
		undefined,
		BACKGROUND_CONTEXT,
	);
	return page.items[0]?.id;
}

async function snapshotBot(root: string): Promise<Map<string, string>> {
	const files = new Map<string, string>();
	let rootReal: string;
	try {
		rootReal = await realpath(root);
	} catch {
		return files;
	}
	const soul = await readInside(rootReal, join(root, "SOUL.md"));
	if (soul !== undefined) files.set("SOUL.md", soul);
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

function changedFiles(
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
