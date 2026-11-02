import { describe, expect, it } from "vitest";
import {
	connectTestWs,
	ScriptedDaemon,
	sendRpc,
	uniqueAccountId,
	useWorkerFixture,
	workerFetch,
} from "./helpers.js";

describe("tools env deregister", () => {
	useWorkerFixture();

	it("removes a just-bash env from the account and forbids members", async () => {
		const accountId = uniqueAccountId("dereg-jb");
		const options = { accountId, familyId: "default" };
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
		expect(envId.length).toBeGreaterThan(0);

		const setDefault = await sendRpc(
			"account.update",
			{ defaultToolsEnv: { envId } },
			options,
		);
		expect(setDefault.frame.ok).toBe(true);

		await sendRpc(
			"bot.create",
			{
				slug: "assistant",
				name: "Assistant",
				model: "faux/echo",
				tools: ["write"],
				toolsEnv: { enabled: true, binding: { envId } },
			},
			options,
		);
		await sendRpc("chat.create", { botId: "assistant", key: "main" }, options);
		const ws = await connectTestWs(options);
		try {
			const wrote = await ws.send("turn.submit", {
				chatKey: "main",
				text: '[tool:write {"path":"note.txt","content":"keep"}]',
			});
			expect(wrote.ok).toBe(true);
		} finally {
			ws.close();
		}

		const memberToken = crypto.randomUUID();
		const added = await sendRpc(
			"account.members.add",
			{
				userId: `member-${crypto.randomUUID()}`,
				name: "Member",
				role: "member",
				token: memberToken,
			},
			options,
		);
		expect(added.frame.ok).toBe(true);

		const denied = await sendRpc(
			"account.toolsEnvs.deregister",
			{ envId },
			{ token: memberToken },
		);
		expect(denied.frame.ok).toBe(false);
		expect(denied.frame.error?.code).toBe("forbidden");

		const stillThere = await sendRpc<{
			envs: Array<{ envId: string }>;
		}>("account.toolsEnvs.list", {}, options);
		expect(
			stillThere.frame.result?.envs.some((row) => row.envId === envId),
		).toBe(true);

		const removed = await sendRpc<{ deregistered: string }>(
			"account.toolsEnvs.deregister",
			{ envId },
			options,
		);
		expect(removed.frame.ok).toBe(true);
		expect(removed.frame.result?.deregistered).toBe(envId);

		const listed = await sendRpc<{
			default: { envId: string } | null;
			envs: Array<{ envId: string }>;
		}>("account.toolsEnvs.list", {}, options);
		expect(listed.frame.ok).toBe(true);
		expect(listed.frame.result?.envs.some((row) => row.envId === envId)).toBe(
			false,
		);
		expect(listed.frame.result?.default).toBeNull();
	});

	it("removes a paired connected daemon and closes its socket", async () => {
		const accountId = uniqueAccountId("dereg-live");
		const options = { accountId, familyId: "default" };
		await sendRpc("family.update", { harvestDelayMs: 0 }, options);
		const created = await sendRpc<{
			env: { envId: string };
			pairingToken?: string;
		}>(
			"account.toolsEnvs.create",
			{
				kind: "local-daemon",
				label: "Desk",
				persist: true,
				confineToWorkspace: false,
				baseUrl: "http://example.com",
			},
			options,
		);
		expect(created.frame.ok).toBe(true);
		const envId = created.frame.result?.env.envId ?? "";
		const pairingToken = created.frame.result?.pairingToken ?? "";
		const paired = await workerFetch("http://example.com/tools-env/pair", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ pairingToken, name: "Desk" }),
		});
		expect(paired.status).toBe(200);
		const redeemed = (await paired.json()) as { token: string };
		const upgraded = await ScriptedDaemon.upgrade({
			token: redeemed.token,
			envId,
		});
		expect(upgraded.status).toBe(101);
		const peer = upgraded.peer;
		if (!peer) throw new Error("missing peer");

		await sendRpc("account.update", { defaultToolsEnv: { envId } }, options);

		const removed = await sendRpc<{ deregistered: string }>(
			"account.toolsEnvs.deregister",
			{ envId },
			options,
		);
		expect(removed.frame.ok).toBe(true);
		expect(removed.frame.result?.deregistered).toBe(envId);
		await peer.closed;
		expect(peer.closeCode).toBe(1008);
		expect(peer.closeReason).toContain("Daemon deregistered");

		const listed = await sendRpc<{
			default: { envId: string } | null;
			envs: Array<{ envId: string }>;
		}>("account.toolsEnvs.list", {}, options);
		expect(listed.frame.result?.envs.some((row) => row.envId === envId)).toBe(
			false,
		);
		expect(listed.frame.result?.default).toBeNull();

		const again = await ScriptedDaemon.upgrade({
			token: redeemed.token,
			envId,
		});
		expect(again.status).toBe(401);
	});

	it("removes a never-connected daemon and forbids members", async () => {
		const accountId = uniqueAccountId("dereg-idle");
		const options = { accountId, familyId: "default" };
		await sendRpc("family.update", { harvestDelayMs: 0 }, options);
		const created = await sendRpc<{
			env: { envId: string; connection?: { status?: string } };
		}>(
			"account.toolsEnvs.create",
			{
				kind: "local-daemon",
				label: "Unpaired",
				persist: true,
				confineToWorkspace: false,
				baseUrl: "http://example.com",
			},
			options,
		);
		expect(created.frame.ok).toBe(true);
		const envId = created.frame.result?.env.envId ?? "";
		expect(created.frame.result?.env.connection?.status).toBe("disconnected");

		const memberToken = crypto.randomUUID();
		const added = await sendRpc(
			"account.members.add",
			{
				userId: `member-${crypto.randomUUID()}`,
				name: "Member",
				role: "member",
				token: memberToken,
			},
			options,
		);
		expect(added.frame.ok).toBe(true);

		const denied = await sendRpc(
			"account.toolsEnvs.deregister",
			{ envId },
			{ token: memberToken },
		);
		expect(denied.frame.ok).toBe(false);
		expect(denied.frame.error?.code).toBe("forbidden");

		const stillThere = await sendRpc<{
			envs: Array<{ envId: string }>;
		}>("account.toolsEnvs.list", {}, options);
		expect(
			stillThere.frame.result?.envs.some((row) => row.envId === envId),
		).toBe(true);

		const removed = await sendRpc<{ deregistered: string }>(
			"account.toolsEnvs.deregister",
			{ envId },
			options,
		);
		expect(removed.frame.ok).toBe(true);
		expect(removed.frame.result?.deregistered).toBe(envId);

		const listed = await sendRpc<{
			envs: Array<{ envId: string }>;
		}>("account.toolsEnvs.list", {}, options);
		expect(listed.frame.result?.envs.some((row) => row.envId === envId)).toBe(
			false,
		);
	});
});
