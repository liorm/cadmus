import { describe, expect, it } from "bun:test";
import {
	CODING_TOOL_NAMES,
	DEFAULT_CADMUS_TOOL_NAMES,
} from "@cadmus/contract/tools";
import { allowlistCount } from "./allowlist-count.ts";

describe("allowlistCount", () => {
	it("counts the default Cadmus set when no coding env is offered", () => {
		const count = allowlistCount(undefined, false);
		expect(count.allowed).toBe(DEFAULT_CADMUS_TOOL_NAMES.length);
		expect(count.total).toBe(DEFAULT_CADMUS_TOOL_NAMES.length);
		expect(count.label).toBe(
			`${DEFAULT_CADMUS_TOOL_NAMES.length} of ${DEFAULT_CADMUS_TOOL_NAMES.length} tools allowed`,
		);
	});

	it("counts default plus coding tools when a coding env is offered", () => {
		const count = allowlistCount(undefined, true);
		const allowed =
			DEFAULT_CADMUS_TOOL_NAMES.length - 1 + CODING_TOOL_NAMES.length;
		expect(count.allowed).toBe(allowed);
		expect(count.total).toBe(allowed);
	});

	it("counts an explicit list against the current env catalogue", () => {
		const count = allowlistCount(
			["read", CODING_TOOL_NAMES[0] ?? "bash"],
			true,
		);
		expect(count.allowed).toBe(2);
	});

	it("filters out provider-native tools for unsupported model providers", () => {
		const count = allowlistCount(
			undefined,
			false,
			"anthropic/claude-3-5-sonnet",
		);
		// web.search, x.search, code.execute are omitted
		expect(count.total).toBe(DEFAULT_CADMUS_TOOL_NAMES.length - 3);
		expect(count.allowed).toBe(DEFAULT_CADMUS_TOOL_NAMES.length - 3);

		const xaiCount = allowlistCount(undefined, false, "xai/grok-2");
		expect(xaiCount.total).toBe(DEFAULT_CADMUS_TOOL_NAMES.length);
	});
});
