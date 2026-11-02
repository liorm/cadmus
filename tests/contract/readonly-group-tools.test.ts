import { describe, expect, it } from "bun:test";
import {
	CODING_TOOL_NAMES,
	DEFAULT_CADMUS_TOOL_NAMES,
	isReadOnlyGroupTool,
	READONLY_GROUP_TOOL_NAMES,
	readOnlyGroupToolNames,
} from "@cadmus/contract/tools";

describe("readOnlyGroupToolNames", () => {
	it("keeps only memory and knowledge reads from the default set", () => {
		expect(readOnlyGroupToolNames(undefined)).toEqual([
			...READONLY_GROUP_TOOL_NAMES,
		]);
		expect(readOnlyGroupToolNames(undefined)).toEqual([
			"knowledge_read",
			"memory_read",
		]);
	});

	it("intersects an explicit list and drops side-effecting tools", () => {
		expect(
			readOnlyGroupToolNames([
				"bash",
				"memory_update",
				"memory_read",
				"message_bot",
				"schedule_create",
				"knowledge_update",
				"knowledge_read",
				"code.execute",
				"create_bot",
			]),
		).toEqual(["memory_read", "knowledge_read"]);
	});

	it("returns nothing when the bot lists no read tools", () => {
		expect(readOnlyGroupToolNames(["message_bot", "bash"])).toEqual([]);
		expect(readOnlyGroupToolNames([])).toEqual([]);
	});

	it("does not treat coding tools as reads", () => {
		for (const name of [...DEFAULT_CADMUS_TOOL_NAMES, ...CODING_TOOL_NAMES]) {
			expect(isReadOnlyGroupTool(name)).toBe(
				name === "knowledge_read" || name === "memory_read",
			);
		}
	});
});
