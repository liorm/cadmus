import { describe, expect, it } from "bun:test";
import {
	CODE_EXECUTE_TOOL_NAME,
	CODING_TOOL_NAMES,
	DEFAULT_CADMUS_TOOL_NAMES,
	effectiveToolNames,
} from "@cadmus/contract/tools";
import { defaultCadmusToolNames } from "../../packages/worker/src/extensions/cadmus-tools.js";
import { expandCodingOnlyAllowlist } from "../../packages/worker/src/extensions/coding-allowlist.js";

describe("default Cadmus tool names", () => {
	it("matches the backend default registry and excludes coding tools", () => {
		const names = defaultCadmusToolNames();
		expect(names).toEqual([...DEFAULT_CADMUS_TOOL_NAMES]);
		for (const name of CODING_TOOL_NAMES) {
			expect(names).not.toContain(name);
		}
		expect(names).toContain("web.search");
		expect(names).toContain("x.search");
		expect(names).toContain("code.execute");
	});
});

describe("effective tool names", () => {
	const both = [...DEFAULT_CADMUS_TOOL_NAMES, ...CODING_TOOL_NAMES];

	it("drops code.execute only when coding tools are offered", () => {
		expect(effectiveToolNames(undefined, { codingToolsOffered: true })).toBe(
			undefined,
		);
		expect(effectiveToolNames(undefined, { codingToolsOffered: false })).toBe(
			undefined,
		);
		expect(effectiveToolNames(both, { codingToolsOffered: false })).toBe(both);
		expect(effectiveToolNames(both, { codingToolsOffered: true })).toEqual(
			both.filter((name) => name !== CODE_EXECUTE_TOOL_NAME),
		);
		expect(
			effectiveToolNames(["bash", "read"], { codingToolsOffered: true }),
		).toEqual(["bash", "read"]);
		expect(
			effectiveToolNames([...DEFAULT_CADMUS_TOOL_NAMES], {
				codingToolsOffered: false,
			}),
		).toEqual([...DEFAULT_CADMUS_TOOL_NAMES]);
	});
});

describe("create_bot coding-only allowlist", () => {
	it("expands a coding-only list to the default set plus those coding tools", () => {
		expect(expandCodingOnlyAllowlist(undefined)).toBeUndefined();
		expect(expandCodingOnlyAllowlist([])).toEqual([]);
		expect(
			expandCodingOnlyAllowlist(["bash", "read", "write", "edit"]),
		).toEqual([...DEFAULT_CADMUS_TOOL_NAMES, ...CODING_TOOL_NAMES]);
		expect(expandCodingOnlyAllowlist(["bash"])).toEqual([
			...DEFAULT_CADMUS_TOOL_NAMES,
			"bash",
		]);
		expect(expandCodingOnlyAllowlist(["memory_read", "bash"])).toEqual([
			"memory_read",
			"bash",
		]);
	});
});
