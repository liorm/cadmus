import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ServerEvent } from "../packages/worker/src/protocol.js";
import { sha256Hex } from "../packages/worker/src/store/d1-admin.js";
import { connectTestWs, type RpcOptions, sendRpc } from "./helpers.js";

const CODING_TOOLS = ["bash", "read", "write", "edit"];

function scope(
	label: string,
	familyId = "default",
): RpcOptions & {
	accountId: string;
	familyId: string;
} {
	const accountId = `daemon-${label}-${crypto.randomUUID().slice(0, 8)}`;
	return { accountId, familyId };
}

function toolResults(events: ServerEvent[]) {
	return events.filter((event) => event.type === "turn.tool_result");
}

async function bashResult(
	options: RpcOptions,
	chatKey: string,
	command: string,
) {
	const ws = await connectTestWs(options);
	try {
		ws.events.length = 0;
		const turn = await ws.send<{ reply?: string }>("turn.submit", {
			chatKey,
			text: `[tool:bash ${JSON.stringify({ command })}]`,
		});
		const payload = toolResults(ws.events)[0]?.payload as
			| { toolName?: string; isError?: boolean; content?: string }
			| undefined;
		return { turnOk: turn.ok, payload, events: [...ws.events] };
	} finally {
		ws.close();
	}
}

interface SecretMeta {
	secretId: string;
	label?: string;
	kind: string;
	updatedAt: number;
}

interface EnvRow {
	envId: string;
	kind: string;
	persist: boolean;
	confineToWorkspace: boolean;
	sharedWorkspace?: boolean;
	workspacePath?: string;
	secretId?: string;
	secretMissing?: boolean;
	supportsConfinement: boolean;
	connection?: { status: string };
}

async function mintSecret(
	options: RpcOptions,
	label?: string,
): Promise<{ secretId: string; token: string }> {
	const set = await sendRpc<{ secret: SecretMeta; token: string }>(
		"account.toolsEnvSecrets.set",
		label ? { label } : {},
		options,
	);
	expect(set.frame.ok).toBe(true);
	const token = set.frame.result?.token ?? "";
	const secretId = set.frame.result?.secret.secretId ?? "";
	expect(token).toMatch(/^cadmus_dt_[0-9a-f]{64}$/);
	expect(secretId.startsWith("hs_")).toBe(true);
	return { secretId, token };
}

async function createDaemon(
	options: RpcOptions,
	input: {
		secretId: string;
		workspacePath: string;
		label?: string;
		persist?: boolean;
		confineToWorkspace?: boolean;
		sharedWorkspace?: boolean;
	},
) {
	return sendRpc<{ env: EnvRow }>(
		"account.toolsEnvs.create",
		{ kind: "local-daemon", ...input },
		options,
	);
}

