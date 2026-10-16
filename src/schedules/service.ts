import type { Harness, RegistryReader } from "@earendil-works/pi-durable";
import { now as clockNow } from "../clock.ts";
import { getLogger } from "../log.ts";
import type { BotRuntime } from "../runtime.ts";
import { nextCron, parseCron } from "./cron.ts";
import { dispatchFire } from "./dispatch.ts";
import { isHarvestId } from "./ids.ts";
import { createSqliteScheduleStore, type StoredSchedule } from "./store.ts";
import { createScheduleTimer } from "./timer.ts";

export type ScheduleTarget =
	| { mode: "chat"; chatId: string; at?: number }
	| { mode: "new-chat" }
	| { mode: "fork"; chatId: string; at?: number };

export type Schedule = {
	id: string;
	botId: string;
	target: ScheduleTarget;
	text: string;
	/** Display label. Omitted when the row has none. */
	name?: string;
	/** `false` keeps the row but the clock does not fire it. Omitted means on. */
	enabled?: boolean;
	nextRun?: number;
} & ({ kind: "cron"; cron: string } | { kind: "when"; when: number });

export class ScheduleRejected extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ScheduleRejected";
	}
}

export type ScheduleService = {
	put(
		schedule: Schedule,
		options?: { ifExists?: "reject" | "replace"; nextRun?: number },
	): Promise<"created" | "replaced" | "exists">;
	/** Next fire time for `schedule`, using this service's clock and time zone. */
	nextRun(schedule: Schedule): number;
	reschedule(
		id: string,
		when: { cron: string } | { when: number },
	): Promise<"rescheduled" | "missing" | "invalid">;
	remove(id: string): Promise<void>;
	get(id: string): Promise<Schedule | undefined>;
	list(botId?: string): Promise<Schedule[]>;
	/** Run one due row now. A future row runs only when `force` is set. */
	fire(
		id: string,
		options?: { force?: boolean },
	): Promise<"fired" | "duplicate" | "missing" | "skipped">;
	start(): void;
	stop(): Promise<void>;
	idle(): Promise<void>;
};

/** How long to wait before retrying a harvest fire that threw. */
export const HARVEST_RETRY_MS = 5_000;

/**
 * Host-facing manager: sidecar store, in-process clock, and fire dispatch.
 * `fire` is the only dispatch entry (clock, HTTP `/fire`, tests).
 */
