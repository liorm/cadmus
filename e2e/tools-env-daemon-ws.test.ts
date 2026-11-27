import { describe, expect, it } from "vitest";
import {
	adminScope,
	connectTestWs,
	type DaemonRequest,
	type RpcOptions,
	ScriptedDaemon,
	type ServerEvent,
	sendRpc,
	useWorkerFixture,
	workerFetch,
} from "./helpers.js";

const TEST_TOKEN = "rejected-bearer";

const CODING_TOOLS = ["bash", "read", "write", "edit", "delete"];
const WORKSPACE = "/home/dev/workspace";

async function scope(
	_label: string,
	familyId = "default",
): Promise<RpcOptions & { accountId: string; familyId: string }> {
	return adminScope(familyId);
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
	const pairResponse = await workerFetch("http://example.com/tools-env/pair", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ pairingToken, name: "Rig" }),
	});
	expect(pairResponse.status).toBe(200);
	const redeemed = (await pairResponse.json()) as { token: string };
	return { envId, token: redeemed.token };
}

async function ensureFamily(
	base: RpcOptions,
	familyId: string,
	name: string,
): Promise<void> {
	const created = await sendRpc(
		"family.create",
		{ familyId, name, timezone: "UTC" },
		{ token: base.token, accountId: base.accountId },
	);
	expect(created.frame.ok).toBe(true);
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
		const deadline = Date.now() + 2_000;
		while (toolResults(ws.events).length === 0 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		const payload = toolResults(ws.events)[0]?.payload as
			| { toolName?: string; isError?: boolean; content?: string }
			| undefined;
		return { turnOk: turn.ok, payload, events: [...ws.events] };
	} finally {
		ws.close();
	}
}

