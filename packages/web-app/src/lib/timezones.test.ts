import { describe, expect, it } from "bun:test";
import {
	filterTimeZones,
	selectableTimeZone,
	timeZoneOptions,
} from "./timezones.ts";

describe("timeZoneOptions", () => {
	it("includes UTC and keeps an unknown saved value", () => {
		const zones = timeZoneOptions("Mars/Olympus");
		expect(zones[0]).toBe("Mars/Olympus");
		expect(zones).toContain("UTC");
		expect(new Set(zones).size).toBe(zones.length);
	});

	it("does not duplicate a known zone", () => {
		const zones = timeZoneOptions("UTC");
		expect(zones.filter((zone) => zone === "UTC")).toHaveLength(1);
	});
});

describe("filterTimeZones", () => {
	const zones = ["UTC", "Asia/Jerusalem", "America/New_York", "Europe/London"];

	it("returns every zone for a blank query", () => {
		expect(filterTimeZones(zones, "  ")).toEqual(zones);
	});

	it("matches a case-insensitive substring", () => {
		expect(filterTimeZones(zones, "jerus")).toEqual(["Asia/Jerusalem"]);
		expect(filterTimeZones(zones, "NEW")).toEqual(["America/New_York"]);
	});
});

describe("selectableTimeZone", () => {
	const zones = ["UTC", "Asia/Jerusalem"];

	it("accepts a listed zone and rejects free text", () => {
		expect(selectableTimeZone(zones, "Asia/Jerusalem")).toBe("Asia/Jerusalem");
		expect(selectableTimeZone(zones, "Not/AZone")).toBeNull();
		expect(selectableTimeZone(zones, "")).toBeNull();
	});
});