export function createScheduleService(options: {
	home: string;
	timeZone: string;
	harness: Harness;
	registry: RegistryReader;
	runtime(botId: string): BotRuntime | undefined;
	now?: () => number;
}): ScheduleService {
	const store = createSqliteScheduleStore(options.home);
	const now = () => options.now?.() ?? clockNow();
	let tail: Promise<void> = Promise.resolve();

	const track = (work: Promise<void>) => {
		const tracked = work.then(
			() => {},
			(error) => getLogger().error("schedule fire failed", { error }),
		);
		const current = tail.then(() => tracked);
		tail = current;
		return work;
	};

	const writeNext = (schedule: Schedule): number => {
		if (schedule.kind === "when") {
			if (!Number.isFinite(schedule.when))
				throw new ScheduleRejected("When is not a time.");
			return schedule.when;
		}
		const fields = parseCron(schedule.cron);
		if (!fields) throw new ScheduleRejected("Cron must be five fields.");
		const next = nextCron(fields, now(), options.timeZone);
		if (next === undefined)
			throw new ScheduleRejected("Cron has no upcoming time.");
		return next;
	};

	const advanceUser = (row: StoredSchedule): boolean => {
		const requestId = `sched:${row.id}:${row.nextRun}`;
		const fields = row.cron ? parseCron(row.cron) : undefined;
		const cronNext = fields
			? nextCron(fields, Math.max(now(), row.nextRun), options.timeZone)
			: undefined;
		return store.claimOccurrence(row, requestId, cronNext);
	};

	async function fireRow(
		row: StoredSchedule,
		force: boolean,
	): Promise<"fired" | "duplicate" | "skipped"> {
		if (!force && row.nextRun > now()) return "skipped";
		const schedule = fromStored(row);
		if (isHarvestId(row.id)) {
			const at =
				schedule.target.mode === "fork" ? schedule.target.at : undefined;
			const requestId = `sched:${row.id}:${at ?? row.nextRun}`;
			try {
				await dispatchFire({
					schedule,
					requestId,
					harness: options.harness,
					home: options.home,
					registry: options.registry,
					runtime: options.runtime,
				});
			} catch (error) {
				getLogger().error("harvest fire failed; will retry", {
					error,
					harvest: row.id,
				});
				store.setNextRun(row.id, now() + HARVEST_RETRY_MS);
				return "skipped";
			}
			store.remove(row.id);
			return "fired";
		}
		const admitted = advanceUser(row);
		if (!admitted) return "duplicate";
		const requestId = `sched:${row.id}:${row.nextRun}`;
		await dispatchFire({
			schedule,
			requestId,
			harness: options.harness,
			home: options.home,
			registry: options.registry,
			runtime: options.runtime,
		});
		return "fired";
	}

	const timer = createScheduleTimer({
		now,
		dueIds: (at) => store.due(at).map((row) => row.id),
		nextRunAfter: (at) => store.nextAfter(at)?.nextRun,
		async fire(id) {
			const row = store.get(id);
			if (!row) return;
			await fireRow(row, false);
		},
		track,
	});

	return {
		nextRun(schedule) {
			return writeNext(schedule);
		},
		async put(schedule, putOptions) {
			const nextRun = putOptions?.nextRun ?? writeNext(schedule);
			if (!Number.isFinite(nextRun))
				throw new ScheduleRejected("When is not a time.");
			const outcome = store.put(toStored(schedule, nextRun), {
				ifExists: putOptions?.ifExists,
			});
			timer.wake();
			return outcome;
		},
		async reschedule(id, when) {
			const existing = store.get(id);
			if (!existing) return "missing";
			let nextRun: number | undefined;
			if ("when" in when) {
				if (!Number.isFinite(when.when)) return "invalid";
				nextRun = when.when;
			} else {
				const fields = parseCron(when.cron);
				nextRun = fields
					? nextCron(fields, now(), options.timeZone)
					: undefined;
				if (nextRun === undefined) return "invalid";
			}
			const moved = store.setNextRun(id, nextRun);
			if (!moved) return "missing";
			timer.wake();
			return "rescheduled";
		},
		async remove(id) {
			store.remove(id);
			timer.wake();
		},
		async get(id) {
			const row = store.get(id);
			return row ? fromStored(row) : undefined;
		},
		async list(botId) {
			return store.list(botId).map(fromStored);
		},
		async fire(id, fireOptions) {
			const row = store.get(id);
			if (!row) return "missing";
			const outcome = fireRow(row, fireOptions?.force === true);
			track(
				outcome.then(
					() => {},
					() => {},
				),
			);
			return outcome;
		},
		start() {
			timer.start();
		},
		async stop() {
			timer.stop();
			await this.idle();
			store.close();
		},
		async idle() {
			let current: Promise<void>;
			do {
				current = tail;
				await current;
			} while (current !== tail);
		},
	};
}

function toStored(schedule: Schedule, nextRun: number): StoredSchedule {
	return {
		id: schedule.id,
		botId: schedule.botId,
		kind: schedule.kind,
		cron: schedule.kind === "cron" ? schedule.cron : null,
		whenMs: schedule.kind === "when" ? schedule.when : null,
		nextRun,
		text: schedule.text,
		targetJson: JSON.stringify(schedule.target),
		name: schedule.name?.trim() ? schedule.name.trim() : null,
		enabled: schedule.enabled !== false,
	};
}

function fromStored(row: StoredSchedule): Schedule {
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
		return { ...base, kind: "cron", cron: row.cron ?? "" };
	return { ...base, kind: "when", when: row.nextRun };
}
