import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { EntryId, Harness } from "@earendil-works/pi-durable";
import { listChats, webChatKey } from "../channels/telegram/chats.ts";
import { now as clockNow, testClockActive, testClockPollMs } from "../clock.ts";
import { getLogger } from "../log.ts";
import type { BotRuntime } from "../runtime.ts";
import { nextCron, parseCron } from "./cron.ts";
import { isHarvestId, runHarvest } from "./harvest.ts";

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

type Row = {
	id: string;
	bot_id: string;
	kind: string;
	cron: string | null;
	when_ms: number | null;
	next_run: number;
	text: string;
	target_json: string;
	name: string | null;
	enabled: number;
};

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

export function createScheduleService(options: {
	home: string;
	timeZone: string;
	harness: Harness;
	runtime(botId: string): BotRuntime | undefined;
	now?: () => number;
}): ScheduleService {
	mkdirSync(options.home, { recursive: true });
	const db = new Database(join(options.home, "schedules.sqlite"));
	db.exec("PRAGMA journal_mode = WAL");
	db.exec(`
		CREATE TABLE IF NOT EXISTS schedules (
			id TEXT PRIMARY KEY,
			bot_id TEXT NOT NULL,
			kind TEXT NOT NULL,
			cron TEXT,
			when_ms INTEGER,
			next_run INTEGER NOT NULL,
			text TEXT NOT NULL,
			target_json TEXT NOT NULL
		);
		CREATE TABLE IF NOT EXISTS fires (
			request_id TEXT PRIMARY KEY
		);
	`);
	const columns = new Set(
		db
			.query<{ name: string }, []>("PRAGMA table_info(schedules)")
			.all()
			.map((column) => column.name),
	);
	if (!columns.has("name"))
		db.exec("ALTER TABLE schedules ADD COLUMN name TEXT");
	if (!columns.has("enabled"))
		db.exec(
			"ALTER TABLE schedules ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1",
		);
	const now = () => options.now?.() ?? clockNow();
	const selectOne = db.query<Row, [string]>(
		"SELECT * FROM schedules WHERE id = ?",
	);
	const selectDue = db.query<Row, [number]>(
		"SELECT * FROM schedules WHERE next_run <= ? AND enabled != 0 ORDER BY next_run, id",
	);
	const selectNext = db.query<Row, [number]>(
		"SELECT * FROM schedules WHERE next_run > ? AND enabled != 0 ORDER BY next_run LIMIT 1",
	);
	const selectAll = db.query<Row, []>(
		"SELECT * FROM schedules ORDER BY next_run, id",
	);
	const selectBot = db.query<Row, [string]>(
		"SELECT * FROM schedules WHERE bot_id = ? ORDER BY next_run, id",
	);
	const claimed = db.query<{ request_id: string }, [string]>(
		"SELECT request_id FROM fires WHERE request_id = ?",
	);
	const insertFire = db.query("INSERT INTO fires (request_id) VALUES (?)");
	const removeRow = db.query("DELETE FROM schedules WHERE id = ?");
	const setNext = db.query(
		"UPDATE schedules SET next_run = ? WHERE id = ? AND next_run = ?",
	);
	const moveNext = db.query("UPDATE schedules SET next_run = ? WHERE id = ?");
	const upsert = db.query(
		`INSERT INTO schedules (id, bot_id, kind, cron, when_ms, next_run, text, target_json, name, enabled)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
		   bot_id = excluded.bot_id,
		   kind = excluded.kind,
		   cron = excluded.cron,
		   when_ms = excluded.when_ms,
		   next_run = excluded.next_run,
		   text = excluded.text,
		   target_json = excluded.target_json,
		   name = excluded.name,
		   enabled = excluded.enabled`,
	);

	let started = false;
	let pumping = false;
	let dirty = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
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

	const wake = () => {
		dirty = true;
		if (!started) return;
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}
		void pump();
	};

	const armTimer = () => {
		if (!started) return;
		const upcoming = selectNext.get(now());
		if (!upcoming) return;
		const delay = Math.min(
			Math.max(0, upcoming.next_run - now()),
			2_147_483_647,
		);
		// A pinned test clock can jump; the wall-clock delay would not notice.
		const wait =
			testClockActive() && delay > testClockPollMs ? testClockPollMs : delay;
		timer = setTimeout(() => {
			timer = undefined;
			dirty = true;
			void pump();
		}, wait);
		timer.unref?.();
	};

	const pump = (): Promise<void> => {
		if (pumping || !started) return tail;
		pumping = true;
		const run = (async () => {
			try {
				while (started && dirty) {
					dirty = false;
					const due = selectDue.all(now());
					for (const row of due) {
						if (!started) return;
						await fireRow(row, false);
					}
				}
			} finally {
				pumping = false;
				if (started && dirty) void pump();
				else armTimer();
			}
		})();
		return track(run);
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

	const advance = db.transaction((row: Row) => {
		const requestId = `sched:${row.id}:${row.next_run}`;
		if (claimed.get(requestId)) return false;
		insertFire.run(requestId);
		const current = selectOne.get(row.id);
		if (current && current.next_run === row.next_run) {
			if (current.kind === "when") removeRow.run(row.id);
			else {
				const fields = current.cron ? parseCron(current.cron) : undefined;
				const next = fields
					? nextCron(fields, Math.max(now(), row.next_run), options.timeZone)
					: undefined;
				setNext.run(next ?? row.next_run + 86_400_000, row.id, row.next_run);
			}
		}
		return true;
	});

	async function fireRow(
		row: Row,
		force: boolean,
	): Promise<"fired" | "duplicate" | "skipped"> {
		if (!force && row.next_run > now()) return "skipped";
		const admitted = advance(row);
		if (!admitted) return "duplicate";
		const schedule = fromRow(row);
		const requestId = `sched:${row.id}:${row.next_run}`;
		await dispatch(schedule, requestId);
		return "fired";
	}

	async function dispatch(
		schedule: Schedule,
		requestId: string,
	): Promise<void> {
		if (isHarvestId(schedule.id)) {
			await runHarvest({
				harness: options.harness,
				home: options.home,
				schedule,
				requestId,
			});
			return;
		}
		const runtime = options.runtime(schedule.botId);
		if (!runtime) return;
		const target = schedule.target;
		if (target.mode === "chat") {
			await runtime.submit(target.chatId, requestId, schedule.text);
			return;
		}
		if (target.mode === "new-chat") {
			const chat = await runtime.createChat(
				webChatKey(schedule.botId, newChatId()),
			);
			await runtime.submit(chat.key, requestId, schedule.text);
			return;
		}
		await forkOnly(options.harness, schedule, requestId);
	}

	return {
		nextRun(schedule) {
			return writeNext(schedule);
		},
		async put(schedule, putOptions) {
			const nextRun = putOptions?.nextRun ?? writeNext(schedule);
			if (!Number.isFinite(nextRun))
				throw new ScheduleRejected("When is not a time.");
			const replace = putOptions?.ifExists === "replace";
			const outcome = db.transaction(() => {
				const existing = selectOne.get(schedule.id);
				if (existing && !replace) return "exists" as const;
				upsert.run(
					schedule.id,
					schedule.botId,
					schedule.kind,
					schedule.kind === "cron" ? schedule.cron : null,
					schedule.kind === "when" ? schedule.when : null,
					nextRun,
					schedule.text,
					JSON.stringify(schedule.target),
					schedule.name?.trim() ? schedule.name.trim() : null,
					schedule.enabled === false ? 0 : 1,
				);
				return existing ? ("replaced" as const) : ("created" as const);
			})();
			wake();
			return outcome;
		},
		async reschedule(id, when) {
			const outcome = db.transaction(() => {
				const existing = selectOne.get(id);
				if (!existing) return "missing" as const;
				let nextRun: number | undefined;
				if ("when" in when) {
					if (!Number.isFinite(when.when)) return "invalid" as const;
					nextRun = when.when;
				} else {
					const fields = parseCron(when.cron);
					nextRun = fields
						? nextCron(fields, now(), options.timeZone)
						: undefined;
					if (nextRun === undefined) return "invalid" as const;
				}
				const moved = moveNext.run(nextRun, id);
				return moved.changes === 0
					? ("missing" as const)
					: ("rescheduled" as const);
			})();
			if (outcome === "rescheduled") wake();
			return outcome;
		},
		async remove(id) {
			removeRow.run(id);
			wake();
		},
		async list(botId) {
			const rows = botId === undefined ? selectAll.all() : selectBot.all(botId);
			return rows.map(fromRow);
		},
		async fire(id, fireOptions) {
			const row = selectOne.get(id);
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
			if (started) return;
			started = true;
			wake();
		},
		async stop() {
			started = false;
			if (timer) clearTimeout(timer);
			timer = undefined;
			await this.idle();
			db.close();
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

function fromRow(row: Row): Schedule {
	const target = JSON.parse(row.target_json) as ScheduleTarget;
	const base = {
		id: row.id,
		botId: row.bot_id,
		target,
		text: row.text,
		...(row.name ? { name: row.name } : {}),
		...(row.enabled === 0 ? { enabled: false as const } : {}),
		nextRun: row.next_run,
	};
	if (row.kind === "cron")
		return { ...base, kind: "cron", cron: row.cron ?? "" };
	return { ...base, kind: "when", when: row.next_run };
}

function newChatId(): string {
	return crypto.randomUUID().replaceAll("-", "").slice(0, 12);
}

async function forkOnly(
	harness: Harness,
	schedule: Schedule,
	requestId: string,
): Promise<void> {
	const target = schedule.target;
	if (target.mode !== "fork") return;
	const chat = (await listChats(harness)).find(
		(item) => item.key === target.chatId && item.botId === schedule.botId,
	);
	if (!chat) return;
	const parent = await harness.conversation(
		chat.conversationId,
		BACKGROUND_CONTEXT,
	);
	if (!parent) return;
	let at = target.at as EntryId | undefined;
	if (at === undefined) {
		const page = await parent.entries(
			{ order: "descending" },
			1,
			undefined,
			BACKGROUND_CONTEXT,
		);
		at = page.items[0]?.id;
	}
	if (at === undefined) return;
	const child = await parent.fork(
		at,
		{ ownership: { kind: "ownerless" } },
		BACKGROUND_CONTEXT,
	);
	const submission = await child.submit(
		{ type: "input", content: schedule.text, requestId, whenBusy: "steer" },
		BACKGROUND_CONTEXT,
	);
	await submission.wait(BACKGROUND_CONTEXT);
}
