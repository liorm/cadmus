import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type SystemMessage,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { cadmusDefaultExtensions } from "../src/extensions/cadmus-tools.js";
import {
	localizeToolName,
	localizeTranscriptContext,
	normalizeAssistantMessage,
	resolveToolDialect,
	withToolLocalization,
	wrapLocalizedEventStream,
} from "../src/tool-localization.js";

describe("withToolLocalization harness integration", () => {
	it("translates outbound tool declarations & history and normalizes inbound calls across providers", async () => {
		const models = createModels();
		const capturedAnthropic: {
			tools: string[];
			editProps: string[];
			historyCalls: { name: string; arguments: Record<string, unknown> }[];
			historyResultNames: string[];
		}[] = [];
		const capturedGoogle: {
			tools: string[];
			grepProps: string[];
			historyCalls: { name: string; arguments: Record<string, unknown> }[];
			historyResultNames: string[];
		}[] = [];

		const anthropicFaux = fauxProvider({
			provider: "anthropic",
			models: [{ id: "claude-test", contextWindow: 128_000, maxTokens: 4096 }],
		});
		anthropicFaux.setResponses([
			(context) => {
				const tools: string[] = [];
				let editProps: string[] = [];
				const historyCalls: {
					name: string;
					arguments: Record<string, unknown>;
				}[] = [];
				const historyResultNames: string[] = [];

				for (const msg of context.messages) {
					if (msg.role === "system") {
						for (const t of msg.toolsAdded ?? []) {
							tools.push(t.name);
							if (t.name === "Edit") {
								editProps = Object.keys(
									(t.parameters as { properties: Record<string, unknown> })
										.properties,
								);
							}
						}
					} else if (msg.role === "assistant") {
						for (const part of msg.content) {
							if (part.type === "toolCall") {
								historyCalls.push({
									name: part.name,
									arguments: part.arguments as Record<string, unknown>,
								});
							}
						}
					} else if (msg.role === "toolResult") {
						historyResultNames.push(msg.toolName);
					}
				}
				capturedAnthropic.push({
					tools,
					editProps,
					historyCalls,
					historyResultNames,
				});
				return fauxAssistantMessage(
					[
						fauxText("Searching..."),
						fauxToolCall("Grep", {
							pattern: "deploy",
							path: "/.cadmus",
							ignore_case: true,
							head_limit: 5,
						}),
					],
					{ stopReason: "toolUse" },
				);
			},
		]);

		const googleFaux = fauxProvider({
			provider: "google",
			models: [{ id: "gemini-test", contextWindow: 128_000, maxTokens: 4096 }],
		});
		googleFaux.setResponses([
			(context) => {
				const tools: string[] = [];
				let grepProps: string[] = [];
				const historyCalls: {
					name: string;
					arguments: Record<string, unknown>;
				}[] = [];
				const historyResultNames: string[] = [];

				for (const msg of context.messages) {
					if (msg.role === "system") {
						for (const t of msg.toolsAdded ?? []) {
							tools.push(t.name);
							if (t.name === "grep_search") {
								grepProps = Object.keys(
									(t.parameters as { properties: Record<string, unknown> })
										.properties,
								);
							}
						}
					} else if (msg.role === "assistant") {
						for (const part of msg.content) {
							if (part.type === "toolCall") {
								historyCalls.push({
									name: part.name,
									arguments: part.arguments as Record<string, unknown>,
								});
							}
						}
					} else if (msg.role === "toolResult") {
						historyResultNames.push(msg.toolName);
					}
				}
				capturedGoogle.push({
					tools,
					grepProps,
					historyCalls,
					historyResultNames,
				});
				return fauxAssistantMessage(
					[
						fauxToolCall("read_file", {
							path: "/.cadmus/MEMORY.md",
							limit: 10,
						}),
						fauxToolCall("edit_file", {
							path: "/.cadmus/MEMORY.md",
							old_text: "before",
							new_text: "after",
						}),
					],
					{ stopReason: "toolUse" },
				);
			},
		]);

		models.setProvider(anthropicFaux.provider);
		models.setProvider(googleFaux.provider);
		const localizedModels = withToolLocalization(models);

		const filesExt = cadmusDefaultExtensions().find(
			(ext) => ext.name === "cadmus.files",
		);
		expect(filesExt).toBeDefined();
		const tools = (filesExt?.tools ?? []).map((t) => ({
			name: t.name,
			description: t.description,
			parameters: t.parameters,
		}));

		// Turn 1: Anthropic model receives Read/Write/Edit/Delete/LS/Glob/Grep
		const anthropicModel = localizedModels.getModel("anthropic", "claude-test");
		expect(anthropicModel).toBeDefined();
		if (!anthropicModel) return;

		const stream1 = localizedModels.streamSimple(anthropicModel, {
			messages: [
				{
					role: "system",
					content: "sys",
					toolsAdded: tools,
					timestamp: 1,
				},
				{ role: "user", content: "find deploy", timestamp: 2 },
			],
		});
		for await (const _ of stream1) {
			// consume
		}
		const msg1 = await stream1.result();

		expect(capturedAnthropic[0]?.tools).toEqual([
			"Read",
			"Write",
			"Edit",
			"Delete",
			"LS",
			"Glob",
			"Grep",
		]);
		expect(capturedAnthropic[0]?.editProps).toEqual([
			"file_path",
			"old_string",
			"new_string",
		]);

		// Normalized canonical tool call stored in transcript
		const toolCall1 = msg1.content.find((c) => c.type === "toolCall");
		expect(toolCall1).toMatchObject({
			type: "toolCall",
			name: "grep",
			arguments: {
				pattern: "deploy",
				path: "/.cadmus",
				ignoreCase: true,
				limit: 5,
			},
		});

		// Turn 2: Switch model mid-conversation to Google!
		// The canonical history (grep + toolResult) must be translated outbound to Google (grep_search).
		const googleModel = localizedModels.getModel("google", "gemini-test");
		expect(googleModel).toBeDefined();
		if (!googleModel) return;

		const stream2 = localizedModels.streamSimple(googleModel, {
			messages: [
				{
					role: "system",
					content: "sys",
					toolsAdded: tools,
					timestamp: 1,
				},
				{ role: "user", content: "find deploy", timestamp: 2 },
				msg1,
				{
					role: "toolResult",
					toolCallId: toolCall1?.type === "toolCall" ? toolCall1.id : "id1",
					toolName: "grep",
					content: [{ type: "text", text: "/.cadmus/MEMORY.md:1: deploy" }],
					isError: false,
					timestamp: 3,
				},
				{ role: "user", content: "read and edit", timestamp: 4 },
			],
		});
		const msg2 = await stream2.result();

		expect(capturedGoogle[0]?.tools).toEqual([
			"read_file",
			"write_file",
			"edit_file",
			"delete_file",
			"list_directory",
			"glob",
			"grep_search",
		]);
		expect(capturedGoogle[0]?.grepProps).toEqual([
			"query",
			"path",
			"glob",
			"ignore_case",
			"literal",
			"limit",
		]);
		expect(capturedGoogle[0]?.historyCalls).toEqual([
			{
				name: "grep_search",
				arguments: {
					query: "deploy",
					path: "/.cadmus",
					ignore_case: true,
					limit: 5,
				},
			},
		]);
		expect(capturedGoogle[0]?.historyResultNames).toEqual(["grep_search"]);

		// Google's inbound calls normalized back to canonical read & edit
		const calls2 = msg2.content.filter((c) => c.type === "toolCall");
		expect(calls2).toMatchObject([
			{
				type: "toolCall",
				name: "read",
				arguments: { path: "/.cadmus/MEMORY.md", limit: 10 },
			},
			{
				type: "toolCall",
				name: "edit",
				arguments: {
					path: "/.cadmus/MEMORY.md",
					edits: [{ oldText: "before", newText: "after" }],
				},
			},
		]);
	});

	it("handles completeSimple, multi-edit history, toolsRemoved, delete/write/ls/find/bash, and stream errors", async () => {
		expect(resolveToolDialect("google-vertex")).toBe("google");
		expect(localizeToolName("anthropic", "bash")).toBe("Bash");
		expect(localizeToolName("google", "bash")).toBe("run_shell_command");
		expect(localizeToolName("openai", "ls")).toBe("ls");

		const models = createModels();
		const capturedRequests: unknown[] = [];
		const anthropicFaux = fauxProvider({
			provider: "anthropic",
			models: [
				{ id: "claude-complete", contextWindow: 128_000, maxTokens: 4096 },
			],
		});
		anthropicFaux.setResponses([
			(context) => {
				capturedRequests.push(context.messages);
				return fauxAssistantMessage(
					[
						fauxToolCall("Write", {
							file_path: "/.cadmus/MEMORY.md",
							content: "hello",
						}),
						fauxToolCall("Delete", {
							file_path: "/.cadmus/skills/bot/old/SKILL.md",
						}),
						fauxToolCall("LS", { path: "/.cadmus", depth: 2 }),
						fauxToolCall("Glob", { pattern: "**/*.md", path: "/.cadmus" }),
						fauxToolCall("Bash", { command: "pwd", timeout: 5 }),
					],
					{ stopReason: "toolUse" },
				);
			},
		]);
		models.setProvider(anthropicFaux.provider);
		const localizedModels = withToolLocalization(models);
		const model = localizedModels.getModel("anthropic", "claude-complete");
		expect(model).toBeDefined();
		if (!model) return;

		const completed = await localizedModels.completeSimple(model, {
			tools: [
				{
					name: "bash",
					description: "Run bash",
					parameters: Type.Object({
						command: Type.String(),
						timeout: Type.Optional(Type.Number()),
					}),
				},
			],
			messages: [
				{
					role: "system",
					content: "sys",
					timestamp: 1,
				},
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "m1",
							name: "edit",
							arguments: {
								path: "/.cadmus/MEMORY.md",
								edits: [
									{ oldText: "a", newText: "b" },
									{ oldText: "c", newText: "d" },
								],
							},
						},
						{
							type: "toolCall",
							id: "m2",
							name: "write",
							arguments: { path: "/.cadmus/MEMORY.md", content: "v2" },
						},
						{
							type: "toolCall",
							id: "m3",
							name: "delete",
							arguments: { path: "/.cadmus/skills/bot/old/SKILL.md" },
						},
					],
					api: "anthropic-messages",
					provider: "anthropic",
					model: "claude-complete",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							total: 0,
						},
					},
					stopReason: "toolUse",
					timestamp: 2,
				},
				{
					role: "system",
					content: "",
					toolsRemoved: [{ name: "edit" }, { name: "delete" }],
					timestamp: 3,
				},
			],
		});

		const calls = completed.content.filter((c) => c.type === "toolCall");
		expect(calls).toMatchObject([
			{
				name: "write",
				arguments: { path: "/.cadmus/MEMORY.md", content: "hello" },
			},
			{
				name: "delete",
				arguments: { path: "/.cadmus/skills/bot/old/SKILL.md" },
			},
			{ name: "ls", arguments: { path: "/.cadmus", depth: 2 } },
			{ name: "find", arguments: { pattern: "**/*.md", path: "/.cadmus" } },
			{ name: "bash", arguments: { command: "pwd", timeout: 5 } },
		]);

		const sentMsgs = capturedRequests[0] as SystemMessage[];
		const removedMsg = sentMsgs.find(
			(m) => m.role === "system" && m.toolsRemoved?.length,
		);
		expect(removedMsg?.toolsRemoved).toEqual([
			{ name: "Edit" },
			{ name: "Delete" },
		]);

		// Google multi-edit + bash + write + delete round-trip
		const googleCtx = localizeTranscriptContext("google", {
			messages: [
				{
					role: "assistant",
					content: [
						{
							type: "toolCall",
							id: "g1",
							name: "edit",
							arguments: {
								path: "/.cadmus/MEMORY.md",
								edits: [
									{ oldText: "a", newText: "b" },
									{ oldText: "c", newText: "d" },
								],
							},
						},
					],
					api: "google-generative-ai",
					provider: "google",
					model: "gemini-test",
					usage: {
						input: 1,
						output: 1,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 2,
						cost: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							total: 0,
						},
					},
					stopReason: "toolUse",
					timestamp: 3,
				},
			],
		});
		const googleAsst = googleCtx.messages[0] as AssistantMessage;
		const normalizedBack = normalizeAssistantMessage("google", googleAsst);
		expect(normalizedBack.content[0]).toMatchObject({
			type: "toolCall",
			name: "edit",
			arguments: {
				path: "/.cadmus/MEMORY.md",
				edits: [
					{ oldText: "a", newText: "b" },
					{ oldText: "c", newText: "d" },
				],
			},
		});

		// Error event normalization in wrapLocalizedEventStream
		const upstream = createAssistantMessageEventStream();
		const wrapped = wrapLocalizedEventStream("google", upstream);
		const errMsg: AssistantMessage = {
			...googleAsst,
			content: [
				{
					type: "toolCall",
					id: "ge1",
					name: "read_file",
					arguments: { path: "/.cadmus/SOUL.md" },
				},
			],
			stopReason: "error",
			errorMessage: "interrupted",
		};
		upstream.push({ type: "error", reason: "error", error: errMsg });
		upstream.end();
		const finalErr = await wrapped.result();
		expect(finalErr.content[0]).toMatchObject({
			name: "read",
			arguments: { path: "/.cadmus/SOUL.md" },
		});
	});
});
