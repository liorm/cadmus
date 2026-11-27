import { describe, expect, it } from "vitest";
import { resolveConversationExtensionsAndTools } from "../src/extensions/cadmus-tools.js";
import {
	attachNativeTools,
	isSupportedGoogleModel,
	noteServerTool,
	type ServerToolPart,
} from "../src/models.js";
import type { BotRecord } from "../src/protocol.js";

describe("isSupportedGoogleModel", () => {
	it("excludes Gemini models older than Gemini 3", () => {
		expect(isSupportedGoogleModel("gemini-1.5-pro")).toBe(false);
		expect(isSupportedGoogleModel("gemini-2.0-flash")).toBe(false);
		expect(isSupportedGoogleModel("gemini-2.5-flash")).toBe(false);
		expect(isSupportedGoogleModel("gemini-2.5-flash-lite")).toBe(false);
		expect(isSupportedGoogleModel("gemini-2.5-pro")).toBe(false);
		expect(
			isSupportedGoogleModel("gemini-2.5-computer-use-preview-10-2025"),
		).toBe(false);
		expect(isSupportedGoogleModel("gemini-live-2.5-flash-preview")).toBe(false);
	});

	it("keeps Gemini 3+, Gemini 4+, latest aliases, deep research, and Gemma 4", () => {
		expect(isSupportedGoogleModel("gemini-3-flash-preview")).toBe(true);
		expect(isSupportedGoogleModel("gemini-3.1-flash-lite")).toBe(true);
		expect(isSupportedGoogleModel("gemini-3.8-flash")).toBe(true);
		expect(isSupportedGoogleModel("gemini-4-hydrogen")).toBe(true);
		expect(isSupportedGoogleModel("gemini-4-neon")).toBe(true);
		expect(isSupportedGoogleModel("gemini-pro-latest")).toBe(true);
		expect(isSupportedGoogleModel("gemini-flash-latest")).toBe(true);
		expect(isSupportedGoogleModel("deep-research-preview-04-2026")).toBe(true);
		expect(isSupportedGoogleModel("gemma-4-31b-it")).toBe(true);
	});
});

describe("attachNativeTools", () => {
	it("rewrites Google functionDeclarations into googleSearch and codeExecution alongside custom tools", () => {
		const payload = {
			model: "gemini-4-hydrogen",
			contents: [{ role: "user", parts: [{ text: "hello" }] }],
			config: {
				tools: [
					{
						functionDeclarations: [
							{ name: "read_file", description: "read" },
							{ name: "web.search", description: "search" },
							{ name: "code.execute", description: "code" },
						],
					},
				],
				toolConfig: {
					functionCallingConfig: { mode: "VALIDATED" },
				},
			},
		};

		const rewritten = attachNativeTools("google", payload) as {
			config: {
				tools: unknown[];
				toolConfig?: { functionCallingConfig?: { mode: string } };
			};
		};

		expect(rewritten.config.tools).toEqual([
			{
				functionDeclarations: [{ name: "read_file", description: "read" }],
			},
			{ googleSearch: {} },
			{ codeExecution: {} },
		]);
		expect(rewritten.config.toolConfig).toEqual({
			functionCallingConfig: { mode: "VALIDATED" },
		});
	});

	it("drops empty functionDeclarations and functionCallingConfig when only native tools are requested", () => {
		const payload = {
			model: "gemini-4-hydrogen",
			contents: [],
			config: {
				tools: [
					{
						functionDeclarations: [
							{ name: "web.search", description: "search" },
						],
					},
				],
				toolConfig: {
					functionCallingConfig: { mode: "VALIDATED" },
				},
			},
		};

		const rewritten = attachNativeTools("google", payload) as {
			config: {
				tools: unknown[];
				toolConfig?: unknown;
			};
		};

		expect(rewritten.config.tools).toEqual([{ googleSearch: {} }]);
		expect(rewritten.config.toolConfig).toBeUndefined();
	});

	it("does not rewrite x.search for google", () => {
		const payload = {
			model: "gemini-4-hydrogen",
			contents: [],
			config: {
				tools: [
					{
						functionDeclarations: [{ name: "x.search", description: "x" }],
					},
				],
			},
		};

		expect(attachNativeTools("google", payload)).toBe(payload);
	});

	it("continues rewriting flat Responses-API tools for xai", () => {
		const payload = {
			tools: [
				{ type: "function", name: "read" },
				{ type: "function", name: "web.search" },
				{ type: "function", name: "x.search" },
				{ type: "function", name: "code.execute" },
			],
		};

		expect(attachNativeTools("xai", payload)).toEqual({
			tools: [
				{ type: "function", name: "read" },
				{ type: "web_search" },
				{ type: "x_search" },
				{ type: "code_interpreter" },
			],
		});
	});
});