describe("local-daemon tools env through the bot", () => {
	it("mints, lists, and deletes pairing secrets without storing plaintext", async () => {
		const options = scope("secrets");
		await sendRpc("family.update", { harvestDelayMs: 0 }, options);

		const supplied = await sendRpc(
			"account.toolsEnvSecrets.set",
			{ token: "cadmus_dt_caller" },
			options,
		);
		expect(supplied.frame.ok).toBe(false);
		expect(supplied.frame.error?.code).toBe("invalid_command");

		const { secretId, token } = await mintSecret(options, "laptop");
		const listed = await sendRpc<{ secrets: SecretMeta[] }>(
			"account.toolsEnvSecrets.list",
			{},
			options,
		);
		expect(listed.frame.ok).toBe(true);
		expect(listed.frame.result?.secrets).toEqual([
			expect.objectContaining({
				secretId,
				label: "laptop",
				kind: "daemon_token",
			}),
		]);
		const listedJson = JSON.stringify(listed.frame.result);
		expect(listedJson).not.toContain(token);
		expect(listedJson).not.toContain("cipher");
		expect(listedJson).not.toContain("iv_hex");

		const row = await env.CADMUS_ADMIN_DB.prepare(
			`SELECT token_hash, cipher_hex, iv_hex FROM cadmus_tools_env_secrets
       WHERE account_id = ? AND secret_id = ?`,
		)
			.bind(options.accountId, secretId)
			.first<{ token_hash: string; cipher_hex: string; iv_hex: string }>();
		expect(row?.token_hash).toBe(await sha256Hex(token));
		expect(row?.token_hash).not.toBe(token);
		expect(row?.cipher_hex).not.toContain(token);
		expect(row?.iv_hex).not.toContain(token);
		expect(row?.iv_hex.length).toBeGreaterThan(0);

		const columns = await env.CADMUS_ADMIN_DB.prepare(
			"PRAGMA table_info(cadmus_tools_env_secrets)",
		).all<{ name: string }>();
		expect(columns.results.map((column) => column.name)).not.toContain(
			"family_id",
		);

		const other = await mintSecret(options);
		const sharedA = await createDaemon(options, {
			secretId,
			workspacePath: "/home/dev/a",
			label: "A",
			persist: true,
			confineToWorkspace: true,
		});
		const sharedB = await createDaemon(options, {
			secretId,
			workspacePath: "/home/dev/b",
			label: "B",
			persist: false,
			confineToWorkspace: false,
		});
		const otherEnv = await createDaemon(options, {
			secretId: other.secretId,
			workspacePath: "/home/dev/c",
			label: "C",
			confineToWorkspace: true,
		});
		expect(sharedA.frame.ok).toBe(true);
		expect(sharedB.frame.ok).toBe(true);
		expect(otherEnv.frame.ok).toBe(true);
		const envA = sharedA.frame.result?.env.envId ?? "";
		const envB = sharedB.frame.result?.env.envId ?? "";
		const envC = otherEnv.frame.result?.env.envId ?? "";
		expect(envA).not.toBe(envB);
		expect(envA.startsWith("ld_")).toBe(true);
		expect(sharedA.frame.result?.env.connection).toEqual({
			status: "disconnected",
		});
		expect(sharedA.frame.result?.env.supportsConfinement).toBe(true);
		expect(sharedA.frame.result?.env.sharedWorkspace).toBe(false);
		expect(sharedB.frame.result?.env.persist).toBe(false);
		expect(sharedB.frame.result?.env.confineToWorkspace).toBe(false);

		const stored = await env.CADMUS_ADMIN_DB.prepare(
			`SELECT workspace_path, persist, confine_to_workspace, shared_workspace, secret_id
       FROM cadmus_tools_envs WHERE account_id = ? AND env_id = ?`,
		)
			.bind(options.accountId, envA)
			.first<{
				workspace_path: string;
				persist: number;
				confine_to_workspace: number;
				shared_workspace: number;
				secret_id: string;
			}>();
		expect(stored).toMatchObject({
			workspace_path: "/home/dev/a",
			persist: 1,
			confine_to_workspace: 1,
			shared_workspace: 0,
			secret_id: secretId,
		});

		const sharedRejected = await createDaemon(options, {
			secretId,
			workspacePath: "/home/dev/shared",
			sharedWorkspace: true,
			confineToWorkspace: true,
		});
		expect(sharedRejected.frame.error?.code).toBe("invalid_tools_env");
		const missingFlag = await sendRpc(
			"account.toolsEnvs.create",
			{
				kind: "local-daemon",
				label: "No flag",
				secretId,
				workspacePath: "/tmp/proj",
			},
			options,
		);
		expect(missingFlag.frame.error?.code).toBe("invalid_tools_env");
		const unknownSecret = await createDaemon(options, {
			secretId: "hs_missing",
			workspacePath: "/tmp/proj",
			confineToWorkspace: true,
		});
		expect(unknownSecret.frame.error?.code).toBe("not_found");

		await sendRpc(
			"bot.create",
			{
				slug: "pinned",
				name: "Pinned",
				model: "faux/echo",
				tools: CODING_TOOLS,
				toolsEnv: { enabled: true, binding: { envId: envA } },
			},
			options,
		);
		await sendRpc(
			"account.update",
			{ defaultToolsEnv: { envId: envA } },
			options,
		);

		const removed = await sendRpc<{ deleted: string }>(
			"account.toolsEnvSecrets.delete",
			{ secretId },
			options,
		);
		expect(removed.frame.ok).toBe(true);
		expect(removed.frame.result?.deleted).toBe(secretId);

		const after = await sendRpc<{
			default: { envId: string } | null;
			envs: EnvRow[];
		}>("account.toolsEnvs.list", {}, options);
		expect(after.frame.ok).toBe(true);
		expect(after.frame.result?.default).toBeNull();
		const rows = after.frame.result?.envs ?? [];
		const byId = new Map(rows.map((row) => [row.envId, row]));
		expect(byId.get("jb_default")?.kind).toBe("just-bash");
		expect(byId.get("jb_default")?.connection).toEqual({ status: "connected" });
		expect(byId.get("jb_default")?.supportsConfinement).toBe(true);
		expect(byId.get(envA)?.secretMissing).toBe(true);
		expect(byId.get(envA)?.secretId).toBe(secretId);
		expect(byId.get(envA)?.connection).toEqual({
			status: "disconnected",
			lastError: "secret_missing",
		});
		expect(byId.get(envB)?.secretMissing).toBe(true);
		expect(byId.get(envC)?.secretMissing).toBeUndefined();
		expect(byId.get(envC)?.secretId).toBe(other.secretId);

		const secretsLeft = await sendRpc<{ secrets: SecretMeta[] }>(
			"account.toolsEnvSecrets.list",
			{},
			options,
		);
		expect(
			secretsLeft.frame.result?.secrets.map((item) => item.secretId),
		).toEqual([other.secretId]);
		expect(JSON.stringify(secretsLeft.frame.result)).not.toContain(token);
		expect(JSON.stringify(secretsLeft.frame.result)).not.toContain(other.token);

		const bot = await sendRpc<{
			bot: { toolsEnv?: { enabled?: boolean; binding?: { envId?: string } } };
			toolsEnvLastError?: string | null;
		}>("bot.get", { botId: "pinned" }, options);
		expect(bot.frame.result?.bot.toolsEnv).toEqual({
			enabled: true,
			binding: { envId: envA },
		});
		expect(bot.frame.result?.toolsEnvLastError).toBe("secret_missing");

		const gone = await env.CADMUS_ADMIN_DB.prepare(
			`SELECT secret_id FROM cadmus_tools_env_secrets
       WHERE account_id = ? AND secret_id = ?`,
		)
			.bind(options.accountId, secretId)
			.first<{ secret_id: string }>();
		expect(gone).toBeNull();

		const flagged = await env.CADMUS_ADMIN_DB.prepare(
			`SELECT secret_missing, secret_id FROM cadmus_tools_envs
       WHERE account_id = ? AND env_id = ?`,
		)
			.bind(options.accountId, envB)
			.first<{ secret_missing: number; secret_id: string }>();
		expect(flagged).toEqual({ secret_missing: 1, secret_id: secretId });

		await sendRpc(
			"chat.create",
			{ botId: "pinned", key: "daemon-chat" },
			options,
		);
		const daemonChat = await sendRpc<{
			toolsEnvLastError?: string | null;
		}>("chat.get", { chatKey: "daemon-chat" }, options);
		expect(daemonChat.frame.ok).toBe(true);
		expect(daemonChat.frame.result?.toolsEnvLastError).toBe("secret_missing");
		const daemonStatus = await sendRpc<{
			status: {
				toolsEnv?: {
					enabled?: boolean;
					kind?: string;
					envId?: string;
					status?: string;
					lastError?: string;
				};
			};
			text: string;
		}>("turn.submit", { chatKey: "daemon-chat", text: "/status" }, options);
		expect(daemonStatus.frame.ok).toBe(true);
		expect(daemonStatus.frame.result?.status.toolsEnv).toMatchObject({
			enabled: true,
			kind: "local-daemon",
			envId: envA,
			status: "disconnected",
			lastError: "secret_missing",
		});
		expect(daemonStatus.frame.result?.text).toContain(
			`Tools env: local-daemon (${envA}, disconnected, error: secret_missing)`,
		);
		const offline = await bashResult(options, "daemon-chat", "echo hi");
		expect(offline.turnOk).toBe(true);
		expect(offline.payload?.isError).toBe(true);
		expect(offline.payload?.content ?? "").toContain("env disconnected");
		expect(offline.payload?.content ?? "").toContain("reconnects on its own");

		await sendRpc(
			"chat.create",
			{
				botId: "pinned",
				key: "bash-chat",
				toolsEnv: { enabled: true, binding: { envId: "jb_default" } },
			},
			options,
		);
		const stillBash = await bashResult(options, "bash-chat", "echo still");
		expect(stillBash.payload?.isError).toBe(false);

		const labelOnly = await sendRpc<{
			env: { secretMissing?: boolean; label?: string };
		}>(
			"account.toolsEnvs.update",
			{ envId: envA, label: "still missing" },
			options,
		);
		expect(labelOnly.frame.ok).toBe(true);
		expect(labelOnly.frame.result?.env.secretMissing).toBe(true);
		expect(labelOnly.frame.result?.env.label).toBe("still missing");

		const sameSecret = await sendRpc(
			"account.toolsEnvs.update",
			{ envId: envA, secretId },
			options,
		);
		expect(sameSecret.frame.ok).toBe(false);
		expect(sameSecret.frame.error?.code).toBe("not_found");
		const stillFlagged = await sendRpc<{ envs: EnvRow[] }>(
			"account.toolsEnvs.list",
			{},
			options,
		);
		expect(
			stillFlagged.frame.result?.envs.find((row) => row.envId === envA)
				?.secretMissing,
		).toBe(true);

		const replacement = await mintSecret(options, "replacement");
		const repaired = await sendRpc<{
			env: { secretId?: string; secretMissing?: boolean };
		}>(
			"account.toolsEnvs.update",
			{ envId: envA, secretId: replacement.secretId },
			options,
		);
		expect(repaired.frame.ok).toBe(true);
		expect(repaired.frame.result?.env.secretId).toBe(replacement.secretId);
		expect(repaired.frame.result?.env.secretMissing).toBeUndefined();
		const repairedBot = await sendRpc<{
			toolsEnvLastError?: string | null;
		}>("bot.get", { botId: "pinned" }, options);
		expect(repairedBot.frame.result?.toolsEnvLastError).toBeNull();

		const missing = await sendRpc(
			"account.toolsEnvSecrets.delete",
			{ secretId },
			options,
		);
		expect(missing.frame.error?.code).toBe("not_found");
	});

	it("fans a default change to a second family without arming an alarm or rewriting bot rows", async () => {
		const accountId = `daemon-fan-${crypto.randomUUID().slice(0, 8)}`;
		const alpha = { accountId, familyId: "alpha" };
		const beta = { accountId, familyId: "beta" };
		expect(
			(
				await sendRpc(
					"family.create",
					{ familyId: "alpha", name: "Alpha", timezone: "UTC" },
					{ accountId },
				)
			).frame.ok,
		).toBe(true);
		expect(
			(
				await sendRpc(
					"family.create",
					{ familyId: "beta", name: "Beta", timezone: "UTC" },
					{ accountId },
				)
			).frame.ok,
		).toBe(true);
		await sendRpc("family.update", { harvestDelayMs: 0 }, alpha);
		await sendRpc("family.update", { harvestDelayMs: 0 }, beta);
		await sendRpc(
			"bot.create",
			{
				slug: "assistant",
				name: "Assistant",
				model: "faux/echo",
				tools: CODING_TOOLS,
			},
			beta,
		);
		await sendRpc("chat.create", { botId: "assistant", key: "main" }, beta);
		const warmed = await bashResult(beta, "main", "echo warm");
		expect(warmed.payload?.isError).toBe(false);

		const before = await sendRpc<{
			status: { nextWakeAt: number | null };
		}>("turn.submit", { chatKey: "main", text: "/status" }, beta);
		const beforeEntries = await sendRpc<{ entries: unknown[] }>(
			"chat.entries",
			{ chatKey: "main" },
			beta,
		);
		const entryCount = beforeEntries.frame.result?.entries.length ?? 0;

		const { secretId } = await mintSecret(alpha);
		const created = await createDaemon(alpha, {
			secretId,
			workspacePath: "/srv/work",
			confineToWorkspace: true,
			persist: true,
		});
		const daemonId = created.frame.result?.env.envId ?? "";
		expect(created.frame.ok).toBe(true);

		const sibling = await connectTestWs(beta);
		try {
			sibling.events.length = 0;
			const updated = await sendRpc(
				"account.update",
				{ defaultToolsEnv: { envId: daemonId } },
				alpha,
			);
			expect(updated.frame.ok).toBe(true);
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(
				sibling.events.some((event) => event.type.startsWith("turn.")),
			).toBe(false);
		} finally {
			sibling.close();
		}

		const after = await sendRpc<{
			status: { nextWakeAt: number | null };
		}>("turn.submit", { chatKey: "main", text: "/status" }, beta);
		expect(after.frame.result?.status.nextWakeAt).toBe(
			before.frame.result?.status.nextWakeAt,
		);
		const afterEntries = await sendRpc<{ entries: unknown[] }>(
			"chat.entries",
			{ chatKey: "main" },
			beta,
		);
		expect(afterEntries.frame.result?.entries.length).toBe(entryCount);

		const view = await sendRpc<{
			bot: { toolsEnv?: unknown };
			toolsEnvEnabled?: boolean;
			toolsEnvBindingSource?: string;
			effectiveToolsEnv?: { envId?: string; kind?: string } | null;
		}>("bot.get", { botId: "assistant" }, beta);
		expect(view.frame.result?.bot.toolsEnv).toBeUndefined();
		expect(view.frame.result?.toolsEnvBindingSource).toBe("account");
		expect(view.frame.result?.effectiveToolsEnv).toMatchObject({
			envId: daemonId,
			kind: "local-daemon",
		});

		const offline = await bashResult(beta, "main", "echo later");
		expect(offline.payload?.isError).toBe(true);
		expect(offline.payload?.content ?? "").toContain("env disconnected");

		await sendRpc(
			"account.update",
			{ defaultToolsEnv: { envId: "jb_default" } },
			alpha,
		);
		const restored = await bashResult(beta, "main", "echo back");
		expect(restored.payload?.isError).toBe(false);

		await sendRpc("account.update", { defaultToolsEnv: null }, alpha);
		const removedTools = await bashResult(beta, "main", "echo gone");
		expect(removedTools.payload?.isError).toBe(true);
		expect(removedTools.payload?.content ?? "").toMatch(
			/not available|disabled/,
		);
		const stillNull = await sendRpc<{ bot: { toolsEnv?: unknown } }>(
			"bot.get",
			{ botId: "assistant" },
			beta,
		);
		expect(stillNull.frame.result?.bot.toolsEnv).toBeUndefined();
	});

	it("does not offer coding tools when the bot is off and uses the account env when the bot is on without a binding", async () => {
		const options = scope("inherit");
		await sendRpc("family.update", { harvestDelayMs: 0 }, options);
		const { secretId } = await mintSecret(options);
		const created = await createDaemon(options, {
			secretId,
			workspacePath: "/srv/account",
			confineToWorkspace: true,
		});
		const daemonId = created.frame.result?.env.envId ?? "";
		await sendRpc(
			"account.update",
			{ defaultToolsEnv: { envId: daemonId } },
			options,
		);
		await sendRpc(
			"bot.create",
			{
				slug: "off-bot",
				name: "Off",
				model: "faux/echo",
				tools: CODING_TOOLS,
				toolsEnv: { enabled: false },
			},
			options,
		);
		await sendRpc(
			"bot.create",
			{
				slug: "on-bot",
				name: "On",
				model: "faux/echo",
				tools: CODING_TOOLS,
				toolsEnv: { enabled: true },
			},
			options,
		);
		await sendRpc(
			"chat.create",
			{ botId: "off-bot", key: "off-chat" },
			options,
		);
		await sendRpc("chat.create", { botId: "on-bot", key: "on-chat" }, options);

		const hidden = await bashResult(options, "off-chat", "echo no");
		expect(hidden.payload?.isError).toBe(true);
		expect(hidden.payload?.content ?? "").toMatch(/not available|disabled/);
		expect(hidden.payload?.content ?? "").not.toContain("env disconnected");

		const onView = await sendRpc<{
			bot: { toolsEnv?: unknown };
			effectiveToolsEnv?: { envId?: string; kind?: string } | null;
			toolsEnvBindingSource?: string;
		}>("bot.get", { botId: "on-bot" }, options);
		expect(onView.frame.result?.bot.toolsEnv).toEqual({ enabled: true });
		expect(onView.frame.result?.toolsEnvBindingSource).toBe("account");
		expect(onView.frame.result?.effectiveToolsEnv?.envId).toBe(daemonId);

		const usedAccount = await bashResult(options, "on-chat", "echo yes");
		expect(usedAccount.payload?.isError).toBe(true);
		expect(usedAccount.payload?.content ?? "").toContain("env disconnected");
		expect(usedAccount.payload?.content ?? "").toContain(
			"reconnects on its own",
		);
	});

	it("reports chat.get sources for chat, bot, account, and unbound", async () => {
		const options = scope("sources");
		await sendRpc("family.update", { harvestDelayMs: 0 }, options);
		const { secretId } = await mintSecret(options);
		const created = await createDaemon(options, {
			secretId,
			workspacePath: "/workspace/laptop",
			label: "Laptop",
			persist: true,
			confineToWorkspace: true,
		});
		const daemonId = created.frame.result?.env.envId ?? "";
		await sendRpc(
			"bot.create",
			{
				slug: "assistant",
				name: "Assistant",
				model: "faux/echo",
				tools: CODING_TOOLS,
				toolsEnv: { enabled: true, binding: { envId: "jb_default" } },
			},
			options,
		);
		await sendRpc(
			"chat.create",
			{
				botId: "assistant",
				key: "chat-pin",
				toolsEnv: { enabled: true, binding: { envId: daemonId } },
			},
			options,
		);
		await sendRpc(
			"chat.create",
			{ botId: "assistant", key: "bot-pin" },
			options,
		);
		await sendRpc(
			"chat.create",
			{
				botId: "assistant",
				key: "chat-off",
				toolsEnv: { enabled: false },
			},
			options,
		);

		const chatPin = await sendRpc<{
			toolsEnvEnabled?: boolean;
			toolsEnvEnabledSource?: string;
			toolsEnvBindingSource?: string;
			effectiveToolsEnv?: {
				kind?: string;
				envId?: string;
				workspacePath?: string;
				sharedWorkspace?: boolean;
				root?: string;
			} | null;
			toolsEnvStatus?: string;
		}>("chat.get", { chatKey: "chat-pin" }, options);
		expect(chatPin.frame.result?.toolsEnvEnabled).toBe(true);
		expect(chatPin.frame.result?.toolsEnvEnabledSource).toBe("chat");
		expect(chatPin.frame.result?.toolsEnvBindingSource).toBe("chat");
		expect(chatPin.frame.result?.toolsEnvStatus).toBe("disconnected");
		expect(chatPin.frame.result?.effectiveToolsEnv).toMatchObject({
			kind: "local-daemon",
			envId: daemonId,
			workspacePath: "/workspace/laptop",
			sharedWorkspace: false,
			root: "/workspace/laptop",
			persist: true,
			confineToWorkspace: true,
		});

		const botPin = await sendRpc<{
			toolsEnvEnabledSource?: string;
			toolsEnvBindingSource?: string;
			effectiveToolsEnv?: { kind?: string; envId?: string } | null;
		}>("chat.get", { chatKey: "bot-pin" }, options);
		expect(botPin.frame.result?.toolsEnvEnabledSource).toBe("bot");
		expect(botPin.frame.result?.toolsEnvBindingSource).toBe("bot");
		expect(botPin.frame.result?.effectiveToolsEnv).toMatchObject({
			kind: "just-bash",
			envId: "jb_default",
		});

		const chatOff = await sendRpc<{
			toolsEnvEnabled?: boolean;
			toolsEnvEnabledSource?: string;
			toolsEnvBindingSource?: string;
			effectiveToolsEnv?: unknown;
		}>("chat.get", { chatKey: "chat-off" }, options);
		expect(chatOff.frame.result?.toolsEnvEnabled).toBe(false);
		expect(chatOff.frame.result?.toolsEnvEnabledSource).toBe("chat");
		expect(chatOff.frame.result?.toolsEnvBindingSource).toBe("bot");
		expect(chatOff.frame.result?.effectiveToolsEnv).toBeNull();

		await sendRpc(
			"bot.create",
			{
				slug: "inherits",
				name: "Inherits",
				model: "faux/echo",
				tools: CODING_TOOLS,
			},
			options,
		);
		await sendRpc(
			"chat.create",
			{ botId: "inherits", key: "account-chat" },
			options,
		);
		const accountPin = await sendRpc<{
			toolsEnvEnabledSource?: string;
			toolsEnvBindingSource?: string;
			effectiveToolsEnv?: { envId?: string } | null;
		}>("chat.get", { chatKey: "account-chat" }, options);
		expect(accountPin.frame.result?.toolsEnvEnabledSource).toBe("account");
		expect(accountPin.frame.result?.toolsEnvBindingSource).toBe("account");
		expect(accountPin.frame.result?.effectiveToolsEnv?.envId).toBe(
			"jb_default",
		);

		await sendRpc("account.update", { defaultToolsEnv: null }, options);
		const unbound = await sendRpc<{
			toolsEnvEnabled?: boolean;
			toolsEnvEnabledSource?: string;
			toolsEnvBindingSource?: string;
			effectiveToolsEnv?: unknown;
		}>("chat.get", { chatKey: "account-chat" }, options);
		expect(unbound.frame.result?.toolsEnvEnabled).toBe(false);
		expect(unbound.frame.result?.toolsEnvEnabledSource).toBe("unbound");
		expect(unbound.frame.result?.toolsEnvBindingSource).toBe("unbound");
		expect(unbound.frame.result?.effectiveToolsEnv).toBeNull();
	});

	it("drops a daemon chat pin without a namespace RPC and inherits just-bash", async () => {
		const options = scope("unpin");
		await sendRpc("family.update", { harvestDelayMs: 0 }, options);
		const { secretId } = await mintSecret(options);
		const created = await createDaemon(options, {
			secretId,
			workspacePath: "/srv/unpin",
			confineToWorkspace: true,
		});
		const daemonId = created.frame.result?.env.envId ?? "";
		expect(created.frame.ok).toBe(true);
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
				key: "daemon-pin",
				toolsEnv: { enabled: true, binding: { envId: daemonId } },
			},
			options,
		);
		const offline = await bashResult(options, "daemon-pin", "echo no");
		expect(offline.payload?.isError).toBe(true);
		expect(offline.payload?.content ?? "").toContain("env disconnected");

		const cleared = await sendRpc<{ chat: { toolsEnv?: unknown } }>(
			"chat.update",
			{ chatKey: "daemon-pin", toolsEnv: null },
			options,
		);
		expect(cleared.frame.ok).toBe(true);
		expect(cleared.frame.result?.chat.toolsEnv).toBeUndefined();

		const inherited = await bashResult(options, "daemon-pin", "echo hi");
		expect(inherited.payload?.isError).toBe(false);
		const view = await sendRpc<{
			toolsEnvBindingSource?: string;
			effectiveToolsEnv?: { envId?: string; kind?: string } | null;
			toolsEnvStatus?: string;
		}>("chat.get", { chatKey: "daemon-pin" }, options);
		expect(view.frame.result?.toolsEnvBindingSource).toBe("account");
		expect(view.frame.result?.effectiveToolsEnv).toMatchObject({
			envId: "jb_default",
			kind: "just-bash",
		});
		expect(view.frame.result?.toolsEnvStatus).toBe("connected");
	});

	it("rejects binding fields other than envId", async () => {
		const options = scope("bind");
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
		const extras = {
			secretId: "hs_x",
			workspacePath: "/tmp",
			persist: true,
			confineToWorkspace: true,
			sharedWorkspace: false,
			kind: "local-daemon",
			token: "cadmus_dt_nope",
		};
		for (const [key, value] of Object.entries(extras)) {
			const botUpdate = await sendRpc(
				"bot.update",
				{
					botId: "assistant",
					toolsEnv: {
						enabled: true,
						binding: { envId: "jb_default", [key]: value },
					},
				},
				options,
			);
			expect(botUpdate.frame.ok).toBe(false);
			expect(botUpdate.frame.error?.code).toBe("invalid_command");
			const chatUpdate = await sendRpc(
				"chat.update",
				{
					chatKey: "main",
					toolsEnv: {
						enabled: true,
						binding: { envId: "jb_default", [key]: value },
					},
				},
				options,
			);
			expect(chatUpdate.frame.ok).toBe(false);
			expect(chatUpdate.frame.error?.code).toBe("invalid_command");
		}
		const accountDefault = await sendRpc(
			"account.update",
			{ defaultToolsEnv: { envId: "jb_default", token: "nope" } },
			options,
		);
		expect(accountDefault.frame.error?.code).toBe("invalid_command");
	});

	it("pins a daemon env from create_bot and rejects an inline token", async () => {
		const options = scope("create-bot");
		await sendRpc("family.update", { harvestDelayMs: 0 }, options);
		const { secretId } = await mintSecret(options);
		const created = await createDaemon(options, {
			secretId,
			workspacePath: "/srv/peer",
			confineToWorkspace: true,
		});
		const daemonId = created.frame.result?.env.envId ?? "";
		const ws = await connectTestWs(options);
		try {
			expect(
				(
					await ws.send("bot.create", {
						slug: "parent",
						name: "Parent",
						model: "faux/echo",
						tools: ["create_bot"],
					})
				).ok,
			).toBe(true);
			expect(
				(await ws.send("chat.create", { botId: "parent", key: "parent" })).ok,
			).toBe(true);

			ws.events.length = 0;
			const leaked = await ws.send("turn.submit", {
				chatKey: "parent",
				text: `[tool:create_bot ${JSON.stringify({
					name: "Leaked",
					slug: "leaked-peer",
					tools: ["bash"],
					toolsEnv: {
						enabled: true,
						binding: { envId: daemonId, token: "cadmus_dt_inline" },
					},
				})}]`,
			});
			expect(leaked.ok).toBe(true);
			const leakedPayload = toolResults(ws.events)[0]?.payload as
				| { isError?: boolean; content?: string }
				| undefined;
			expect(leakedPayload?.isError).toBe(true);
			expect(leakedPayload?.content ?? "").toMatch(
				/rejects 'token'|additional properties/,
			);
			expect(leakedPayload?.content ?? "").toContain("token");

			ws.events.length = 0;
			const pinned = await ws.send("turn.submit", {
				chatKey: "parent",
				text: `[tool:create_bot ${JSON.stringify({
					name: "Daemon Peer",
					slug: "daemon-peer",
					tools: CODING_TOOLS,
					toolsEnv: { enabled: true, binding: { envId: daemonId } },
				})}]`,
			});
			expect(pinned.ok).toBe(true);
			const pinnedPayload = toolResults(ws.events)[0]?.payload as
				| { isError?: boolean; content?: string }
				| undefined;
			expect(pinnedPayload?.isError).toBe(false);
			expect(pinnedPayload?.content ?? "").toContain("daemon-peer");
		} finally {
			ws.close();
		}

		const missing = await sendRpc("bot.get", { botId: "leaked-peer" }, options);
		expect(missing.frame.ok).toBe(false);
		expect(missing.frame.error?.code).toBe("not_found");
		const peer = await sendRpc<{
			bot: { toolsEnv?: { binding?: { envId?: string } } };
		}>("bot.get", { botId: "daemon-peer" }, options);
		expect(peer.frame.result?.bot.toolsEnv).toEqual({
			enabled: true,
			binding: { envId: daemonId },
		});

		await sendRpc(
			"chat.create",
			{ botId: "daemon-peer", key: "peer-chat" },
			options,
		);
		const offline = await bashResult(options, "peer-chat", "echo peer");
		expect(offline.payload?.toolName).toBe("bash");
		expect(offline.payload?.isError).toBe(true);
		expect(offline.payload?.content ?? "").toContain("env disconnected");
		expect(offline.payload?.content ?? "").toContain("reconnects on its own");
	});
});
