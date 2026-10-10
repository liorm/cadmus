/** Five-field cron: minute hour day month weekday. No names, seconds, or macros. */

export type CronFields = {
	readonly minute: ReadonlySet<number>;
	readonly hour: ReadonlySet<number>;
	readonly day: ReadonlySet<number>;
	readonly month: ReadonlySet<number>;
	/** 0–6, Sunday is 0. Input `7` is Sunday too. */
	readonly weekday: ReadonlySet<number>;
};

const PART = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/;

/** `undefined` when `input` is not five legal fields. */
export function parseCron(input: string): CronFields | undefined {
	const fields = input.trim().split(/\s+/);
	if (fields.length !== 5) return undefined;
	const minute = parseField(fields[0]!, 0, 59);
	const hour = parseField(fields[1]!, 0, 23);
	const day = parseField(fields[2]!, 1, 31);
	const month = parseField(fields[3]!, 1, 12);
	const weekday = parseWeekday(fields[4]!);
	if (!minute || !hour || !day || !month || !weekday) return undefined;
	return { minute, hour, day, month, weekday };
}

/**
 * The next match strictly after `afterMs`, as epoch ms in `timeZone`.
 * Day-of-month and weekday are OR when both are restricted; otherwise both must match.
 */
export function nextCron(fields: CronFields, afterMs: number, timeZone: string): number | undefined {
	let civil = addMinutes(zonedParts(afterMs, timeZone), 1);
	const limit = civil.year + 2;
	while (civil.year < limit) {
		if (!fields.month.has(civil.month)) {
			civil = civil.month === 12 ? { year: civil.year + 1, month: 1, day: 1, hour: 0, minute: 0, weekday: 0 } : { year: civil.year, month: civil.month + 1, day: 1, hour: 0, minute: 0, weekday: 0 };
			civil = stamped(civil);
			continue;
		}
		if (!dayMatches(fields, civil)) {
			civil = stamped({ ...civil, day: civil.day + 1, hour: 0, minute: 0 });
			continue;
		}
		if (!fields.hour.has(civil.hour)) {
			civil = stamped({ ...civil, hour: civil.hour + 1, minute: 0 });
			continue;
		}
		if (!fields.minute.has(civil.minute)) {
			civil = addMinutes(civil, 1);
			continue;
		}
		const utc = zonedToUtc(civil, timeZone);
		if (utc > afterMs && sameCivil(zonedParts(utc, timeZone), civil)) return utc;
		civil = addMinutes(civil, 1);
	}
	return undefined;
}

function parseWeekday(raw: string): Set<number> | undefined {
	const parsed = parseField(raw, 0, 7);
	if (!parsed) return undefined;
	if (parsed.has(7)) {
		parsed.delete(7);
		parsed.add(0);
	}
	return parsed;
}

function parseField(raw: string, min: number, max: number): Set<number> | undefined {
	if (!raw) return undefined;
	const values = new Set<number>();
	for (const part of raw.split(",")) {
		const match = PART.exec(part);
		if (!match) return undefined;
		const head = match[1]!;
		const step = match[3] === undefined ? 1 : Number(match[3]);
		if (!Number.isInteger(step) || step <= 0) return undefined;
		let start: number;
		let end: number;
		if (head === "*") {
			if (match[2] !== undefined) return undefined;
			start = min;
			end = max;
		} else {
			start = Number(head);
			if (match[2] !== undefined) end = Number(match[2]);
			else if (match[3] !== undefined) end = max;
			else end = start;
		}
		if (!Number.isInteger(start) || !Number.isInteger(end) || start < min || end > max || end < start) return undefined;
		if (head !== "*" && match[2] === undefined && match[3] === undefined) values.add(start);
		else for (let value = start; value <= end; value += step) values.add(value);
	}
	return values.size > 0 ? values : undefined;
}

function dayMatches(fields: CronFields, civil: Civil): boolean {
	const domRestricted = fields.day.size !== 31;
	const dowRestricted = fields.weekday.size !== 7;
	const dom = fields.day.has(civil.day);
	const dow = fields.weekday.has(civil.weekday);
	if (domRestricted && dowRestricted) return dom || dow;
	return dom && dow;
}

type Civil = { year: number; month: number; day: number; hour: number; minute: number; weekday: number };

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function zonedParts(ms: number, timeZone: string): Civil {
	const fmt = new Intl.DateTimeFormat("en-US", {
		timeZone,
		hourCycle: "h23",
		weekday: "short",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	});
	const map: Record<string, string> = {};
	for (const part of fmt.formatToParts(new Date(ms))) if (part.type !== "literal") map[part.type] = part.value;
	let hour = Number(map.hour);
	if (hour === 24) hour = 0;
	const weekday = WEEKDAYS.indexOf(map.weekday ?? "");
	return {
		year: Number(map.year),
		month: Number(map.month),
		day: Number(map.day),
		hour,
		minute: Number(map.minute),
		weekday: weekday < 0 ? 0 : weekday,
	};
}

/** Normalize an overflowed civil clock (`day: 32`, `hour: 24`) and set its weekday. */
function stamped(civil: Omit<Civil, "weekday"> & { weekday?: number }): Civil {
	const date = new Date(Date.UTC(civil.year, civil.month - 1, civil.day, civil.hour, civil.minute));
	return {
		year: date.getUTCFullYear(),
		month: date.getUTCMonth() + 1,
		day: date.getUTCDate(),
		hour: date.getUTCHours(),
		minute: date.getUTCMinutes(),
		weekday: date.getUTCDay(),
	};
}

function addMinutes(civil: Civil, minutes: number): Civil {
	return stamped({ ...civil, minute: civil.minute + minutes });
}

function sameCivil(left: Civil, right: Civil): boolean {
	return left.year === right.year && left.month === right.month && left.day === right.day && left.hour === right.hour && left.minute === right.minute;
}

function zonedToUtc(civil: Civil, timeZone: string): number {
	let utc = Date.UTC(civil.year, civil.month - 1, civil.day, civil.hour, civil.minute);
	const want = utc;
	for (let attempt = 0; attempt < 4; attempt++) {
		const got = zonedParts(utc, timeZone);
		const gotAsUtc = Date.UTC(got.year, got.month - 1, got.day, got.hour, got.minute);
		const diff = want - gotAsUtc;
		if (diff === 0) return utc;
		utc += diff;
	}
	return utc;
}
