import {
	env,
	runDurableObjectAlarm,
	runInDurableObject,
	SELF,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ServerEvent } from "../src/protocol.js";
import { resolveHeartbeatMs } from "../src/tools-env/wire.js";
import {
	connectTestWs,
	type RpcOptions,
	sendRpc,
	uniqueAccountId,
} from "./helpers.js";
import { ScriptedDaemon } from "./scripted-daemon.js";

const CODING_TOOLS = [
	"bash",
	"read",
	"write",
	"edit",
	"memory_update",
	"knowledge_update",
];

function scope(
	label: string,
	familyId = "default",
): RpcOptions & { accountId: string; familyId: string } {
	return {
		accountId: uniqueAccountId(`ws-do-${label}`),
		familyId,
	};
}

function toolResults(events: ServerEvent[]) {
	return events.filter((event) => event.type === "turn.tool_result");
}

async function registerDaemon(
	options: RpcOptions,
	input: {
		persist?: boolean;
		confineToWorkspace?: boolean;
	} = {},
): Promise<{ envId: string; token: string }> {
	const created = await sendRpc<{
		env: { envId: string };
		pairingToken?: string;
	}>(
		"account.toolsEnvs.create",
		{
			kind: "local-daemon",
			persist: input.persist ?? true,
			confineToWorkspace: input.confineToWorkspace ?? false,
			baseUrl: "http://example.com",
		},
		options,
	);
	expect(created.frame.ok).toBe(true);
	const envId = created.frame.result?.env.envId ?? "";
	const pairingToken = created.frame.result?.pairingToken ?? "";
	const pairResponse = await SELF.fetch("http://example.com/tools-env/pair", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ pairingToken, name: "Rig" }),
	});
	expect(pairResponse.status).toBe(200);
	const redeemed = (await pairResponse.json()) as { token: string };
	return { envId, token: redeemed.token };
}

function envStub(accountId: string, envId: string) {
	return env.CADMUS_ENV.getByName(`env:${accountId}:${envId}`);
}

function familyStub(accountId: string, familyId = "default") {
	return env.CADMUS_BOT_FAMILY.get(
		env.CADMUS_BOT_FAMILY.idFromName(`cadmus:${accountId}:${familyId}`),
	);
}

async function toolTurn(
	options: RpcOptions,
	chatKey: string,
	tool: string,
	args: Record<string, unknown>,
) {
	const ws = await connectTestWs(options);
	try {
		ws.events.length = 0;
		const turn = await ws.send("turn.submit", {
			chatKey,
			text: `[tool:${tool} ${JSON.stringify(args)}]`,
		});
		const payload = toolResults(ws.events)[0]?.payload as
			| { toolName?: string; isError?: boolean; content?: string }
			| undefined;
		return { turnOk: turn.ok, payload, events: [...ws.events] };
	} finally {
		ws.close();
	}
}

async function connection(accountId: string, envId: string) {
	return envStub(accountId, envId).getConnection("local-daemon");
}

async function waitFor(
	check: () => boolean | Promise<boolean>,
	timeoutMs: number,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await check()) return true;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	return check();
}

const HEARTBEAT_MS_UNDER_TEST = resolveHeartbeatMs(env.CADMUS_HEARTBEAT_MS);
const HEARTBEAT_QUIET_MS = Math.max(2_000, HEARTBEAT_MS_UNDER_TEST * 4);
const HEARTBEAT_TEST_BUDGET_MS =
	HEARTBEAT_QUIET_MS * 2 + HEARTBEAT_MS_UNDER_TEST * 8 + 20_000;

