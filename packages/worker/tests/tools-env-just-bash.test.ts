import { env, runDurableObjectAlarm } from "cloudflare:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { describe, expect, it } from "vitest";
import type { ServerEvent } from "../src/protocol.js";
import { createProxyExecutionEnv } from "../src/tools-env/proxy-env.js";
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
	const accountId = uniqueAccountId(`env-do-${label}`);
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

describe("just-bash tools env DO & D1 internals", () => {
	it("verifies DO namespaceBytes, listStorageTables, and deregister storage cleanup", async () => {
		const options = scope("dereg-jb");
		await sendRpc("family.update", { harvestDelayMs: 0 }, options);
		const created = await sendRpc<{
			env: { envId: string; kind: string };
		}>(
			"account.toolsEnvs.create",
			{
				kind: "just-bash",
				label: "Scratch",
				persist: true,
				confineToWorkspace: true,
			},
			options,
		);
		expect(created.frame.ok).toBe(true);
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
		const ws = await connectTestWs(options);
		try {
			const wrote = await ws.send("turn.submit", {
				chatKey: "bot:assistant",
				text: '[tool:write {"path":"note.txt","content":"keep"}]',
			});
			expect(wrote.ok).toBe(true);
		} finally {
			ws.close();
		}
		expect(
			await envStub(options.accountId, envId).namespaceBytes(
				"default",
				"bot:assistant",
			),
		).toBeGreaterThan(0);
		expect(
			await envStub(options.accountId, envId).namespaceBytes(
				"default",
				"chat:main",
			),
		).toBe(0);

		const tables = await envStub(options.accountId, envId).listStorageTables();
		expect(tables).not.toContain("cadmus_env_connection");

		const removed = await sendRpc<{ deregistered: string }>(
			"account.toolsEnvs.deregister",
			{ envId },
			options,
		);
		expect(removed.frame.ok).toBe(true);
		expect(
			await envStub(options.accountId, envId).namespaceBytes(
				"default",
				"bot:assistant",
			),
		).toBe(0);
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
		}

		const five = new Uint8Array(5 * 1024 * 1024);
		const stub = envStub(accountId);
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
				chatKey: "bot:assistant",
				text: '[tool:write {"path":"shared.txt","content":"both"}]',
			});
			wsB2.events.length = 0;
			await wsB2.send("turn.submit", {
				chatKey: "bot:assistant",
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
		}
		const ws = await connectTestWs(alpha);
		try {
			await ws.send("turn.submit", {
				chatKey: "bot:assistant",
				text: '[tool:write {"path":"usage.txt","content":"bytes"}]',
			});
			await ws.send("turn.submit", {
				chatKey: "bot:assistant",
				text: '[tool:bash {"command":"echo ran"}]',
			});
			await ws.send("turn.submit", {
				chatKey: "bot:assistant",
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
			expect(
				execRows.reduce((sum, row) => sum + row.bashRuntimeMs, 0),
			).toBeGreaterThanOrEqual(0);
			expect(
				grainRows.reduce((sum, row) => sum + row.errors, 0),
			).toBeGreaterThan(0);
		}
		expect(other.reduce((sum, row) => sum + row.ops, 0)).toBe(0);
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
				tools: [...CODING_TOOLS, "read", "write", "edit", "delete"],
			},
			options,
		);
		await sendRpc(
			"chat.update",
			{
				chatKey: "bot:assistant",
				toolsEnv: { enabled: true, binding: { envId: "jb_default" } },
			},
			options,
		);
		await sendRpc(
			"turn.submit",
			{ chatKey: "bot:assistant", text: "hello before the fork" },
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
				target: { mode: "fork", chatKey: "bot:assistant" },
			},
			options,
		);
		expect(scheduled.frame.ok).toBe(true);
		await runDurableObjectAlarm(familyStub(options.accountId));
		const routes = await familyStub(options.accountId).listConversationRoutes(
			"bot:assistant",
		);
		expect(routes.length).toBeGreaterThanOrEqual(2);
		expect(routes.every((route) => route.toolsEnvEnabled)).toBe(true);

		const ws = await connectTestWs(options);
		try {
			ws.events.length = 0;
			await ws.send("turn.submit", {
				chatKey: "bot:assistant",
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
			await envStub(options.accountId).namespaceBytes(
				"default",
				"chat:bot:assistant",
			),
		).toBe(0);

		await sendRpc("family.update", { harvestDelayMs: 5000 }, options);
		await sendRpc(
			"turn.submit",
			{ chatKey: "bot:assistant", text: "please harvest this" },
			options,
		);
		await sendRpc(
			"schedule.update",
			{
				id: "harvest:bot:assistant",
				kind: "absolute",
				input: Date.now() - 1000,
				text: '[tool:bash {"command":"echo harvested > /workspace/harvested.txt"}]',
			},
			options,
		);
		const beforeHarvest = await familyStub(
			options.accountId,
		).listConversationRoutes("bot:assistant");
		await runDurableObjectAlarm(familyStub(options.accountId));
		let afterHarvest = await familyStub(
			options.accountId,
		).listConversationRoutes("bot:assistant");
		const deadline = Date.now() + 2_000;
		while (
			afterHarvest.length !== beforeHarvest.length + 1 &&
			Date.now() < deadline
		) {
			await new Promise((resolve) => setTimeout(resolve, 25));
			afterHarvest = await familyStub(options.accountId).listConversationRoutes(
				"bot:assistant",
			);
		}
		expect(afterHarvest).toHaveLength(beforeHarvest.length + 1);
		const harvestRoute = afterHarvest.find((r) => r.kind === "harvest");
		expect(harvestRoute).toBeDefined();
		expect(harvestRoute?.toolsEnvEnabled).toBe(false);
		const nonHarvestRoutes = afterHarvest.filter((r) => r.kind !== "harvest");
		expect(nonHarvestRoutes.every((route) => route.toolsEnvEnabled)).toBe(true);
		const ws2 = await connectTestWs(options);
		try {
			ws2.events.length = 0;
			await ws2.send("turn.submit", {
				chatKey: "bot:assistant",
				text: '[tool:read {"path":"harvested.txt"}]',
			});
			expect(toolIsError(ws2.events)).toBe(true);
		} finally {
			ws2.close();
		}
	});

	it("drops the unused store when persist flips and deletes removed bot namespaces", async () => {
		const options = scope("persist");
		await sendRpc("family.update", { harvestDelayMs: 0 }, options);
		const created = await sendRpc<{ env: { envId: string; persist: boolean } }>(
			"account.toolsEnvs.create",
			{ kind: "just-bash", persist: true, label: "Disk" },
			options,
		);
		const envId = created.frame.result?.env.envId ?? "";
		for (const slug of ["assistant", "doomed"]) {
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
		const ws = await connectTestWs(options);
		try {
			await ws.send("turn.submit", {
				chatKey: "bot:assistant",
				text: '[tool:write {"path":"disk.txt","content":"on-disk"}]',
			});
			await ws.send("turn.submit", {
				chatKey: "bot:doomed",
				text: '[tool:write {"path":"doom.txt","content":"gone"}]',
			});
		} finally {
			ws.close();
		}
		const stub = envStub(options.accountId, envId);
		expect(
			await stub.namespaceBytes("default", "bot:assistant"),
		).toBeGreaterThan(0);
		expect(await stub.namespaceBytes("default", "bot:doomed")).toBeGreaterThan(
			0,
		);

		const deleted = await sendRpc("bot.delete", { botId: "doomed" }, options);
		expect(deleted.frame.ok).toBe(true);
		expect(await stub.namespaceBytes("default", "bot:doomed")).toBe(0);
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

		const ws2 = await connectTestWs(options);
		try {
			await ws2.send("turn.submit", {
				chatKey: "bot:assistant",
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
});
