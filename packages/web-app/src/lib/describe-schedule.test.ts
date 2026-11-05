import { describe, expect, it } from "bun:test";
import { describeSchedule } from "./describe-schedule.ts";

const ZONE = "Asia/Jerusalem";
const NOW = Date.parse("2026-04-10T12:00:00Z");

describe("describeSchedule", () => {
	it("describes an enabled daily cron as the next local run", () => {
		const next = Date.parse("2026-04-11T04:00:00Z");
		expect(
			describeSchedule(
				{
					kind: "cron",
					input: "0 7 * * *",
					nextRun: next,
					enabled: true,
					timeZone: ZONE,
				},
				NOW,
			),
		).toBe("Next: tomorrow 07:00 · every day");
	});

	it("describes a weekly cron with the weekday", () => {
		const next = Date.parse("2026-04-12T06:00:00Z");
		expect(
			describeSchedule(
				{
					kind: "cron",
					input: "0 9 * * 0",
					nextRun: next,
					enabled: true,
					timeZone: ZONE,
				},
				NOW,
			),
		).toBe("Next: Sun 09:00 · weekly");
	});

	it("omits a next timestamp when the backend has not scheduled a run", () => {
		expect(
			describeSchedule(
				{
					kind: "cron",
					input: "0 7 * * *",
					enabled: true,
					timeZone: ZONE,
				},
				NOW,
			),
		).toBe("every day");
	});

	it("treats cron weekday 7 as Sunday", () => {
		expect(
			describeSchedule(
				{
					kind: "cron",
					input: "0 9 * * 7",
					enabled: false,
					timeZone: ZONE,
				},
				NOW,
			),
		).toBe("Paused · every Sun 09:00");
	});

	it("describes a paused weekday cron without a next time", () => {
		expect(
			describeSchedule(
				{
					kind: "cron",
					input: "0 20 * * 3",
					nextRun: NOW,
					enabled: false,
					timeZone: ZONE,
				},
				NOW,
			),
		).toBe("Paused · every Wed 20:00");
	});
});
