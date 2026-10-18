import type { Context } from "@earendil-works/chord/context";
import {
	type Conversation,
	type ConversationId,
	defineExtension,
	defineTask,
	type EntryId,
	type Harness,
	type RegistryReader,
	type TaskRuntime,
} from "@earendil-works/pi-durable";
import { BotsDoc, botDir } from "../channels/bots.ts";
import { listChats } from "../channels/telegram/chats.ts";
import { testClockActive, testClockPollMs } from "../clock.ts";
import { getLogger } from "../log.ts";
import type { BotRuntime } from "../runtime.ts";
import { nextCron, parseCron } from "./cron.ts";
import { dispatchFire } from "./dispatch.ts";
import {
	changedFiles,
	HARVEST_RETRY_MS,
	HarvestNotesDoc,
	harvestPrompt,
	harvestTools,
	snapshotBot,
} from "./harvest.ts";
import { harvestRequestId, isHarvestId } from "./ids.ts";
import type { Schedule, ScheduleTarget } from "./service.ts";
import type { StoredSchedule } from "./store.ts";

/** Host services a schedule task reads. Bound before the harness resumes. */
export type ScheduleOps = {
	now(): number;
	timeZone: string;
	home: string;
	harness: Harness;
	registry: RegistryReader;
	runtime(botId: string): BotRuntime | undefined;
	get(id: string): StoredSchedule | undefined;
	setNextRun(id: string, nextRun: number): void;
	setTaskId(id: string, taskId: string): void;
	remove(id: string): void;
	claim(
		row: StoredSchedule,
		requestId: string,
		cronNext: number | undefined,
	): boolean;
	track(work: Promise<void>): void;
};

export const scheduleOps: { current?: ScheduleOps } = {};

type Checkpoint =
	| { phase: "wait" }
	| { phase: "run"; nextRun: number }
	| { phase: "snap"; nextRun: number }
	| {
			phase: "fork";
			nextRun: number;
			at: number;
			chatKey: string;
			watermark?: number;
			before: Record<string, string>;
	  }
	| {
			phase: "awaitChild";
			nextRun: number;
			at: number;
			chatKey: string;
			watermark?: number;
			before: Record<string, string>;
			childId: number;
	  }
	| {
			phase: "note";
			nextRun: number;
			at: number;
			chatKey: string;
			before: Record<string, string>;
			childId: number;
	  };

type Input = { scheduleId: string };
type Runtime = TaskRuntime<Input, Checkpoint, null, object>;

function taskKey(id: unknown): string {
	return String(id);
}

function host(): ScheduleOps {
	const current = scheduleOps.current;
	if (!current) throw new Error("Schedule task has no host.");
	return current;
}

const busy = new Map<string, () => void>();

/** Keep `ScheduleService.idle` open while an occurrence is past the wait. */
function hold(id: string): void {
	if (!id || busy.has(id)) return;
	let settle = () => {};
	const tracked = new Promise<void>((resolve) => {
		settle = resolve;
	});
	host().track(tracked);
	busy.set(id, settle);
}

