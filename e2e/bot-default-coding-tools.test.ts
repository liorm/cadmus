import {
	CODING_TOOL_NAMES,
	DEFAULT_CADMUS_TOOL_NAMES,
	effectiveToolNames,
} from "@cadmus/contract/tools";
import { describe, expect, it } from "vitest";
import type { ServerEvent } from "../packages/worker/src/protocol.js";
import {
	connectTestWs,
	type RpcOptions,
	sendRpc,
	uniqueAccountId,
} from "./helpers.js";

function scope(
	label: string,
): RpcOptions & { accountId: string; familyId: string } {
	const accountId = uniqueAccountId(`default-coding-${label}`);
	return { accountId, familyId: "default" };
}

const DEFAULT_PLUS_CODING = [
	...DEFAULT_CADMUS_TOOL_NAMES,
	...CODING_TOOL_NAMES,
];

function toolResults(events: ServerEvent[]) {
	return events.filter((event) => event.type === "turn.tool_result");
}

describe("default Cadmus tools plus coding tools", () => {
	it("create, enable coding, then disable coding returns the default set", async () => {
		const options = scope("round-trip");
		await sendRpc("family.update", { harvestDelayMs: 0 }, options);
		const created = await sendRpc<{ bot: { tools?: string[] } }>(
			"bot.create",
			{ slug: "assistant", name: "Assistant", model: "faux/echo" },
			options,
		);
		expect(created.frame.ok).toBe(true);
		expect(created.frame.result?.bot.tools).toBeUndefined();
		await sendRpc("chat.create", { botId: "assistant", key: "main" }, options);

		const initialStatus = await sendRpc<{
			status: { tools: string[] | "all" };
		}>("chat.status", { chatKey: "main" }, options);
		expect(initialStatus.frame.ok).toBe(true);
		expect(initialStatus.frame.result?.status.tools).toBe("all");

		const ws = await connectTestWs(options);
		const turn = async (text: string) => {
			ws.events.length = 0;
			const submitted = await ws.send("turn.submit", {
				chatKey: "main",
				text,
			});
			expect(submitted.ok).toBe(true);
			return toolResults(ws.events)[0]?.payload as
				| { toolName?: string; isError?: boolean; content?: string }
				| undefined;
		};
		try {
			const memory = await turn(
				'[tool:memory_update {"content":"from-default","expectedVersion":0}]',
			);
			expect(memory?.toolName).toBe("memory_update");
			expect(memory?.isError).toBe(false);
			const bashBlocked = await turn('[tool:bash {"command":"echo no"}]');
			expect(bashBlocked?.isError).toBe(true);
			expect(bashBlocked?.content ?? "").toMatch(/not available|disabled/);

			const enabled = await sendRpc<{ bot: { tools?: string[] } }>(
				"bot.update",
				{ botId: "assistant", tools: DEFAULT_PLUS_CODING },
				options,
			);
			expect(enabled.frame.ok).toBe(true);
			expect(enabled.frame.result?.bot.tools).toEqual(DEFAULT_PLUS_CODING);
			const codingStatus = await sendRpc<{
				status: { tools: string[] | "all" };
			}>("chat.status", { chatKey: "main" }, options);
			expect(codingStatus.frame.result?.status.tools).toEqual(
				effectiveToolNames(DEFAULT_PLUS_CODING, { codingToolsOffered: true }),
			);

			const knowledge = await turn(
				'[tool:knowledge_update {"slug":"note","description":"a note","body":"kept","expectedVersion":0}]',
			);
			expect(knowledge?.toolName).toBe("knowledge_update");
			expect(knowledge?.isError).toBe(false);
			const bash = await turn('[tool:bash {"command":"echo coded"}]');
			expect(bash?.toolName).toBe("bash");
			expect(bash?.isError).toBe(false);
			expect(bash?.content ?? "").toContain("coded");

			const cleared = await sendRpc<{ bot: { tools?: string[] } }>(
				"bot.update",
				{ botId: "assistant", tools: null },
				options,
			);
			expect(cleared.frame.ok).toBe(true);
			expect(cleared.frame.result?.bot.tools).toBeUndefined();
			const fetched = await sendRpc<{ bot: { tools?: string[] } }>(
				"bot.get",
				{ botId: "assistant" },
				options,
			);
			expect(fetched.frame.result?.bot.tools).toBeUndefined();
			const restored = await sendRpc<{
				status: { tools: string[] | "all" };
			}>("chat.status", { chatKey: "main" }, options);
			expect(restored.frame.result?.status.tools).toBe("all");

			const memoryAgain = await turn("[tool:memory_read {}]");
			expect(memoryAgain?.toolName).toBe("memory_read");
			expect(memoryAgain?.isError).toBe(false);
			const bashAgain = await turn('[tool:bash {"command":"echo no"}]');
			expect(bashAgain?.isError).toBe(true);
			expect(bashAgain?.content ?? "").toMatch(/not available|disabled/);
		} finally {
			ws.close();
		}

		const memoryFile = await sendRpc<{ content: string }>(
			"file.read",
			{ botId: "assistant", path: "MEMORY.md" },
			options,
		);
		expect(memoryFile.frame.result?.content).toBe("from-default");
		const knowledgeFile = await sendRpc<{ content: string }>(
			"file.read",
			{ botId: "assistant", path: "knowledge/note.md" },
			options,
		);
		expect(knowledgeFile.frame.result?.content).toContain("kept");
	});

	it("create_bot with only coding tools keeps the default Cadmus tools", async () => {
		const options = scope("create-bot");
		await sendRpc("family.update", { harvestDelayMs: 0 }, options);
		await sendRpc(
			"bot.create",
			{ slug: "caller", name: "Caller", model: "faux/echo" },
			options,
		);
		await sendRpc(
			"chat.create",
			{ botId: "caller", key: "caller-chat" },
			options,
		);
		const ws = await connectTestWs(options);
		try {
			const submitted = await ws.send("turn.submit", {
				chatKey: "caller-chat",
				text: `[tool:create_bot ${JSON.stringify({
					name: "Coder",
					slug: "coder",
					model: "faux/echo",
					tools: [...CODING_TOOL_NAMES],
				})}]`,
			});
			expect(submitted.ok).toBe(true);
		} finally {
			ws.close();
		}

		const created = await sendRpc<{ bot: { tools?: string[] } }>(
			"bot.get",
			{ botId: "coder" },
			options,
		);
		expect(created.frame.ok).toBe(true);
		expect(created.frame.result?.bot.tools).toEqual(DEFAULT_PLUS_CODING);

		await sendRpc(
			"chat.create",
			{ botId: "coder", key: "coder-chat" },
			options,
		);
		const coder = await connectTestWs(options);
		try {
			coder.events.length = 0;
			const memory = await coder.send("turn.submit", {
				chatKey: "coder-chat",
				text: '[tool:memory_update {"content":"from-create-bot","expectedVersion":0}]',
			});
			expect(memory.ok).toBe(true);
			const memoryResult = toolResults(coder.events)[0]?.payload as
				| { toolName?: string; isError?: boolean }
				| undefined;
			expect(memoryResult?.toolName).toBe("memory_update");
			expect(memoryResult?.isError).toBe(false);

			coder.events.length = 0;
			const bash = await coder.send("turn.submit", {
				chatKey: "coder-chat",
				text: '[tool:bash {"command":"echo coded"}]',
			});
			expect(bash.ok).toBe(true);
			const bashResult = toolResults(coder.events)[0]?.payload as
				| { toolName?: string; isError?: boolean; content?: string }
				| undefined;
			expect(bashResult?.toolName).toBe("bash");
			expect(bashResult?.isError).toBe(false);
			expect(bashResult?.content ?? "").toContain("coded");
		} finally {
			coder.close();
		}
	});
});
