import type { Context } from "@earendil-works/chord/context";
import {
	defineExtension,
	defineTask,
	type TaskRuntime,
} from "@earendil-works/pi-durable";
import { type AppServices, requireServices } from "../services.ts";
import { nextCron, parseCron } from "./cron.ts";
import { dispatchFire } from "./dispatch.ts";
import type { Schedule, ScheduleTarget } from "./service.ts";
import type { StoredSchedule } from "./store.ts";

type Checkpoint = { phase: "wait" } | { phase: "run"; nextRun: number };

type Input = { scheduleId: string };
type Runtime = TaskRuntime<Input, Checkpoint, null, object>;

function taskKey(id: unknown): string {
	return String(id);
}

function services(context: Context): AppServices {
	return requireServices(context);
}

const busy = new Map<string, () => void>();

/** Keep `ScheduleService.idle` open while an occurrence is past the wait. */
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

function done() {
	return {
		status: "terminal" as const,
		outcome: { status: "completed" as const, result: null },
	};
}

function running(checkpoint: Checkpoint) {
	return { status: "running" as const, checkpoint };
}

/** Sleep until `until` on the harness clock. */
async function sleepUntil(
	runtime: Runtime,
	until: number,
	context: Context,
): Promise<void> {
	const at = runtime.now();
	if (at < until) await runtime.sleep(until, context);
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
			const ops = services(context);
			const id = task.input.scheduleId;
			for (;;) {
				const row = ops.catalog.get(id);
				if (
					!row?.enabled ||
					(row.taskId !== null && row.taskId !== taskKey(runtime.taskId))
				) {
					await finish(runtime, context, id);
					return;
				}
				if (!row.taskId) ops.catalog.setTaskId(id, taskKey(runtime.taskId));
				if (runtime.now() >= row.nextRun) {
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
			const ops = services(context);
			const id = task.input.scheduleId;
			hold(id, context);
			const nextRun = task.state.checkpoint.nextRun;
			const row = ops.catalog.get(id);
			if (!row || row.taskId !== taskKey(runtime.taskId)) {
				await finish(runtime, context, id);
				return;
			}
			const requestId = `sched:${row.id}:${nextRun}`;
			const fields = row.cron ? parseCron(row.cron) : undefined;
			const cronNext = fields
				? nextCron(fields, Math.max(runtime.now(), nextRun), ops.timeZone)
				: undefined;
			const admitted = ops.catalog.claim(
				{ ...row, nextRun },
				requestId,
				cronNext,
			);
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
			const fresh = ops.catalog.get(id);
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
