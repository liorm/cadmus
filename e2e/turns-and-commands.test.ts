import { describe, expect, it } from "vitest";
import {
	adminScope,
	type ChatGetResult,
	type ChatRecord,
	connectTestWs,
	sendRpc,
	type TurnBlock,
	useWorkerFixture,
	workerFetch,
} from "./helpers.js";

async function untilType(
	events: Array<{ type: string }>,
	type: string,
) {
	const deadline = Date.now() + 2_000;
	while (!events.some((event) => event.type === type) && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

describe("Turns, Streaming Protocol Events & chat.status", () => {
	useWorkerFixture();

	it("streams turn.delta, turn.tool_call, turn.tool_result, chat.state, and turn.completed over WebSocket", async () => {
		const scope = await adminScope("default");
		const wsClient = await connectTestWs(scope);

		try {
			const botRes = await wsClient.send("bot.create", {
				slug: "echo-bot",
				name: "Echo Bot",
				model: "faux/echo",
			});
			expect(botRes.ok).toBe(true);

			const chatRes = await wsClient.send<{ chat: ChatRecord }>("chat.create", {
				botId: "echo-bot",
				key: "ws-chat-1",
			});
			expect(chatRes.ok).toBe(true);

			// Submit a turn with a tool call directive
			const turnRes = await wsClient.send<{ reply: string }>("turn.submit", {
				chatKey: "ws-chat-1",
				text: "Read memory please [tool:memory_read {}]",
			});
			expect(turnRes.ok).toBe(true);
			expect(turnRes.result?.reply).toContain("echo(1):");
			expect(turnRes.result?.reply).toContain('"exists":false');
			await untilType(wsClient.events, "turn.completed");

			const eventTypes = wsClient.events.map((e) => e.type);
			expect(eventTypes).toContain("chat.state");
			expect(eventTypes).toContain("turn.delta");
			expect(eventTypes).toContain("turn.tool_call");
			expect(eventTypes).toContain("turn.tool_result");
			expect(eventTypes).toContain("turn.completed");
		} finally {
			wsClient.close();
		}
	});

	it("returns chat.status without polluting conversation history or calling the LLM", async () => {
		const scope = await adminScope("default");

		await sendRpc(
			"bot.create",
			{
				slug: "status-bot",
				name: "Status Bot",
				model: "faux/echo",
				thinking: "low",
			},
			scope,
		);

		await sendRpc(
			"chat.create",
			{ botId: "status-bot", key: "status-chat" },
			scope,
		);

		const firstTurn = await sendRpc<{ reply: string }>(
			"turn.submit",
			{ chatKey: "status-chat", text: "First message" },
			scope,
		);
		expect(firstTurn.frame.result?.reply).toBe("echo(1): First message");

		const statusRes = await sendRpc<{
			status: {
				botId: string;
				model: string;
				thinking: string;
				entryCount: number;
				busy: boolean;
			};
		}>("chat.status", { chatKey: "status-chat" }, scope);
		expect(statusRes.status).toBe(200);
		expect(statusRes.frame.result?.status.botId).toBe("status-bot");
		expect(statusRes.frame.result?.status.model).toBe("faux/echo");
		expect(statusRes.frame.result?.status.thinking).toBe("low");
		expect(statusRes.frame.result?.status.busy).toBe(false);
		expect(statusRes.frame.result?.status.entryCount).toBe(3);
		expect(statusRes.frame.result).not.toHaveProperty("outOfBand");
		expect(statusRes.frame.result).not.toHaveProperty("command");
		expect(statusRes.frame.result).not.toHaveProperty("text");

		const unsupported = await sendRpc(
			"turn.submit",
			{ chatKey: "status-chat", text: "/clear" },
			scope,
		);
		expect(unsupported.status).toBe(400);
		expect(unsupported.frame.error?.code).toBe("unsupported_command");

		const secondTurn = await sendRpc<{ reply: string }>(
			"turn.submit",
			{ chatKey: "status-chat", text: "Second message" },
			scope,
		);
		expect(secondTurn.frame.result?.reply).toBe("echo(2): Second message");
	});

	it("recreates 'what can you do?' conversation: complete streaming deltas and no duplicate output", async () => {
		const scope = await adminScope("default");
		const wsClient = await connectTestWs(scope);

		try {
			const botRes = await wsClient.send("bot.create", {
				slug: "xai",
				name: "xAI Bot",
				model: "faux/echo",
			});
			expect(botRes.ok).toBe(true);

			const chatRes = await wsClient.send<{ chat: ChatRecord }>("chat.create", {
				botId: "xai",
				key: "xai:71aa0dae",
			});
			expect(chatRes.ok).toBe(true);

			// Recreate user request "what can you do?"
			const turnRes = await wsClient.send<{ reply: string }>("turn.submit", {
				chatKey: "xai:71aa0dae",
				text: "what can you do?",
			});
			expect(turnRes.ok).toBe(true);
			expect(turnRes.result?.reply).toContain("What do you want to do?");
			await untilType(wsClient.events, "turn.completed");

			// Verify server events
			const deltaEvents = wsClient.events.filter(
				(e) => e.type === "turn.delta" && e.payload.chatKey === "xai:71aa0dae",
			);
			expect(deltaEvents.length).toBeGreaterThan(0);

			const streamedText = deltaEvents
				.map((e) => (e.payload as { delta: string }).delta)
				.join("");
			expect(streamedText).toBe(turnRes.result?.reply);

			// Verify turn.completed event has complete text
			const completedEvent = wsClient.events.find(
				(e) =>
					e.type === "turn.completed" && e.payload.chatKey === "xai:71aa0dae",
			);
			expect(completedEvent).toBeDefined();
			if (completedEvent && completedEvent.type === "turn.completed") {
				expect(completedEvent.payload.text).toBe(turnRes.result?.reply);
			}
		} finally {
			wsClient.close();
		}
	});

	it("broadcasts blocks in turn.completed, returns blocks in turn.submit, and renders TUI chips for thinking and tools", async () => {
		const scope = await adminScope("default");
		const wsClient = await connectTestWs(scope);

		try {
			await wsClient.send("bot.create", {
				slug: "chip-bot",
				name: "Chip Bot",
				model: "faux/echo",
			});

			await wsClient.send<{ chat: ChatRecord }>("chat.create", {
				botId: "chip-bot",
				key: "chip-chat-1",
			});

			// Submit a turn with both thinking and tool call directives
			const turnRes = await wsClient.send<{
				reply: string;
				blocks: TurnBlock[];
			}>("turn.submit", {
				chatKey: "chip-chat-1",
				text: "Analyze my memory [think: reasoning deeply] [tool:memory_read {}]",
			});

			expect(turnRes.ok).toBe(true);
			await untilType(wsClient.events, "turn.completed");
			expect(turnRes.result?.blocks).toBeDefined();
			const resultBlocks = turnRes.result?.blocks ?? [];
			expect(resultBlocks.some((b) => b.type === "thinking")).toBe(true);
			expect(
				resultBlocks.some(
					(b) => b.type === "tool_call" && b.toolName === "memory_read",
				),
			).toBe(true);

			// Check WebSocket events
			const completedEvent = wsClient.events.find(
				(e) =>
					e.type === "turn.completed" && e.payload.chatKey === "chip-chat-1",
			);
			expect(completedEvent).toBeDefined();
			if (completedEvent && completedEvent.type === "turn.completed") {
				expect(completedEvent.payload.blocks).toBeDefined();
				expect(
					completedEvent.payload.blocks?.some((b) => b.type === "thinking"),
				).toBe(true);
				expect(
					completedEvent.payload.blocks?.some(
						(b) => b.type === "tool_call" && b.toolName === "memory_read",
					),
				).toBe(true);
			}
		} finally {
			wsClient.close();
		}
	});

	it("enriches transcript messages and entries with server-side binding over synchronous RPC", async () => {
		const scope = await adminScope("default");

		// 1. Calling POST /rpc via sendRpc acts as a synchronous request-response where the server binds the response
		const customReqId = "req-custom-sync-check-42";
		const directRes = await workerFetch("http://example.com/rpc", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${scope.token}`,
				"x-account-id": scope.accountId,
			},
			body: JSON.stringify({
				id: customReqId,
				type: "bot.create",
				payload: {
					slug: "enrich-bot",
					name: "Enrich Bot",
					model: "faux/echo",
				},
			}),
		});
		const directFrame = (await directRes.json()) as {
			id: string;
			type: string;
			command: string;
			ok: boolean;
		};
		expect(directRes.status).toBe(200);
		expect(directFrame.id).toBe(customReqId);
		expect(directFrame.command).toBe("bot.create");
		expect(directFrame.ok).toBe(true);

		const chatCreate = await sendRpc<{ chat: ChatRecord }>(
			"chat.create",
			{
				botId: "enrich-bot",
				key: "enrich-chat",
			},
			scope,
		);
		expect(chatCreate.status).toBe(200);
		expect(chatCreate.frame.command).toBe("chat.create");
		expect(chatCreate.frame.ok).toBe(true);

		// 2. Submit turn with thinking and tool call
		const turnRes = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "enrich-chat",
				text: "Check memory [think: checking memory first] [tool:memory_read {}]",
			},
			scope,
		);
		expect(turnRes.status).toBe(200);
		expect(turnRes.frame.command).toBe("turn.submit");
		expect(turnRes.frame.ok).toBe(true);

		// 3. Call chat.get via sendRpc
		const chatGet = await sendRpc<ChatGetResult>(
			"chat.get",
			{ chatKey: "enrich-chat" },
			scope,
		);
		expect(chatGet.status).toBe(200);
		expect(chatGet.frame.command).toBe("chat.get");
		expect(chatGet.frame.ok).toBe(true);

		// 4. Call chat.entries via sendRpc
		const chatEntries = await sendRpc<ChatGetResult>(
			"chat.entries",
			{ chatKey: "enrich-chat" },
			scope,
		);
		expect(chatEntries.status).toBe(200);
		expect(chatEntries.frame.command).toBe("chat.entries");
		expect(chatEntries.frame.ok).toBe(true);

		// 5. Verify messages in chat.get
		const messages = chatGet.frame.result?.messages ?? [];
		const userMsg = messages.find((m) => m.role === "user");
		expect(userMsg).toBeDefined();
		expect(userMsg?.text).toBe(
			"Check memory [think: checking memory first] [tool:memory_read {}]",
		);
		expect(userMsg?.id).toBeDefined();

		const assistantWithTool = messages.find(
			(m) => m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0,
		);
		expect(assistantWithTool).toBeDefined();
		expect(assistantWithTool?.replyToEntryId).toBe(userMsg?.id);
		expect(assistantWithTool?.thinking).toBe("checking memory first");
		expect(assistantWithTool?.toolCalls?.[0].name).toBe("memory_read");
		expect(assistantWithTool?.toolCalls?.[0].result).toBeDefined();
		expect(assistantWithTool?.toolCalls?.[0].result?.isError).toBe(false);
		expect(assistantWithTool?.toolCalls?.[0].result?.content).toContain(
			'"exists":false',
		);

		const thinkingBlock = assistantWithTool?.blocks?.find(
			(b) => b.type === "thinking",
		);
		expect(thinkingBlock).toBeDefined();
		const toolCallBlock = assistantWithTool?.blocks?.find(
			(b) => b.type === "toolCall",
		);
		expect(toolCallBlock).toBeDefined();
		if (toolCallBlock && toolCallBlock.type === "toolCall") {
			expect(toolCallBlock.name).toBe("memory_read");
			expect(toolCallBlock.result?.isError).toBe(false);
			expect(toolCallBlock.result?.content).toContain('"exists":false');
		}

		// 6. Verify entries in chat.entries
		const entries = chatEntries.frame.result?.entries ?? [];
		expect(entries.length).toBeGreaterThanOrEqual(4);

		const systemEntry = entries.find((e) => {
			const m = e.model?.[0] as
				| { role?: string; sections?: Record<string, unknown> }
				| undefined;
			return m?.role === "system" && m?.sections !== undefined;
		});
		expect(systemEntry).toBeDefined();

		const userEntry = entries.find((e) => {
			const m = e.model?.[0] as { role?: string } | undefined;
			return m?.role === "user";
		});
		expect(userEntry).toBeDefined();

		const assistantEntries = entries.filter((e) => {
			const m = e.model?.[0] as
				| { role?: string; content?: unknown[] }
				| undefined;
			return m?.role === "assistant" && Array.isArray(m?.content);
		});
		expect(assistantEntries.length).toBeGreaterThanOrEqual(1);

		const toolResultEntry = entries.find((e) => {
			const m = e.model?.[0] as { role?: string } | undefined;
			return m?.role === "toolResult";
		});
		expect(toolResultEntry).toBeDefined();
	});
});
