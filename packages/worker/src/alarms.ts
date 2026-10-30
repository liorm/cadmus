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
 * Computes the earliest next wake timestamp across all live `cadmus.schedule` tasks
 * in `harness.inspect(BACKGROUND_CONTEXT)` and enabled schedules in `familyStore`,
 * then programs or deletes the Durable Object storage alarm accordingly.
 */
export async function syncDurableObjectAlarm(
	storage: DurableObjectStorage,
	harness: Harness,
	familyStore: FamilyStore,
): Promise<number | undefined> {
	const inspection = await harness.inspect(BACKGROUND_CONTEXT);
	let earliest: number | undefined;

	for (const task of inspection.tasks) {
		const wake = scheduledWakeTime(task, familyStore);
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
		const wake = Math.min(
			group.replyDeadline ?? group.overallDeadline,
			group.overallDeadline,
		);
		if (earliest === undefined || wake < earliest) earliest = wake;
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
