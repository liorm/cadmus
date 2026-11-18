import {
	env,
	runDurableObjectAlarm,
	runInDurableObject,
	SELF,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getEdgeCache } from "../src/edge-cache.js";
import type { ServerEvent } from "../src/protocol.js";
import { D1AdminStore } from "../src/store/d1-admin.js";
import { resolveHeartbeatMs } from "../src/tools-env/wire.js";
import {
	connectTestWs,
	type RpcOptions,
	sendRpc,
	streamAuthParams,
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

async function scopedToken(
	accountId: string,
	grants: string[],
	kind: "pat" | "service" = "service",
): Promise<{
	raw: string;
	accessToken: string;
	revoke: () => Promise<void>;
}> {
	const store = new D1AdminStore({
		db: env.CADMUS_ADMIN_DB,
		encryptionKey: env.CADMUS_ENCRYPTION_KEY,
		edgeCache: getEdgeCache(env),
	});
	const userId = `usr_${accountId}`;
	await store.ensureAccountAndUser({
		accountId,
		userId,
		role: "account-admin",
	});
	const admin = await store.createSession({ userId, accountId });
	// Service tokens are an admin-mode use.
	await env.CADMUS_ADMIN_DB.prepare(
		`UPDATE cadmus_sessions SET elevated_until = ?2 WHERE id = ?1`,
	)
		.bind(admin.sessionId, Date.now() + 600_000)
		.run();
	const created = await SELF.fetch("https://example.com/rpc", {
		method: "POST",
		headers: {
			authorization: `Bearer ${admin.accessToken}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			id: crypto.randomUUID(),
			type: "auth.tokens.create",
			payload: { kind, label: "scoped", grants, ttlDays: 1 },
		}),
	});
	const body = (await created.json()) as {
		ok: boolean;
		result?: { token: string; summary: { id: string } };
	};
	if (!body.ok || !body.result) throw new Error("token create failed");
	const login = await SELF.fetch("https://example.com/api/auth/login/token", {
		method: "POST",
		headers: { authorization: `Bearer ${body.result.token}` },
	});
	const accessToken = ((await login.json()) as { accessToken: string })
		.accessToken;
	const tokenId = body.result.summary.id;
	const raw = body.result.token;
	return {
		raw,
		accessToken,
		revoke: async () => {
			const res = await SELF.fetch("https://example.com/rpc", {
				method: "POST",
				headers: {
					authorization: `Bearer ${admin.accessToken}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					id: crypto.randomUUID(),
					type: "auth.tokens.revoke",
					payload: { tokenId },
				}),
			});
			const out = (await res.json()) as { ok: boolean };
			if (!out.ok) throw new Error("token revoke failed");
		},
	};
}

async function scopedAccessToken(
	accountId: string,
	grants: string[],
): Promise<string> {
	return (await scopedToken(accountId, grants)).accessToken;
}

