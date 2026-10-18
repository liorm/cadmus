import type { Context } from "@earendil-works/chord/context";
import {
	defineExtension,
	defineTask,
	type Harness,
	type RegistryReader,
	type TaskRuntime,
} from "@earendil-works/pi-durable";
import { testClockActive, testClockPollMs } from "../clock.ts";
import type { BotRuntime } from "../runtime.ts";
import { nextCron, parseCron } from "./cron.ts";
import { dispatchFire } from "./dispatch.ts";
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

type Checkpoint = { phase: "wait" } | { phase: "run"; nextRun: number };

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
	},
});

export function scheduleExtension() {
	return defineExtension({
		name: "pi-bot.schedule",
		tasks: [ScheduleTask],
	});
}
