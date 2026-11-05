import { describe, expect, it } from "bun:test";
import { matchRanges } from "./match-ranges.ts";

describe("matchRanges", () => {
	it("returns every non-overlapping case-insensitive hit", () => {
		expect(matchRanges("Tune thermostat schedules", "thermo")).toEqual([
			[5, 11],
		]);
		expect(matchRanges("Thermo thermo", "THERMO")).toEqual([
			[0, 6],
			[7, 13],
		]);
	});

	it("returns nothing for an empty query or a miss", () => {
		expect(matchRanges("Tune thermostat schedules", "")).toEqual([]);
		expect(matchRanges("Tune thermostat schedules", "   ")).toEqual([]);
		expect(matchRanges("Morning notes", "thermo")).toEqual([]);
	});
});
