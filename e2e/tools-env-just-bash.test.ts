import { env, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ServerEvent } from "../packages/worker/src/protocol.js";
import {
	connectTestWs,
	type RpcOptions,
	sendRpc,
	uniqueAccountId,
} from "./helpers.js";

const CODING_TOOLS = ["bash", "read", "write", "edit"];

function scope(
	label: string,
): RpcOptions & { accountId: string; familyId: string } {
	const accountId = uniqueAccountId(`env-${label}`);
	return { accountId, familyId: "default" };
}

function familyStub(accountId: string, familyId = "default") {
	return env.CADMUS_BOT_FAMILY.get(
		env.CADMUS_BOT_FAMILY.idFromName(`cadmus:${accountId}:${familyId}`),
	);
}

function envStub(accountId: string, envId = "jb_default") {
	return env.CADMUS_ENV.getByName(`env:${accountId}:${envId}`);
}

function toolResults(events: ServerEvent[]) {
	return events.filter((event) => event.type === "turn.tool_result");
}

function toolIsError(events: ServerEvent[]): boolean | undefined {
	const payload = toolResults(events)[0]?.payload as
		| { isError?: boolean }
		| undefined;
	return payload?.isError;
}

async function waitForEvent(
	events: ServerEvent[],
	type: string,
	timeoutMs = 5000,
): Promise<void> {
	const started = Date.now();
	while (Date.now() - started < timeoutMs) {
		if (events.some((event) => event.type === type)) return;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	throw new Error(`timed out waiting for ${type}`);
}

describe("just-bash tools env through the bot", () => {
	it("runs bash end to end on the shared bot namespace", async () => {
		const options = scope("bash");
		await sendRpc("family.update", { harvestDelayMs: 0 }, options);
		const ws = await connectTestWs(options);
		try {
			expect(
				(
					await ws.send("bot.create", {
						slug: "assistant",
						name: "Assistant",
						model: "faux/echo",
						tools: CODING_TOOLS,
					})
				).ok,
			).toBe(true);
			expect(
				(await ws.send("chat.create", { botId: "assistant", key: "left" })).ok,
			).toBe(true);
			expect(
				(await ws.send("chat.create", { botId: "assistant", key: "right" })).ok,
			).toBe(true);

			ws.events.length = 0;
			const turn = await ws.send<{ reply: string }>("turn.submit", {
				chatKey: "left",
				text: '[tool:bash {"command":"echo hi > /workspace/hello.txt"}]',
			});
			expect(turn.ok).toBe(true);
			const results = toolResults(ws.events);
			expect(results.length).toBeGreaterThan(0);
			const payload = results[0]?.payload as {
				toolName?: string;
				isError?: boolean;
				content?: string;
			};
			expect(payload.toolName).toBe("bash");
			expect(payload.isError).toBe(false);

			const bytes = await envStub(options.accountId).namespaceBytes(
				"default",
				"bot:assistant",
			);
			expect(bytes).toBeGreaterThan(0);

			ws.events.length = 0;
			const seen = await ws.send("turn.submit", {
				chatKey: "right",
				text: '[tool:read {"path":"hello.txt"}]',
			});
			expect(seen.ok).toBe(true);
			const cat = toolResults(ws.events)[0]?.payload as {
				toolName?: string;
				isError?: boolean;
				content?: string;
			};
			expect(cat.toolName).toBe("read");
			expect(cat.isError).toBe(false);
			expect(cat.content ?? "").toContain("hi");

			const entries = await sendRpc<{
				entries: unknown[];
			}>("chat.entries", { chatKey: "left" }, options);
			expect(JSON.stringify(entries.frame.result?.entries)).toContain(
				"Use bash, read, write, and edit",
			);
		} finally {
			ws.close();
		}
	});

	it("runs write end to end when the body contains a closing brace", async () => {
		const options = scope("write");
		await sendRpc("family.update", { harvestDelayMs: 0 }, options);
		const ws = await connectTestWs(options);
		try {
			await ws.send("bot.create", {
				slug: "assistant",
				name: "Assistant",
				model: "faux/echo",
				tools: CODING_TOOLS,
			});
			await ws.send("chat.create", { botId: "assistant", key: "main" });
			ws.events.length = 0;
			const turn = await ws.send("turn.submit", {
				chatKey: "main",
				text: '[tool:write {"path":"note.txt","content":"a } b"}]',
			});
			expect(turn.ok).toBe(true);
			const payload = toolResults(ws.events)[0]?.payload as {
				toolName?: string;
				isError?: boolean;
			};
			expect(payload.toolName).toBe("write");
			expect(payload.isError).toBe(false);
			expect(
				await envStub(options.accountId).namespaceBytes(
					"default",
					"bot:assistant",
				),
			).toBeGreaterThan(0);
		} finally {
			ws.close();
		}
	});

	it("runs read end to end against a file another inheriting chat wrote", async () => {
		const options = scope("read");
		await sendRpc("family.update", { harvestDelayMs: 0 }, options);
		const ws = await connectTestWs(options);
		try {
			await ws.send("bot.create", {
				slug: "assistant",
				name: "Assistant",
				model: "faux/echo",
				tools: CODING_TOOLS,
			});
			await ws.send("chat.create", { botId: "assistant", key: "left" });
			await ws.send("chat.create", { botId: "assistant", key: "right" });
			await ws.send("turn.submit", {
				chatKey: "left",
				text: '[tool:write {"path":"shared.txt","content":"from-left"}]',
			});
			ws.events.length = 0;
			await ws.send("turn.submit", {
				chatKey: "right",
				text: '[tool:read {"path":"shared.txt"}]',
			});
			const payload = toolResults(ws.events)[0]?.payload as {
				toolName?: string;
				isError?: boolean;
				content?: string;
			};
			expect(payload.toolName).toBe("read");
			expect(payload.isError).toBe(false);
			expect(payload.content ?? "").toContain("from-left");
		} finally {
			ws.close();
		}
	});

	it("runs edit end to end and the next read sees the replacement", async () => {
		const options = scope("edit");
		await sendRpc("family.update", { harvestDelayMs: 0 }, options);
		const ws = await connectTestWs(options);
		try {
			await ws.send("bot.create", {
				slug: "assistant",
				name: "Assistant",
				model: "faux/echo",
				tools: CODING_TOOLS,
			});
			await ws.send("chat.create", { botId: "assistant", key: "main" });
			await ws.send("turn.submit", {
				chatKey: "main",
				text: '[tool:write {"path":"edit.txt","content":"alpha beta"}]',
			});
			ws.events.length = 0;
			await ws.send("turn.submit", {
				chatKey: "main",
				text: '[tool:edit {"path":"edit.txt","edits":[{"oldText":"alpha","newText":"gamma"}]}]',
			});
			const edited = toolResults(ws.events)[0]?.payload as {
				toolName?: string;
				isError?: boolean;
			};
			expect(edited.toolName).toBe("edit");
			expect(edited.isError).toBe(false);
			ws.events.length = 0;
			await ws.send("turn.submit", {
				chatKey: "main",
				text: '[tool:read {"path":"edit.txt"}]',
			});
			const read = toolResults(ws.events)[0]?.payload as { content?: string };
			expect(read.content ?? "").toContain("gamma beta");
		} finally {
			ws.close();
		}
	});

	it("executes multi-tool round with mutating tools sequentially so write followed by bash succeeds in one turn", async () => {
		const options = scope("seq-tools");
		await sendRpc("family.update", { harvestDelayMs: 0 }, options);
		const ws = await connectTestWs(options);
		try {
			await ws.send("bot.create", {
				slug: "assistant",
				name: "Assistant",
				model: "faux/echo",
				tools: CODING_TOOLS,
			});
			await ws.send("chat.create", { botId: "assistant", key: "main" });
			await ws.send("turn.submit", {
				chatKey: "main",
				text: '[tool:write {"path":"disp.md","content":"hello world"}] [tool:bash {"command":"ls -ltr disp.md"}]',
			});
			const results = toolResults(ws.events);
			expect(results.length).toBe(2);
			const writeResult = results[0]?.payload as {
				toolName?: string;
				isError?: boolean;
			};
			const bashResult = results[1]?.payload as {
				toolName?: string;
				content?: string;
				isError?: boolean;
			};
			expect(writeResult.toolName).toBe("write");
			expect(writeResult.isError).toBe(false);
			expect(bashResult.toolName).toBe("bash");
			expect(bashResult.isError).toBe(false);
			expect(bashResult.content).toContain("disp.md");
		} finally {
			ws.close();
		}
	});

	it("shares the bot namespace across inheriting and explicitly bound chats on the same env, and isolates across envs", async () => {
		const options = scope("pin");
		await sendRpc("family.update", { harvestDelayMs: 0 }, options);
		const created = await sendRpc<{
			env: {
				envId: string;
				supportsConfinement: boolean;
				connection: { status: string };
			};
		}>(
			"account.toolsEnvs.create",
			{ kind: "just-bash", label: "Scratch", persist: true },
			options,
		);
		expect(created.frame.ok).toBe(true);
		const envId = created.frame.result?.env.envId ?? "";
		expect(envId.startsWith("jb_")).toBe(true);
		expect(created.frame.result?.env.supportsConfinement).toBe(true);
		expect(created.frame.result?.env.connection.status).toBe("connected");

		await sendRpc(
			"bot.create",
			{
				slug: "assistant",
				name: "Assistant",
				model: "faux/echo",
				tools: CODING_TOOLS,
			},
			options,
		);
		await sendRpc(
			"chat.create",
			{ botId: "assistant", key: "inherit" },
			options,
		);
		await sendRpc(
			"chat.create",
			{
				botId: "assistant",
				key: "pinned",
				toolsEnv: { enabled: true, binding: { envId } },
			},
			options,
		);
		await sendRpc(
			"chat.create",
			{
				botId: "assistant",
				key: "same-default",
				toolsEnv: { enabled: true, binding: { envId: "jb_default" } },
			},
			options,
		);

		const ws = await connectTestWs(options);
		try {
			await ws.send("turn.submit", {
				chatKey: "inherit",
				text: '[tool:write {"path":"bot-only.txt","content":"bot"}]',
			});
			await ws.send("turn.submit", {
				chatKey: "pinned",
				text: '[tool:write {"path":"chat-only.txt","content":"chat"}]',
			});
			ws.events.length = 0;
			// Pinned is in a separate envId, so it cannot see bot-only.txt from jb_default
			await ws.send("turn.submit", {
				chatKey: "pinned",
				text: '[tool:read {"path":"bot-only.txt"}]',
			});
			expect(toolIsError(ws.events)).toBe(true);
			ws.events.length = 0;
			// Inherit is in jb_default, so it cannot see chat-only.txt from envId
			await ws.send("turn.submit", {
				chatKey: "inherit",
				text: '[tool:read {"path":"chat-only.txt"}]',
			});
			expect(toolIsError(ws.events)).toBe(true);
			ws.events.length = 0;
			// Same-default is in jb_default for the same bot assistant, so it CAN see bot-only.txt
			await ws.send("turn.submit", {
				chatKey: "same-default",
				text: '[tool:read {"path":"bot-only.txt"}]',
			});
			expect(toolIsError(ws.events)).toBe(false);

			const again = await ws.send("turn.submit", {
				chatKey: "pinned",
				text: '[tool:read {"path":"chat-only.txt"}]',
			});
			expect(again.ok).toBe(true);
		} finally {
			ws.close();
		}

		// Pinned wrote to bot:assistant inside envId
		expect(
			await envStub(options.accountId, envId).namespaceBytes(
				"default",
				"bot:assistant",
			),
		).toBeGreaterThan(0);
		// Inherit and same-default wrote to bot:assistant inside jb_default
		expect(
			await envStub(options.accountId).namespaceBytes(
				"default",
				"bot:assistant",
			),
		).toBeGreaterThan(0);
		// Chat-scoped namespaces are disabled and never populated
		expect(
			await envStub(options.accountId, envId).namespaceBytes(
				"default",
				"chat:pinned",
			),
		).toBe(0);
		expect(
			await envStub(options.accountId).namespaceBytes(
				"default",
				"chat:same-default",
			),
		).toBe(0);
	});

	it("stays connected after a non-zero command and does not arm a recovery alarm", async () => {
		const options = scope("nonzero");
		await sendRpc("family.update", { harvestDelayMs: 0 }, options);
		await sendRpc(
			"bot.create",
			{
				slug: "assistant",
				name: "Assistant",
				model: "faux/echo",
				tools: CODING_TOOLS,
			},
			options,
		);
		await sendRpc("chat.create", { botId: "assistant", key: "main" }, options);
		const before = await sendRpc<{
			status: { nextWakeAt: number | null; toolsEnv?: { status?: string } };
		}>("turn.submit", { chatKey: "main", text: "/status" }, options);
		const ws = await connectTestWs(options);
		try {
			await ws.send("turn.submit", {
				chatKey: "main",
				text: '[tool:bash {"command":"exit 3"}]',
			});
		} finally {
			ws.close();
		}
		const after = await sendRpc<{
			status: {
				nextWakeAt: number | null;
				toolsEnv?: { status?: string; nextProbeAt?: number };
			};
		}>("turn.submit", { chatKey: "main", text: "/status" }, options);
		expect(after.frame.result?.status.toolsEnv?.status).toBe("connected");
		expect(after.frame.result?.status.toolsEnv).not.toHaveProperty(
			"nextProbeAt",
		);
		expect(after.frame.result?.status.nextWakeAt).toBe(
			before.frame.result?.status.nextWakeAt,
		);
		const tables = await envStub(options.accountId).listStorageTables();
		expect(tables).not.toContain("cadmus_env_connection");
	});

	it("gates bash when the default is cleared, tools omit coding tools, or the bot is off", async () => {
		const options = scope("gate");
		await sendRpc("family.update", { harvestDelayMs: 0 }, options);
		const cleared = await sendRpc(
			"account.update",
			{ defaultToolsEnv: null },
			options,
		);
		expect(cleared.frame.ok).toBe(true);
		const missing = await sendRpc(
			"bot.create",
			{
				slug: "needs-default",
				name: "Needs Default",
				model: "faux/echo",
				tools: CODING_TOOLS,
				toolsEnv: { enabled: true },
			},
			options,
		);
		expect(missing.frame.ok).toBe(false);
		expect(missing.frame.error?.code).toBe("tools_env_on_without_config");

		await sendRpc(
			"account.update",
			{ defaultToolsEnv: { envId: "jb_default" } },
			options,
		);
		const inherited = await sendRpc<{
			bot: { toolsEnv?: unknown };
			toolsEnvEnabled?: boolean;
			effectiveToolsEnv?: { envId?: string } | null;
			toolsEnvBindingSource?: string;
		}>(
			"bot.create",
			{
				slug: "inherits",
				name: "Inherits",
				model: "faux/echo",
				tools: CODING_TOOLS,
				toolsEnv: { enabled: true },
			},
			options,
		);
		expect(inherited.frame.ok).toBe(true);
		expect(inherited.frame.result?.bot.toolsEnv).toEqual({ enabled: true });
		const inheritedView = await sendRpc<{
			effectiveToolsEnv?: { envId?: string } | null;
			toolsEnvBindingSource?: string;
		}>("bot.get", { botId: "inherits" }, options);
		expect(inheritedView.frame.ok).toBe(true);
		expect(inheritedView.frame.result?.effectiveToolsEnv?.envId).toBe(
			"jb_default",
		);
		expect(inheritedView.frame.result?.toolsEnvBindingSource).toBe("account");

		await sendRpc("account.update", { defaultToolsEnv: null }, options);
		await sendRpc(
			"bot.create",
			{
				slug: "unguided",
				name: "Unguided",
				model: "faux/echo",
				tools: CODING_TOOLS,
			},
			options,
		);
		await sendRpc(
			"bot.create",
			{
				slug: "memory-only",
				name: "Memory",
				model: "faux/echo",
				tools: ["memory_read"],
			},
			options,
		);
		await sendRpc(
			"bot.create",
			{
				slug: "all-tools",
				name: "All",
				model: "faux/echo",
			},
			options,
		);
		await sendRpc(
			"chat.create",
			{
				botId: "memory-only",
				key: "memory-chat",
				toolsEnv: { enabled: true, binding: { envId: "jb_default" } },
			},
			options,
		);
		await sendRpc(
			"chat.create",
			{ botId: "unguided", key: "unguided-chat" },
			options,
		);
		await sendRpc(
			"chat.create",
			{ botId: "all-tools", key: "all-chat" },
			options,
		);

		const ws = await connectTestWs(options);
		try {
			for (const chatKey of ["unguided-chat", "memory-chat", "all-chat"]) {
				ws.events.length = 0;
				await ws.send("turn.submit", {
					chatKey,
					text: '[tool:bash {"command":"echo no"}]',
				});
				const payload = toolResults(ws.events)[0]?.payload as {
					isError?: boolean;
					content?: string;
				};
				expect(payload.isError).toBe(true);
				expect(payload.content ?? "").toMatch(
					/disabled|not available|No execution environment/,
				);
			}
		} finally {
			ws.close();
		}
	});

	it("offers coding tools on a chat pin when the bot is off, and not on a sibling that is off", async () => {
		const options = scope("tri");
		await sendRpc("family.update", { harvestDelayMs: 0 }, options);
		await sendRpc(
			"bot.create",
			{
				slug: "assistant",
				name: "Assistant",
				model: "faux/echo",
				tools: CODING_TOOLS,
				toolsEnv: {
					enabled: false,
					binding: { envId: "jb_default" },
				},
			},
			options,
		);
		await sendRpc(
			"chat.create",
			{
				botId: "assistant",
				key: "chat-on",
				toolsEnv: { enabled: true, binding: { envId: "jb_default" } },
			},
			options,
		);
		await sendRpc(
			"chat.create",
			{ botId: "assistant", key: "inherit-off" },
			options,
		);
		const ws = await connectTestWs(options);
		try {
			ws.events.length = 0;
			await ws.send("turn.submit", {
				chatKey: "chat-on",
				text: '[tool:bash {"command":"echo chat-on > /workspace/on.txt"}]',
			});
			expect(toolIsError(ws.events)).toBe(false);
			ws.events.length = 0;
			await ws.send("turn.submit", {
				chatKey: "inherit-off",
				text: '[tool:bash {"command":"echo no"}]',
			});
			expect(toolIsError(ws.events)).toBe(true);
		} finally {
			ws.close();
		}
		expect(
			await envStub(options.accountId).namespaceBytes(
				"default",
				"bot:assistant",
			),
		).toBeGreaterThan(0);
		expect(
			await envStub(options.accountId).namespaceBytes(
				"default",
				"chat:chat-on",
			),
		).toBe(0);

		const off = await sendRpc<{
			status: { toolsEnv: { enabled: boolean; status?: string } };
			text: string;
		}>("turn.submit", { chatKey: "inherit-off", text: "/status" }, options);
		expect(off.frame.result?.status.toolsEnv.enabled).toBe(false);
		expect(off.frame.result?.status.toolsEnv.status).toBeUndefined();
		expect(off.frame.result?.text).toContain("Tools env: off");

		const on = await sendRpc<{
			status: {
				toolsEnv: {
					enabled: boolean;
					status?: string;
					kind?: string;
					envId?: string;
				};
			};
			text: string;
		}>("turn.submit", { chatKey: "chat-on", text: "/status" }, options);
		expect(on.frame.result?.status.toolsEnv).toMatchObject({
			enabled: true,
			status: "connected",
			kind: "just-bash",
			envId: "jb_default",
		});
		expect(on.frame.result?.status.toolsEnv).not.toHaveProperty("nextProbeAt");
		expect(on.frame.result?.text).toContain(
			"Tools env: just-bash (jb_default, connected)",
		);
	});

	it("retains a file across off and on, and the next turn drops coding tools", async () => {
		const options = scope("toggle");
		await sendRpc("family.update", { harvestDelayMs: 0 }, options);
		await sendRpc(
			"bot.create",
			{
				slug: "assistant",
				name: "Assistant",
				model: "faux/echo",
				tools: CODING_TOOLS,
			},
			options,
		);
		await sendRpc(
			"chat.create",
			{
				botId: "assistant",
				key: "main",
				toolsEnv: { enabled: true, binding: { envId: "jb_default" } },
			},
			options,
		);
		await sendRpc(
			"chat.create",
			{ botId: "assistant", key: "sibling" },
			options,
		);
		const before = await sendRpc<{ status: { nextWakeAt: number | null } }>(
			"turn.submit",
			{ chatKey: "main", text: "/status" },
			options,
		);
		const ws = await connectTestWs(options);
		try {
			await ws.send("turn.submit", {
				chatKey: "main",
				text: '[tool:write {"path":"kept.txt","content":"kept"}]',
			});
			ws.events.length = 0;
			const running = ws.send("turn.submit", {
				chatKey: "main",
				text: '[tool:bash {"command":"sleep 1"}]',
			});
			await waitForEvent(ws.events, "turn.tool_call");
			const updated = await ws.send("chat.update", {
				chatKey: "main",
				toolsEnv: { enabled: false, binding: { envId: "jb_default" } },
			});
			expect(updated.ok).toBe(true);
			const finished = await running;
			expect(finished.ok).toBe(true);
			const slept = toolResults(ws.events).find((event) => {
				const payload = event.payload as { toolName?: string };
				return payload.toolName === "bash";
			});
			const sleptPayload = slept?.payload as { isError?: boolean } | undefined;
			expect(sleptPayload?.isError).toBe(false);

			ws.events.length = 0;
			await ws.send("turn.submit", {
				chatKey: "main",
				text: '[tool:bash {"command":"echo later"}]',
			});
			expect(toolIsError(ws.events)).toBe(true);

			ws.events.length = 0;
			await ws.send("turn.submit", {
				chatKey: "sibling",
				text: '[tool:bash {"command":"echo sibling"}]',
			});
			expect(toolIsError(ws.events)).toBe(false);
		} finally {
			ws.close();
		}
		const after = await sendRpc<{ status: { nextWakeAt: number | null } }>(
			"turn.submit",
			{ chatKey: "sibling", text: "/status" },
			options,
		);
		expect(after.frame.result?.status.nextWakeAt).toBe(
			before.frame.result?.status.nextWakeAt,
		);

		await sendRpc(
			"chat.update",
			{
				chatKey: "main",
				toolsEnv: { enabled: true, binding: { envId: "jb_default" } },
			},
			options,
		);
		const ws2 = await connectTestWs(options);
		try {
			ws2.events.length = 0;
			await ws2.send("turn.submit", {
				chatKey: "main",
				text: '[tool:read {"path":"kept.txt"}]',
			});
			const payload = toolResults(ws2.events)[0]?.payload as {
				isError?: boolean;
				content?: string;
			};
			expect(payload.isError).toBe(false);
			expect(payload.content ?? "").toContain("kept");
		} finally {
			ws2.close();
		}
	});

	it("rejects bad env writes and extra binding fields", async () => {
		const options = scope("reject");
		const confined = await sendRpc(
			"account.toolsEnvs.create",
			{ kind: "just-bash", confineToWorkspace: false },
			options,
		);
		expect(confined.frame.ok).toBe(false);
		expect(confined.frame.error?.code).toBe("confinement_required");
		const allowed = await sendRpc(
			"account.toolsEnvs.create",
			{ kind: "just-bash", confineToWorkspace: true, label: "Tight" },
			options,
		);
		expect(allowed.frame.ok).toBe(true);
		const daemon = await sendRpc(
			"account.toolsEnvs.create",
			{ kind: "local-daemon", label: "Laptop" },
			options,
		);
		expect(daemon.frame.ok).toBe(false);
		expect(daemon.frame.error?.code).toBe("invalid_tools_env");
		const extra = await sendRpc(
			"bot.create",
			{
				name: "Extra",
				model: "faux/echo",
				toolsEnv: {
					enabled: true,
					binding: { envId: "jb_default", persist: true },
				},
			},
			options,
		);
		expect(extra.frame.ok).toBe(false);
		expect(extra.frame.error?.code).toBe("invalid_command");

		const listed = await sendRpc<{
			default: { envId: string } | null;
			envs: Array<{
				envId: string;
				supportsConfinement: boolean;
				kind: string;
			}>;
		}>("account.toolsEnvs.list", {}, options);
		expect(listed.frame.result?.default).toEqual({ envId: "jb_default" });
		const builtin = listed.frame.result?.envs.find(
			(row) => row.envId === "jb_default",
		);
		expect(builtin).toMatchObject({
			kind: "just-bash",
			supportsConfinement: true,
		});
	});

	it("isolates families until sharedWorkspace is set, including the byte cap", async () => {
		const accountId = uniqueAccountId("env-share");
		const alpha = { accountId, familyId: "default" };
		await sendRpc("family.update", { harvestDelayMs: 0 }, alpha);
		const createdFamily = await sendRpc(
			"family.create",
			{ familyId: "beta", name: "Beta" },
			alpha,
		);
		expect(createdFamily.frame.ok).toBe(true);
		const beta = { accountId, familyId: "beta" };
		await sendRpc("family.update", { harvestDelayMs: 0 }, beta);

		for (const options of [alpha, beta]) {
			await sendRpc(
				"bot.create",
				{
					slug: "assistant",
					name: "Assistant",
					model: "faux/echo",
					tools: CODING_TOOLS,
				},
				options,
			);
			await sendRpc(
				"chat.create",
				{ botId: "assistant", key: "main" },
				options,
			);
		}
		const wsA = await connectTestWs(alpha);
		const wsB = await connectTestWs(beta);
		try {
			await wsA.send("turn.submit", {
				chatKey: "main",
				text: '[tool:write {"path":"private.txt","content":"alpha"}]',
			});
			wsB.events.length = 0;
			await wsB.send("turn.submit", {
				chatKey: "main",
				text: '[tool:read {"path":"private.txt"}]',
			});
			expect(toolIsError(wsB.events)).toBe(true);
		} finally {
			wsA.close();
			wsB.close();
		}

		const five = new Uint8Array(5 * 1024 * 1024);
		const stub = envStub(accountId);
		const { createProxyExecutionEnv } = await import(
			"../packages/worker/src/tools-env/proxy-env.js"
		);
		const { BACKGROUND_CONTEXT } = await import(
			"@earendil-works/chord/context"
		);
		const proxyFor = (familyId: string) =>
			createProxyExecutionEnv({
				stub,
				id: `just-bash:${accountId}:jb_default:${familyId}:bot:assistant`,
				call: {
					storageFamilyId: familyId,
					scope: "bot:assistant",
					botId: "assistant",
					chatKey: "",
					usageFamilyId: familyId,
					persist: true,
				},
			});
		expect(
			(await proxyFor("default").writeFile("a.bin", five, BACKGROUND_CONTEXT))
				.ok,
		).toBe(true);
		expect(
			(await proxyFor("beta").writeFile("b.bin", five, BACKGROUND_CONTEXT)).ok,
		).toBe(true);
		const overflow = await proxyFor("default").writeFile(
			"c.bin",
			five,
			BACKGROUND_CONTEXT,
		);
		expect(overflow.ok).toBe(false);
		expect(
			(await proxyFor("beta").writeFile("ok.txt", "still", BACKGROUND_CONTEXT))
				.ok,
		).toBe(true);

		const shared = await sendRpc<{ env: { envId: string } }>(
			"account.toolsEnvs.create",
			{
				kind: "just-bash",
				sharedWorkspace: true,
				persist: true,
				label: "Shared",
			},
			alpha,
		);
		const sharedId = shared.frame.result?.env.envId ?? "";
		for (const options of [alpha, beta]) {
			const updated = await sendRpc(
				"bot.update",
				{
					botId: "assistant",
					toolsEnv: { enabled: true, binding: { envId: sharedId } },
				},
				options,
			);
			expect(updated.frame.ok).toBe(true);
		}
		const wsA2 = await connectTestWs(alpha);
		const wsB2 = await connectTestWs(beta);
		try {
			await wsA2.send("turn.submit", {
				chatKey: "main",
				text: '[tool:write {"path":"shared.txt","content":"both"}]',
			});
			wsB2.events.length = 0;
			await wsB2.send("turn.submit", {
				chatKey: "main",
				text: '[tool:read {"path":"shared.txt"}]',
			});
			const payload = toolResults(wsB2.events)[0]?.payload as {
				isError?: boolean;
				content?: string;
			};
			expect(payload.isError).toBe(false);
			expect(payload.content ?? "").toContain("both");
		} finally {
			wsA2.close();
			wsB2.close();
		}

		const sharedStub = envStub(accountId, sharedId);
		expect(
			await sharedStub.namespaceBytes("", "bot:assistant"),
		).toBeGreaterThan(0);
		const fiveShared = new Uint8Array(5 * 1024 * 1024);
		fiveShared.fill(9);
		const sharedProxy = (usageFamilyId: string) =>
			createProxyExecutionEnv({
				stub: sharedStub,
				id: `just-bash:${accountId}:${sharedId}:shared:bot:assistant`,
				call: {
					storageFamilyId: "",
					scope: "bot:assistant",
					botId: "assistant",
					chatKey: "",
					usageFamilyId,
					persist: true,
				},
			});
		expect(
			(
				await sharedProxy("default").writeFile(
					"a.bin",
					fiveShared,
					BACKGROUND_CONTEXT,
				)
			).ok,
		).toBe(true);
		const sharedOverflow = await sharedProxy("beta").writeFile(
			"b.bin",
			fiveShared,
			BACKGROUND_CONTEXT,
		);
		expect(sharedOverflow.ok).toBe(false);
		if (!sharedOverflow.ok) expect(sharedOverflow.error.code).toBe("invalid");
		const flipped = await sendRpc(
			"account.toolsEnvs.update",
			{ envId: sharedId, sharedWorkspace: false },
			alpha,
		);
		expect(flipped.frame.ok).toBe(true);
		expect(await sharedStub.namespaceBytes("", "bot:assistant")).toBe(0);
		const wsA3 = await connectTestWs(alpha);
		try {
			wsA3.events.length = 0;
			await wsA3.send("turn.submit", {
				chatKey: "main",
				text: '[tool:read {"path":"shared.txt"}]',
			});
			expect(toolIsError(wsA3.events)).toBe(true);
		} finally {
			wsA3.close();
		}
	}, 60_000);

	it("counts usage per family and records application errors without disconnecting", async () => {
		const accountId = uniqueAccountId("env-usage");
		const alpha = { accountId, familyId: "default" };
		await sendRpc("family.update", { harvestDelayMs: 0 }, alpha);
		await sendRpc("family.create", { familyId: "beta", name: "Beta" }, alpha);
		const beta = { accountId, familyId: "beta" };
		await sendRpc("family.update", { harvestDelayMs: 0 }, beta);
		for (const options of [alpha, beta]) {
			await sendRpc(
				"bot.create",
				{
					slug: "assistant",
					name: "Assistant",
					model: "faux/echo",
					tools: CODING_TOOLS,
				},
				options,
			);
			await sendRpc(
				"chat.create",
				{ botId: "assistant", key: "main" },
				options,
			);
		}
		const ws = await connectTestWs(alpha);
		try {
			await ws.send("turn.submit", {
				chatKey: "main",
				text: '[tool:write {"path":"usage.txt","content":"bytes"}]',
			});
			await ws.send("turn.submit", {
				chatKey: "main",
				text: '[tool:bash {"command":"echo ran"}]',
			});
			await ws.send("turn.submit", {
				chatKey: "main",
				text: '[tool:read {"path":"missing.txt"}]',
			});
		} finally {
			ws.close();
		}
		const rows = await envStub(accountId).readUsage();
		const mine = rows.filter(
			(row) => row.familyId === "default" && row.botId === "assistant",
		);
		const other = rows.filter((row) => row.familyId === "beta");
		for (const grain of ["hour", "day"]) {
			const grainRows = mine.filter((row) => row.grain === grain);
			expect(grainRows.reduce((sum, row) => sum + row.ops, 0)).toBeGreaterThan(
				0,
			);
			expect(
				grainRows.reduce((sum, row) => sum + row.bytesWritten, 0),
			).toBeGreaterThan(0);
			const execRows = grainRows.filter((row) => row.opKind === "exec");
			expect(execRows.reduce((sum, row) => sum + row.ops, 0)).toBeGreaterThan(
				0,
			);
			// just-bash exec is in-memory. workerd Date.now() only advances across
			// I/O and has millisecond granularity, so a fast `echo` can record 0 ms.
			// That is a correct measurement; exec ops already count the command.
			expect(
				execRows.reduce((sum, row) => sum + row.bashRuntimeMs, 0),
			).toBeGreaterThanOrEqual(0);
			expect(
				grainRows.reduce((sum, row) => sum + row.errors, 0),
			).toBeGreaterThan(0);
		}
		expect(other.reduce((sum, row) => sum + row.ops, 0)).toBe(0);
		const status = await sendRpc<{
			status: { toolsEnv?: { status?: string } };
		}>("turn.submit", { chatKey: "main", text: "/status" }, alpha);
		expect(status.frame.result?.status.toolsEnv?.status).toBe("connected");
	});

	it("runs a schedule fork on the chat namespace and omits coding tools from harvest", async () => {
		const options = scope("fork");
		await sendRpc("family.update", { harvestDelayMs: 0 }, options);
		await sendRpc(
			"bot.create",
			{
				slug: "assistant",
				name: "Assistant",
				model: "faux/echo",
				tools: [...CODING_TOOLS, "memory_update", "knowledge_update"],
			},
			options,
		);
		await sendRpc(
			"chat.create",
			{
				botId: "assistant",
				key: "pinned",
				toolsEnv: { enabled: true, binding: { envId: "jb_default" } },
			},
			options,
		);
		await sendRpc(
			"turn.submit",
			{ chatKey: "pinned", text: "hello before the fork" },
			options,
		);
		const scheduled = await sendRpc(
			"schedule.create",
			{
				id: "fork-bash",
				botId: "assistant",
				name: "Fork bash",
				kind: "absolute",
				input: Date.now() - 1000,
				text: '[tool:bash {"command":"echo forked > /workspace/forked.txt"}]',
				target: { mode: "fork", chatKey: "pinned" },
			},
			options,
		);
		expect(scheduled.frame.ok).toBe(true);
		await runDurableObjectAlarm(familyStub(options.accountId));
		const routes = await familyStub(options.accountId).listConversationRoutes(
			"pinned",
		);
		expect(routes.length).toBeGreaterThanOrEqual(2);
		expect(routes.every((route) => route.toolsEnvEnabled)).toBe(true);

		const ws = await connectTestWs(options);
		try {
			ws.events.length = 0;
			await ws.send("turn.submit", {
				chatKey: "pinned",
				text: '[tool:read {"path":"forked.txt"}]',
			});
			const payload = toolResults(ws.events)[0]?.payload as {
				isError?: boolean;
				content?: string;
			};
			expect(payload.isError).toBe(false);
			expect(payload.content ?? "").toContain("forked");
		} finally {
			ws.close();
		}
		expect(
			await envStub(options.accountId).namespaceBytes(
				"default",
				"bot:assistant",
			),
		).toBeGreaterThan(0);
		expect(
			await envStub(options.accountId).namespaceBytes("default", "chat:pinned"),
		).toBe(0);

		await sendRpc("family.update", { harvestDelayMs: 5000 }, options);
		await sendRpc(
			"turn.submit",
			{ chatKey: "pinned", text: "please harvest this" },
			options,
		);
		await sendRpc(
			"schedule.update",
			{
				id: "harvest:pinned",
				kind: "absolute",
				input: Date.now() - 1000,
				text: '[tool:bash {"command":"echo harvested > /workspace/harvested.txt"}]',
			},
			options,
		);
		const beforeHarvest = await familyStub(
			options.accountId,
		).listConversationRoutes("pinned");
		await runDurableObjectAlarm(familyStub(options.accountId));
		let afterHarvest = await familyStub(
			options.accountId,
		).listConversationRoutes("pinned");
		const deadline = Date.now() + 2_000;
		while (
			afterHarvest.length !== beforeHarvest.length &&
			Date.now() < deadline
		) {
			await new Promise((resolve) => setTimeout(resolve, 25));
			afterHarvest = await familyStub(options.accountId).listConversationRoutes(
				"pinned",
			);
		}
		expect(afterHarvest).toHaveLength(beforeHarvest.length);
		expect(afterHarvest.every((route) => route.toolsEnvEnabled)).toBe(true);
		const ws2 = await connectTestWs(options);
		try {
			ws2.events.length = 0;
			await ws2.send("turn.submit", {
				chatKey: "pinned",
				text: '[tool:read {"path":"harvested.txt"}]',
			});
			expect(toolIsError(ws2.events)).toBe(true);
		} finally {
			ws2.close();
		}
	});

	it("pins tools env from create_bot and clears a chat pin back to the bot namespace", async () => {
		const options = scope("create-bot");
		await sendRpc("family.update", { harvestDelayMs: 0 }, options);
		await sendRpc(
			"bot.create",
			{
				slug: "caller",
				name: "Caller",
				model: "faux/echo",
				tools: ["create_bot", ...CODING_TOOLS],
			},
			options,
		);
		await sendRpc(
			"chat.create",
			{ botId: "caller", key: "caller-chat" },
			options,
		);
		const ws = await connectTestWs(options);
		try {
			await ws.send("turn.submit", {
				chatKey: "caller-chat",
				text: '[tool:create_bot {"name":"Pinned","slug":"pinned-peer","tools":["bash"],"toolsEnv":{"enabled":true,"binding":{"envId":"jb_default"}}}]',
			});
			await ws.send("turn.submit", {
				chatKey: "caller-chat",
				text: '[tool:create_bot {"name":"Off","slug":"off-peer","tools":["bash"],"toolsEnv":{"enabled":false}}]',
			});
			await ws.send("turn.submit", {
				chatKey: "caller-chat",
				text: '[tool:create_bot {"name":"Inherit","slug":"inherit-peer","tools":["bash"]}]',
			});
		} finally {
			ws.close();
		}
		const pinned = await sendRpc<{
			bot: {
				toolsEnv?: { enabled?: boolean; binding?: { envId?: string } } | null;
			};
		}>("bot.get", { botId: "pinned-peer" }, options);
		expect(pinned.frame.result?.bot.toolsEnv).toEqual({
			enabled: true,
			binding: { envId: "jb_default" },
		});
		const off = await sendRpc<{
			bot: { toolsEnv?: { enabled?: boolean } | null };
			toolsEnvEnabled?: boolean;
		}>("bot.get", { botId: "off-peer" }, options);
		expect(off.frame.result?.bot.toolsEnv).toEqual({ enabled: false });
		expect(off.frame.result?.toolsEnvEnabled).toBe(false);
		const inherited = await sendRpc<{
			bot: { toolsEnv?: unknown };
			toolsEnvBindingSource?: string;
		}>("bot.get", { botId: "inherit-peer" }, options);
		expect(inherited.frame.result?.bot.toolsEnv).toBeUndefined();
		expect(inherited.frame.result?.toolsEnvBindingSource).toBe("account");

		await sendRpc(
			"chat.create",
			{
				botId: "caller",
				key: "pinned-chat",
				toolsEnv: { enabled: true, binding: { envId: "jb_default" } },
			},
			options,
		);
		const ws2 = await connectTestWs(options);
		try {
			await ws2.send("turn.submit", {
				chatKey: "caller-chat",
				text: '[tool:write {"path":"bot-file.txt","content":"bot-body"}]',
			});
			await ws2.send("turn.submit", {
				chatKey: "pinned-chat",
				text: '[tool:write {"path":"chat-file.txt","content":"chat-body"}]',
			});
			const cleared = await ws2.send("chat.update", {
				chatKey: "pinned-chat",
				toolsEnv: null,
			});
			expect(cleared.ok).toBe(true);
			ws2.events.length = 0;
			await ws2.send("turn.submit", {
				chatKey: "pinned-chat",
				text: '[tool:read {"path":"bot-file.txt"}]',
			});
			const payload = toolResults(ws2.events)[0]?.payload as {
				isError?: boolean;
				content?: string;
			};
			expect(payload.isError).toBe(false);
			expect(payload.content ?? "").toContain("bot-body");
		} finally {
			ws2.close();
		}
		expect(
			await envStub(options.accountId).namespaceBytes(
				"default",
				"chat:pinned-chat",
			),
		).toBe(0);
	});

	it("drops the unused store when persist flips and ignores persist on bot.update", async () => {
		const options = scope("persist");
		await sendRpc("family.update", { harvestDelayMs: 0 }, options);
		const created = await sendRpc<{ env: { envId: string; persist: boolean } }>(
			"account.toolsEnvs.create",
			{ kind: "just-bash", persist: true, label: "Disk" },
			options,
		);
		const envId = created.frame.result?.env.envId ?? "";
		await sendRpc(
			"bot.create",
			{
				slug: "assistant",
				name: "Assistant",
				model: "faux/echo",
				tools: CODING_TOOLS,
				toolsEnv: { enabled: true, binding: { envId } },
			},
			options,
		);
		await sendRpc("chat.create", { botId: "assistant", key: "main" }, options);
		const ws = await connectTestWs(options);
		try {
			await ws.send("turn.submit", {
				chatKey: "main",
				text: '[tool:write {"path":"disk.txt","content":"on-disk"}]',
			});
		} finally {
			ws.close();
		}
		const stub = envStub(options.accountId, envId);
		expect(
			await stub.namespaceBytes("default", "bot:assistant"),
		).toBeGreaterThan(0);
		const flipped = await sendRpc(
			"account.toolsEnvs.update",
			{ envId, persist: false },
			options,
		);
		expect(flipped.frame.ok).toBe(true);
		await stub.dropCachedNamespaces();
		expect(await stub.namespaceBytes("default", "bot:assistant")).toBe(0);

		const botUpdate = await sendRpc(
			"bot.update",
			{ botId: "assistant", name: "Renamed" },
			options,
		);
		expect(botUpdate.frame.ok).toBe(true);
		const persistOnBinding = await sendRpc(
			"bot.update",
			{
				botId: "assistant",
				toolsEnv: {
					enabled: true,
					binding: { envId, persist: true },
				},
			},
			options,
		);
		expect(persistOnBinding.frame.ok).toBe(false);
		expect(persistOnBinding.frame.error?.code).toBe("invalid_command");
		const persistField = await sendRpc(
			"bot.update",
			{ botId: "assistant", persist: true },
			options,
		);
		if (!persistField.frame.ok) {
			expect(persistField.frame.error?.code).toBe("invalid_command");
		}
		const listed = await sendRpc<{
			envs: Array<{ envId: string; persist: boolean }>;
		}>("account.toolsEnvs.list", {}, options);
		expect(
			listed.frame.result?.envs.find((row) => row.envId === envId)?.persist,
		).toBe(false);

		const ws2 = await connectTestWs(options);
		try {
			await ws2.send("turn.submit", {
				chatKey: "main",
				text: '[tool:write {"path":"memory.txt","content":"ram"}]',
			});
		} finally {
			ws2.close();
		}
		expect(
			await stub.namespaceBytes("default", "bot:assistant"),
		).toBeGreaterThan(0);
		await stub.dropCachedNamespaces();
		expect(await stub.namespaceBytes("default", "bot:assistant")).toBe(0);

		await sendRpc(
			"account.toolsEnvs.update",
			{ envId, persist: true },
			options,
		);
		const ws3 = await connectTestWs(options);
		try {
			await ws3.send("turn.submit", {
				chatKey: "main",
				text: '[tool:write {"path":"again.txt","content":"stored"}]',
			});
		} finally {
			ws3.close();
		}
		await stub.dropCachedNamespaces();
		expect(
			await stub.namespaceBytes("default", "bot:assistant"),
		).toBeGreaterThan(0);
	});

	it("deletes only the removed bot's namespaces, including its chats", async () => {
		const options = scope("botdel");
		await sendRpc("family.update", { harvestDelayMs: 0 }, options);
		const created = await sendRpc<{ env: { envId: string } }>(
			"account.toolsEnvs.create",
			{ kind: "just-bash", persist: false, label: "Ram" },
			options,
		);
		const envId = created.frame.result?.env.envId ?? "";
		for (const slug of ["keeper", "doomed"]) {
			await sendRpc(
				"bot.create",
				{
					slug,
					name: slug,
					model: "faux/echo",
					tools: CODING_TOOLS,
					toolsEnv: { enabled: true, binding: { envId } },
				},
				options,
			);
		}
		await sendRpc(
			"chat.create",
			{ botId: "keeper", key: "keep-main" },
			options,
		);
		await sendRpc(
			"chat.create",
			{ botId: "doomed", key: "doom-main" },
			options,
		);
		await sendRpc(
			"chat.create",
			{
				botId: "doomed",
				key: "doom-pin",
				toolsEnv: { enabled: true, binding: { envId } },
			},
			options,
		);
		const ws = await connectTestWs(options);
		try {
			await ws.send("turn.submit", {
				chatKey: "keep-main",
				text: '[tool:write {"path":"keep.txt","content":"alive"}]',
			});
			await ws.send("turn.submit", {
				chatKey: "doom-main",
				text: '[tool:write {"path":"doom.txt","content":"gone"}]',
			});
			await ws.send("turn.submit", {
				chatKey: "doom-pin",
				text: '[tool:write {"path":"pin.txt","content":"gone"}]',
			});
		} finally {
			ws.close();
		}
		const stub = envStub(options.accountId, envId);
		expect(await stub.namespaceBytes("default", "bot:keeper")).toBeGreaterThan(
			0,
		);
		expect(await stub.namespaceBytes("default", "bot:doomed")).toBeGreaterThan(
			0,
		);
		expect(await stub.namespaceBytes("default", "chat:doom-pin")).toBe(0);

		const deleted = await sendRpc("bot.delete", { botId: "doomed" }, options);
		expect(deleted.frame.ok).toBe(true);
		expect(await stub.namespaceBytes("default", "bot:doomed")).toBe(0);
		expect(await stub.namespaceBytes("default", "chat:doom-pin")).toBe(0);
		expect(await stub.namespaceBytes("default", "bot:keeper")).toBeGreaterThan(
			0,
		);

		const ws2 = await connectTestWs(options);
		try {
			ws2.events.length = 0;
			await ws2.send("turn.submit", {
				chatKey: "keep-main",
				text: '[tool:read {"path":"keep.txt"}]',
			});
			const payload = toolResults(ws2.events)[0]?.payload as {
				isError?: boolean;
				content?: string;
			};
			expect(payload.isError).toBe(false);
			expect(payload.content ?? "").toContain("alive");
		} finally {
			ws2.close();
		}
	});

	it("does not clear a prefix-sharing account default when deleting another env", async () => {
		const options = scope("d1like");
		await sendRpc("family.update", { harvestDelayMs: 0 }, options);
		await env.CADMUS_ADMIN_DB.prepare(
			`INSERT INTO cadmus_tools_envs (
          account_id, env_id, kind, label, workspace_path, persist,
          confine_to_workspace, shared_workspace, updated_at
        ) VALUES (?1, 'jb_default_extra', 'just-bash', 'Extra', NULL, 1, 1, 0, ?2)`,
		)
			.bind(options.accountId, Date.now())
			.run();
		const setDefault = await sendRpc(
			"account.update",
			{ defaultToolsEnv: { envId: "jb_default_extra" } },
			options,
		);
		expect(setDefault.frame.ok).toBe(true);
		const deleted = await sendRpc(
			"account.toolsEnvs.delete",
			{ envId: "jb_default" },
			options,
		);
		expect(deleted.frame.ok).toBe(true);
		const listed = await sendRpc<{ default: { envId: string } | null }>(
			"account.toolsEnvs.list",
			{},
			options,
		);
		expect(listed.frame.result?.default).toEqual({
			envId: "jb_default_extra",
		});
	});

	it("clears bot.tools on null, leaves them unchanged when omitted, and replaces them with a list or []", async () => {
		const options = scope("tools-update");
		const allowlist = ["memory_read", "memory_update", ...CODING_TOOLS];
		await sendRpc("family.update", { harvestDelayMs: 0 }, options);
		await sendRpc(
			"bot.create",
			{
				slug: "assistant",
				name: "Assistant",
				model: "faux/echo",
				tools: allowlist,
			},
			options,
		);
		await sendRpc("chat.create", { botId: "assistant", key: "main" }, options);
		const created = await sendRpc<{ bot: { tools?: string[] } }>(
			"bot.create",
			{
				slug: "empty",
				name: "Empty",
				model: "faux/echo",
				tools: [],
			},
			options,
		);
		expect(created.frame.ok).toBe(true);
		expect(created.frame.result?.bot.tools).toEqual([]);
		await sendRpc("chat.create", { botId: "empty", key: "empty" }, options);

		const ws = await connectTestWs(options);
		const turn = async (chatKey: string, text: string) => {
			ws.events.length = 0;
			const submitted = await ws.send<{ reply?: string }>("turn.submit", {
				chatKey,
				text,
			});
			expect(submitted.ok).toBe(true);
			const payload = toolResults(ws.events)[0]?.payload as
				| { isError?: boolean; content?: string }
				| undefined;
			return payload;
		};
		const expectBlocked = (
			payload: { isError?: boolean; content?: string } | undefined,
		) => {
			expect(payload?.isError).toBe(true);
			expect(payload?.content ?? "").toMatch(/not available|disabled/);
		};
		try {
			expect(
				(await turn("main", '[tool:bash {"command":"echo hi"}]'))?.isError,
			).toBe(false);
			expect(
				(
					await turn(
						"main",
						'[tool:memory_update {"content":"kept","expectedVersion":0}]',
					)
				)?.isError,
			).toBe(false);

			const nulled = await sendRpc<{ bot: { tools?: string[] } }>(
				"bot.update",
				{ botId: "assistant", tools: null },
				options,
			);
			expect(nulled.frame.ok).toBe(true);
			expect(nulled.frame.result?.bot.tools).toBeUndefined();
			const afterNull = await sendRpc<{ bot: { tools?: string[] } }>(
				"bot.get",
				{ botId: "assistant" },
				options,
			);
			expect(afterNull.frame.result?.bot.tools).toBeUndefined();
			const defaultStatus = await sendRpc<{
				status: { tools: string[] | "all" };
			}>("chat.status", { chatKey: "main" }, options);
			expect(defaultStatus.frame.result?.status.tools).toBe("all");
			expect((await turn("main", "[tool:memory_read {}]"))?.isError).toBe(
				false,
			);
			const restoredKnowledge = await turn(
				"main",
				'[tool:knowledge_update {"slug":"restored","description":"back","body":"default","expectedVersion":0}]',
			);
			expect(restoredKnowledge?.isError).toBe(false);
			expectBlocked(await turn("main", '[tool:bash {"command":"echo no"}]'));

			const renamed = await sendRpc<{
				bot: { name: string; tools?: string[] };
			}>("bot.update", { botId: "assistant", name: "Renamed" }, options);
			expect(renamed.frame.ok).toBe(true);
			expect(renamed.frame.result?.bot.name).toBe("Renamed");
			expect(renamed.frame.result?.bot.tools).toBeUndefined();

			const replaced = await sendRpc<{ bot: { tools?: string[] } }>(
				"bot.update",
				{ botId: "assistant", tools: ["memory_read"] },
				options,
			);
			expect(replaced.frame.ok).toBe(true);
			expect(replaced.frame.result?.bot.tools).toEqual(["memory_read"]);
			expectBlocked(
				await turn(
					"main",
					'[tool:memory_update {"content":"nope","expectedVersion":1}]',
				),
			);
			expectBlocked(await turn("main", '[tool:bash {"command":"echo no"}]'));
			expect((await turn("main", "[tool:memory_read {}]"))?.isError).toBe(
				false,
			);
			const memory = await sendRpc<{ version: number; content: string }>(
				"file.read",
				{ botId: "assistant", path: "MEMORY.md" },
				options,
			);
			expect(memory.frame.result?.version).toBe(1);
			expect(memory.frame.result?.content).toBe("kept");

			const cleared = await sendRpc<{ bot: { tools?: string[] } }>(
				"bot.update",
				{ botId: "assistant", tools: [] },
				options,
			);
			expect(cleared.frame.ok).toBe(true);
			expect(cleared.frame.result?.bot.tools).toEqual([]);
			const afterClear = await sendRpc<{ bot: { tools?: string[] } }>(
				"bot.get",
				{ botId: "assistant" },
				options,
			);
			expect(afterClear.frame.result?.bot.tools).toEqual([]);
			expectBlocked(await turn("main", "[tool:memory_read {}]"));
			expectBlocked(await turn("main", '[tool:bash {"command":"echo no"}]'));
			expectBlocked(await turn("empty", "[tool:memory_read {}]"));
			expectBlocked(await turn("empty", '[tool:bash {"command":"echo no"}]'));
		} finally {
			ws.close();
		}
	});

	it("blocks coding tools from writing, editing, or reading virtual files like memory.md", async () => {
		const options = scope("virtual-block");
		await sendRpc("family.update", { harvestDelayMs: 0 }, options);
		await sendRpc(
			"account.toolsEnvs.update",
			{ envId: "jb_default", enabled: true },
			options,
		);
		await sendRpc(
			"bot.create",
			{
				slug: "assistant",
				name: "Assistant",
				model: "faux/echo",
				tools: [...CODING_TOOLS, "memory_update", "memory_read"],
				toolsEnv: { enabled: true, binding: { envId: "jb_default" } },
			},
			options,
		);
		await sendRpc("chat.create", { botId: "assistant", key: "main" }, options);

		const ws = await connectTestWs(options);
		try {
			const turn = async (text: string) => {
				ws.events.length = 0;
				const submitted = await ws.send<{ reply?: string }>("turn.submit", {
					chatKey: "main",
					text,
				});
				expect(submitted.ok).toBe(true);
				const payload = toolResults(ws.events)[0]?.payload as
					| { isError?: boolean; content?: string }
					| undefined;
				return payload;
			};

			const blockedWrite = await turn(
				'Save this [tool:write {"path":"memory.md","content":"hello"}]',
			);
			expect(blockedWrite?.isError).toBe(true);
			expect(blockedWrite?.content ?? "").toContain("virtual entity");
			expect(blockedWrite?.content ?? "").toContain("memory_update");

			const blockedEdit = await turn(
				'Edit this [tool:edit {"path":"MEMORY.md","edits":[{"oldText":"a","newText":"b"}]}]',
			);
			expect(blockedEdit?.isError).toBe(true);
			expect(blockedEdit?.content ?? "").toContain("virtual entity");

			const blockedKnowledge = await turn(
				'Edit knowledge [tool:write {"path":"knowledge/test.md","content":"body"}]',
			);
			expect(blockedKnowledge?.isError).toBe(true);
			expect(blockedKnowledge?.content ?? "").toContain("virtual entity");
			expect(blockedKnowledge?.content ?? "").toContain("knowledge_update");
		} finally {
			ws.close();
		}
	});
});