describe("daemon websocket DO internals (generation, alarms, fork routes, heartbeats)", () => {
	it("bumps generation on reconnect and ignores a stale close", async () => {
		const options = scope("gen");
		await sendRpc("family.update", { harvestDelayMs: 0 }, options);
		const secret = await registerDaemon(options);
		const envId = secret.envId;
		await sendRpc(
			"bot.create",
			{
				slug: "assistant",
				name: "Assistant",
				model: "faux/echo",
				tools: ["bash"],
				toolsEnv: { enabled: true, binding: { envId } },
			},
			options,
		);
		await sendRpc("chat.create", { botId: "assistant", key: "main" }, options);
		const first = await ScriptedDaemon.upgrade({ token: secret.token, envId });
		const older = first.peer;
		if (!older) throw new Error("missing peer");
		let release: () => void = () => {};
		let holding = false;
		older.onFrame = async (request) => {
			if (request.method === "exec") {
				holding = true;
				await new Promise<void>((resolve) => {
					release = resolve;
				});
			}
			return "default";
		};
		const running = toolTurn(options, "main", "bash", { command: "echo old" });
		expect(await waitFor(() => holding, 5_000)).toBe(true);
		const second = await ScriptedDaemon.upgrade({ token: secret.token, envId });
		const newer = second.peer;
		if (!newer) throw new Error("missing peer");
		await older.closed;
		expect(older.closeCode).toBe(1000);
		expect(older.closeReason).toContain("Superseded");
		release();
		const stale = await running;
		expect(stale.payload?.content ?? "").toContain(
			"tools-env transport: env disconnected",
		);
		const snap = await connection(options.accountId, envId);
		expect(snap.status).toBe("connected");
		expect(snap.generation).toBe(2);
		const again = await toolTurn(options, "main", "bash", {
			command: "echo new",
		});
		expect(again.payload?.isError).toBe(false);
		expect((await connection(options.accountId, envId)).generation).toBe(2);
		newer.close();
	});

	it("runs chat, memory, knowledge, and a schedule fork while the daemon is offline", async () => {
		const options = scope("fork");
		await sendRpc("family.update", { harvestDelayMs: 0 }, options);
		const secret = await registerDaemon(options);
		const envId = secret.envId;
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
		const hello = await sendRpc<{ reply?: string }>(
			"turn.submit",
			{ chatKey: "main", text: "Hello" },
			options,
		);
		expect(JSON.stringify(hello.frame.result)).toContain("Hello");
		const memory = await toolTurn(options, "main", "memory_update", {
			content: "kept",
			expectedVersion: 0,
		});
		expect(memory.payload?.isError).toBe(false);
		const knowledge = await toolTurn(options, "main", "knowledge_update", {
			slug: "note",
			description: "A note",
			body: "body",
			expectedVersion: 0,
		});
		expect(knowledge.payload?.isError).toBe(false);
		const scheduled = await sendRpc(
			"schedule.create",
			{
				id: "fork-bash",
				botId: "assistant",
				name: "Fork bash",
				kind: "absolute",
				input: Date.now() - 1000,
				text: '[tool:bash {"command":"echo forked"}]',
				target: { mode: "fork", chatKey: "main" },
			},
			options,
		);
		expect(scheduled.frame.ok).toBe(true);
		const ws = await connectTestWs(options);
		try {
			ws.events.length = 0;
			await runDurableObjectAlarm(familyStub(options.accountId));
			const deadline = Date.now() + 2_000;
			while (ws.events.length === 0 && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			const routes = await familyStub(options.accountId).listConversationRoutes(
				"main",
			);
			expect(routes.length).toBe(2);
			const parent = await sendRpc<{ chat: { conversationId: number } }>(
				"chat.get",
				{ chatKey: "main" },
				options,
			);
			const child = routes.find(
				(route) =>
					route.conversationId !== parent.frame.result?.chat.conversationId,
			);
			expect(child).toBeDefined();
			const forkText = await familyStub(options.accountId).conversationToolText(
				child?.conversationId ?? 0,
			);
			const text = `${JSON.stringify(ws.events)}\n${forkText}`;
			expect(text).toContain("env disconnected");
			expect(text).not.toContain("tools-env.reachability");
			expect(text).not.toContain("nextProbeAt");
		} finally {
			ws.close();
		}
		const status = await sendRpc<{
			status: { toolsEnv?: Record<string, unknown>; nextProbeAt?: unknown };
		}>("chat.status", { chatKey: "main" }, options);
		expect(status.frame.result?.status.toolsEnv).toMatchObject({
			status: "disconnected",
		});
		expect(status.frame.result?.status.toolsEnv).not.toHaveProperty(
			"nextProbeAt",
		);
		expect(JSON.stringify(status.frame.result)).not.toContain("nextProbeAt");
	});

	it(
		"heartbeats only while a daemon call is in flight",
		async () => {
			const options = scope("beat");
			await sendRpc("family.update", { harvestDelayMs: 0 }, options);
			const secret = await registerDaemon(options);
			const envId = secret.envId;
			await sendRpc(
				"bot.create",
				{
					slug: "assistant",
					name: "Assistant",
					model: "faux/echo",
					tools: ["bash"],
					toolsEnv: { enabled: true, binding: { envId } },
				},
				options,
			);
			await sendRpc(
				"chat.create",
				{ botId: "assistant", key: "main" },
				options,
			);
			await sendRpc(
				"chat.create",
				{
					botId: "assistant",
					key: "plan",
					toolsEnv: { enabled: true, binding: { envId: "jb_default" } },
				},
				options,
			);
			const upgraded = await ScriptedDaemon.upgrade({
				token: secret.token,
				envId,
			});
			const peer = upgraded.peer;
			if (!peer) throw new Error("missing peer");
			const plan = await toolTurn(options, "plan", "bash", {
				command: "echo plan",
			});
			expect(plan.payload?.isError).toBe(false);
			expect(peer.heartbeats).toHaveLength(0);
			await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_QUIET_MS));
			expect(peer.heartbeats).toHaveLength(0);
			expect(await envStub(options.accountId, envId).readAlarm()).toBeNull();
			let release: () => void = () => {};
			peer.onFrame = async (request) => {
				if (request.method !== "exec") return "default";
				await new Promise<void>((resolve) => {
					release = resolve;
				});
				return "default";
			};
			const running = toolTurn(options, "main", "bash", {
				command: "echo slow",
			});
			const sawBeat = await waitFor(
				() => peer.heartbeats.length > 0,
				HEARTBEAT_MS_UNDER_TEST * 8 + 5_000,
			);
			release();
			const done = await running;
			expect(sawBeat).toBe(true);
			expect(done.payload?.isError).toBe(false);
			const seen = peer.heartbeats.length;
			await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_QUIET_MS));
			expect(peer.heartbeats.length).toBe(seen);
			expect(await envStub(options.accountId, envId).readAlarm()).toBeNull();
			peer.ignoreHeartbeat = true;
			peer.onFrame = async () => "manual";
			const missed = toolTurn(options, "main", "bash", {
				command: "echo miss",
			});
			const failed = await missed;
			expect(failed.payload?.content ?? "").toContain(
				"tools-env transport: env disconnected",
			);
			const snap = await connection(options.accountId, envId);
			expect(snap.status).toBe("disconnected");
			expect(snap.lastError).toBe("heartbeat_timeout");
			const planAfter = await toolTurn(options, "plan", "bash", {
				command: "echo still",
			});
			expect(planAfter.payload?.isError).toBe(false);
		},
		HEARTBEAT_TEST_BUDGET_MS,
	);

	it("broadcasts account.toolsEnv.event on connect/disconnect and reconciles stale connected rows", async () => {
		const options = scope("live-events");
		const secret = await registerDaemon(options);
		const envId = secret.envId;
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
			ws.events.length = 0;
			const first = await ScriptedDaemon.upgrade({
				token: secret.token,
				envId,
				workspace: "/tmp/live-ws",
			});
			expect(first.status).toBe(101);
			const sawConnected = await waitFor(
				() =>
					ws.events.some(
						(e) =>
							e.type === "account.toolsEnv.event" &&
							e.payload.envId === envId &&
							e.payload.status === "connected",
					),
				5_000,
			);
			expect(sawConnected).toBe(true);
			const connectedEv = ws.events.find(
				(e): e is Extract<ServerEvent, { type: "account.toolsEnv.event" }> =>
					e.type === "account.toolsEnv.event" &&
					e.payload.status === "connected",
			);
			expect(connectedEv?.payload.workspacePath).toBe("/tmp/live-ws");
			expect(typeof connectedEv?.payload.connectedAt).toBe("number");

			ws.events.length = 0;
			first.peer?.close();
			const sawDisconnected = await waitFor(
				() =>
					ws.events.some(
						(e) =>
							e.type === "account.toolsEnv.event" &&
							e.payload.envId === envId &&
							e.payload.status === "disconnected",
					),
				5_000,
			);
			expect(sawDisconnected).toBe(true);

			// Simulate a stale "connected" row left behind by an unclean drop or DO restart.
			const stub = envStub(options.accountId, envId);
			await runInDurableObject(stub, async (_instance, state) => {
				state.storage.sql.exec(
					`UPDATE cadmus_env_connection
					 SET status = 'connected', disconnected_at = NULL, last_error = NULL
					 WHERE env_id = ?`,
					envId,
				);
			});

			// getConnection must reconcile against openSockets() and report disconnected.
			const reconciled = await connection(options.accountId, envId);
			expect(reconciled.status).toBe("disconnected");
			expect(reconciled.lastError).toBe("socket_closed");
		} finally {
			ws.close();
		}
	});

	it("updates system prompt tools-env vs tools-env-unavailable across connect, stale disconnect, and reconnect", async () => {
		const options = scope("prompt-fresh");
		const secret = await registerDaemon(options);
		const envId = secret.envId;
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
		const created = await sendRpc<{ chat: { conversationId: number } }>(
			"chat.create",
			{ botId: "assistant", key: "main" },
			options,
		);
		const conversationId = created.frame.result?.chat.conversationId ?? 0;
		const familyStub = env.CADMUS_BOT_FAMILY.getByName(
			`cadmus:${options.accountId}:default`,
		);
		const readPromptSection = async () =>
			runInDurableObject(familyStub, async (instance) => {
				const fn = (
					instance as unknown as {
						describeToolsEnv: (input: {
							conversationId: number;
							botId: string;
							toolNames: readonly string[];
						}) => Promise<{ name: string; text: string } | undefined>;
					}
				).describeToolsEnv;
				return fn.call(instance, {
					conversationId,
					botId: "assistant",
					toolNames: ["bash"],
				});
			});

		// 1. Disconnected initially -> tools-env-unavailable
		expect((await readPromptSection())?.name).toBe("tools-env-unavailable");

		// 2. Daemon connects -> tools-env
		const daemon1 = await ScriptedDaemon.upgrade({
			token: secret.token,
			envId,
			workspace: "/tmp/prompt-ws",
		});
		expect(daemon1.status).toBe(101);
		const connectedSection = await readPromptSection();
		expect(connectedSection?.name).toBe("tools-env");
		expect(connectedSection?.text).toContain("/tmp/prompt-ws");

		// 3. Disconnect and force a stale 'connected' row -> describeToolsEnv & turn.submit must reconcile & see unavailable
		daemon1.peer?.close();
		await waitFor(
			async () =>
				(await connection(options.accountId, envId)).status === "disconnected",
			5_000,
		);
		await runInDurableObject(
			envStub(options.accountId, envId),
			async (_instance, state) => {
				state.storage.sql.exec(
					`UPDATE cadmus_env_connection
					 SET status = 'connected', disconnected_at = NULL, last_error = NULL
					 WHERE env_id = ?`,
					envId,
				);
			},
		);
		expect((await readPromptSection())?.name).toBe("tools-env-unavailable");
		const offlineTurn = await toolTurn(options, "main", "bash", {
			command: "echo offline",
		});
		expect(offlineTurn.payload?.content ?? "").toContain(
			"The tools env for this chat is offline (env disconnected)",
		);

		// 4. Daemon reconnects -> tools-env again
		const daemon2 = await ScriptedDaemon.upgrade({
			token: secret.token,
			envId,
			workspace: "/tmp/prompt-ws-2",
		});
		expect(daemon2.status).toBe(101);
		try {
			const reconnectedSection = await readPromptSection();
			expect(reconnectedSection?.name).toBe("tools-env");
			expect(reconnectedSection?.text).toContain("/tmp/prompt-ws-2");
		} finally {
			daemon2.peer?.close();
		}
	});
});
