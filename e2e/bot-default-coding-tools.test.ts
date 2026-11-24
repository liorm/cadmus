import { describe, expect, it } from "vitest";
import {
	adminScope,
	CODING_TOOL_NAMES,
	connectTestWs,
	DEFAULT_CADMUS_TOOL_NAMES,
	effectiveToolNames,
	type RpcOptions,
	type ServerEvent,
	sendRpc,
	useWorkerFixture,
} from "./helpers.js";

async function scope(
	_label: string,
): Promise<RpcOptions & { accountId: string; familyId: string }> {
	return adminScope("default");
}

const DEFAULT_PLUS_CODING = [
	...DEFAULT_CADMUS_TOOL_NAMES,
	...CODING_TOOL_NAMES,
];

function toolResults(events: ServerEvent[]) {
	return events.filter((event) => event.type === "turn.tool_result");
}

describe("default Cadmus tools plus coding tools", () => {
	useWorkerFixture();

	it("create, enable coding, then disable coding returns the default set", async () => {
		const options = await scope("round-trip");
		await sendRpc("family.update", { harvestDelayMs: 0 }, options);
		const created = await sendRpc<{ bot: { tools?: string[] } }>(
			"bot.create",
			{ slug: "assistant", name: "Assistant", model: "faux/echo" },
			options,
		);
		expect(created.frame.ok).toBe(true);
		expect(created.frame.result?.bot.tools).toBeUndefined();

		const initialStatus = await sendRpc<{
			status: { tools: string[] | "all" };
		}>("chat.status", { chatKey: "bot:assistant" }, options);
		expect(initialStatus.frame.ok).toBe(true);
		expect(initialStatus.frame.result?.status.tools).toEqual(
			effectiveToolNames(undefined, { codingToolsOffered: true }),
		);

		const ws = await connectTestWs(options);
		const turn = async (text: string) => {
			ws.events.length = 0;
			const submitted = await ws.send("turn.submit", {
				chatKey: "bot:assistant",
				text,
			});
			expect(submitted.ok).toBe(true);
			return toolResults(ws.events)[0]?.payload as
				| { toolName?: string; isError?: boolean; content?: string }
				| undefined;
		};
		try {
			const memory = await turn(
				'[tool:write {"path":"/.cadmus/MEMORY.md","content":"from-default"}]',
			);
			expect(memory?.toolName).toBe("write");
			expect(memory?.isError).toBe(false);
			const bashFirst = await turn('[tool:bash {"command":"echo coded"}]');
			expect(bashFirst?.toolName).toBe("bash");
			expect(bashFirst?.isError).toBe(false);
			expect(bashFirst?.content ?? "").toContain("coded");

			const narrowed = await sendRpc<{ bot: { tools?: string[] } }>(
				"bot.update",
				{ botId: "assistant", tools: [...DEFAULT_CADMUS_TOOL_NAMES] },
				options,
			);
			expect(narrowed.frame.ok).toBe(true);
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
			}>("chat.status", { chatKey: "bot:assistant" }, options);
			expect(codingStatus.frame.result?.status.tools).toEqual(
				effectiveToolNames(DEFAULT_PLUS_CODING, { codingToolsOffered: true }),
			);

			const skill = await turn(
				`[tool:write ${JSON.stringify({
					path: "/.cadmus/skills/note/SKILL.md",
					content: "---\nname: note\ndescription: a note\n---\n\nkept",
				})}]`,
			);
			expect(skill?.toolName).toBe("write");
			expect(skill?.isError).toBe(false);
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
			}>("chat.status", { chatKey: "bot:assistant" }, options);
			expect(restored.frame.result?.status.tools).toEqual(
				effectiveToolNames(undefined, { codingToolsOffered: true }),
			);

			const memoryAgain = await turn(
				'[tool:read {"path":"/.cadmus/MEMORY.md"}]',
			);
			expect(memoryAgain?.toolName).toBe("read");
			expect(memoryAgain?.isError).toBe(false);
			const bashAgain = await turn('[tool:bash {"command":"echo again"}]');
			expect(bashAgain?.toolName).toBe("bash");
			expect(bashAgain?.isError).toBe(false);
			expect(bashAgain?.content ?? "").toContain("again");
		} finally {
			ws.close();
		}

		const memoryFile = await sendRpc<{ content: string }>(
			"file.read",
			{ botId: "assistant", path: "/.cadmus/MEMORY.md" },
			options,
		);
		expect(memoryFile.frame.result?.content).toBe("from-default");
		const skillFile = await sendRpc<{ content: string }>(
			"file.read",
			{ botId: "assistant", path: "/.cadmus/skills/note/SKILL.md" },
			options,
		);
		expect(skillFile.frame.result?.content).toContain("kept");
	});

	it("create_bot with only coding tools keeps the default Cadmus tools", async () => {
		const options = await scope("create-bot");
		await sendRpc("family.update", { harvestDelayMs: 0 }, options);
		await sendRpc(
			"bot.create",
			{ slug: "caller", name: "Caller", model: "faux/echo" },
			options,
		);
		const ws = await connectTestWs(options);
		try {
			const submitted = await ws.send("turn.submit", {
				chatKey: "bot:caller",
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

		const coder = await connectTestWs(options);
		try {
			coder.events.length = 0;
			const memory = await coder.send("turn.submit", {
				chatKey: "bot:coder",
				text: '[tool:write {"path":"/.cadmus/MEMORY.md","content":"from-create-bot"}]',
			});
			expect(memory.ok).toBe(true);
			const memoryResult = toolResults(coder.events)[0]?.payload as
				| { toolName?: string; isError?: boolean }
				| undefined;
			expect(memoryResult?.toolName).toBe("write");
			expect(memoryResult?.isError).toBe(false);

			coder.events.length = 0;
			const bash = await coder.send("turn.submit", {
				chatKey: "bot:coder",
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
