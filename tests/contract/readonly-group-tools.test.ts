import { describe, expect, it } from "bun:test";
import {
	CODING_TOOL_NAMES,
	DEFAULT_CADMUS_TOOL_NAMES,
	isReadOnlyGroupTool,
	READONLY_GROUP_TOOL_NAMES,
	readOnlyGroupToolNames,
} from "@cadmus/contract/tools";

describe("readOnlyGroupToolNames", () => {
	it("keeps only read-only file tools from the default set", () => {
		expect(readOnlyGroupToolNames(undefined)).toEqual([
			...READONLY_GROUP_TOOL_NAMES,
		]);
		expect(readOnlyGroupToolNames(undefined)).toEqual([
			"read",
			"ls",
			"find",
			"grep",
		]);
	});

	it("intersects an explicit list and drops side-effecting tools", () => {
		expect(
			readOnlyGroupToolNames([
				"bash",
				"write",
				"read",
				"ls",
				"find",
				"grep",
				"edit",
				"delete",
				"message_bot",
				"schedule_create",
				"code.execute",
				"create_bot",
			]),
		).toEqual(["read", "ls", "find", "grep"]);
	});

	it("returns nothing when the bot lists no read tool", () => {
		expect(readOnlyGroupToolNames(["message_bot", "bash"])).toEqual([]);
		expect(readOnlyGroupToolNames([])).toEqual([]);
	});

	it("only treats read, ls, find, and grep as read-only group tools", () => {
		const allowed = new Set(["read", "ls", "find", "grep"]);
		for (const name of [...DEFAULT_CADMUS_TOOL_NAMES, ...CODING_TOOL_NAMES]) {
			expect(isReadOnlyGroupTool(name)).toBe(allowed.has(name));
		}
	});
});
