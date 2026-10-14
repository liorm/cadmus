// `bun --preload test/egress/preload.ts …` routes a child process's egress to the FakeEgress at EGRESS_URL.
// `PI_BOT_STALL_SCHEDULE` holds the process after a user-schedule write commits, so a test can kill it
// before the tool's outcome memo. `tx` waits until the schedules transaction returns; `run` waits inside
// `Statement.run` (autocommit deletes).

import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { routeEgress } from "./route.ts";

if (!process.env.EGRESS_URL)
	throw new Error("EGRESS_URL is required by the egress preload");
routeEgress(process.env.EGRESS_URL);

const stallMode = process.env.PI_BOT_STALL_SCHEDULE;
const stallSentinel = process.env.PI_BOT_STALL_SENTINEL;
if (stallMode && stallSentinel) installScheduleStall(stallMode);

type Query = (sql: string) => { run: (...args: unknown[]) => unknown };
type Transaction = (
	fn: (...args: unknown[]) => unknown,
) => (...args: unknown[]) => unknown;

function installScheduleStall(mode: string) {
	let touchedUser = false;
	const proto = Database.prototype as unknown as {
		query: Query;
		transaction: Transaction;
	};
	const query = proto.query;
	proto.query = function (this: Database, sql: string) {
		const stmt = query.call(this, sql);
		const ownRun = stmt.run.bind(stmt);
		const file = this.filename;
		stmt.run = (...runArgs: unknown[]) => {
			const result = ownRun(...runArgs);
			const id = runArgs[0];
			if (
				file.endsWith("schedules.sqlite") &&
				typeof id === "string" &&
				id.startsWith("u-")
			) {
				if (mode === "run") hold();
				else touchedUser = true;
			}
			return result;
		};
		return stmt;
	};
	const transaction = proto.transaction;
	proto.transaction = function (this: Database, fn) {
		const trx = transaction.call(this, fn);
		const file = this.filename;
		return (...inner: unknown[]) => {
			touchedUser = false;
			const result = trx(...inner);
			if (mode === "tx" && touchedUser && file.endsWith("schedules.sqlite"))
				hold();
			return result;
		};
	};
}

function hold(): never {
	const path = process.env.PI_BOT_STALL_SENTINEL;
	if (path) writeFileSync(path, "1");
	for (;;) Bun.sleepSync(1000);
}