describe("noteServerTool for Google stream chunks", () => {
	it("extracts and merges Google Search grounding metadata across chunks", () => {
		const found = new Map<string, ServerToolPart>();
		noteServerTool(found, {
			candidates: [
				{
					groundingMetadata: {
						webSearchQueries: ["cadmus cloudflare workers"],
					},
				},
			],
		});
		noteServerTool(found, {
			candidates: [
				{
					groundingMetadata: {
						webSearchQueries: [
							"cadmus cloudflare workers",
							"gemini googleSearch tool",
						],
						groundingChunks: [
							{
								web: {
									title: "Gemini API Docs",
									uri: "https://ai.google.dev/gemini-api/docs/google-search",
								},
							},
						],
					},
				},
			],
		});

		expect([...found.values()]).toEqual([
			{
				type: "serverTool",
				id: "google:web.search",
				name: "web.search",
				arguments: {
					queries: ["cadmus cloudflare workers", "gemini googleSearch tool"],
				},
				status: "done",
				result: JSON.stringify([
					{
						title: "Gemini API Docs",
						uri: "https://ai.google.dev/gemini-api/docs/google-search",
					},
				]),
			},
		]);
	});

	it("extracts executableCode and codeExecutionResult parts with success and failure status", () => {
		const found = new Map<string, ServerToolPart>();
		noteServerTool(found, {
			candidates: [
				{
					content: {
						parts: [
							{
								executableCode: {
									language: "PYTHON",
									code: "print(2 + 2)",
								},
							},
						],
					},
				},
			],
		});
		noteServerTool(found, {
			candidates: [
				{
					content: {
						parts: [
							{
								codeExecutionResult: {
									outcome: "OUTCOME_OK",
									output: "4\n",
								},
							},
						],
					},
				},
			],
		});
		noteServerTool(found, {
			candidates: [
				{
					content: {
						parts: [
							{
								executableCode: {
									id: "exec-2",
									language: "PYTHON",
									code: "1/0",
								},
							},
							{
								codeExecutionResult: {
									id: "exec-2",
									outcome: "OUTCOME_FAILED",
									output: "ZeroDivisionError",
								},
							},
						],
					},
				},
			],
		});

		expect([...found.values()]).toEqual([
			{
				type: "serverTool",
				id: "google:code.execute:1",
				name: "code.execute",
				arguments: {
					language: "PYTHON",
					code: "print(2 + 2)",
				},
				status: "done",
				result: "4\n",
			},
			{
				type: "serverTool",
				id: "exec-2",
				name: "code.execute",
				arguments: {
					language: "PYTHON",
					code: "1/0",
				},
				status: "error",
				result: "ZeroDivisionError",
			},
		]);
	});
});

describe("resolveConversationExtensionsAndTools for google", () => {
	const bot: BotRecord = {
		slug: "helper",
		name: "Helper",
		model: "google/gemini-4-hydrogen",
		createdAt: 1,
		updatedAt: 1,
	};

	it("enables web.search and code.execute for google while excluding x.search", () => {
		const resolved = resolveConversationExtensionsAndTools({
			bot,
			workspaceEnvEnabled: false,
			isGroupSession: false,
			isGroupCaller: false,
			isConsultMember: false,
			hasActiveTasks: false,
			provider: "google",
		});

		expect(resolved.effectiveToolNames).toContain("web.search");
		expect(resolved.effectiveToolNames).toContain("code.execute");
		expect(resolved.effectiveToolNames).not.toContain("x.search");
	});

	it("suppresses code.execute for google when workspace env is active with bash", () => {
		const resolved = resolveConversationExtensionsAndTools({
			bot,
			workspaceEnvEnabled: true,
			isGroupSession: false,
			isGroupCaller: false,
			isConsultMember: false,
			hasActiveTasks: false,
			provider: "google",
		});

		expect(resolved.effectiveToolNames).toContain("web.search");
		expect(resolved.effectiveToolNames).not.toContain("code.execute");
		expect(resolved.effectiveToolNames).not.toContain("x.search");
	});
});
