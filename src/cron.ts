import * as chrono from "chrono-node";
import { Cron } from "croner";
import parseDuration from "parse-duration";

export type CronInstance = Cron;

/** Returns true if expression is a valid cron pattern or nickname. */
export function isValidCron(input: string): boolean {
	try {
		new Cron(input);
		return true;
	} catch {
		return false;
	}
}

/** Returns a Cron instance if valid, or undefined. */
export function parseCron(input: string): Cron | undefined {
	try {
		return new Cron(input);
	} catch {
		return undefined;
	}
}

/**
 * Calculates the next occurrence of a cron expression strictly after `afterMs` in `timeZone`.
 * Accepts either a raw cron string expression or a Cron instance.
 */
export function nextCron(
	input: string | Cron,
	afterMs: number = Date.now(),
	timeZone = "UTC",
): number | undefined {
	try {
		const pattern = typeof input === "string" ? input : input.getPattern();
		if (!pattern) return undefined;
		const cron = new Cron(pattern, { timezone: timeZone });
		const nextDate = cron.nextRun(new Date(afterMs));
		return nextDate ? nextDate.getTime() : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Parses a relative duration string or number into an absolute epoch milliseconds timestamp.
 * - If input is a number: treated as seconds relative to now (e.g. 10 -> now + 10s).
 * - If input is a numeric string (e.g. "10"): treated as seconds relative to now.
 * - Otherwise parsed via parse-duration (e.g. "1s", "5m", "1s4m", "4s 2m", "100ms").
 * Always returns epoch milliseconds strictly relative to `now`.
 */
export function parseRelativeDuration(
	input: string | number,
	now: number = Date.now(),
): number {
	if (typeof input === "number") {
		if (!Number.isFinite(input)) {
			throw new Error("Invalid duration number");
		}
		return now + Math.round(input * 1000);
	}

	const trimmed = input.trim();
	if (!trimmed) {
		throw new Error("Duration cannot be empty");
	}

	if (/^[+-]?\d+(?:\.\d+)?$/.test(trimmed)) {
		const seconds = parseFloat(trimmed);
		if (!Number.isFinite(seconds)) {
			throw new Error(`Invalid duration seconds: '${input}'`);
		}
		return now + Math.round(seconds * 1000);
	}

	const ms = parseDuration(trimmed);
	if (ms === null || ms === undefined || !Number.isFinite(ms)) {
		throw new Error(
			`Could not parse duration '${input}'. Use formats like '10s', '5m', '1s4m', '4s 2m', or '100ms'.`,
		);
	}

	return now + Math.round(ms);
}

/**
 * Parses an absolute date/time string or number into epoch milliseconds.
 * - If input is a number: if >= 1e11 treated as epoch ms, otherwise epoch seconds.
 * - If input is a string of digits: treated as above.
 * - Otherwise parsed via chrono-node with the provided timezone and reference instant.
 * - Falls back to standard Date.parse if chrono fails.
 */
export function parseAbsoluteTime(
	input: string | number,
	now: number = Date.now(),
	timezone = "UTC",
): number {
	if (typeof input === "number") {
		if (!Number.isFinite(input)) {
			throw new Error("Invalid timestamp number");
		}
		return input >= 100_000_000_000
			? Math.round(input)
			: Math.round(input * 1000);
	}

	const trimmed = input.trim();
	if (!trimmed) {
		throw new Error("Date/time cannot be empty");
	}

	if (/^\d+$/.test(trimmed)) {
		const num = parseInt(trimmed, 10);
		return num >= 100_000_000_000 ? num : num * 1000;
	}

	const parsedDate = chrono.parseDate(trimmed, {
		instant: new Date(now),
		timezone,
	});

	if (parsedDate && !Number.isNaN(parsedDate.getTime())) {
		return parsedDate.getTime();
	}

	const standardMs = Date.parse(trimmed);
	if (!Number.isNaN(standardMs)) {
		return standardMs;
	}

	throw new Error(
		`Could not parse date/time '${input}'. Provide an ISO string (e.g. '2026-10-18T22:30:00Z') or a natural format like 'tomorrow at 5pm'.`,
	);
}

/**
 * Computes remaining relative seconds from `now` to `targetMs`, rounded.
 */
export function computeInSeconds(
	targetMs: number,
	now: number = Date.now(),
): number {
	return Math.max(0, Math.round((targetMs - now) / 1000));
}
