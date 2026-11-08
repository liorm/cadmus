import { describe, expect, it } from "bun:test";
import { groupToolRuns } from "./group-tool-runs.ts";

describe("groupToolRuns", () => {
	it("collapses a tool-call run into one row", () => {
		const items = groupToolRuns([
			{ id: 1, role: "user", text: "go" },
			{
				id: 2,
				role: "assistant",
				text: "On it.",
				toolCalls: [{ name: "read" }, { name: "list" }],
			},
			{ id: 3, role: "toolResult", text: "ok", toolName: "read" },
			{ id: 4, role: "toolResult", text: "ok", toolName: "list" },
			{
				id: 5,
				role: "assistant",
				text: "",
				toolCalls: [{ name: "write" }],
			},
			{ id: 6, role: "toolResult", text: "saved", toolName: "write" },
			{ id: 7, role: "assistant", text: "Done." },
		]);
		expect(items.map((item) => item.type)).toEqual([
			"user",
			"assistant",
			"tools",
			"assistant",
		]);
		const tools = items[2];
		expect(tools?.type).toBe("tools");
		if (tools?.type === "tools") {
			expect(tools.count).toBe(3);
			expect(tools.names).toEqual(["read", "list", "write"]);
			expect(tools.startId).toBe(2);
			expect(tools.endId).toBe(6);
			expect(tools.calls).toHaveLength(3);
		}
	});

	it("keeps later tool results that were not named on the assistant call", () => {
		const items = groupToolRuns([
			{ id: 1, role: "user", text: "go" },
			{ id: 2, role: "toolResult", text: "a", toolName: "read" },
			{ id: 3, role: "toolResult", text: "b", toolName: "list" },
			{ id: 4, role: "toolResult", text: "a2", toolName: "read" },
		]);
		const tools = items.find((item) => item.type === "tools");
		expect(tools?.type).toBe("tools");
		if (tools?.type === "tools") {
			expect(tools.names).toEqual(["read", "list"]);
			expect(tools.count).toBe(3);
			expect(tools.startId).toBe(2);
			expect(tools.calls).toHaveLength(3);
		}
	});

	it("counts repeated calls once per run and starts at the first tool entry", () => {
		const items = groupToolRuns([
			{ id: 1, role: "user", text: "go" },
			{ id: 2, role: "assistant", text: "Looking." },
			{ id: 3, role: "toolResult", text: "a", toolName: "file.read" },
			{ id: 4, role: "toolResult", text: "b", toolName: "file.read" },
			{ id: 5, role: "toolResult", text: "c", toolName: "file.read" },
			{ id: 6, role: "toolResult", text: "d", toolName: "file.read" },
		]);
		const tools = items.find((item) => item.type === "tools");
		expect(tools?.type).toBe("tools");
		if (tools?.type === "tools") {
			expect(tools.names).toEqual(["file.read"]);
			expect(tools.count).toBe(4);
			expect(tools.startId).toBe(3);
			expect(tools.endId).toBe(6);
			expect(tools.calls).toHaveLength(4);
		}
		expect(items[1]?.type).toBe("assistant");
	});

	it("dedupes names when one assistant message calls the same tool twice", () => {
		const items = groupToolRuns([
			{
				id: 1,
				role: "assistant",
				text: "",
				toolCalls: [{ name: "file.read" }, { name: "file.read" }],
			},
		]);
		const tools = items[0];
		expect(tools?.type).toBe("tools");
		if (tools?.type === "tools") {
			expect(tools.names).toEqual(["file.read"]);
			expect(tools.count).toBe(2);
			expect(tools.startId).toBe(1);
			expect(tools.endId).toBe(1);
			expect(tools.calls).toHaveLength(2);
		}
	});

	it("pairs assistant tool calls with toolResult by toolCallId with args and duration", () => {
		const items = groupToolRuns([
			{
				id: 1,
				role: "assistant",
				text: "",
				toolCalls: [
					{
						id: "call_a",
						name: "message_bot",
						arguments: { slug: "researcher", topic: "Find notes" },
					},
				],
			},
			{
				id: 2,
				role: "toolResult",
				toolCallId: "call_a",
				toolName: "message_bot",
				text: JSON.stringify({ ok: true, status: "ended" }),
				durationMs: 340,
				isError: false,
			},
		]);
		expect(items).toHaveLength(1);
		const tools = items[0];
		expect(tools?.type).toBe("tools");
		if (tools?.type === "tools") {
			expect(tools.names).toEqual(["message_bot"]);
			expect(tools.totalDurationMs).toBe(340);
			expect(tools.hasError).toBeUndefined();
			expect(tools.calls).toHaveLength(1);
			const call = tools.calls[0];
			expect(call?.id).toBe("call_a");
			expect(call?.name).toBe("message_bot");
			expect(call?.args).toEqual({ slug: "researcher", topic: "Find notes" });
			expect(call?.durationMs).toBe(340);
			expect(call?.isError).toBe(false);
			expect(call?.result?.content).toBe(
				JSON.stringify({ ok: true, status: "ended" }),
			);
		}
	});

	it("detects error flag in tool calls", () => {
		const items = groupToolRuns([
			{
				id: 1,
				role: "toolResult",
				toolName: "file.read",
				text: "File not found",
				isError: true,
				durationMs: 50,
			},
		]);
		const tools = items[0];
		expect(tools?.type).toBe("tools");
		if (tools?.type === "tools") {
			expect(tools.hasError).toBe(true);
			expect(tools.totalDurationMs).toBe(50);
		}
	});

	it("keeps plain assistant text without a tools row", () => {
		const items = groupToolRuns([
			{ id: 1, role: "user", text: "hi" },
			{ id: 2, role: "assistant", text: "hello" },
		]);
		expect(items).toHaveLength(2);
		expect(items[1]?.type).toBe("assistant");
	});
});
