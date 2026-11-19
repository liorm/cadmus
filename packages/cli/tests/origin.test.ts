import { describe, expect, it } from "bun:test";
import {
	DEV_ORIGIN,
	defaultOrigin,
	isCompiledCli,
	PRODUCTION_ORIGIN,
} from "../src/origin.js";

describe("defaultOrigin", () => {
	it("uses localhost for a source module URL", () => {
		const url =
			"file:///Users/developer/projects/pi-bot/packages/cli/src/origin.ts";
		expect(isCompiledCli(url)).toBe(false);
		expect(defaultOrigin(url)).toBe(DEV_ORIGIN);
	});

	it("uses the production origin for a compiled bunfs module URL", () => {
		const url = "file:///$bunfs/root/origin.js";
		expect(isCompiledCli(url)).toBe(true);
		expect(defaultOrigin(url)).toBe(PRODUCTION_ORIGIN);
	});

	it("treats this test process as a source run", () => {
		expect(defaultOrigin()).toBe(DEV_ORIGIN);
	});
});
