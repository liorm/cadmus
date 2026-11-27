import { describe, expect, it } from "bun:test";
import { BASH_TOOL_NAME, CATALOG_TOOL_NAMES } from "@cadmus/contract/tools";
import { allowlistCount } from "./allowlist-count.ts";

describe("allowlistCount", () => {
	it("counts the full catalog set by default including bash and code.execute", () => {
		const count = allowlistCount(undefined);
		expect(count.allowed).toBe(CATALOG_TOOL_NAMES.length);
		expect(count.total).toBe(CATALOG_TOOL_NAMES.length);
		expect(count.label).toBe(
			`${CATALOG_TOOL_NAMES.length} of ${CATALOG_TOOL_NAMES.length} tools allowed`,
		);
	});

	it("counts an explicit list against the current model catalogue", () => {
		const count = allowlistCount(["read", BASH_TOOL_NAME]);
		expect(count.allowed).toBe(2);
		expect(count.total).toBe(CATALOG_TOOL_NAMES.length);
	});

	it("filters out provider-native tools for unsupported model providers while keeping bash", () => {
		const count = allowlistCount(undefined, "anthropic/claude-3-5-sonnet");
		// web.search, x.search, code.execute are omitted
		expect(count.total).toBe(CATALOG_TOOL_NAMES.length - 3);
		expect(count.allowed).toBe(CATALOG_TOOL_NAMES.length - 3);

		const xaiCount = allowlistCount(undefined, "xai/grok-2");
		expect(xaiCount.total).toBe(CATALOG_TOOL_NAMES.length);
		expect(xaiCount.allowed).toBe(CATALOG_TOOL_NAMES.length);
	});
});
