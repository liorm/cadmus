import type { Context } from "@earendil-works/chord/context";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	type Conversation,
	type ConversationId,
	defineExtension,
	defineTask,
	type EntryId,
	type Harness,
	LiveDoc,
	type RegistryReader,
	type TaskId,
	type TaskRuntime,
} from "@earendil-works/pi-durable";
import { BotsDoc, botDir, ensureBotRoot } from "../channels/bots.ts";
import { listChats } from "../channels/telegram/chats.ts";
import { testClockActive, testClockPollMs } from "../clock.ts";
import { getLogger } from "../log.ts";
import {
	changedFiles,
	HARVEST_RETRY_MS,
	HARVEST_TEXT,
	HarvestNotesDoc,
	harvestPrompt,
	harvestRequestId,
	harvestTools,
	snapshotBot,
} from "./notes.ts";

export type HarvestHost = {
	harness: Harness;
	registry: RegistryReader;
	home: string;
	delayMs: number;
	now(): number;
	track(work: Promise<void>): void;
};

export const harvestHost: { current?: HarvestHost } = {};

type Input = { botId: string; chatKey: string; entryId: number };
type Checkpoint =
	| { phase: "wait" }
	| { phase: "snap" }
	| {
			phase: "fork";
			at: number;
			watermark?: number;
			before: Record<string, string>;
	  }
	| {
			phase: "awaitChild";
			at: number;
			watermark?: number;
			before: Record<string, string>;
			childId: number;
	  }
	| {
			phase: "note";
			at: number;
			before: Record<string, string>;
			childId: number;
	  };

type Runtime = TaskRuntime<Input, Checkpoint, null, object>;

const busy = new Map<string, () => void>();
const inflight = new Set<Promise<void>>();

function host(): HarvestHost {
	const current = harvestHost.current;
	if (!current) throw new Error("Harvest task has no host.");
	return current;
}

function taskKey(id: unknown): string {
	return String(id);
}

function done() {
	return {
		status: "terminal" as const,
		outcome: { status: "completed" as const, result: null },
	};
}

function running(checkpoint: Checkpoint) {
	return { status: "running" as const, checkpoint };
}

function hold(id: string): void {
	if (!id || busy.has(id)) return;
	let settle = () => {};
	const tracked = new Promise<void>((resolve) => {
		settle = resolve;
	});
	inflight.add(tracked);
	void tracked.finally(() => inflight.delete(tracked));
	host().track(tracked);
	busy.set(id, settle);
}

function release(id: string): void {
	const settle = busy.get(id);
	if (!settle) return;
	busy.delete(id);
	settle();
}

async function finish(runtime: Runtime, context: Context, id: string) {
	release(id);
	await runtime.commit(async () => done(), context);
}

async function sleepUntil(runtime: Runtime, until: number, context: Context) {
	const ops = host();
	for (;;) {
		const at = ops.now();
		if (at >= until) return;
		const step = testClockActive() ? testClockPollMs : Math.max(1, until - at);
		await runtime.sleep(at + step, context);
	}
}

async function readArm(chatKey: string, context: Context) {
	const notes = await host().harness.snapshot(HarvestNotesDoc, context);
	return notes?.armed?.[chatKey];
}

export const HarvestTask = defineTask<Input, Checkpoint, null>({
	name: "pi-bot.harvest",
	version: 1,
	initial: () => ({ phase: "wait" }),
	async abort(_task, runtime, context) {
		await runtime.commit(async () => done(), context);
	},
	phases: {
		async wait(task, runtime, context) {
			const id = task.input.chatKey;
			for (;;) {
				const arm = await readArm(id, context);
				if (
					!arm ||
					arm.taskId !== taskKey(runtime.taskId) ||
					arm.at !== task.input.entryId
				) {
					await finish(runtime, context, id);
					return;
				}
				if (host().now() >= arm.until) {
					hold(id);
					await runtime.commit(async () => running({ phase: "snap" }), context);
					return;
				}
				await sleepUntil(runtime, arm.until, context);
			}
		},
		async snap(task, runtime, context) {
			await snap(task.input, runtime, context);
		},
		async fork(task, runtime, context) {
			await fork(task.input, task.state.checkpoint, runtime, context);
		},
		async awaitChild(task, runtime, context) {
			await awaitChild(task.input, task.state.checkpoint, runtime, context);
		},
		async note(task, runtime, context) {
			await note(task.input, task.state.checkpoint, runtime, context);
		},
	},
});