function release(id: string): void {
	const settle = busy.get(id);
	if (!settle) return;
	busy.delete(id);
	settle();
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

/** Sleep until `until` on the harness clock. A pinned test clock is polled. */
async function sleepUntil(
	runtime: Runtime,
	until: number,
	context: Context,
): Promise<void> {
	const ops = host();
	for (;;) {
		const at = ops.now();
		if (at >= until) return;
		const step = testClockActive() ? testClockPollMs : Math.max(1, until - at);
		await runtime.sleep(at + step, context);
	}
}

function scheduleOf(row: StoredSchedule): Schedule {
	const target = JSON.parse(row.targetJson) as ScheduleTarget;
	const base = {
		id: row.id,
		botId: row.botId,
		target,
		text: row.text,
		...(row.name ? { name: row.name } : {}),
		...(row.enabled ? {} : { enabled: false as const }),
		nextRun: row.nextRun,
	};
	if (row.kind === "cron")
		return { ...base, kind: "cron" as const, cron: row.cron ?? "" };
	return { ...base, kind: "when" as const, when: row.nextRun };
}

async function goWait(
	runtime: Runtime,
	context: Context,
	id: string,
): Promise<void> {
	release(id);
	await runtime.commit(async () => running({ phase: "wait" }), context);
}

async function finish(
	runtime: Runtime,
	context: Context,
	id?: string,
): Promise<void> {
	if (id) release(id);
	await runtime.commit(async () => done(), context);
}

export const ScheduleTask = defineTask<Input, Checkpoint, null>({
	name: "pi-bot.schedule",
	version: 1,
	initial: () => ({ phase: "wait" }),
	async abort(_task, runtime, context) {
		await runtime.commit(async () => done(), context);
	},
	phases: {
		async wait(task, runtime, context) {
			const ops = host();
			const id = task.input.scheduleId;
			for (;;) {
				const row = ops.get(id);
				if (
					!row?.enabled ||
					(row.taskId !== null && row.taskId !== taskKey(runtime.taskId))
				) {
					await finish(runtime, context, id);
					return;
				}
				if (!row.taskId) ops.setTaskId(id, taskKey(runtime.taskId));
				if (ops.now() >= row.nextRun) {
					await runtime.commit(
						async () => running({ phase: "run", nextRun: row.nextRun }),
						context,
					);
					return;
				}
				await sleepUntil(runtime, row.nextRun, context);
			}
		},
		async run(task, runtime, context) {
			const ops = host();
			const id = task.input.scheduleId;
			hold(id);
			const nextRun = task.state.checkpoint.nextRun;
			const row = ops.get(id);
			if (!row || row.taskId !== taskKey(runtime.taskId)) {
				await finish(runtime, context, id);
				return;
			}
			if (isHarvestId(id)) {
				await runtime.commit(
					async () => running({ phase: "snap", nextRun }),
					context,
				);
				return;
			}
			const requestId = `sched:${row.id}:${nextRun}`;
			const fields = row.cron ? parseCron(row.cron) : undefined;
			const cronNext = fields
				? nextCron(fields, Math.max(ops.now(), nextRun), ops.timeZone)
				: undefined;
			const admitted = ops.claim({ ...row, nextRun }, requestId, cronNext);
			if (admitted) {
				const work = dispatchFire({
					schedule: scheduleOf({ ...row, nextRun }),
					requestId,
					harness: ops.harness,
					runtime: ops.runtime,
				});
				let settle: () => void = () => {};
				const tracked = new Promise<void>((resolve) => {
					settle = resolve;
				});
				ops.track(tracked);
				try {
					await work;
				} finally {
					settle();
				}
			}
			const fresh = ops.get(id);
			if (!fresh || fresh.taskId !== taskKey(runtime.taskId)) {
				await finish(runtime, context, id);
				return;
			}
			await goWait(runtime, context, id);
		},
		async snap(task, runtime, context) {
			await harvestSnap(
				task.input.scheduleId,
				task.state.checkpoint.nextRun,
				runtime,
				context,
			);
		},
		async fork(task, runtime, context) {
			await harvestFork(task.state.checkpoint, runtime, context);
		},
		async awaitChild(task, runtime, context) {
			await harvestAwait(
				task.input.scheduleId,
				task.state.checkpoint,
				runtime,
				context,
			);
		},
		async note(task, runtime, context) {
			await harvestNote(
				task.input.scheduleId,
				task.state.checkpoint,
				runtime,
				context,
			);
		},
	},
});

export function scheduleExtension() {
	return defineExtension({
		name: "pi-bot.schedule",
		tasks: [ScheduleTask],
	});
}

async function harvestSnap(
	scheduleId: string,
	nextRun: number,
	runtime: Runtime,
	context: Context,
): Promise<void> {
	const ops = host();
	hold(scheduleId);
	try {
		const row = ops.get(scheduleId);
		if (!row || row.taskId !== taskKey(runtime.taskId)) {
			await finish(runtime, context, scheduleId);
			return;
		}
		const schedule = scheduleOf(row);
		const target = schedule.target;
		if (target.mode !== "fork") {
			ops.remove(scheduleId);
			await finish(runtime, context, scheduleId);
			return;
		}
		const chat = (await listChats(ops.harness)).find(
			(item) => item.key === target.chatId && item.botId === schedule.botId,
		);
		const parent = chat
			? await ops.harness.conversation(chat.conversationId, context)
			: undefined;
		if (!chat || !parent) {
			ops.remove(scheduleId);
			await finish(runtime, context, scheduleId);
			return;
		}
		const at = await resolveEntry(parent, target.at, context);
		if (at === undefined) {
			ops.remove(scheduleId);
			await finish(runtime, context, scheduleId);
			return;
		}
		const atNum = at as unknown as number;
		const notes = await ops.harness.snapshot(HarvestNotesDoc, context);
		const watermark = notes?.completed?.[chat.key];
		const unchanged = watermark === atNum;
		const noDelta =
			watermark !== undefined &&
			!unchanged &&
			!(await hasUserAfter(parent, watermark, atNum, context));
		if (unchanged || noDelta) {
			await runtime.commit(async (tx) => {
				const doc = await tx.doc(HarvestNotesDoc);
				doc.completed = { ...doc.completed, [chat.key]: atNum };
				return done();
			}, context);
			if (ops.get(scheduleId)?.nextRun === nextRun) ops.remove(scheduleId);
			release(scheduleId);
			return;
		}
		const before = Object.fromEntries(
			await snapshotBot(botDir(ops.home, schedule.botId)),
		);
		await runtime.commit(
			async () =>
				running({
					phase: "fork",
					nextRun,
					at: atNum,
					chatKey: chat.key,
					...(watermark === undefined ? {} : { watermark }),
					before,
				}),
			context,
		);
	} catch (error) {
		await retryHarvest(scheduleId, runtime, context, error);
	}
}

async function harvestFork(
	checkpoint: Extract<Checkpoint, { phase: "fork" }>,
	runtime: Runtime,
	context: Context,
): Promise<void> {
	const ops = host();
	const record = await runtime.getTask(runtime.taskId, context);
	const scheduleId = (record?.input as Input | undefined)?.scheduleId ?? "";
	hold(scheduleId);
	try {
		const row = ops.get(scheduleId);
		const chat = (await listChats(ops.harness)).find(
			(item) => item.key === checkpoint.chatKey,
		);
		if (!row || !chat) {
			if (row) ops.remove(scheduleId);
			await finish(runtime, context, scheduleId);
			return;
		}
		const schedule = scheduleOf(row);
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
		const bot = bots?.items.find((item) => item.id === schedule.botId);
		await child.configure({ tools: harvestTools(bot, ops.registry) }, context);
		await runtime.commit(
			async () =>
				running({
					phase: "awaitChild",
					nextRun: checkpoint.nextRun,
					at: checkpoint.at,
					chatKey: checkpoint.chatKey,
					...(checkpoint.watermark === undefined
						? {}
						: { watermark: checkpoint.watermark }),
					before: checkpoint.before,
					childId,
				}),
			context,
		);
	} catch (error) {
		await retryHarvest(scheduleId, runtime, context, error);
	}
}

async function harvestAwait(
	scheduleId: string,
	checkpoint: Extract<Checkpoint, { phase: "awaitChild" }>,
	runtime: Runtime,
	context: Context,
): Promise<void> {
	const ops = host();
	hold(scheduleId);
	try {
		const row = ops.get(scheduleId);
		const child = await ops.harness.conversation(
			checkpoint.childId as ConversationId,
			context,
		);
		if (!row || !child) {
			await finish(runtime, context, scheduleId);
			return;
		}
		const submission = await child.submit(
			{
				type: "input",
				content: harvestPrompt(scheduleOf(row).text, checkpoint.watermark),
				requestId: harvestRequestId(checkpoint.chatKey, checkpoint.at),
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
					nextRun: checkpoint.nextRun,
					at: checkpoint.at,
					chatKey: checkpoint.chatKey,
					before: checkpoint.before,
					childId: checkpoint.childId,
				}),
			context,
		);
	} catch (error) {
		await retryHarvest(scheduleId, runtime, context, error);
	}
}