async function connection(options: RpcOptions, envId: string) {
	const listed = await sendRpc<{
		envs: Array<{
			envId: string;
			connection?: {
				status: string;
				lastError?: string;
				connectedAt?: number;
				workspacePath?: string;
			};
		}>;
	}>("account.toolsEnvs.list", {}, options);
	const env = listed.frame.result?.envs.find((item) => item.envId === envId);
	return env?.connection ?? { status: "disconnected" };
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

describe("daemon websocket tools env", () => {
	useWorkerFixture();

	it("serves bash, read, write, and edit through one scripted peer", async () => {
		const options = await scope("tools");
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
		await sendRpc(
			"bot.create",
			{
				slug: "plan",
				name: "Plan",
				model: "faux/echo",
				tools: CODING_TOOLS,
				toolsEnv: { enabled: true, binding: { envId: "jb_default" } },
			},
			options,
		);

		const plan = await toolTurn(options, "bot:plan", "bash", {
			command: "echo plan",
		});
		expect(plan.payload?.isError).toBe(false);
		expect(plan.payload?.content ?? "").toContain("plan");

		const upgraded = await ScriptedDaemon.upgrade({
			token: secret.token,
			envId,
		});
		expect(upgraded.status).toBe(101);
		const peer = upgraded.peer;
		if (!peer) throw new Error("missing peer");
		peer.seed(`${WORKSPACE}/notes.txt`, "hello-daemon\n");
		const family = await connectTestWs(options);
		try {
			family.events.length = 0;
			const bash = await family.send("turn.submit", {
				chatKey: "bot:assistant",
				text: '[tool:bash {"command":"echo daemon"}]',
			});
			expect(bash.ok).toBe(true);
			const bashPayload = toolResults(family.events)[0]?.payload as {
				isError?: boolean;
				content?: string;
			};
			expect(bashPayload.isError).toBe(false);
			expect(bashPayload.content ?? "").toContain("ok");
			expect(peer.requests.some((request) => request.method === "exec")).toBe(
				true,
			);
			expect(peer.requests.every((request) => !("type" in request))).toBe(true);
			expect(
				family.events.some((event) => event.type.startsWith("turn.")),
			).toBe(true);
			expect(JSON.stringify(peer.requests)).not.toContain("turn.");
		} finally {
			family.close();
		}

		const read = await toolTurn(options, "bot:assistant", "read", {
			path: "notes.txt",
		});
		expect(read.payload?.isError).toBe(false);
		expect(read.payload?.content ?? "").toContain("hello-daemon");

		const write = await toolTurn(options, "bot:assistant", "write", {
			path: "out.txt",
			content: "written",
		});
		expect(write.payload?.isError).toBe(false);
		expect(write.payload?.content ?? "").toContain("Successfully wrote");

		peer.seed(`${WORKSPACE}/edit.txt`, "alpha");
		const edit = await toolTurn(options, "bot:assistant", "edit", {
			path: "edit.txt",
			edits: [{ oldText: "alpha", newText: "beta" }],
		});
		expect(edit.payload?.isError).toBe(false);
		expect(edit.payload?.content ?? "").toContain("Successfully replaced");

		const snap = await connection(options, envId);
		expect(snap.status).toBe("connected");
		peer.close();
	});

	it("rejects daemon upgrades before generic auth", async () => {
		const options = await scope("auth");
		await sendRpc("family.update", { harvestDelayMs: 0 }, options);
		const other = await registerDaemon(options, {
			confineToWorkspace: false,
		});
		const envId = other.envId;
		const otherEnvReg = await registerDaemon(options);
		const otherEnv = otherEnvReg.envId;
		const plain = await ScriptedDaemon.upgrade({
			token: "not-a-daemon-token",
			envId,
			websocket: true,
		});
		expect(plain.status).toBe(401);
		const malformed = await ScriptedDaemon.upgrade({
			token: `cadmus_dk_${"zz".repeat(32)}`,
			envId,
		});
		expect(malformed.status).toBe(401);
		const unknown = await ScriptedDaemon.upgrade({
			token: `cadmus_dk_${"ab".repeat(32)}`,
			envId,
		});
		expect(unknown.status).toBe(401);
		const user = await ScriptedDaemon.upgrade({
			token: TEST_TOKEN,
			envId,
			headers: { "x-account-id": options.accountId },
		});
		expect(user.status).toBe(401);
		const notWs = await ScriptedDaemon.upgrade({
			token: other.token,
			envId,
			websocket: false,
		});
		expect(notWs.status).toBe(426);
		const missingEnv = await ScriptedDaemon.upgrade({
			token: other.token,
			envId: "ld_missing",
		});
		expect(missingEnv.status).toBe(404);
		const justBash = await ScriptedDaemon.upgrade({
			token: other.token,
			envId: "jb_default",
		});
		expect(justBash.status).toBe(404);
		const forged = await ScriptedDaemon.upgrade({
			token: other.token,
			envId,
			headers: { "X-Cadmus-Daemon-Token-Hash": "forged" },
		});
		expect(forged.status).toBe(101);
		forged.peer?.close();
		const mismatch = await ScriptedDaemon.upgrade({
			token: other.token,
			envId: otherEnv,
		});
		expect(mismatch.status).toBe(403);
	});

	it("shares one socket across two families and keeps another account out", async () => {
		const alpha = await scope("share", "alpha");
		const beta = { ...alpha, familyId: "beta" };
		await ensureFamily(alpha, "alpha", "Alpha");
		await ensureFamily(alpha, "beta", "Beta");
		await sendRpc("family.update", { harvestDelayMs: 0 }, alpha);
		await sendRpc("family.update", { harvestDelayMs: 0 }, beta);
		const secret = await registerDaemon(alpha);
		const envId = secret.envId;
		for (const options of [alpha, beta]) {
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
		}
		const upgraded = await ScriptedDaemon.upgrade({
			token: secret.token,
			envId,
		});
		const peer = upgraded.peer;
		if (!peer) throw new Error("missing peer");
		let release: () => void = () => {};
		const held = new Promise<void>((resolve) => {
			release = resolve;
		});
		let started = 0;
		peer.onFrame = async (request) => {
			if (request.method !== "exec") return "default";
			started += 1;
			await held;
			return "manual";
		};
		const first = toolTurn(alpha, "bot:assistant", "bash", {
			command: "echo a",
		});
		const second = toolTurn(beta, "bot:assistant", "bash", {
			command: "echo b",
		});
		expect(await waitFor(() => started === 2, 5_000)).toBe(true);
		peer.close();
		release();
		const [left, right] = await Promise.all([first, second]);
		expect(left.payload?.content ?? "").toContain(
			"tools-env transport: env disconnected",
		);
		expect(right.payload?.content ?? "").toContain(
			"tools-env transport: env disconnected",
		);
		const snap = await connection(alpha, envId);
		expect(snap.status).toBe("disconnected");
		expect(snap.lastError).toBe("socket_closed");

		const other = await scope("outsider");
		await sendRpc("family.update", { harvestDelayMs: 0 }, other);
		const foreign = await sendRpc(
			"bot.create",
			{
				slug: "assistant",
				name: "Assistant",
				model: "faux/echo",
				tools: CODING_TOOLS,
				toolsEnv: { enabled: true, binding: { envId } },
			},
			other,
		);
		expect(foreign.frame.ok).toBe(false);
		const otherSecret = await registerDaemon(other);
		const foreignSocket = await ScriptedDaemon.upgrade({
			token: otherSecret.token,
			envId,
		});
		expect(foreignSocket.status).toBe(404);
	});

	it("does not run a protocol command from the daemon socket", async () => {
		const options = await scope("cmd");
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
		const upgraded = await ScriptedDaemon.upgrade({
			token: secret.token,
			envId,
		});
		const peer = upgraded.peer;
		if (!peer) throw new Error("missing peer");
		peer.send({
			id: "bad",
			type: "bot.delete",
			payload: { botId: "assistant" },
		});
		await peer.closed;
		expect(peer.closeCode).toBe(1008);
		const bot = await sendRpc("bot.get", { botId: "assistant" }, options);
		expect(bot.frame.ok).toBe(true);
	});

	it("deregisters only the targeted daemon", async () => {
		const options = await scope("revoke");
		await sendRpc("family.update", { harvestDelayMs: 0 }, options);
		const target = await registerDaemon(options);
		const envId = target.envId;
		const keptDaemon = await registerDaemon(options);
		const keptId = keptDaemon.envId;
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
		const live = await ScriptedDaemon.upgrade({ token: target.token, envId });
		const kept = await ScriptedDaemon.upgrade({
			token: keptDaemon.token,
			envId: keptId,
		});
		const peer = live.peer;
		if (!peer || !kept.peer) throw new Error("missing peer");
		let release: () => void = () => {};
		let holding = false;
		peer.onFrame = async (request) => {
			if (request.method === "exec") {
				holding = true;
				await new Promise<void>((resolve) => {
					release = resolve;
				});
			}
			return "default";
		};
		const running = toolTurn(options, "bot:assistant", "bash", {
			command: "echo hold",
		});
		expect(await waitFor(() => holding, 5_000)).toBe(true);
		const removed = await sendRpc(
			"account.toolsEnvs.deregister",
			{ envId },
			options,
		);
		expect(removed.frame.ok).toBe(true);
		release();
		const failed = await running;
		expect(failed.payload?.content ?? "").toContain(
			"tools-env transport: env disconnected",
		);
		await peer.closed;
		expect(peer.closeCode).toBe(1008);
		expect(peer.closeReason).toContain("Daemon deregistered");
		const next = await toolTurn(options, "bot:assistant", "bash", {
			command: "echo later",
		});
		expect(next.payload?.isError).toBe(true);
		expect(next.payload?.content ?? "").toContain(
			"No workspace tools environment is enabled",
		);
		expect(
			peer.requests.filter((request) => request.method === "exec").length,
		).toBe(1);
		expect((await connection(options, keptId)).status).toBe("connected");
		const listed = await sendRpc<{
			envs: Array<{ envId: string; connection?: { status?: string } }>;
		}>("account.toolsEnvs.list", {}, options);
		const rows = new Map(
			(listed.frame.result?.envs ?? []).map((row) => [row.envId, row]),
		);
		expect(rows.has(envId)).toBe(false);
		expect(rows.get(keptId)?.connection?.status).toBe("connected");
		expect(rows.get("jb_default")?.connection).toEqual({ status: "connected" });
		kept.peer.close();
	});

	it("keeps a non-zero exit connected and fails fast while disconnected", async () => {
		const options = await scope("exit");
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
			"bot.create",
			{
				slug: "plan",
				name: "Plan",
				model: "faux/echo",
				tools: ["bash"],
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
		peer.onFrame = async (request) => {
			if (request.method !== "exec") return "default";
			peer.send({
				id: request.id,
				event: "output",
				text: "nope\n",
				stream: "stdout",
			});
			peer.send({ id: request.id, ok: true, value: { exitCode: 1 } });
			return "manual";
		};
		const failed = await toolTurn(options, "bot:assistant", "bash", {
			command: "false",
		});
		expect(failed.payload?.isError).toBe(true);
		expect(failed.payload?.content ?? "").toContain("nope");
		expect((await connection(options, envId)).status).toBe("connected");
		const plan = await toolTurn(options, "bot:plan", "bash", {
			command: "echo plan",
		});
		expect(plan.payload?.isError).toBe(false);
		peer.close();
		expect(
			await waitFor(
				async () =>
					(await connection(options, envId)).status === "disconnected",
				5_000,
			),
		).toBe(true);
		const before = peer.requests.length;
		const offline = await toolTurn(options, "bot:assistant", "bash", {
			command: "echo later",
		});
		expect(offline.payload?.content ?? "").toContain("reconnects on its own");
		expect(peer.requests.length).toBe(before);
		const echo = await sendRpc<{ reply?: string }>(
			"turn.submit",
			{ chatKey: "bot:assistant", text: "Hello" },
			options,
		);
		expect(echo.frame.ok).toBe(true);
		expect(JSON.stringify(echo.frame.result)).toContain("Hello");
	}, 20_000);

	it("closes an oversized daemon frame before parsing it", async () => {
		const options = await scope("size");
		await sendRpc("family.update", { harvestDelayMs: 0 }, options);
		const secret = await registerDaemon(options);
		const envId = secret.envId;
		const upgraded = await ScriptedDaemon.upgrade({
			token: secret.token,
			envId,
		});
		const peer = upgraded.peer;
		if (!peer) throw new Error("missing peer");
		peer.send("x".repeat(6 * 1024 * 1024 + 1));
		await peer.closed;
		expect(peer.closeCode).toBe(1009);
	});

	it("orders writes on one path and does not order bash", async () => {
		const alpha = await scope("queue", "alpha");
		const beta = { ...alpha, familyId: "beta" };
		await ensureFamily(alpha, "alpha", "Alpha");
		await ensureFamily(alpha, "beta", "Beta");
		await sendRpc("family.update", { harvestDelayMs: 0 }, alpha);
		await sendRpc("family.update", { harvestDelayMs: 0 }, beta);
		const secret = await registerDaemon(alpha);
		const envId = secret.envId;
		for (const options of [alpha, beta]) {
			await sendRpc(
				"bot.create",
				{
					slug: "assistant",
					name: "Assistant",
					model: "faux/echo",
					tools: ["bash", "write"],
					toolsEnv: { enabled: true, binding: { envId } },
				},
				options,
			);
		}
		const upgraded = await ScriptedDaemon.upgrade({
			token: secret.token,
			envId,
		});
		const peer = upgraded.peer;
		if (!peer) throw new Error("missing peer");
		const writes: DaemonRequest[] = [];
		peer.onFrame = async (request) => {
			if (request.method !== "writeFile") return "default";
			writes.push(request);
			if (writes.length === 1) {
				await new Promise((resolve) => setTimeout(resolve, 400));
				expect(writes).toHaveLength(1);
			}
			return "default";
		};
		await Promise.all([
			toolTurn(alpha, "bot:assistant", "write", {
				path: "same.txt",
				content: "one",
			}),
			toolTurn(beta, "bot:assistant", "write", {
				path: "same.txt",
				content: "two",
			}),
		]);
		expect(writes).toHaveLength(2);

		const execs: DaemonRequest[] = [];
		let overlapped = false;
		peer.onFrame = async (request) => {
			if (request.method !== "exec") return "default";
			execs.push(request);
			if (execs.length === 1) {
				overlapped = await waitFor(() => execs.length >= 2, 5_000);
			}
			return "default";
		};
		await Promise.all([
			toolTurn(alpha, "bot:assistant", "bash", { command: "echo a" }),
			toolTurn(beta, "bot:assistant", "bash", { command: "echo b" }),
		]);
		expect(overlapped).toBe(true);
		peer.close();
	});

	it("classifies peer errors separately from transport failures", async () => {
		const options = await scope("class");
		await sendRpc("family.update", { harvestDelayMs: 0 }, options);
		const secret = await registerDaemon(options);
		const envId = secret.envId;
		await sendRpc(
			"bot.create",
			{
				slug: "assistant",
				name: "Assistant",
				model: "faux/echo",
				tools: ["bash", "read"],
				toolsEnv: { enabled: true, binding: { envId } },
			},
			options,
		);
		const upgraded = await ScriptedDaemon.upgrade({
			token: secret.token,
			envId,
		});
		const peer = upgraded.peer;
		if (!peer) throw new Error("missing peer");
		peer.onFrame = async (request) => {
			if (request.method === "exec") {
				peer.send({
					id: request.id,
					ok: false,
					error: {
						kind: "exec",
						code: "shell_unavailable",
						message: "tools-env transport: env disconnected",
					},
				});
				return "manual";
			}
			return "default";
		};
		const shell = await toolTurn(options, "bot:assistant", "bash", {
			command: "true",
		});
		expect(shell.payload?.content ?? "").not.toContain("tools-env transport:");
		expect((await connection(options, envId)).status).toBe("connected");
		peer.onFrame = async (request) => {
			if (request.method === "openBinaryReader") {
				peer.send({
					id: request.id,
					ok: false,
					error: {
						kind: "file",
						code: "unknown",
						message: "tools-env transport: env disconnected",
					},
				});
				return "manual";
			}
			return "default";
		};
		await toolTurn(options, "bot:assistant", "read", { path: "missing.txt" });
		expect((await connection(options, envId)).status).toBe("connected");
		peer.onFrame = async (request) => {
			if (request.method === "openBinaryReader") {
				peer.send({
					id: request.id,
					ok: false,
					error: { kind: "file", code: "not_found", message: "missing" },
				});
				return "manual";
			}
			return "default";
		};
		await toolTurn(options, "bot:assistant", "read", { path: "gone.txt" });
		expect((await connection(options, envId)).status).toBe("connected");
		peer.onFrame = async (request) => {
			if (request.method === "exec") {
				peer.send({
					id: request.id,
					ok: false,
					error: { kind: "exec", code: "timeout", message: "too slow" },
				});
				return "manual";
			}
			return "default";
		};
		await toolTurn(options, "bot:assistant", "bash", { command: "sleep 1" });
		expect((await connection(options, envId)).status).toBe("connected");
		peer.onFrame = async () => "manual";
		const timed = await toolTurn(options, "bot:assistant", "read", {
			path: "slow.txt",
		});
		expect(timed.payload?.content ?? "").toContain(
			"tools-env transport: env disconnected",
		);
		const after = await connection(options, envId);
		expect(after.status).toBe("disconnected");
		expect(after.lastError).toBe("socket_closed");
	});

	it("leaves the socket up when a bot or chat turns tools off", async () => {
		const alpha = await scope("off", "alpha");
		const beta = { ...alpha, familyId: "beta" };
		await ensureFamily(alpha, "alpha", "Alpha");
		await ensureFamily(alpha, "beta", "Beta");
		await sendRpc("family.update", { harvestDelayMs: 0 }, alpha);
		await sendRpc("family.update", { harvestDelayMs: 0 }, beta);
		const secret = await registerDaemon(alpha);
		const envId = secret.envId;
		for (const options of [alpha, beta]) {
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
		}
		const upgraded = await ScriptedDaemon.upgrade({
			token: secret.token,
			envId,
		});
		const peer = upgraded.peer;
		if (!peer) throw new Error("missing peer");
		let release: () => void = () => {};
		let heldExec = false;
		peer.onFrame = async (request) => {
			if (request.method === "exec" && !heldExec) {
				heldExec = true;
				await new Promise<void>((resolve) => {
					release = resolve;
				});
			}
			return "default";
		};
		const running = toolTurn(alpha, "bot:assistant", "bash", {
			command: "echo hold",
		});
		expect(await waitFor(() => heldExec, 5_000)).toBe(true);
		await sendRpc(
			"bot.update",
			{ botId: "assistant", toolsEnv: { enabled: false } },
			alpha,
		);
		release();
		const finished = await running;
		expect(finished.payload?.isError).toBe(false);
		const later = await toolTurn(alpha, "bot:assistant", "bash", {
			command: "echo later",
		});
		expect(later.payload?.isError).toBe(true);
		expect(later.payload?.content ?? "").toContain(
			"No workspace tools environment is enabled",
		);
		expect((await connection(alpha, envId)).status).toBe("connected");
		const sibling = await toolTurn(beta, "bot:assistant", "bash", {
			command: "echo sib",
		});
		expect(sibling.payload?.isError).toBe(false);
		const cleanups = peer.requests.filter(
			(request) => request.method === "cleanup",
		);
		await sendRpc(
			"chat.update",
			{ chatKey: "bot:assistant", toolsEnv: null },
			beta,
		);
		expect(
			peer.requests.filter((request) => request.method === "cleanup"),
		).toEqual(cleanups);
		expect(peer.closeCode).toBe(0);
		await sendRpc(
			"bot.create",
			{
				slug: "planner",
				name: "Planner",
				model: "faux/echo",
				tools: ["bash"],
				toolsEnv: { enabled: true, binding: { envId: "jb_default" } },
			},
			alpha,
		);
		await sendRpc(
			"chat.update",
			{
				chatKey: "bot:planner",
				toolsEnv: { enabled: true, binding: { envId } },
			},
			alpha,
		);
		const cleanupCount = peer.requests.filter(
			(request) => request.method === "cleanup",
		).length;
		const pinned = await toolTurn(alpha, "bot:planner", "bash", {
			command: "echo pinned",
		});
		expect(pinned.payload?.content ?? "").toContain("ok");
		await sendRpc(
			"chat.update",
			{ chatKey: "bot:planner", toolsEnv: null },
			alpha,
		);
		expect(
			peer.requests.filter((request) => request.method === "cleanup").length,
		).toBe(cleanupCount);
		expect(peer.closeCode).toBe(0);
		const inherited = await toolTurn(alpha, "bot:planner", "bash", {
			command: "echo inherited",
		});
		expect(inherited.payload?.content ?? "").toContain("inherited");
		expect((await connection(alpha, envId)).status).toBe("connected");
		peer.close();
	}, 20_000);

	it("sends cleanup when the env is deleted or persist flips, not when one bot unbinds", async () => {
		const options = await scope("clean");
		await sendRpc("family.update", { harvestDelayMs: 0 }, options);
		const secret = await registerDaemon(options, { persist: false });
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
			"bot.create",
			{
				slug: "other",
				name: "Other",
				model: "faux/echo",
				tools: ["bash"],
				toolsEnv: { enabled: true, binding: { envId } },
			},
			options,
		);
		const upgraded = await ScriptedDaemon.upgrade({
			token: secret.token,
			envId,
		});
		const peer = upgraded.peer;
		if (!peer) throw new Error("missing peer");
		await sendRpc("bot.update", { botId: "other", toolsEnv: null }, options);
		expect(peer.requests.some((request) => request.method === "cleanup")).toBe(
			false,
		);
		expect((await connection(options, envId)).status).toBe("connected");
		await sendRpc(
			"account.toolsEnvs.update",
			{ envId, persist: true },
			options,
		);
		await peer.closed;
		const cleanup = peer.requests.find(
			(request) => request.method === "cleanup",
		);
		expect(cleanup?.args.deleteEphemeral).toBe(true);
		expect(peer.closeCode).toBe(1000);

		const ephemeral = await registerDaemon(options, {
			persist: false,
		});
		const again = await ScriptedDaemon.upgrade({
			token: ephemeral.token,
			envId: ephemeral.envId,
		});
		const second = again.peer;
		if (!second) throw new Error("missing peer");
		await sendRpc(
			"account.toolsEnvs.delete",
			{ envId: ephemeral.envId },
			options,
		);
		await second.closed;
		expect(
			second.requests.find((request) => request.method === "cleanup")?.args
				.deleteEphemeral,
		).toBe(true);
	});

	async function setupConfinedPeer(label: string) {
		const options = await scope(label);
		await sendRpc("family.update", { harvestDelayMs: 0 }, options);
		const secret = await registerDaemon(options, { confineToWorkspace: true });
		const envId = secret.envId;
		const upgraded = await ScriptedDaemon.upgrade({
			token: secret.token,
			envId,
			capabilities: "confinement",
		});
		expect(upgraded.status).toBe(101);
		const peer = upgraded.peer;
		if (!peer) throw new Error("missing peer");
		peer.jailRoot = WORKSPACE;
		peer.link(`${WORKSPACE}/leak`, "/etc/passwd");
		await sendRpc(
			"bot.create",
			{
				slug: "assistant",
				name: "Assistant",
				model: "faux/echo",
				tools: ["bash", "read", "write", "edit"],
				toolsEnv: { enabled: true, binding: { envId } },
			},
			options,
		);
		peer.seed(`${WORKSPACE}/notes.txt`, "inside");
		return { options, envId, peer };
	}

	it("enforces confinement capability on daemon upgrade", async () => {
		const options = await scope("jail-up");
		await sendRpc("family.update", { harvestDelayMs: 0 }, options);
		const secret = await registerDaemon(options, { confineToWorkspace: true });
		const envId = secret.envId;
		const blocked = await ScriptedDaemon.upgrade({
			token: secret.token,
			envId,
		});
		expect(blocked.status).toBe(409);
		const first = await connection(options, envId);
		expect(first.status).toBe("disconnected");
		expect(first.lastError).toBe("confinement_unavailable");
		const again = await ScriptedDaemon.upgrade({ token: secret.token, envId });
		expect(again.status).toBe(409);
		const upgraded = await ScriptedDaemon.upgrade({
			token: secret.token,
			envId,
			capabilities: "confinement",
		});
		expect(upgraded.status).toBe(101);
		const peer = upgraded.peer;
		if (!peer) throw new Error("missing peer");
		const whileUp = await ScriptedDaemon.upgrade({
			token: secret.token,
			envId,
		});
		expect(whileUp.status).toBe(409);
		const live = await connection(options, envId);
		expect(live.status).toBe("connected");
		peer.close();
	});

	it("rejects escaped read paths on a confined daemon", async () => {
		const { options, peer } = await setupConfinedPeer("jail-rd");
		for (const path of ["../escape", "/etc/passwd", "leak"]) {
			const read = await toolTurn(options, "bot:assistant", "read", { path });
			expect(read.payload?.content ?? "").toContain("permission_denied");
		}
		peer.close();
	});

	it("rejects escaped write paths on a confined daemon", async () => {
		const { options, peer } = await setupConfinedPeer("jail-wr");
		for (const path of ["../escape", "/etc/passwd", "leak"]) {
			const write = await toolTurn(options, "bot:assistant", "write", {
				path,
				content: "x",
			});
			expect(write.payload?.content ?? "").toContain("permission_denied");
		}
		peer.close();
	});

	it("rejects escaped edit paths and confines bash cwd on a confined daemon", async () => {
		const { options, envId, peer } = await setupConfinedPeer("jail-ed");
		const edited = await toolTurn(options, "bot:assistant", "edit", {
			path: "../escape",
			edits: [{ oldText: "a", newText: "b" }],
		});
		expect(edited.payload?.content ?? "").toContain("permission_denied");
		const cwd = peer.requests.find((request) => request.method === "exec");
		const bash = await toolTurn(options, "bot:assistant", "bash", {
			command: "pwd",
		});
		expect(bash.payload?.isError).toBe(false);
		const exec = [...peer.requests]
			.reverse()
			.find((request) => request.method === "exec");
		expect(exec?.args.cwd).toBe(WORKSPACE);
		expect(cwd).toBeUndefined();
		expect((await connection(options, envId)).status).toBe("connected");
		peer.close();
	});

	it("lists daemon connection fields from account.toolsEnvs.list and chat.status", async () => {
		const options = await scope("list");
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
		const upgraded = await ScriptedDaemon.upgrade({
			token: secret.token,
			envId,
		});
		const peer = upgraded.peer;
		if (!peer) throw new Error("missing peer");
		const listed = await sendRpc<{
			envs: Array<{
				envId: string;
				connection?: {
					status?: string;
					connectedAt?: number;
					lastError?: string;
				};
			}>;
		}>("account.toolsEnvs.list", {}, options);
		const row = listed.frame.result?.envs.find((item) => item.envId === envId);
		expect(row?.connection?.status).toBe("connected");
		expect(typeof row?.connection?.connectedAt).toBe("number");
		expect(row?.connection?.lastError).toBeUndefined();
		const status = await sendRpc<{
			status: {
				toolsEnv?: {
					status?: string;
					connectedAt?: number;
					nextProbeAt?: unknown;
				};
			};
		}>("chat.status", { chatKey: "bot:assistant" }, options);
		expect(status.frame.result?.status.toolsEnv?.status).toBe("connected");
		expect(typeof status.frame.result?.status.toolsEnv?.connectedAt).toBe(
			"number",
		);
		expect(status.frame.result?.status.toolsEnv).not.toHaveProperty(
			"nextProbeAt",
		);
		peer.close();
	});
});