export function harvestExtension() {
	return defineExtension({
		name: "pi-bot.harvest",
		tasks: [HarvestTask],
	});
}

/** Drop the wake for a chat that just received new user text. */
export async function cancelHarvest(chatKey: string): Promise<void> {
	const ops = harvestHost.current;
	if (!ops) return;
	const notes = await ops.harness.snapshot(HarvestNotesDoc, BACKGROUND_CONTEXT);
	const arm = notes?.armed?.[chatKey];
	if (!arm) return;
	getLogger().debug("dropping harvest wake on new input", { chat: chatKey });
	await ops.harness.commit(async (tx) => {
		const doc = await tx.doc(HarvestNotesDoc);
		if (doc.armed) delete doc.armed[chatKey];
	}, BACKGROUND_CONTEXT);
	await ops.harness.abortTask(Number(arm.taskId) as TaskId, BACKGROUND_CONTEXT);
}

/** Arm a harvest of `entryId` after the idle delay. The same entry only moves the wake. */
export async function armHarvest(input: {
	botId: string;
	chatKey: string;
	entryId: number;
}): Promise<void> {
	const ops = harvestHost.current;
	if (!ops) return;
	const notes = await ops.harness.snapshot(HarvestNotesDoc, BACKGROUND_CONTEXT);
	if (notes?.completed?.[input.chatKey] === input.entryId) return;
	const until = ops.now() + ops.delayMs;
	const existing = notes?.armed?.[input.chatKey];
	if (existing && existing.at === input.entryId) {
		const live = await ops.harness.getTask(
			Number(existing.taskId) as TaskId,
			BACKGROUND_CONTEXT,
		);
		if (live && live.state.status !== "terminal") {
			await ops.harness.commit(async (tx) => {
				const doc = await tx.doc(HarvestNotesDoc);
				const arm = doc.armed?.[input.chatKey];
				if (arm && arm.at === input.entryId) arm.until = until;
			}, BACKGROUND_CONTEXT);
			getLogger().debug("harvest wake moved", {
				chat: input.chatKey,
				delayMs: ops.delayMs,
			});
			return;
		}
	}
	if (existing) {
		await ops.harness.abortTask(
			Number(existing.taskId) as TaskId,
			BACKGROUND_CONTEXT,
		);
	}
	const root = await ensureBotRoot(ops.harness, input.botId);
	if (!root) return;
	const taskId = await ops.harness.commit(
		(tx) =>
			tx.createTask(HarvestTask, input, {
				ownership: { kind: "conversation" },
				conversationId: root,
				background: true,
			}),
		BACKGROUND_CONTEXT,
	);
	await ops.harness.commit(async (tx) => {
		const doc = await tx.doc(HarvestNotesDoc);
		doc.armed = {
			...doc.armed,
			[input.chatKey]: {
				taskId: String(taskId),
				at: input.entryId,
				until,
			},
		};
	}, BACKGROUND_CONTEXT);
	getLogger().debug("harvest armed", {
		chat: input.chatKey,
		bot: input.botId,
		delayMs: ops.delayMs,
	});
}

