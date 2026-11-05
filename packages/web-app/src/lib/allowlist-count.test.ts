import { describe, expect, it } from "bun:test";
import {
	CODING_TOOL_NAMES,
	DEFAULT_CADMUS_TOOL_NAMES,
} from "@cadmus/contract/tools";
import { allowlistCount, TOOL_CATALOGUE } from "./allowlist-count.ts";

describe("allowlistCount", () => {
	it("counts the default set when tools are omitted", () => {
		const count = allowlistCount(undefined);
		expect(count.allowed).toBe(DEFAULT_CADMUS_TOOL_NAMES.length);
		expect(count.total).toBe(TOOL_CATALOGUE.length);
		expect(count.label).toBe(
			`${DEFAULT_CADMUS_TOOL_NAMES.length} of ${TOOL_CATALOGUE.length} tools allowed`,
		);
	});

	it("counts an explicit list, including a coding tool", () => {
		const count = allowlistCount([
			"memory_read",
			CODING_TOOL_NAMES[0] ?? "bash",
		]);
		expect(count.allowed).toBe(2);
		expect(count.total).toBe(
			DEFAULT_CADMUS_TOOL_NAMES.length + CODING_TOOL_NAMES.length,
		);
	});
});
