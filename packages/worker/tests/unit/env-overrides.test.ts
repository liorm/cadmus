import { describe, expect, it } from "bun:test";
import {
	isProductionDeploy,
	parseClampedInt,
	resolveClampedTestInt,
} from "../../src/env-overrides.js";

describe("isProductionDeploy", () => {
	it("matches only the string 'production' case-insensitively with trimming", () => {
		expect(isProductionDeploy("production")).toBe(true);
		expect(isProductionDeploy("  PRODUCTION  ")).toBe(true);
		expect(isProductionDeploy("Production")).toBe(true);
		expect(isProductionDeploy("test")).toBe(false);
		expect(isProductionDeploy("development")).toBe(false);
		expect(isProductionDeploy("")).toBe(false);
		expect(isProductionDeploy(undefined)).toBe(false);
		expect(isProductionDeploy({ get: () => null })).toBe(false);
	});
});

describe("parseClampedInt", () => {
	it("returns null for unset, blank, or non-finite values", () => {
		expect(parseClampedInt(undefined, 10, 100)).toBeNull();
		expect(parseClampedInt("", 10, 100)).toBeNull();
		expect(parseClampedInt("   ", 10, 100)).toBeNull();
		expect(parseClampedInt("abc", 10, 100)).toBeNull();
		expect(parseClampedInt("NaN", 10, 100)).toBeNull();
		expect(parseClampedInt("Infinity", 10, 100)).toBeNull();
	});

	it("rounds and clamps finite numbers to [min, max]", () => {
		expect(parseClampedInt("42", 10, 100)).toBe(42);
		expect(parseClampedInt(" 42.4 ", 10, 100)).toBe(42);
		expect(parseClampedInt("42.6", 10, 100)).toBe(43);
		expect(parseClampedInt("1", 10, 100)).toBe(10);
		expect(parseClampedInt("-5", 10, 100)).toBe(10);
		expect(parseClampedInt("500", 10, 100)).toBe(100);
	});
});

describe("resolveClampedTestInt", () => {
	it("returns null in production regardless of raw value", () => {
		expect(resolveClampedTestInt("500", "production", 50, 60_000)).toBeNull();
		expect(resolveClampedTestInt("500", " Production ", 50, 60_000)).toBeNull();
	});

	it("parses and clamps outside production", () => {
		expect(resolveClampedTestInt("500", "test", 50, 60_000)).toBe(500);
		expect(resolveClampedTestInt("10", undefined, 50, 60_000)).toBe(50);
		expect(resolveClampedTestInt("999999", "development", 50, 60_000)).toBe(
			60_000,
		);
	});
});
