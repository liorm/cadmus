import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness, TaskInspection } from "@earendil-works/pi-durable";
import { getLogger } from "./log.js";
import type { FamilyStore } from "./store/family-interface.js";

/**
 * Inspects a single pi-durable TaskInspection and returns its scheduled wake time
 * if it is a `cadmus.schedule` task waiting for a future timestamp.
 */
export function scheduledWakeTime(
	inspection: TaskInspection,
	familyStore?: FamilyStore,
): number | undefined {
	const { record } = inspection;
	if (record.kind !== "cadmus.schedule") return undefined;
	if (record.state.status !== "running") return undefined;

	const checkpoint = record.state.checkpoint as
		| { phase?: string; nextRun?: number }
		| undefined;
	if (checkpoint?.phase === "run") {
		return undefined;
	}

	const input = record.input as { scheduleId?: string } | undefined;
	if (input?.scheduleId && familyStore) {
		const sched = familyStore.schedules.getSchedule(input.scheduleId);
		if (
			!sched?.enabled ||
			familyStore.schedules.hasFired(sched.id, sched.nextRun)
		) {
			return undefined;
		}
		return checkpoint?.phase === "wait" &&
			typeof checkpoint.nextRun === "number"
			? checkpoint.nextRun
			: sched.nextRun;
	}

	if (checkpoint?.phase === "wait" && typeof checkpoint.nextRun === "number") {
		return checkpoint.nextRun;
	}

	return undefined;
}

/**
 * Returns the scheduled retry wake time for a `pi.compaction` task sleeping
 * in `phase: "retry"`, or undefined otherwise.
 */
export function compactionRetryWakeTime(
	inspection: TaskInspection,
): number | undefined {
	const { record } = inspection;
	if (record.kind !== "pi.compaction") return undefined;
	if (record.state.status !== "running") return undefined;
	const checkpoint = record.state.checkpoint as
		| { phase?: string; until?: number }
		| undefined;
	if (checkpoint?.phase === "retry" && typeof checkpoint.until === "number") {
		return checkpoint.until;
	}
	return undefined;
}

/**
 * Computes the earliest next wake timestamp across all live `cadmus.schedule`
 * and `pi.compaction` tasks in `harness.inspect(BACKGROUND_CONTEXT)` and enabled
 * schedules in `familyStore`, then programs or deletes the Durable Object
 * storage alarm accordingly.
 */
export async function syncDurableObjectAlarm(
	storage: DurableObjectStorage,
	harness: Harness,
	familyStore: FamilyStore,
	/** An extra wake time (for example the next stream authority sweep). */
	extraWake?: number,
): Promise<number | undefined> {
	const inspection = await harness.inspect(BACKGROUND_CONTEXT);
	let earliest: number | undefined = extraWake;

	for (const task of inspection.tasks) {
		const wake =
			scheduledWakeTime(task, familyStore) ?? compactionRetryWakeTime(task);
		if (wake !== undefined && (earliest === undefined || wake < earliest)) {
			earliest = wake;
		}
	}

	for (const sched of familyStore.schedules.listSchedules(undefined, true)) {
		if (!sched.enabled) continue;
		if (familyStore.schedules.hasFired(sched.id, sched.nextRun)) continue;
		if (earliest === undefined || sched.nextRun < earliest) {
			earliest = sched.nextRun;
		}
	}

	for (const group of familyStore.groups.listOpen()) {
		const candidates = [
			group.replyDeadline,
			group.overallDeadline > 0 ? group.overallDeadline : undefined,
		].filter((value): value is number => value !== undefined);
		if (candidates.length === 0) continue;
		const wake = Math.min(...candidates);
		if (earliest === undefined || wake < earliest) earliest = wake;
	}

	for (const row of familyStore.tasks.listRunDeadlines()) {
		if (earliest === undefined || row.runDeadline < earliest) {
			earliest = row.runDeadline;
		}
	}

	const currentAlarm = await storage.getAlarm();

	if (earliest !== undefined) {
		if (currentAlarm !== earliest) {
			await storage.setAlarm(earliest);
			getLogger().debug("durable object alarm scheduled", {
				nextWake: earliest,
			});
		}
	} else if (currentAlarm !== null && currentAlarm !== undefined) {
		await storage.deleteAlarm();
		getLogger().debug("durable object alarm cleared");
	}

	return earliest;
}

/**
 * Deadline for the next stream authority sweep. It is fixed when the first
 * stream opens and never moves later because some other operation re-synced
 * the shared alarm; it advances only when a sweep has run, and clears when no
 * stream is open.
 */
export class StreamSweepDeadline {
	private at: number | undefined;

	constructor(private readonly intervalMs: number) {}

	/** Seeds the deadline from durable storage after the object was recreated. */
	restore(at: number | undefined): void {
		this.at ??= at;
	}

	current(): number | undefined {
		return this.at;
	}

	/** The deadline to program, or undefined when no stream is open. */
	wake(streamsOpen: boolean, now: number): number | undefined {
		if (!streamsOpen) {
			this.at = undefined;
			return undefined;
		}
		this.at ??= now + this.intervalMs;
		return this.at;
	}

	/** A sweep ran: the next deadline is anchored to its completion. */
	swept(): void {
		this.at = undefined;
	}
}
