import { describe, expect, it } from "vitest";
import {
	addMemberBearer,
	adminScope,
	connectTestWs,
	loginDevPassword,
	ScriptedDaemon,
	sendRpc,
	useWorkerFixture,
	workerFetch,
} from "./helpers.js";

describe("tools env deregister", () => {
	useWorkerFixture();

	it("removes a just-bash env from the account and forbids members", async () => {
		const options = await adminScope("default");
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

		const other = await adminScope();
		const denied = await sendRpc(
			"account.toolsEnvs.deregister",
			{ envId },
			{ accountId: other.accountId, token: other.token },
		);
		expect(denied.frame.ok).toBe(false);
		expect(denied.frame.error?.code).toBe("not_found");

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
		const options = await adminScope("default");
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

	it("removes a never-connected daemon as user member without elevation and forbids super-admin", async () => {
		const options = await adminScope("default");
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

		const boss = await loginDevPassword();
		const denied = await sendRpc(
			"account.toolsEnvs.deregister",
			{ envId },
			{ token: boss.accessToken },
		);
		expect(denied.frame.ok).toBe(false);
		expect(denied.frame.error?.code).toBe("forbidden");

		const stillThere = await sendRpc<{
			envs: Array<{ envId: string }>;
		}>("account.toolsEnvs.list", {}, options);
		expect(
			stillThere.frame.result?.envs.some((row) => row.envId === envId),
		).toBe(true);

		const member = await addMemberBearer({ accountId: options.accountId });
		expect(member.userId).toBeTruthy();
		const removed = await sendRpc<{ deregistered: string }>(
			"account.toolsEnvs.deregister",
			{ envId },
			{ token: member.token },
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