/** After restart, arm the rested entry unless this chat already harvested it. */
export async function armIdleHarvest(input: {
	botId: string;
	chatKey: string;
	conversationId: ConversationId;
}): Promise<void> {
	const ops = harvestHost.current;
	if (!ops) return;
	const conversation = await ops.harness.conversation(
		input.conversationId,
		BACKGROUND_CONTEXT,
	);
	if (!conversation) return;
	const live = await ops.harness.snapshot(
		LiveDoc,
		input.conversationId,
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
	const state = await ops.harness.snapshot(HarvestNotesDoc, BACKGROUND_CONTEXT);
	if (state?.completed?.[input.chatKey] === entryId) return;
	if (state?.armed?.[input.chatKey]?.at === entryId) return;
	await armHarvest({
		botId: input.botId,
		chatKey: input.chatKey,
		entryId: entryId as unknown as number,
	});
}

export async function harvestIdle(): Promise<void> {
	while (inflight.size > 0) await Promise.all([...inflight]);
}

async function snap(input: Input, runtime: Runtime, context: Context) {
	const ops = host();
	hold(input.chatKey);
	try {
		const arm = await readArm(input.chatKey, context);
		if (!arm || arm.taskId !== taskKey(runtime.taskId)) {
			await finish(runtime, context, input.chatKey);
			return;
		}
		const chat = (await listChats(ops.harness)).find(
			(item) => item.key === input.chatKey && item.botId === input.botId,
		);
		const parent = chat
			? await ops.harness.conversation(chat.conversationId, context)
			: undefined;
		if (!chat || !parent) {
			await clearArm(input.chatKey, context);
			await finish(runtime, context, input.chatKey);
			return;
		}
		const at = input.entryId;
		const notes = await ops.harness.snapshot(HarvestNotesDoc, context);
		const watermark = notes?.completed?.[input.chatKey];
		const unchanged = watermark === at;
		const noDelta =
			watermark !== undefined &&
			!unchanged &&
			!(await hasUserAfter(parent, watermark, at, context));
		if (unchanged || noDelta) {
			await runtime.commit(async (tx) => {
				const doc = await tx.doc(HarvestNotesDoc);
				doc.completed = { ...doc.completed, [input.chatKey]: at };
				if (doc.armed) delete doc.armed[input.chatKey];
				return done();
			}, context);
			release(input.chatKey);
			return;
		}
		const before = Object.fromEntries(
			await snapshotBot(botDir(ops.home, input.botId)),
		);
		await runtime.commit(
			async () =>
				running({
					phase: "fork",
					at,
					...(watermark === undefined ? {} : { watermark }),
					before,
				}),
			context,
		);
	} catch (error) {
		await retry(input.chatKey, runtime, context, error);
	}
}

async function fork(
	input: Input,
	checkpoint: Extract<Checkpoint, { phase: "fork" }>,
	runtime: Runtime,
	context: Context,
) {
	const ops = host();
	hold(input.chatKey);
	try {
		const chat = (await listChats(ops.harness)).find(
			(item) => item.key === input.chatKey,
		);
		if (!chat) {
			await clearArm(input.chatKey, context);
			await finish(runtime, context, input.chatKey);
			return;
		}
		let childId = await runtime.memo<number>("child", context);
		if (childId === undefined) {
			let created = 0;
			await runtime.commit(async (tx) => {
				const found = (
					await tx.scanConversations({ ownerTaskId: runtime.taskId }, 1)
				).items[0];
				if (found) created = found.id as unknown as number;
				else {
					const child = await tx.forkConversation(
						chat.conversationId,
						checkpoint.at as EntryId,
						{ ownership: { kind: "task", taskId: runtime.taskId } },
					);
					created = child.id as unknown as number;
				}
				return undefined;
			}, context);
			childId = await runtime.memo("child", created, context);
		}
		const child = await ops.harness.conversation(
			childId as ConversationId,
			context,
		);
		if (!child) throw new Error("Harvest child is missing.");
		const bots = await ops.harness.snapshot(BotsDoc, context);
		const bot = bots?.items.find((item) => item.id === input.botId);
		await child.configure({ tools: harvestTools(bot, ops.registry) }, context);
		await runtime.commit(
			async () =>
				running({
					phase: "awaitChild",
					at: checkpoint.at,
					...(checkpoint.watermark === undefined
						? {}
						: { watermark: checkpoint.watermark }),
					before: checkpoint.before,
					childId,
				}),
			context,
		);
	} catch (error) {
		await retry(input.chatKey, runtime, context, error);
	}
}

async function awaitChild(
	input: Input,
	checkpoint: Extract<Checkpoint, { phase: "awaitChild" }>,
	runtime: Runtime,
	context: Context,
) {
	const ops = host();
	hold(input.chatKey);
	try {
		const child = await ops.harness.conversation(
			checkpoint.childId as ConversationId,
			context,
		);
		if (!child) {
			await finish(runtime, context, input.chatKey);
			return;
		}
		const submission = await child.submit(
			{
				type: "input",
				content: harvestPrompt(HARVEST_TEXT, checkpoint.watermark),
				requestId: harvestRequestId(input.chatKey, checkpoint.at),
				whenBusy: "steer",
			},
			context,
		);
		await submission.wait(context);
		await child.waitForIdle(context);
		await runtime.commit(
			async () =>
				running({
					phase: "note",
					at: checkpoint.at,
					before: checkpoint.before,
					childId: checkpoint.childId,
				}),
			context,
		);
	} catch (error) {
		await retry(input.chatKey, runtime, context, error);
	}
}

async function note(
	input: Input,
	checkpoint: Extract<Checkpoint, { phase: "note" }>,
	runtime: Runtime,
	context: Context,
) {
	const ops = host();
	hold(input.chatKey);
	try {
		const files = changedFiles(
			new Map(Object.entries(checkpoint.before)),
			await snapshotBot(botDir(ops.home, input.botId)),
		);
		await runtime.commit(async (tx) => {
			const notes = await tx.doc(HarvestNotesDoc);
			notes.completed = { ...notes.completed, [input.chatKey]: checkpoint.at };
			if (notes.armed?.[input.chatKey]?.taskId === taskKey(runtime.taskId))
				delete notes.armed[input.chatKey];
			if (files.length > 0) {
				notes.notes.push({
					chatKey: input.chatKey,
					at: checkpoint.at,
					files,
					when: ops.now(),
				});
			}
			return done();
		}, context);
		release(input.chatKey);
		const log = getLogger().child({
			harvest: input.chatKey,
			chat: input.chatKey,
			bot: input.botId,
		});
		if (files.length === 0) log.debug("harvest finished with no file changes");
		else
			log.debug("harvest wrote knowledge", {
				files: files.map((file) => file.path),
			});
	} catch (error) {
		await retry(input.chatKey, runtime, context, error);
	}
}

async function retry(
	chatKey: string,
	runtime: Runtime,
	context: Context,
	error: unknown,
) {
	if (runtime.signal.aborted) throw error;
	getLogger().error("harvest failed; will retry", { error, harvest: chatKey });
	await host().harness.commit(async (tx) => {
		const doc = await tx.doc(HarvestNotesDoc);
		const arm = doc.armed?.[chatKey];
		if (arm && arm.taskId === taskKey(runtime.taskId))
			arm.until = host().now() + HARVEST_RETRY_MS;
	}, context);
	release(chatKey);
	await runtime.commit(async () => running({ phase: "wait" }), context);
}

async function clearArm(chatKey: string, context: Context) {
	await host().harness.commit(async (tx) => {
		const doc = await tx.doc(HarvestNotesDoc);
		if (doc.armed) delete doc.armed[chatKey];
	}, context);
}

async function hasUserAfter(
	conversation: Conversation,
	after: number,
	through: number,
	context: Context,
): Promise<boolean> {
	let cursor: Parameters<Conversation["entries"]>[2];
	for (;;) {
		const page = await conversation.entries(
			{
				order: "ascending",
				minEntryId: after as EntryId,
				maxEntryId: through as EntryId,
			},
			100,
			cursor,
			context,
		);
		for (const entry of page.items) {
			const id = entry.id as unknown as number;
			if (id <= after || id > through) continue;
			if (entry.model?.[0]?.role === "user") return true;
		}
		if (page.next === undefined) return false;
		cursor = page.next;
	}
}
