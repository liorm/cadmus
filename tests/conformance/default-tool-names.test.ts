import { describe, expect, it } from "bun:test";
import {
	CODING_TOOL_NAMES,
	DEFAULT_CADMUS_TOOL_NAMES,
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
