import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Durable schedule rows and fire claims. Today's adapter is a sidecar SQLite file.
 * A later central scheduler (Durable Object storage, another process) implements
 * the same methods; the clock and the harness dispatcher never open this file
 * except through this interface.
 */
export type StoredSchedule = {
	id: string;
	botId: string;
	kind: string;
	cron: string | null;
	whenMs: number | null;
	nextRun: number;
	text: string;
	targetJson: string;
	name: string | null;
	enabled: boolean;
};

export type ScheduleStore = {
	put(
		row: StoredSchedule,
		options?: { ifExists?: "reject" | "replace" },
	): "created" | "replaced" | "exists";
	get(id: string): StoredSchedule | undefined;
	list(botId?: string): StoredSchedule[];
	remove(id: string): void;
	/** Set `next_run`. When `onlyIfCurrent` is set, the write is a no-op if the wake moved. */
	setNextRun(id: string, nextRun: number, onlyIfCurrent?: number): boolean;
	due(now: number): StoredSchedule[];
	nextAfter(now: number): StoredSchedule | undefined;
	/**
	 * Claim this occurrence and delete a `when` row or move a cron row's wake.
	 * One transaction so a crash cannot leave a claimed fire with the old wake.
	 */
	claimOccurrence(
		row: StoredSchedule,
		requestId: string,
		cronNext: number | undefined,
	): boolean;
	close(): void;
};

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

export function createSqliteScheduleStore(home: string): ScheduleStore {
	mkdirSync(home, { recursive: true });
	const db = new Database(join(home, "schedules.sqlite"));
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

	const fromRow = (row: Row): StoredSchedule => ({
		id: row.id,
		botId: row.bot_id,
		kind: row.kind,
		cron: row.cron,
		whenMs: row.when_ms,
		nextRun: row.next_run,
		text: row.text,
		targetJson: row.target_json,
		name: row.name,
		enabled: row.enabled !== 0,
	});

	return {
		put(row, options) {
			const replace = options?.ifExists === "replace";
			return db.transaction(() => {
				const existing = selectOne.get(row.id);
				if (existing && !replace) return "exists" as const;
				upsert.run(
					row.id,
					row.botId,
					row.kind,
					row.cron,
					row.whenMs,
					row.nextRun,
					row.text,
					row.targetJson,
					row.name,
					row.enabled ? 1 : 0,
				);
				return existing ? ("replaced" as const) : ("created" as const);
			})();
		},
		get(id) {
			const row = selectOne.get(id);
			return row ? fromRow(row) : undefined;
		},
		list(botId) {
			const rows = botId === undefined ? selectAll.all() : selectBot.all(botId);
			return rows.map(fromRow);
		},
		remove(id) {
			removeRow.run(id);
		},
		setNextRun(id, nextRun, onlyIfCurrent) {
			if (onlyIfCurrent !== undefined)
				return setNext.run(nextRun, id, onlyIfCurrent).changes > 0;
			return moveNext.run(nextRun, id).changes > 0;
		},
		due(now) {
			return selectDue.all(now).map(fromRow);
		},
		nextAfter(now) {
			const row = selectNext.get(now);
			return row ? fromRow(row) : undefined;
		},
		claimOccurrence(row, requestId, cronNext) {
			return db.transaction(() => {
				if (claimed.get(requestId)) return false;
				insertFire.run(requestId);
				const current = selectOne.get(row.id);
				if (current && current.next_run === row.nextRun) {
					if (current.kind === "when") removeRow.run(row.id);
					else
						setNext.run(
							cronNext ?? row.nextRun + 86_400_000,
							row.id,
							row.nextRun,
						);
				}
				return true;
			})();
		},
		close() {
			db.close();
		},
	};
}
