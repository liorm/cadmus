import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type {
	Harness,
	RegistryReader,
	TaskId,
} from "@earendil-works/pi-durable";
import { ensureBotRoot } from "../channels/bots.ts";
import { now as clockNow } from "../clock.ts";
import { getLogger } from "../log.ts";
import type { BotRuntime } from "../runtime.ts";
import { nextCron, parseCron } from "./cron.ts";
import { createSqliteScheduleStore, type StoredSchedule } from "./store.ts";
import { ScheduleTask, scheduleOps } from "./task.ts";

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
	stop(): Promise<void>;
	idle(): Promise<void>;
};

/**
 * Host-facing catalog. Each enabled row has one background `pi-bot.schedule`
 * task. The harness sleeps until `nextRun`. There is no separate clock.
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

	scheduleOps.current = {
		now,
		timeZone: options.timeZone,
		home: options.home,
		harness: options.harness,
		registry: options.registry,
		runtime: options.runtime,
		get: (id) => store.get(id),
		setNextRun: (id, nextRun) => {
			store.setNextRun(id, nextRun);
		},
		setTaskId: (id, taskId) => {
			store.setTaskId(id, taskId);
		},
		remove: (id) => {
			store.remove(id);
		},
		claim: (row, requestId, cronNext) =>
			store.claimOccurrence(row, requestId, cronNext),
		track,
	};

	async function abortTask(taskId: string | null): Promise<void> {
		if (!taskId) return;
		await options.harness.abortTask(
			Number(taskId) as TaskId,
			BACKGROUND_CONTEXT,
		);
	}

	async function ensureTask(row: StoredSchedule): Promise<void> {
		if (!row.enabled) {
			await abortTask(row.taskId);
			store.setTaskId(row.id, null);
			return;
		}
		if (row.taskId) {
			const live = await options.harness.getTask(
				Number(row.taskId) as TaskId,
				BACKGROUND_CONTEXT,
			);
			if (live && live.state.status !== "terminal") return;
		}
		const root = await ensureBotRoot(options.harness, row.botId);
		if (!root) throw new ScheduleRejected("No such bot.");
		const taskId = await options.harness.commit(
			(tx) =>
				tx.createTask(
					ScheduleTask,
					{ scheduleId: row.id },
					{
						ownership: { kind: "conversation" },
						conversationId: root,
						background: true,
					},
				),
			BACKGROUND_CONTEXT,
		);
		store.setTaskId(row.id, String(taskId));
	}

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
			if (outcome === "exists") return outcome;
			try {
				const row = store.get(schedule.id);
				if (row) await ensureTask(row);
			} catch (error) {
				if (outcome === "created") store.remove(schedule.id);
				throw error;
			}
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
			return "rescheduled";
		},
		async remove(id) {
			const existing = store.get(id);
			store.remove(id);
			await abortTask(existing?.taskId ?? null);
		},
		async get(id) {
			const row = store.get(id);
			return row ? fromStored(row) : undefined;
		},
		async list(botId) {
			return store.list(botId).map(fromStored);
		},
		async stop() {
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
		taskId: null,
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
