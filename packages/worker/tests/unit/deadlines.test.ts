import { describe, expect, it } from "bun:test";
import {
	DEFAULT_DIRECT_RUN_MS,
	DEFAULT_DIRECT_TURN_MS,
	DEFAULT_GROUP_RUN_MS,
	DEFAULT_GROUP_TURN_MS,
	parseDeadlineEnv,
	resolveDeadlines,
} from "../../src/deadlines.js";

describe("resolveDeadlines", () => {
	it("uses kind defaults when env and per-chat overrides are omitted", () => {
		expect(resolveDeadlines({ kind: "direct" })).toEqual({
			turnMs: DEFAULT_DIRECT_TURN_MS,
			runMs: DEFAULT_DIRECT_RUN_MS,
		});
		expect(resolveDeadlines({ kind: "scheduled" })).toEqual({
			turnMs: DEFAULT_DIRECT_TURN_MS,
			runMs: DEFAULT_DIRECT_RUN_MS,
		});
		expect(resolveDeadlines({ kind: "group" })).toEqual({
			turnMs: DEFAULT_GROUP_TURN_MS,
			runMs: DEFAULT_GROUP_RUN_MS,
		});
		expect(resolveDeadlines({ kind: "group-member" })).toEqual({
			turnMs: DEFAULT_GROUP_TURN_MS,
			runMs: DEFAULT_GROUP_RUN_MS,
		});
	});

	it("applies env then per-chat field merge, and 0 means no limit", () => {
		expect(
			resolveDeadlines(
				{ kind: "direct" },
				{ CADMUS_TURN_MS: "1000", CADMUS_RUN_MS: "2000" },
			),
		).toEqual({ turnMs: 1000, runMs: 2000 });
		expect(
			resolveDeadlines(
				{ kind: "direct", deadlines: { turnMs: 0 } },
				{ CADMUS_TURN_MS: "1000", CADMUS_RUN_MS: "2000" },
			),
		).toEqual({ turnMs: 0, runMs: 2000 });
		expect(
			resolveDeadlines(
				{ kind: "group", deadlines: { runMs: 5000 } },
				{ CADMUS_TURN_MS: "1000" },
			),
		).toEqual({ turnMs: 1000, runMs: 5000 });
	});

	it("ignores invalid and over-24h env values", () => {
		expect(parseDeadlineEnv(undefined)).toBeUndefined();
		expect(parseDeadlineEnv("nope")).toBeUndefined();
		expect(parseDeadlineEnv("0")).toBe(0);
		expect(parseDeadlineEnv(String(25 * 60 * 60 * 1000))).toBeUndefined();
	});
});