async function harvestNote(
	scheduleId: string,
	checkpoint: Extract<Checkpoint, { phase: "note" }>,
	runtime: Runtime,
	context: Context,
): Promise<void> {
	const ops = host();
	hold(scheduleId);
	try {
		const row = ops.get(scheduleId);
		if (!row) {
			await finish(runtime, context, scheduleId);
			return;
		}
		const files = changedFiles(
			new Map(Object.entries(checkpoint.before)),
			await snapshotBot(botDir(ops.home, row.botId)),
		);
		await runtime.commit(async (tx) => {
			const notes = await tx.doc(HarvestNotesDoc);
			notes.completed = {
				...notes.completed,
				[checkpoint.chatKey]: checkpoint.at,
			};
			if (files.length > 0) {
				notes.notes.push({
					chatKey: checkpoint.chatKey,
					at: checkpoint.at,
					files,
					when: ops.now(),
				});
			}
			return undefined;
		}, context);
		const fresh = ops.get(scheduleId);
		const sameWake = fresh?.nextRun === checkpoint.nextRun;
		if (sameWake) ops.remove(scheduleId);
		if (ops.get(scheduleId)?.taskId === taskKey(runtime.taskId))
			await goWait(runtime, context, scheduleId);
		else await finish(runtime, context, scheduleId);
		const log = getLogger().child({
			harvest: scheduleId,
			chat: checkpoint.chatKey,
			bot: row.botId,
		});
		if (files.length === 0) log.debug("harvest finished with no file changes");
		else
			log.debug("harvest wrote knowledge", {
				files: files.map((file) => file.path),
			});
	} catch (error) {
		await retryHarvest(scheduleId, runtime, context, error);
	}
}

async function retryHarvest(
	scheduleId: string,
	runtime: Runtime,
	context: Context,
	error: unknown,
): Promise<void> {
	if (runtime.signal.aborted) throw error;
	const ops = host();
	getLogger().error("harvest fire failed; will retry", {
		error,
		harvest: scheduleId,
	});
	if (ops.get(scheduleId))
		ops.setNextRun(scheduleId, ops.now() + HARVEST_RETRY_MS);
	await goWait(runtime, context, scheduleId);
}

async function resolveEntry(
	conversation: Conversation,
	at: number | undefined,
	context: Context,
): Promise<EntryId | undefined> {
	if (at !== undefined) return at as EntryId;
	const page = await conversation.entries(
		{ order: "descending" },
		1,
		undefined,
		context,
	);
	return page.items[0]?.id;
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
