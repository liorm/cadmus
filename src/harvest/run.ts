import type { Context } from "@earendil-works/chord/context";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	type Conversation,
	type ConversationId,
	defineExtension,
	defineTask,
	type EntryId,
	LiveDoc,
	type TaskId,
	type TaskRuntime,
} from "@earendil-works/pi-durable";
import { BotsDoc, botDir, ensureBotRoot } from "../channels/bots.ts";
import { listChats } from "../channels/chats.ts";
import { getLogger } from "../log.ts";
import { type AppServices, requireServices } from "../services.ts";
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

type Input = { botId: string; chatKey: string; entryId: number };
type Checkpoint =
	| { phase: "wait"; seq?: number; until?: number }
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

function services(context: Context): AppServices {
	return requireServices(context);
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

function hold(id: string, context: Context): void {
	if (!id || busy.has(id)) return;
	let settle = () => {};
	const tracked = new Promise<void>((resolve) => {
		settle = resolve;
	});
	services(context).track(tracked);
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
	const at = runtime.now();
	if (at < until) await runtime.sleep(until, context);
}

async function readArm(chatKey: string, context: Context) {
	const notes = await services(context).harness.snapshot(
		HarvestNotesDoc,
		context,
	);
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
			const waiting = task.state.checkpoint;
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
				if (waiting.seq !== arm.seq || waiting.until === undefined) {
					await runtime.commit(
						async () =>
							running({
								phase: "wait",
								seq: arm.seq,
								until: runtime.now() + services(context).harvestDelayMs,
							}),
						context,
					);
					return;
				}
				if (runtime.now() >= waiting.until) {
					hold(id, context);
					await runtime.commit(async () => running({ phase: "snap" }), context);
					return;
				}
				await sleepUntil(runtime, waiting.until, context);
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
export async function cancelHarvest(
	app: AppServices,
	chatKey: string,
): Promise<void> {
	const notes = await app.harness.snapshot(HarvestNotesDoc, BACKGROUND_CONTEXT);
	const arm = notes?.armed?.[chatKey];
	if (!arm) return;
	getLogger().debug("dropping harvest wake on new input", { chat: chatKey });
	await app.harness.commit(async (tx) => {
		const doc = await tx.doc(HarvestNotesDoc);
		if (doc.armed) delete doc.armed[chatKey];
	}, BACKGROUND_CONTEXT);
	await app.harness.abortTask(Number(arm.taskId) as TaskId, BACKGROUND_CONTEXT);
}

/** Arm a harvest of `entryId` after the idle delay. The same entry only moves the wake. */
export async function armHarvest(
	app: AppServices,
	input: {
		botId: string;
		chatKey: string;
		entryId: number;
	},
): Promise<void> {
	const notes = await app.harness.snapshot(HarvestNotesDoc, BACKGROUND_CONTEXT);
	if (notes?.completed?.[input.chatKey] === input.entryId) return;
	const existing = notes?.armed?.[input.chatKey];
	if (existing && existing.at === input.entryId) {
		const live = await app.harness.getTask(
			Number(existing.taskId) as TaskId,
			BACKGROUND_CONTEXT,
		);
		const phase =
			live && "checkpoint" in live.state
				? (live.state.checkpoint as { phase?: string }).phase
				: undefined;
		if (live && live.state.status !== "terminal" && phase !== "wait") return;
	}
	if (existing) {
		await app.harness.abortTask(
			Number(existing.taskId) as TaskId,
			BACKGROUND_CONTEXT,
		);
	}
	const root = await ensureBotRoot(app.harness, input.botId);
	if (!root) return;
	const taskId = await app.harness.commit(
		(tx) =>
			tx.createTask(HarvestTask, input, {
				ownership: { kind: "conversation" },
				conversationId: root,
				background: true,
			}),
		BACKGROUND_CONTEXT,
	);
	await app.harness.commit(async (tx) => {
		const doc = await tx.doc(HarvestNotesDoc);
		doc.armed = {
			...doc.armed,
			[input.chatKey]: {
				taskId: String(taskId),
				at: input.entryId,
				seq: 1,
			},
		};
	}, BACKGROUND_CONTEXT);
	getLogger().debug("harvest armed", {
		chat: input.chatKey,
		bot: input.botId,
		delayMs: app.harvestDelayMs,
	});
}

/** After restart, arm the rested entry unless this chat already harvested it. */
export async function armIdleHarvest(
	app: AppServices,
	input: {
		botId: string;
		chatKey: string;
		conversationId: ConversationId;
	},
): Promise<void> {
	const conversation = await app.harness.conversation(
		input.conversationId,
		BACKGROUND_CONTEXT,
	);
	if (!conversation) return;
	const live = await app.harness.snapshot(
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
	const state = await app.harness.snapshot(HarvestNotesDoc, BACKGROUND_CONTEXT);
	if (state?.completed?.[input.chatKey] === entryId) return;
	if (state?.armed?.[input.chatKey]?.at === entryId) return;
	await armHarvest(app, {
		botId: input.botId,
		chatKey: input.chatKey,
		entryId: entryId as unknown as number,
	});
}

async function snap(input: Input, runtime: Runtime, context: Context) {
	const app = services(context);
	hold(input.chatKey, context);
	try {
		const arm = await readArm(input.chatKey, context);
		if (!arm || arm.taskId !== taskKey(runtime.taskId)) {
			await finish(runtime, context, input.chatKey);
			return;
		}
		const chat = (await listChats(app.harness)).find(
			(item) => item.key === input.chatKey && item.botId === input.botId,
		);
		const parent = chat
			? await app.harness.conversation(chat.conversationId, context)
			: undefined;
		if (!chat || !parent) {
			await clearArm(input.chatKey, context);
			await finish(runtime, context, input.chatKey);
			return;
		}
		const at = input.entryId;
		const notes = await app.harness.snapshot(HarvestNotesDoc, context);
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
			await snapshotBot(botDir(app.home, input.botId)),
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
	const app = services(context);
	hold(input.chatKey, context);
	try {
		const chat = (await listChats(app.harness)).find(
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
		const child = await app.harness.conversation(
			childId as ConversationId,
			context,
		);
		if (!child) throw new Error("Harvest child is missing.");
		const bots = await app.harness.snapshot(BotsDoc, context);
		const bot = bots?.items.find((item) => item.id === input.botId);
		await child.configure({ tools: harvestTools(bot, app.registry) }, context);
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
	const app = services(context);
	hold(input.chatKey, context);
	try {
		const child = await app.harness.conversation(
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
	const app = services(context);
	hold(input.chatKey, context);
	try {
		const files = changedFiles(
			new Map(Object.entries(checkpoint.before)),
			await snapshotBot(botDir(app.home, input.botId)),
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
					when: runtime.now(),
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
	const arm = await readArm(chatKey, context);
	release(chatKey);
	await runtime.commit(
		async () =>
			running({
				phase: "wait",
				...(arm ? { seq: arm.seq } : {}),
				until: runtime.now() + HARVEST_RETRY_MS,
			}),
		context,
	);
}

async function clearArm(chatKey: string, context: Context) {
	await services(context).harness.commit(async (tx) => {
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
