import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
	CommandResultFrame,
	ServerEvent,
	TurnBlock,
} from "@cadmus/contract/types";
import {
	createTuiState,
	handleServerEvent,
	handleTurnSubmitResult,
	type TuiOutput,
} from "./handler.js";

function createMockOutput() {
	const chunks: string[] = [];
	const lines: string[] = [];
	const out: TuiOutput = {
		write(text: string) {
			chunks.push(text);
		},
		writeLine(text = "") {
			lines.push(text);
		},
	};
	return { chunks, lines, out };
}

describe("TUI Handler - Duplicate Output & Streaming Prevention", () => {
	it("does not duplicate assistant output when streaming deltas were received", () => {
		const { chunks, lines, out } = createMockOutput();
		const state = createTuiState("xai:71aa0dae");

		const events: ServerEvent[] = [
			{
				type: "turn.delta",
				payload: {
					chatKey: "xai:71aa0dae",
					kind: "text",
					delta:
						"I can:\n\n- Answer questions, explain things, and chat\n\nWhat",
				},
			},
			// Trailing suffix emitted on message_end
			{
				type: "turn.delta",
				payload: {
					chatKey: "xai:71aa0dae",
					kind: "text",
					delta: " do you want to do?",
				},
			},
			{
				type: "turn.completed",
				payload: {
					chatKey: "xai:71aa0dae",
					status: "done",
					text: "I can:\n\n- Answer questions, explain things, and chat\n\nWhat do you want to do?",
				},
			},
		];

		for (const ev of events) {
			handleServerEvent(ev, state, out);
		}

		// Now turn.submit command result arrives with reply
		const cmdResult: CommandResultFrame<{ reply: string }> = {
			id: "cmd-1",
			type: "command.result",
			command: "turn.submit",
			ok: true,
			result: {
				reply:
					"I can:\n\n- Answer questions, explain things, and chat\n\nWhat do you want to do?",
			},
		};

		handleTurnSubmitResult(cmdResult, state, out);

		// Verify all deltas were written
		const combinedOutput = chunks.join("");
		assert.ok(
			combinedOutput.includes(
				"I can:\n\n- Answer questions, explain things, and chat\n\nWhat do you want to do?",
			),
		);

		// And verify handleTurnSubmitResult did NOT append another assistant reply
		assert.equal(lines.length, 0);
		const countOfAssistant = (combinedOutput.match(/assistant>/g) || []).length;
		assert.equal(countOfAssistant, 1);
	});

	it("outputs assistant reply once when no deltas were streamed (non-streaming/RPC fallback)", () => {
		const { chunks, lines, out } = createMockOutput();
		const state = createTuiState("xai:71aa0dae");

		// No turn.delta events received
		const cmdResult: CommandResultFrame<{ reply: string }> = {
			id: "cmd-2",
			type: "command.result",
			command: "turn.submit",
			ok: true,
			result: {
				reply: "Hello from non-streaming response",
			},
		};

		handleTurnSubmitResult(cmdResult, state, out);

		assert.equal(chunks.length, 0);
		assert.equal(lines.length, 1);
		assert.ok(lines[0]?.includes("assistant>"));
		assert.ok(lines[0]?.includes("Hello from non-streaming response"));
	});

	it("filters out events from other chat keys", () => {
		const { chunks, out } = createMockOutput();
		const state = createTuiState("xai:active-chat");

		handleServerEvent(
			{
				type: "turn.delta",
				payload: {
					chatKey: "xai:other-chat",
					kind: "text",
					delta: "should be ignored",
				},
			},
			state,
			out,
		);

		assert.equal(chunks.length, 0);
		assert.equal(state.hasStreamedReply, false);
	});

	it("displays [thinking] chip when thinking took place and does not stream raw thinking delta", () => {
		const { chunks, lines, out } = createMockOutput();
		const state = createTuiState("chat-1");

		const events: ServerEvent[] = [
			{
				type: "turn.delta",
				payload: {
					chatKey: "chat-1",
					kind: "thinking",
					delta:
						"Secret thoughts and reasoning that should not be in the reply",
				},
			},
			{
				type: "turn.delta",
				payload: {
					chatKey: "chat-1",
					kind: "text",
					delta: "Final answer after thinking",
				},
			},
			{
				type: "turn.completed",
				payload: {
					chatKey: "chat-1",
					status: "done",
					text: "Final answer after thinking",
				},
			},
		];

		for (const ev of events) {
			handleServerEvent(ev, state, out);
		}

		const combinedOutput = chunks.join("");
		// Raw thinking delta must NOT be in the output
		assert.ok(
			!combinedOutput.includes("Secret thoughts and reasoning"),
			"raw thinking delta should not be printed in reply",
		);
		// Must display [thinking] chip
		assert.ok(
			combinedOutput.includes("[thinking]"),
			"thinking chip must be present",
		);
		// Followed by the final text
		assert.ok(
			combinedOutput.includes("Final answer after thinking"),
			"assistant text should follow chips",
		);
		assert.equal(lines.length, 0);
	});

	it("displays tool chips when tools were called during the turn", () => {
		const { chunks, lines, out } = createMockOutput();
		const state = createTuiState("chat-1");

		const events: ServerEvent[] = [
			{
				type: "turn.tool_call",
				payload: {
					chatKey: "chat-1",
					toolCallId: "call-1",
					toolName: "web.fetch",
					args: { url: "https://example.com" },
				},
			},
			{
				type: "turn.tool_result",
				payload: {
					chatKey: "chat-1",
					toolCallId: "call-1",
					toolName: "web.fetch",
					content: "Page content",
					isError: false,
				},
			},
			{
				type: "turn.delta",
				payload: {
					chatKey: "chat-1",
					kind: "text",
					delta: "Here are the web results.",
				},
			},
			{
				type: "turn.completed",
				payload: {
					chatKey: "chat-1",
					status: "done",
					text: "Here are the web results.",
				},
			},
		];

		for (const ev of events) {
			handleServerEvent(ev, state, out);
		}

		// Live tool call and tool result lines
		assert.ok(
			lines.some((l) => l.includes("[tool.call]") && l.includes("web.fetch")),
		);
		assert.ok(
			lines.some((l) => l.includes("[tool.result]") && l.includes("web.fetch")),
		);

		// Assistant reply must contain the [tool: web.fetch] chip
		const combinedChunks = chunks.join("");
		assert.ok(
			combinedChunks.includes("[tool: web.fetch]"),
			"tool chip must be present in assistant line",
		);
		assert.ok(
			combinedChunks.includes("Here are the web results."),
			"streamed text should follow tool chip",
		);
	});

	it("displays combined [thinking] and multiple [tool: <name>] chips in block order", () => {
		const { chunks, out } = createMockOutput();
		const state = createTuiState("chat-1");

		const events: ServerEvent[] = [
			{
				type: "turn.delta",
				payload: {
					chatKey: "chat-1",
					kind: "thinking",
					delta: "Pondering...",
				},
			},
			{
				type: "turn.tool_call",
				payload: {
					chatKey: "chat-1",
					toolCallId: "c1",
					toolName: "memory_read",
					args: {},
				},
			},
			{
				type: "turn.tool_result",
				payload: {
					chatKey: "chat-1",
					toolCallId: "c1",
					toolName: "memory_read",
					content: "ok",
					isError: false,
				},
			},
			{
				type: "turn.tool_call",
				payload: {
					chatKey: "chat-1",
					toolCallId: "c2",
					toolName: "knowledge_search",
					args: { query: "antigravity" },
				},
			},
			{
				type: "turn.tool_result",
				payload: {
					chatKey: "chat-1",
					toolCallId: "c2",
					toolName: "knowledge_search",
					content: "found",
					isError: false,
				},
			},
			{
				type: "turn.delta",
				payload: {
					chatKey: "chat-1",
					kind: "text",
					delta: "Combined results.",
				},
			},
			{
				type: "turn.completed",
				payload: {
					chatKey: "chat-1",
					status: "done",
					text: "Combined results.",
				},
			},
		];

		for (const ev of events) {
			handleServerEvent(ev, state, out);
		}

		const combined = chunks.join("");
		assert.ok(combined.includes("[thinking]"), "has [thinking] chip");
		assert.ok(
			combined.includes("[tool: memory_read]"),
			"has [tool: memory_read] chip",
		);
		assert.ok(
			combined.includes("[tool: knowledge_search]"),
			"has [tool: knowledge_search] chip",
		);
		// Check order: thinking -> memory_read -> knowledge_search -> text
		const idxThinking = combined.indexOf("[thinking]");
		const idxMem = combined.indexOf("[tool: memory_read]");
		const idxKnow = combined.indexOf("[tool: knowledge_search]");
		const idxText = combined.indexOf("Combined results.");
		assert.ok(idxThinking < idxMem);
		assert.ok(idxMem < idxKnow);
		assert.ok(idxKnow < idxText);
	});

	it("renders chips in non-streaming RPC response via result.blocks", () => {
		const { lines, out } = createMockOutput();
		const state = createTuiState("chat-1");

		const cmdResult: CommandResultFrame<{
			reply: string;
			blocks: TurnBlock[];
		}> = {
			id: "cmd-rpc-1",
			type: "command.result",
			command: "turn.submit",
			ok: true,
			result: {
				reply: "RPC reply",
				blocks: [
					{ type: "thinking" },
					{ type: "tool_call", toolName: "internal_tool" },
					{ type: "text", text: "RPC reply" },
				],
			},
		};

		handleTurnSubmitResult(cmdResult, state, out);

		assert.equal(lines.length, 1);
		const line = lines[0] ?? "";
		assert.ok(
			line.includes("[thinking]"),
			"has [thinking] chip in non-streaming",
		);
		assert.ok(
			line.includes("[tool: internal_tool]"),
			"has [tool: internal_tool] chip in non-streaming",
		);
		assert.ok(line.includes("RPC reply"), "has reply text");
	});
});
