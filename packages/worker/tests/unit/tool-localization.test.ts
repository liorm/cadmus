import {
	type AssistantMessage,
	type AssistantMessageEvent,
	createAssistantMessageEventStream,
	type Message,
	type SystemMessage,
	type Tool,
	Type,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
	localizeToolName,
	localizeTranscriptContext,
	normalizeAssistantMessage,
	resolveToolDialect,
	wrapLocalizedEventStream,
} from "../../src/tool-localization.js";

function makeAssistant(
	content: AssistantMessage["content"],
	provider = "anthropic",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider,
		model: "test-model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

describe("resolveToolDialect & localizeToolName", () => {
	it("maps providers to expected dialects and tool names", () => {
		expect(resolveToolDialect("anthropic")).toBe("anthropic");
		expect(resolveToolDialect("google")).toBe("google");
		expect(resolveToolDialect("google-vertex")).toBe("google");
		expect(resolveToolDialect("openai")).toBe("canonical");
		expect(resolveToolDialect("xai")).toBe("canonical");
		expect(resolveToolDialect("faux")).toBe("canonical");
		expect(resolveToolDialect(undefined)).toBe("canonical");

		expect(localizeToolName("anthropic", "read")).toBe("Read");
		expect(localizeToolName("anthropic", "find")).toBe("Glob");
		expect(localizeToolName("anthropic", "grep")).toBe("Grep");
		expect(localizeToolName("anthropic", "ls")).toBe("LS");
		expect(localizeToolName("anthropic", "bash")).toBe("Bash");

		expect(localizeToolName("google", "read")).toBe("read_file");
		expect(localizeToolName("google", "ls")).toBe("list_directory");
		expect(localizeToolName("google", "find")).toBe("glob");
		expect(localizeToolName("google", "grep")).toBe("grep_search");
		expect(localizeToolName("google", "bash")).toBe("run_shell_command");

		expect(localizeToolName("openai", "read")).toBe("read");
		expect(localizeToolName("anthropic", "schedule_list")).toBe(
			"schedule_list",
		);
	});
});

describe("localizeTranscriptContext", () => {
	const canonicalTools: Tool[] = [
		{
			name: "read",
			description: "Read a file.",
			parameters: Type.Object({
				path: Type.String(),
				offset: Type.Optional(Type.Number()),
				limit: Type.Optional(Type.Number()),
			}),
		},
		{
			name: "edit",
			description:
				"Edit a file. Every edits[].oldText must match a unique, non-overlapping region of the original file.",
			parameters: Type.Object({
				path: Type.String(),
				edits: Type.Array(
					Type.Object({ oldText: Type.String(), newText: Type.String() }),
				),
			}),
		},
		{
			name: "grep",
			description: "Search contents.",
			parameters: Type.Object({
				pattern: Type.String(),
				path: Type.Optional(Type.String()),
				ignoreCase: Type.Optional(Type.Boolean()),
				limit: Type.Optional(Type.Number()),
			}),
		},
		{
			name: "schedule_list",
			description: "List schedules.",
			parameters: Type.Object({}),
		},
	];

	const messages: Message[] = [
		{
			role: "system",
			content: "System",
			toolsAdded: canonicalTools,
			timestamp: 1,
		},
		{
			role: "user",
			content: "Find and edit",
			timestamp: 2,
		},
		makeAssistant([
			{
				type: "toolCall",
				id: "tc1",
				name: "read",
				arguments: { path: "/.cadmus/MEMORY.md", offset: 1, limit: 20 },
			},
			{
				type: "toolCall",
				id: "tc2",
				name: "edit",
				arguments: {
					path: "/.cadmus/MEMORY.md",
					edits: [{ oldText: "old", newText: "new" }],
				},
			},
			{
				type: "toolCall",
				id: "tc3",
				name: "grep",
				arguments: {
					pattern: "foo",
					path: "/.cadmus",
					ignoreCase: true,
					limit: 10,
				},
			},
		]),
		{
			role: "toolResult",
			toolCallId: "tc1",
			toolName: "read",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: 3,
		},
		{
			role: "system",
			content: "",
			toolsRemoved: [{ name: "edit" }],
			timestamp: 4,
		},
	];

	it("returns canonical context by reference without modification", () => {
		const ctx = { messages, tools: canonicalTools };
		expect(localizeTranscriptContext("openai", ctx)).toBe(ctx);
		expect(localizeTranscriptContext("faux", ctx)).toBe(ctx);
	});

	it("translates declarations and history for Anthropic", () => {
		const localized = localizeTranscriptContext("anthropic", {
			messages,
			tools: canonicalTools,
		});
		const sys = localized.messages[0] as SystemMessage;
		expect(sys.toolsAdded?.map((t) => t.name)).toEqual([
			"Read",
			"Edit",
			"Grep",
			"schedule_list",
		]);
		const editDecl = sys.toolsAdded?.find((t) => t.name === "Edit");
		expect(editDecl?.description).toContain("old_string must match");
		expect(
			Object.keys(
				(
					editDecl?.parameters as
						| { properties?: Record<string, unknown> }
						| undefined
				)?.properties ?? {},
			),
		).toEqual(["file_path", "old_string", "new_string"]);

		const asst = localized.messages[2] as AssistantMessage;
		expect(asst.content).toEqual([
			{
				type: "toolCall",
				id: "tc1",
				name: "Read",
				arguments: { file_path: "/.cadmus/MEMORY.md", offset: 1, limit: 20 },
			},
			{
				type: "toolCall",
				id: "tc2",
				name: "Edit",
				arguments: {
					file_path: "/.cadmus/MEMORY.md",
					old_string: "old",
					new_string: "new",
				},
			},
			{
				type: "toolCall",
				id: "tc3",
				name: "Grep",
				arguments: {
					pattern: "foo",
					path: "/.cadmus",
					ignore_case: true,
					head_limit: 10,
				},
			},
		]);

		const resultMsg = localized.messages[3] as Extract<
			Message,
			{ role: "toolResult" }
		>;
		expect(resultMsg.toolName).toBe("Read");

		const removedSys = localized.messages[4] as SystemMessage;
		expect(removedSys.toolsRemoved).toEqual([{ name: "Edit" }]);
	});

	it("translates declarations and history for Google", () => {
		const localized = localizeTranscriptContext("google", { messages });
		const sys = localized.messages[0] as SystemMessage;
		expect(sys.toolsAdded?.map((t) => t.name)).toEqual([
			"read_file",
			"edit_file",
			"grep_search",
			"schedule_list",
		]);

		const asst = localized.messages[2] as AssistantMessage;
		expect(asst.content).toEqual([
			{
				type: "toolCall",
				id: "tc1",
				name: "read_file",
				arguments: { path: "/.cadmus/MEMORY.md", offset: 1, limit: 20 },
			},
			{
				type: "toolCall",
				id: "tc2",
				name: "edit_file",
				arguments: {
					path: "/.cadmus/MEMORY.md",
					old_text: "old",
					new_text: "new",
				},
			},
			{
				type: "toolCall",
				id: "tc3",
				name: "grep_search",
				arguments: {
					query: "foo",
					path: "/.cadmus",
					ignore_case: true,
					limit: 10,
				},
			},
		]);
		expect(
			(localized.messages[3] as Extract<Message, { role: "toolResult" }>)
				.toolName,
		).toBe("read_file");
	});
});

describe("normalizeAssistantMessage & wrapLocalizedEventStream", () => {
	it("normalizes Anthropic and Google tool calls back to canonical shapes", () => {
		const anthropicMsg = makeAssistant([
			{
				type: "toolCall",
				id: "a1",
				name: "Read",
				arguments: { file_path: "/.cadmus/SOUL.md", offset: 2 },
			},
			{
				type: "toolCall",
				id: "a2",
				name: "Edit",
				arguments: {
					file_path: "/.cadmus/MEMORY.md",
					old_string: "a",
					new_string: "b",
				},
			},
			{
				type: "toolCall",
				id: "a3",
				name: "Glob",
				arguments: { pattern: "**/*.md", path: "/.cadmus/skills" },
			},
			{
				type: "toolCall",
				id: "a4",
				name: "Grep",
				arguments: { pattern: "needle", ignore_case: true, head_limit: 5 },
			},
		]);
		const normAnthropic = normalizeAssistantMessage("anthropic", anthropicMsg);
		expect(normAnthropic.content).toEqual([
			{
				type: "toolCall",
				id: "a1",
				name: "read",
				arguments: { path: "/.cadmus/SOUL.md", offset: 2 },
			},
			{
				type: "toolCall",
				id: "a2",
				name: "edit",
				arguments: {
					path: "/.cadmus/MEMORY.md",
					edits: [{ oldText: "a", newText: "b" }],
				},
			},
			{
				type: "toolCall",
				id: "a3",
				name: "find",
				arguments: { pattern: "**/*.md", path: "/.cadmus/skills" },
			},
			{
				type: "toolCall",
				id: "a4",
				name: "grep",
				arguments: { pattern: "needle", ignoreCase: true, limit: 5 },
			},
		]);

		const googleMsg = makeAssistant(
			[
				{
					type: "toolCall",
					id: "g1",
					name: "list_directory",
					arguments: { path: "/.cadmus", depth: 2 },
				},
				{
					type: "toolCall",
					id: "g2",
					name: "grep_search",
					arguments: { query: "deploy", ignore_case: true, limit: 15 },
				},
				{
					type: "toolCall",
					id: "g3",
					name: "edit_file",
					arguments: {
						path: "/.cadmus/MEMORY.md",
						old_text: "x",
						new_text: "y",
					},
				},
				{
					type: "toolCall",
					id: "g4",
					name: "run_shell_command",
					arguments: { command: "ls -la" },
				},
			],
			"google",
		);
		const normGoogle = normalizeAssistantMessage("google", googleMsg);
		expect(normGoogle.content).toEqual([
			{
				type: "toolCall",
				id: "g1",
				name: "ls",
				arguments: { path: "/.cadmus", depth: 2 },
			},
			{
				type: "toolCall",
				id: "g2",
				name: "grep",
				arguments: { pattern: "deploy", ignoreCase: true, limit: 15 },
			},
			{
				type: "toolCall",
				id: "g3",
				name: "edit",
				arguments: {
					path: "/.cadmus/MEMORY.md",
					edits: [{ oldText: "x", newText: "y" }],
				},
			},
			{
				type: "toolCall",
				id: "g4",
				name: "bash",
				arguments: { command: "ls -la" },
			},
		]);
	});

	it("normalizes streamed events and final result in wrapLocalizedEventStream", async () => {
		const upstream = createAssistantMessageEventStream();
		const wrapped = wrapLocalizedEventStream("anthropic", upstream);

		const call = {
			type: "toolCall" as const,
			id: "call_1",
			name: "Read",
			arguments: { file_path: "/.cadmus/MEMORY.md" },
		};
		const partial = makeAssistant([call]);
		upstream.push({ type: "start", partial: makeAssistant([]) });
		upstream.push({
			type: "toolcall_end",
			contentIndex: 0,
			toolCall: call,
			partial,
		});
		upstream.push({ type: "done", reason: "toolUse", message: partial });
		upstream.end();

		const events: AssistantMessageEvent[] = [];
		for await (const ev of wrapped) {
			events.push(ev);
		}
		const endEvent = events.find((e) => e.type === "toolcall_end");
		expect(endEvent?.type).toBe("toolcall_end");
		if (endEvent?.type === "toolcall_end") {
			expect(endEvent.toolCall.name).toBe("read");
			expect(endEvent.toolCall.arguments).toEqual({
				path: "/.cadmus/MEMORY.md",
			});
		}

		const result = await wrapped.result();
		expect(result.content[0]).toEqual({
			type: "toolCall",
			id: "call_1",
			name: "read",
			arguments: { path: "/.cadmus/MEMORY.md" },
		});
	});
});