/** Reads an SSE stream into text; `closed` resolves when the server ends it. */
async function openSse(options: RpcOptions & { accountId: string }): Promise<{
	text: () => string;
	closed: () => boolean;
	cancel: () => void;
}> {
	const url = new URL("http://example.com/events");
	for (const [k, v] of Object.entries(
		await streamAuthParams("events", options),
	)) {
		url.searchParams.set(k, v);
	}
	url.searchParams.set("accountId", options.accountId);
	url.searchParams.set("familyId", options.familyId ?? "default");
	const res = await SELF.fetch(url.toString());
	if (res.status !== 200 || !res.body) {
		throw new Error(`SSE open failed: ${res.status}`);
	}
	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let done = false;
	void (async () => {
		try {
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) break;
				buffer += decoder.decode(chunk.value);
			}
		} catch {
			// stream ended with an error: treated as closed
		}
		done = true;
	})();
	return {
		text: () => buffer,
		closed: () => done,
		cancel: () => void reader.cancel().catch(() => undefined),
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

	it("delivers account.toolsEnv.event only to sessions holding toolsEnv.read", async () => {
		const options = scope("live-events-grants");
		const secret = await registerDaemon(options);
		const envId = secret.envId;
		const noRead = await scopedAccessToken(options.accountId, [
			"chat.use",
			"bot.read",
		]);
		const withRead = await scopedAccessToken(options.accountId, [
			"chat.use",
			"toolsEnv.read",
		]);
		const master = await connectTestWs(options);
		const denied = await connectTestWs({ ...options, token: noRead });
		const allowed = await connectTestWs({ ...options, token: withRead });
		try {
			const seen = (events: ServerEvent[], status: string) =>
				events.some(
					(e) =>
						e.type === "account.toolsEnv.event" &&
						e.payload.envId === envId &&
						e.payload.status === status,
				);
			const first = await ScriptedDaemon.upgrade({
				token: secret.token,
				envId,
				workspace: "/tmp/live-grants",
			});
			expect(first.status).toBe(101);
			expect(await waitFor(() => seen(master.events, "connected"), 5_000)).toBe(
				true,
			);
			expect(
				await waitFor(() => seen(allowed.events, "connected"), 5_000),
			).toBe(true);
			first.peer?.close();
			expect(
				await waitFor(() => seen(master.events, "disconnected"), 5_000),
			).toBe(true);
			expect(
				await waitFor(() => seen(allowed.events, "disconnected"), 5_000),
			).toBe(true);
			// The master and the toolsEnv.read session got both events, so the
			// fan-out has finished for this stream: the scoped session without
			// the grant must have received none of the environment metadata.
			expect(
				denied.events.some((e) => e.type === "account.toolsEnv.event"),
			).toBe(false);
			expect(JSON.stringify(denied.events)).not.toContain("/tmp/live-grants");
		} finally {
			master.close();
			denied.close();
			allowed.close();
		}
	});

	it("does not deliver account.toolsEnv.event to a sessionless chat.use-only cad_pat_ or cad_svc_ stream", async () => {
		const options = scope("live-events-sessionless-token");
		const secret = await registerDaemon(options);
		const envId = secret.envId;
		const workspace = "/tmp/sessionless-grants";
		// The raw bearer mints a legacy ticket, so the stream has no session id.
		// A token-login access token would take the session path instead.
		const patChat = await scopedToken(options.accountId, ["chat.use"], "pat");
		const svcChat = await scopedToken(
			options.accountId,
			["chat.use"],
			"service",
		);
		const patRead = await scopedToken(
			options.accountId,
			["chat.use", "toolsEnv.read"],
			"pat",
		);
		expect(patChat.raw.startsWith("cad_pat_")).toBe(true);
		expect(svcChat.raw.startsWith("cad_svc_")).toBe(true);
		expect(patRead.raw.startsWith("cad_pat_")).toBe(true);
		const master = await connectTestWs(options);
		const deniedPat = await connectTestWs({ ...options, token: patChat.raw });
		const deniedSvc = await connectTestWs({ ...options, token: svcChat.raw });
		const allowed = await connectTestWs({ ...options, token: patRead.raw });
		const deniedPatSse = await openSse({ ...options, token: patChat.raw });
		const deniedSvcSse = await openSse({ ...options, token: svcChat.raw });
		const allowedSse = await openSse({ ...options, token: patRead.raw });
		const metadata = (events: ServerEvent[]) =>
			events.some(
				(e) =>
					e.type === "account.toolsEnv.event" &&
					e.payload.envId === envId &&
					e.payload.workspacePath === workspace,
			);
		try {
			const daemon = await ScriptedDaemon.upgrade({
				token: secret.token,
				envId,
				workspace,
			});
			expect(daemon.status).toBe(101);
			expect(await waitFor(() => metadata(master.events), 5_000)).toBe(true);
			expect(await waitFor(() => metadata(allowed.events), 5_000)).toBe(true);
			expect(
				await waitFor(
					() =>
						allowedSse.text().includes("account.toolsEnv.event") &&
						allowedSse.text().includes(workspace),
					5_000,
				),
			).toBe(true);
			// The master and the toolsEnv.read bearer received the metadata, so
			// fan-out for this connect has finished. Chat-only bearers got none.
			expect(metadata(deniedPat.events)).toBe(false);
			expect(metadata(deniedSvc.events)).toBe(false);
			expect(JSON.stringify(deniedPat.events)).not.toContain(workspace);
			expect(JSON.stringify(deniedSvc.events)).not.toContain(workspace);
			expect(deniedPatSse.text()).not.toContain("account.toolsEnv.event");
			expect(deniedSvcSse.text()).not.toContain("account.toolsEnv.event");
			expect(deniedPatSse.text()).not.toContain(workspace);
			expect(deniedSvcSse.text()).not.toContain(workspace);
			daemon.peer?.close();
		} finally {
			master.close();
			deniedPat.close();
			deniedSvc.close();
			allowed.close();
			deniedPatSse.cancel();
			deniedSvcSse.cancel();
			allowedSse.cancel();
		}
	});

	it("gates account.toolsEnv.event on SSE, drops it after revocation, and fails closed when authority cannot be checked", async () => {
		const options = scope("live-events-sse");
		const secret = await registerDaemon(options);
		const envId = secret.envId;
		const noRead = await scopedToken(options.accountId, [
			"chat.use",
			"bot.read",
		]);
		const withRead = await scopedToken(options.accountId, [
			"chat.use",
			"toolsEnv.read",
		]);
		const master = await openSse(options);
		const denied = await openSse({ ...options, token: noRead.accessToken });
		const allowed = await openSse({ ...options, token: withRead.accessToken });
		const marker = (status: string) => `"status":"${status}"`;
		const count = (text: string, status: string) =>
			text.split(marker(status)).length - 1;
		try {
			const cycle = async (workspace: string) => {
				const daemon = await ScriptedDaemon.upgrade({
					token: secret.token,
					envId,
					workspace,
				});
				expect(daemon.status).toBe(101);
				return daemon;
			};
			// Cycle 1: master and the toolsEnv.read stream get it; the other does not.
			const first = await cycle("/tmp/sse-one");
			expect(
				await waitFor(() => count(master.text(), "connected") === 1, 5_000),
			).toBe(true);
			expect(
				await waitFor(() => count(allowed.text(), "connected") === 1, 5_000),
			).toBe(true);
			expect(denied.text()).not.toContain("account.toolsEnv.event");
			expect(denied.text()).not.toContain("/tmp/sse-one");
			first.peer?.close();
			expect(
				await waitFor(() => count(master.text(), "disconnected") === 1, 5_000),
			).toBe(true);
			expect(
				await waitFor(() => count(allowed.text(), "disconnected") === 1, 5_000),
			).toBe(true);

			// Revoke the toolsEnv.read token: its stream is closed and gets no
			// further events; the master stream still does.
			await withRead.revoke();
			const second = await cycle("/tmp/sse-two");
			expect(
				await waitFor(() => count(master.text(), "connected") === 2, 5_000),
			).toBe(true);
			expect(await waitFor(() => allowed.closed(), 5_000)).toBe(true);
			expect(count(allowed.text(), "connected")).toBe(1);
			expect(allowed.text()).not.toContain("/tmp/sse-two");
			expect(denied.text()).not.toContain("account.toolsEnv.event");

			// Authority lookup failure: nothing is delivered and streams end.
			await runInDurableObject(
				familyStub(options.accountId),
				async (instance) => {
					(
						instance as unknown as {
							adminStore: { resolveSession: () => Promise<never> };
						}
					).adminStore.resolveSession = async () => {
						throw new Error("admin store unavailable");
					};
				},
			);
			second.peer?.close();
			expect(await waitFor(() => master.closed(), 5_000)).toBe(true);
			expect(count(master.text(), "disconnected")).toBe(1);
			expect(await waitFor(() => denied.closed(), 5_000)).toBe(true);
			expect(denied.text()).not.toContain("account.toolsEnv.event");
		} finally {
			master.cancel();
			denied.cancel();
			allowed.cancel();
		}
	});

	it("recomputes toolsEnv.read per event: losing only that grant stops metadata while the stream and chat events continue", async () => {
		const options = scope("live-events-grant-loss");
		const secret = await registerDaemon(options);
		const envId = secret.envId;
		const withRead = await scopedAccessToken(options.accountId, [
			"chat.use",
			"toolsEnv.read",
		]);
		const allowed = await connectTestWs({ ...options, token: withRead });
		// Wrap the resolver: the same identity, minus only toolsEnv.read when asked.
		const dropped = { value: false };
		await runInDurableObject(
			familyStub(options.accountId),
			async (instance) => {
				const store = (
					instance as unknown as {
						adminStore: {
							resolveSession: (
								id: string,
							) => Promise<{ grants?: string[] } | undefined>;
						};
					}
				).adminStore;
				const original = store.resolveSession.bind(store);
				store.resolveSession = async (id: string) => {
					const identity = await original(id);
					if (!identity || !dropped.value || !identity.grants) return identity;
					return {
						...identity,
						grants: identity.grants.filter((g) => g !== "toolsEnv.read"),
					};
				};
			},
		);
		const metadata = (status: string) =>
			allowed.events.some(
				(e) =>
					e.type === "account.toolsEnv.event" &&
					e.payload.envId === envId &&
					e.payload.status === status,
			);
		try {
			const cycle = async (workspace: string) => {
				const daemon = await ScriptedDaemon.upgrade({
					token: secret.token,
					envId,
					workspace,
				});
				expect(daemon.status).toBe(101);
				return daemon;
			};
			const first = await cycle("/tmp/grant-one");
			expect(await waitFor(() => metadata("connected"), 5_000)).toBe(true);

			// Lose only toolsEnv.read, keep chat.use.
			dropped.value = true;
			first.peer?.close();
			// A harmless chat event must still reach the same open socket.
			const seenBefore = allowed.events.length;
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
			await sendRpc("turn.submit", { chatKey: "main", text: "Hello" }, options);
			expect(
				await waitFor(
					() =>
						allowed.events
							.slice(seenBefore)
							.some((e) => e.type !== "account.toolsEnv.event"),
					5_000,
				),
			).toBe(true);
			expect(allowed.ws.readyState).toBe(WebSocket.OPEN);
			expect(metadata("disconnected")).toBe(false);

			// Restore the grant: the next metadata event arrives again.
			dropped.value = false;
			const second = await cycle("/tmp/grant-two");
			expect(
				await waitFor(
					() =>
						allowed.events.some(
							(e) =>
								e.type === "account.toolsEnv.event" &&
								e.payload.status === "connected" &&
								e.payload.workspacePath === "/tmp/grant-two",
						),
					5_000,
				),
			).toBe(true);
			second.peer?.close();
		} finally {
			allowed.close();
		}
	}, 30_000);

	it("recomputes toolsEnv.read per event on SSE: losing only that grant stops metadata while the stream and chat events continue", async () => {
		const options = scope("live-events-sse-grant-loss");
		const secret = await registerDaemon(options);
		const envId = secret.envId;
		const withRead = await scopedAccessToken(options.accountId, [
			"chat.use",
			"toolsEnv.read",
		]);
		const stream = await openSse({ ...options, token: withRead });
		// The master stream is the witness that a disconnect was emitted.
		const master = await openSse(options);
		const dropped = { value: false };
		await runInDurableObject(
			familyStub(options.accountId),
			async (instance) => {
				const store = (
					instance as unknown as {
						adminStore: {
							resolveSession: (
								id: string,
							) => Promise<{ grants?: string[] } | undefined>;
						};
					}
				).adminStore;
				const original = store.resolveSession.bind(store);
				store.resolveSession = async (id: string) => {
					const identity = await original(id);
					if (!identity || !dropped.value || !identity.grants) return identity;
					return {
						...identity,
						grants: identity.grants.filter((g) => g !== "toolsEnv.read"),
					};
				};
			},
		);
		type Frame = {
			type: string;
			payload?: { envId?: string; status?: string; workspacePath?: string };
		};
		const frames = (text: string): Frame[] =>
			text
				.split("\n")
				.filter((line) => line.startsWith("data:"))
				.map((line) => JSON.parse(line.slice(5)) as Frame);
		const meta = (
			text: string,
			status: string,
			workspacePath?: string,
		): Frame[] =>
			frames(text).filter(
				(f) =>
					f.type === "account.toolsEnv.event" &&
					f.payload?.envId === envId &&
					f.payload.status === status &&
					(workspacePath === undefined ||
						f.payload.workspacePath === workspacePath),
			);
		try {
			const cycle = async (workspace: string) => {
				const daemon = await ScriptedDaemon.upgrade({
					token: secret.token,
					envId,
					workspace,
				});
				expect(daemon.status).toBe(101);
				return daemon;
			};
			const first = await cycle("/tmp/sse-grant-one");
			expect(
				await waitFor(
					() =>
						meta(stream.text(), "connected", "/tmp/sse-grant-one").length === 1,
					5_000,
				),
			).toBe(true);

			// Lose only toolsEnv.read, keep chat.use.
			dropped.value = true;
			const before = frames(stream.text()).length;
			first.peer?.close();
			// Witness: the disconnect was emitted (master received it) while the
			// token stream's grant is still removed.
			expect(
				await waitFor(
					() => meta(master.text(), "disconnected").length === 1,
					5_000,
				),
			).toBe(true);
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
			await sendRpc("turn.submit", { chatKey: "main", text: "Hello" }, options);
			const chatFrame = () =>
				frames(stream.text())
					.slice(before)
					.filter((f) => f.type !== "account.toolsEnv.event");
			expect(await waitFor(() => chatFrame().length > 0, 5_000)).toBe(true);
			expect(stream.closed()).toBe(false);
			expect(meta(stream.text(), "disconnected")).toHaveLength(0);
			expect(meta(stream.text(), "connected")).toHaveLength(1);

			// Restore the grant: the next metadata event arrives again, and the
			// earlier denied disconnect is not delivered late.
			dropped.value = false;
			const second = await cycle("/tmp/sse-grant-two");
			expect(
				await waitFor(
					() =>
						meta(stream.text(), "connected", "/tmp/sse-grant-two").length === 1,
					5_000,
				),
			).toBe(true);
			expect(meta(stream.text(), "disconnected")).toHaveLength(0);
			second.peer?.close();
		} finally {
			stream.cancel();
			master.cancel();
		}
	}, 30_000);

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
