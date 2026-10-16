import { readdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	type Conversation,
	type ConversationId,
	defineDoc,
	type EntryId,
	type Harness,
	LiveDoc,
	type RegistryReader,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { knowledgeToolNames } from "../channels/bot-catalog.ts";
import { BotsDoc, botDir } from "../channels/bots.ts";
import { listChats } from "../channels/telegram/chats.ts";
import { now as clockNow } from "../clock.ts";
import { chatFields, getLogger } from "../log.ts";
import { harvestId, harvestRequestId } from "./ids.ts";
import type { Schedule, ScheduleService } from "./service.ts";

export { harvestId, isHarvestId } from "./ids.ts";

export const HARVEST_DELAY_MS = 60_000;
export const HARVEST_TEXT = `Improve knowledge from this chat. Keep only notes that will still matter in later conversations: user preferences, standing instructions, working methods, names and durable facts about the user or their work, and corrections of how you should operate. Skip local answers. Do not store one-off questions, encyclopedia trivia, or instance values such as a specific arithmetic result. Prefer the method over the instance: keep that calculations should use code.execute for precision; do not keep the numbers from one sum. A correction of how you should work is knowledge; the answer you gave is not. If nothing qualifies, make no writes. For each note worth keeping, knowledge_read the matching slug (a missing file returns version 0), merge it into the returned body, then knowledge_update with that version, a one-line description (at most 240 characters), the same category unless it should change, and the full new body without a --- frontmatter fence. Put a note in the file whose description already covers that topic, or add a new file; do not append unrelated notes to an existing file. Do not update without a read. Do not delete a file unless it should go away.`;

export type HarvestFile = { path: string; diff: string };

export type HarvestNote = {
	chatKey: string;
	at: number;
	files: HarvestFile[];
	when: number;
};

/** In-flight harvest so a restart can attach to the same child instead of forking again. */
export type HarvestPending = {
	at: number;
	before: Record<string, string>;
	childId?: number;
};

export type HarvestNotesState = {
	notes: HarvestNote[];
	/** Last idle entry that finished harvest for this chat, including no-op harvests. */
	completed?: Record<string, number>;
	pending?: Record<string, HarvestPending>;
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
	const now = input.now ?? clockNow();
	const id = harvestId(input.chatKey);
	const existing = await schedules.get(id);
	const same =
		existing?.target.mode === "fork" &&
		existing.target.chatId === input.chatKey &&
		existing.target.at === input.entryId;
	const log = getLogger().child({
		chat: input.chatKey,
		bot: input.botId,
		harvest: id,
		entryId: input.entryId,
	});
	if (same) {
		await schedules.reschedule(id, { when: now + input.delayMs });
		log.debug("harvest wake moved", { delayMs: input.delayMs });
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
	log.debug("harvest armed", { delayMs: input.delayMs });
}

/**
 * After a chat is idle, keep a harvest wake for its rested entry unless that
 * entry already finished. An existing row is left for the clock. A pending
 * child is woken immediately so a restart finishes the fork.
 */
export async function armIdleHarvest(options: {
	harness: Harness;
	schedules: ScheduleService;
	botId: string;
	chatKey: string;
	conversationId: ConversationId;
	delayMs: number;
	now?: number;
}): Promise<void> {
	const now = options.now ?? clockNow();
	const conversation = await options.harness.conversation(
		options.conversationId,
		BACKGROUND_CONTEXT,
	);
	if (!conversation) return;
	const live = await options.harness.snapshot(
		LiveDoc,
		options.conversationId,
		BACKGROUND_CONTEXT,
	);
	if (live?.run) return;
	const page = await conversation.entries(
		{ order: "descending" },
		1,
		undefined,
		BACKGROUND_CONTEXT,
	);
	const entryId = page.items[0]?.id;
	if (entryId === undefined) return;
	const state = await options.harness.snapshot(
		HarvestNotesDoc,
		BACKGROUND_CONTEXT,
	);
	if (state?.completed?.[options.chatKey] === entryId) return;
	if (
		state?.notes.some(
			(note) => note.chatKey === options.chatKey && note.at === entryId,
		)
	)
		return;
	const id = harvestId(options.chatKey);
	const existing = await options.schedules.get(id);
	const sameEntry =
		existing?.target.mode === "fork" &&
		existing.target.chatId === options.chatKey &&
		existing.target.at === entryId;
	if (sameEntry) return;
	const inflight = state?.pending?.[options.chatKey]?.at === entryId;
	await armHarvest(options.schedules, {
		botId: options.botId,
		chatKey: options.chatKey,
		entryId,
		delayMs: inflight ? 0 : options.delayMs,
		now,
	});
}

/**
 * Fork the chat, let the child edit the bot folder, and leave a note on the parent when files changed.
 * The child is not a chat and nothing is delivered. A restart attaches to the same child.
 */
export async function runHarvest(options: {
	harness: Harness;
	registry: RegistryReader;
	home: string;
	schedule: Schedule;
	requestId: string;
}): Promise<void> {
	const target = options.schedule.target;
	const log = getLogger().child({
		bot: options.schedule.botId,
		harvest: options.schedule.id,
		requestId: options.requestId,
		...(target.mode === "fork" ? { chat: target.chatId } : {}),
	});
	if (target.mode !== "fork") {
		log.debug("harvest skipped: target is not a fork");
		return;
	}
	const chat = (await listChats(options.harness)).find(
		(item) =>
			item.key === target.chatId && item.botId === options.schedule.botId,
	);
	if (!chat) {
		log.warn("harvest skipped: chat missing");
		await clearHarvest(options.harness, target.chatId);
		return;
	}
	const sessionLog = log.child(chatFields(chat));
	const parent = await options.harness.conversation(
		chat.conversationId,
		BACKGROUND_CONTEXT,
	);
	if (!parent) {
		sessionLog.warn("harvest skipped: conversation missing");
		await clearHarvest(options.harness, chat.key);
		return;
	}
	const at = await resolveEntry(parent, target.at);
	if (at === undefined) {
		sessionLog.warn("harvest skipped: no entry to fork");
		await clearHarvest(options.harness, chat.key);
		return;
	}
	const state = await options.harness.snapshot(
		HarvestNotesDoc,
		BACKGROUND_CONTEXT,
	);
	if (state?.completed?.[chat.key] === at) {
		sessionLog.debug("harvest skipped: entry already completed");
		await clearHarvest(options.harness, chat.key);
		return;
	}
	sessionLog.debug("harvest started", { at });
	const root = botDir(options.home, options.schedule.botId);
	const existingPending = state?.pending?.[chat.key];
	let pending: HarvestPending;
	if (existingPending && existingPending.at === at) pending = existingPending;
	else {
		pending = { at, before: Object.fromEntries(await snapshotBot(root)) };
		await writePending(options.harness, chat.key, pending);
	}
	let child = pending.childId
		? await options.harness.conversation(
				pending.childId as unknown as ConversationId,
				BACKGROUND_CONTEXT,
			)
		: undefined;
	if (!child) {
		child = await parent.fork(
			at,
			{ ownership: { kind: "ownerless" } },
			BACKGROUND_CONTEXT,
		);
		pending = { ...pending, childId: child.id as unknown as number };
		await writePending(options.harness, chat.key, pending);
	}
	const bots = await options.harness.snapshot(BotsDoc, BACKGROUND_CONTEXT);
	const bot = bots?.items.find((item) => item.id === options.schedule.botId);
	await child.configure(
		{ tools: harvestTools(bot, options.registry) },
		BACKGROUND_CONTEXT,
	);
	const requestId = harvestRequestId(chat.key, at);
	const submission = await child.submit(
		{
			type: "input",
			content: options.schedule.text,
			requestId,
			whenBusy: "steer",
		},
		BACKGROUND_CONTEXT,
	);
	const settled = await submission.wait(BACKGROUND_CONTEXT);
	await child.waitForIdle(BACKGROUND_CONTEXT);
	const after = await snapshotBot(root);
	const before = new Map(Object.entries(pending.before));
	const files = changedFiles(before, after);
	const note: HarvestNote | undefined =
		files.length === 0
			? undefined
			: { chatKey: chat.key, at, files, when: Date.now() };
	await options.harness.commit(async (tx) => {
		const notes = await tx.doc(HarvestNotesDoc);
		notes.completed = { ...notes.completed, [chat.key]: at };
		if (notes.pending) delete notes.pending[chat.key];
		if (note) notes.notes.push(note);
	}, BACKGROUND_CONTEXT);
	if (!note) {
		sessionLog.debug("harvest finished with no file changes", {
			status: settled.status,
		});
		return;
	}
	sessionLog.debug("harvest wrote knowledge", {
		files: files.map((file) => file.path),
		status: settled.status,
	});
}

async function writePending(
	harness: Harness,
	chatKey: string,
	pending: HarvestPending,
): Promise<void> {
	await harness.commit(async (tx) => {
		const notes = await tx.doc(HarvestNotesDoc);
		notes.pending = { ...notes.pending, [chatKey]: pending };
	}, BACKGROUND_CONTEXT);
}

async function clearHarvest(harness: Harness, chatKey: string): Promise<void> {
	await harness.commit(async (tx) => {
		const notes = await tx.doc(HarvestNotesDoc);
		if (notes.pending) delete notes.pending[chatKey];
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
