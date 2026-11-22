import { describe, expect, it } from "bun:test";
import {
	CODING_TOOL_NAMES,
	DEFAULT_CADMUS_TOOL_NAMES,
	isReadOnlyGroupTool,
	READONLY_GROUP_TOOL_NAMES,
	readOnlyGroupToolNames,
} from "@cadmus/contract/tools";

describe("readOnlyGroupToolNames", () => {
	it("keeps only read from the default set", () => {
		expect(readOnlyGroupToolNames(undefined)).toEqual([
			...READONLY_GROUP_TOOL_NAMES,
		]);
		expect(readOnlyGroupToolNames(undefined)).toEqual(["read"]);
	});

	it("intersects an explicit list and drops side-effecting tools", () => {
		expect(
			readOnlyGroupToolNames([
				"bash",
				"write",
				"read",
				"edit",
				"delete",
				"message_bot",
				"schedule_create",
				"code.execute",
				"create_bot",
			]),
		).toEqual(["read"]);
	});

	it("returns nothing when the bot lists no read tool", () => {
		expect(readOnlyGroupToolNames(["message_bot", "bash"])).toEqual([]);
		expect(readOnlyGroupToolNames([])).toEqual([]);
	});

	it("only treats read as a read-only group tool", () => {
		for (const name of [...DEFAULT_CADMUS_TOOL_NAMES, ...CODING_TOOL_NAMES]) {
			expect(isReadOnlyGroupTool(name)).toBe(name === "read");
		}
	});
});
