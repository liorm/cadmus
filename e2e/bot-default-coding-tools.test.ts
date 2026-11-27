import { describe, expect, it } from "vitest";
import {
	adminScope,
	BASH_TOOL_NAME,
	CATALOG_TOOL_NAMES,
	connectTestWs,
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

const WITHOUT_BASH = CATALOG_TOOL_NAMES.filter(
	(name) => name !== BASH_TOOL_NAME,
);

function toolResults(events: ServerEvent[]) {
	return events.filter((event) => event.type === "turn.tool_result");
}

async function untilToolResult(events: ServerEvent[]) {
	const deadline = Date.now() + 2_000;
	while (toolResults(events).length === 0 && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

describe("catalog tools and runtime bash env gating", () => {
	useWorkerFixture();

	it("create, narrow allowlist, restore catalog, and reset to omitted set", async () => {
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
			effectiveToolNames(undefined, { workspaceEnvEnabled: true }),
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
				{ botId: "assistant", tools: WITHOUT_BASH },
				options,
			);
			expect(narrowed.frame.ok).toBe(true);
			const bashBlocked = await turn('[tool:bash {"command":"echo no"}]');
			expect(bashBlocked?.isError).toBe(true);
			expect(bashBlocked?.content ?? "").toMatch(/not available|disabled/);

			const enabled = await sendRpc<{ bot: { tools?: string[] } }>(
				"bot.update",
				{ botId: "assistant", tools: [...CATALOG_TOOL_NAMES] },
				options,
			);
			expect(enabled.frame.ok).toBe(true);
			expect(enabled.frame.result?.bot.tools).toEqual([...CATALOG_TOOL_NAMES]);
			const codingStatus = await sendRpc<{
				status: { tools: string[] | "all" };
			}>("chat.status", { chatKey: "bot:assistant" }, options);
			expect(codingStatus.frame.result?.status.tools).toEqual(
				effectiveToolNames([...CATALOG_TOOL_NAMES], {
					workspaceEnvEnabled: true,
				}),
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
				effectiveToolNames(undefined, { workspaceEnvEnabled: true }),
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

	it("create_bot with omitted tools grants full catalog, while explicit [bash] restricts to bash", async () => {
		const options = await scope("create-bot");
		await sendRpc("family.update", { harvestDelayMs: 0 }, options);
		await sendRpc(
			"bot.create",
			{ slug: "caller", name: "Caller", model: "faux/echo" },
			options,
		);
		const ws = await connectTestWs(options);
		try {
			const full = await ws.send("turn.submit", {
				chatKey: "bot:caller",
				text: `[tool:create_bot ${JSON.stringify({
					name: "Full",
					slug: "full-peer",
					model: "faux/echo",
				})}]`,
			});
			expect(full.ok).toBe(true);

			const bashOnly = await ws.send("turn.submit", {
				chatKey: "bot:caller",
				text: `[tool:create_bot ${JSON.stringify({
					name: "BashOnly",
					slug: "bash-only",
					model: "faux/echo",
					tools: [BASH_TOOL_NAME],
				})}]`,
			});
			expect(bashOnly.ok).toBe(true);
		} finally {
			ws.close();
		}

		const createdFull = await sendRpc<{ bot: { tools?: string[] } }>(
			"bot.get",
			{ botId: "full-peer" },
			options,
		);
		expect(createdFull.frame.ok).toBe(true);
		expect(createdFull.frame.result?.bot.tools).toBeUndefined();

		const createdBashOnly = await sendRpc<{ bot: { tools?: string[] } }>(
			"bot.get",
			{ botId: "bash-only" },
			options,
		);
		expect(createdBashOnly.frame.ok).toBe(true);
		expect(createdBashOnly.frame.result?.bot.tools).toEqual([BASH_TOOL_NAME]);

		const client = await connectTestWs(options);
		try {
			client.events.length = 0;
			const memory = await client.send("turn.submit", {
				chatKey: "bot:full-peer",
				text: '[tool:write {"path":"/.cadmus/MEMORY.md","content":"from-create-bot"}]',
			});
			expect(memory.ok).toBe(true);
			const memoryResult = toolResults(client.events)[0]?.payload as
				| { toolName?: string; isError?: boolean }
				| undefined;
			expect(memoryResult?.toolName).toBe("write");
			expect(memoryResult?.isError).toBe(false);

			client.events.length = 0;
			const bash = await client.send("turn.submit", {
				chatKey: "bot:full-peer",
				text: '[tool:bash {"command":"echo coded"}]',
			});
			expect(bash.ok).toBe(true);
			const bashResult = toolResults(client.events)[0]?.payload as
				| { toolName?: string; isError?: boolean; content?: string }
				| undefined;
			expect(bashResult?.toolName).toBe("bash");
			expect(bashResult?.isError).toBe(false);
			expect(bashResult?.content ?? "").toContain("coded");

			client.events.length = 0;
			await client.send("turn.submit", {
				chatKey: "bot:bash-only",
				text: '[tool:write {"path":"/.cadmus/MEMORY.md","content":"blocked"}]',
			});
			const blockedWrite = toolResults(client.events)[0]?.payload as
				| { isError?: boolean }
				| undefined;
			expect(blockedWrite?.isError).toBe(true);

			client.events.length = 0;
			await client.send("turn.submit", {
				chatKey: "bot:bash-only",
				text: '[tool:bash {"command":"echo allowed"}]',
			});
			const allowedBash = toolResults(client.events)[0]?.payload as
				| { isError?: boolean; content?: string }
				| undefined;
			expect(allowedBash?.isError).toBe(false);
			expect(allowedBash?.content ?? "").toContain("allowed");
		} finally {
			client.close();
		}
	});

	it("keeps bash registered when toolsEnv is disabled, guides the model, and fails cleanly at runtime", async () => {
		const options = await scope("env-off");
		await sendRpc("family.update", { harvestDelayMs: 0 }, options);
		await sendRpc(
			"bot.create",
			{
				slug: "assistant",
				name: "Assistant",
				model: "faux/echo",
				toolsEnv: { enabled: false },
			},
			options,
		);

		const status = await sendRpc<{ status: { tools: string[] | "all" } }>(
			"chat.status",
			{ chatKey: "bot:assistant" },
			options,
		);
		expect(status.frame.ok).toBe(true);
		expect(status.frame.result?.status.tools).toBe("all");

		const ws = await connectTestWs(options);
		try {
			ws.events.length = 0;
			const failed = await ws.send("turn.submit", {
				chatKey: "bot:assistant",
				text: '[tool:bash {"command":"echo nope"}]',
			});
			expect(failed.ok).toBe(true);
			await untilToolResult(ws.events);
			const payload = toolResults(ws.events)[0]?.payload as
				| { toolName?: string; isError?: boolean; content?: string }
				| undefined;
			expect(payload?.toolName).toBe("bash");
			expect(payload?.isError).toBe(true);
			expect(payload?.content ?? "").toContain(
				"No workspace tools environment is enabled",
			);

			const raw = await sendRpc<{ entries?: unknown[] }>(
				"chat.get",
				{ chatKey: "bot:assistant", raw: true },
				options,
			);
			const blob = JSON.stringify(raw.frame.result?.entries);
			expect(blob).toContain("No workspace tools environment is enabled");
			expect(blob).toContain("do not call bash");
			expect(blob).not.toContain("Code runs in the workspace via bash");

			await sendRpc(
				"chat.update",
				{
					chatKey: "bot:assistant",
					toolsEnv: { enabled: true, binding: { envId: "jb_default" } },
				},
				options,
			);
			ws.events.length = 0;
			const okTurn = await ws.send("turn.submit", {
				chatKey: "bot:assistant",
				text: '[tool:bash {"command":"echo enabled-now"}]',
			});
			expect(okTurn.ok).toBe(true);
			await untilToolResult(ws.events);
			const okPayload = toolResults(ws.events)[0]?.payload as
				| { toolName?: string; isError?: boolean; content?: string }
				| undefined;
			expect(okPayload?.isError).toBe(false);
			expect(okPayload?.content ?? "").toContain("enabled-now");
		} finally {
			ws.close();
		}
	});
});
