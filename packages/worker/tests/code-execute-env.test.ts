import {
	CODE_EXECUTE_TOOL_NAME,
	CODING_TOOL_NAMES,
	DEFAULT_CADMUS_TOOL_NAMES,
} from "@cadmus/contract/tools";
import { describe, expect, it } from "vitest";
import {
	clearProviderToolCapture,
	installProviderToolCapture,
	type ProviderToolCapture,
} from "../src/extensions/provider-tools.js";
import type { ServerEvent } from "../src/protocol.js";
import {
	connectTestWs,
	type RpcOptions,
	sendRpc,
	uniqueAccountId,
} from "./helpers.js";

const BOTH = [...DEFAULT_CADMUS_TOOL_NAMES, ...CODING_TOOL_NAMES];
const BLOCK =
	"code.execute is disabled while the workspace tools env is on; use bash";

function scope(
	label: string,
): RpcOptions & { accountId: string; familyId: string } {
	const accountId = uniqueAccountId(`code-exec-${label}`);
	return { accountId, familyId: "default" };
}

function toolResults(events: ServerEvent[]) {
	return events.filter((event) => event.type === "turn.tool_result");
}

function capturesFor(sink: ProviderToolCapture[], botId: string): string[][] {
	return sink
		.filter((entry) => entry.botId === botId)
		.map((entry) => entry.tools);
}

describe("code.execute while the bash tools env is on", () => {
	it("omits code.execute from the provider request and blocks a call", async () => {
		const options = scope("on");
		const botId = "coder";
		await sendRpc("family.update", { harvestDelayMs: 0 }, options);
		const created = await sendRpc<{ bot: { tools?: string[] } }>(
			"bot.create",
			{
				slug: botId,
				name: "Coder",
				model: "faux/echo",
				tools: BOTH,
				toolsEnv: { enabled: true, binding: { envId: "jb_default" } },
			},
			options,
		);
		expect(created.frame.ok).toBe(true);
		expect(created.frame.result?.bot.tools).toEqual(BOTH);
		await sendRpc("chat.create", { botId, key: "main" }, options);

		const sink = installProviderToolCapture();
		const ws = await connectTestWs(options);
		try {
			ws.events.length = 0;
			const turn = await ws.send("turn.submit", {
				chatKey: "main",
				text: `[tool:${CODE_EXECUTE_TOOL_NAME} {"code":"print(1)"}]`,
			});
			expect(turn.ok).toBe(true);
			const payload = toolResults(ws.events)[0]?.payload as
				| { toolName?: string; isError?: boolean; content?: string }
				| undefined;
			expect(payload?.toolName).toBe(CODE_EXECUTE_TOOL_NAME);
			expect(payload?.isError).toBe(true);
			expect(payload?.content ?? "").toContain(BLOCK);

			const offered = capturesFor(sink, botId);
			expect(offered.length).toBeGreaterThan(0);
			for (const tools of offered) {
				expect(tools).not.toContain(CODE_EXECUTE_TOOL_NAME);
				expect(tools).not.toContain("code_interpreter");
				expect(tools).toContain("bash");
			}
		} finally {
			ws.close();
			clearProviderToolCapture();
		}

		const stored = await sendRpc<{ bot: { tools?: string[] } }>(
			"bot.get",
			{ botId },
			options,
		);
		expect(stored.frame.result?.bot.tools).toEqual(BOTH);
		const status = await sendRpc<{
			status: { tools: string[] | "all" };
		}>("chat.status", { chatKey: "main" }, options);
		expect(status.frame.result?.status.tools).toEqual(
			BOTH.filter((name) => name !== CODE_EXECUTE_TOOL_NAME),
		);
		expect(JSON.stringify(status.frame.result?.status.tools)).not.toContain(
			CODE_EXECUTE_TOOL_NAME,
		);

		const entries = await sendRpc<{ entries: unknown[] }>(
			"chat.entries",
			{ chatKey: "main" },
			options,
		);
		const blob = JSON.stringify(entries.frame.result?.entries);
		expect(blob).toContain("Code runs in the workspace via bash");
		expect(blob).toContain("code.execute is disabled");
		expect(blob).not.toContain("isolated provider sandbox");
	});

	it("offers code.execute again when the chat env is disabled", async () => {
		const options = scope("chat-off");
		const botId = "coder";
		await sendRpc("family.update", { harvestDelayMs: 0 }, options);
		await sendRpc(
			"bot.create",
			{
				slug: botId,
				name: "Coder",
				model: "faux/echo",
				tools: BOTH,
				toolsEnv: { enabled: true, binding: { envId: "jb_default" } },
			},
			options,
		);
		await sendRpc(
			"chat.create",
			{
				botId,
				key: "main",
				toolsEnv: { enabled: false },
			},
			options,
		);

		const sink = installProviderToolCapture();
		const ws = await connectTestWs(options);
		try {
			const turn = await ws.send("turn.submit", {
				chatKey: "main",
				text: "Hello",
			});
			expect(turn.ok).toBe(true);
			const offered = capturesFor(sink, botId);
			expect(offered.length).toBeGreaterThan(0);
			for (const tools of offered) {
				expect(tools).toContain(CODE_EXECUTE_TOOL_NAME);
			}
		} finally {
			ws.close();
			clearProviderToolCapture();
		}

		const status = await sendRpc<{ status: { tools: string[] | "all" } }>(
			"chat.status",
			{ chatKey: "main" },
			options,
		);
		expect(status.frame.result?.status.tools).toEqual(BOTH);
	});

	it("keeps code.execute when an account default env is on but coding tools are not listed", async () => {
		const options = scope("no-coding");
		const botId = "reader";
		await sendRpc("family.update", { harvestDelayMs: 0 }, options);
		await sendRpc(
			"account.update",
			{ defaultToolsEnv: { envId: "jb_default" } },
			options,
		);
		await sendRpc(
			"bot.create",
			{
				slug: botId,
				name: "Reader",
				model: "faux/echo",
				tools: [...DEFAULT_CADMUS_TOOL_NAMES],
			},
			options,
		);
		await sendRpc("chat.create", { botId, key: "main" }, options);

		const sink = installProviderToolCapture();
		const ws = await connectTestWs(options);
		try {
			const turn = await ws.send("turn.submit", {
				chatKey: "main",
				text: "Hello",
			});
			expect(turn.ok).toBe(true);
			const offered = capturesFor(sink, botId);
			expect(offered.length).toBeGreaterThan(0);
			for (const tools of offered) {
				expect(tools).toContain(CODE_EXECUTE_TOOL_NAME);
				expect(tools).not.toContain("bash");
			}
		} finally {
			ws.close();
			clearProviderToolCapture();
		}
	});
});
