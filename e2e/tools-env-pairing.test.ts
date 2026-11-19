import { describe, expect, it } from "vitest";
import {
	addMemberBearer,
	adminScope,
	ScriptedDaemon,
	sendRpc,
	useWorkerFixture,
	workerFetch,
} from "./helpers.js";

describe("tools-env automated pairing and registration", () => {
	useWorkerFixture();

	it("completes full pairing, key exchange, replay prevention, and deregistration", async () => {
		const { accountId, token } = await adminScope();
		const rpcOpts = { accountId, token, familyId: "default" };

		// 1. Create a local-daemon env. It starts unpaired and returns a pairing token.
		const created = await sendRpc(
			"account.toolsEnvs.create",
			{
				kind: "local-daemon",
				persist: true,
				confineToWorkspace: false,
				baseUrl: "http://example.com",
			},
			rpcOpts,
		);

		expect(created.frame.ok).toBe(true);
		const env = created.frame.result?.env;
		const envId = env?.envId ?? "";
		expect(envId).toMatch(/^ld_/);
		expect(env?.connection).toEqual({ status: "disconnected" });
		expect(created.frame.result?.pairingToken).toMatch(/^cadmus_pt_/);
		expect(created.frame.result?.command).toContain(
			"cadmus-daemon pair cadmus_pt_",
		);
		expect(created.frame.result?.expiresAt).toBeGreaterThan(Date.now());

		// 2. Request explicit re-pairing via account.toolsEnvs.pair
		const pairReq = await sendRpc(
			"account.toolsEnvs.pair",
			{
				envId,
				baseUrl: "http://example.com",
			},
			rpcOpts,
		);

		expect(pairReq.frame.ok).toBe(true);
		const pairResult = pairReq.frame.result;
		expect(pairResult?.envId).toBe(envId);
		expect(pairResult?.pairingToken).toMatch(/^cadmus_pt_/);
		expect(pairResult?.command).toContain(
			`cadmus-daemon pair ${pairResult?.pairingToken}`,
		);

		const activeToken = pairResult?.pairingToken ?? "";
		expect(activeToken).not.toBe("");

		// 3. Redeem the pairing token via POST /tools-env/pair
		const pairResponse = await workerFetch(
			"http://example.com/tools-env/pair",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					pairingToken: activeToken,
					name: "Test Laptop Rig",
				}),
			},
		);

		expect(pairResponse.status).toBe(200);
		const redeemed = (await pairResponse.json()) as {
			ok: boolean;
			token: string;
			envId: string;
			url: string;
			wsUrl: string;
			persist: boolean;
			confineToWorkspace: boolean;
			name: string;
		};

		expect(redeemed.ok).toBe(true);
		expect(redeemed.token).toMatch(/^cadmus_dk_[0-9a-f]{64}$/);
		expect(redeemed.envId).toBe(envId);
		expect(redeemed.name).toBe("Test Laptop Rig");
		expect(redeemed).not.toHaveProperty("workspacePath");

		// 4. Verify environment status in account.toolsEnvs.list
		const listed = await sendRpc("account.toolsEnvs.list", {}, rpcOpts);
		expect(listed.frame.ok).toBe(true);
		const listedEnv = listed.frame.result?.envs.find((e) => e.envId === envId);
		expect(listedEnv).toBeDefined();
		expect(listedEnv?.label).toBe("Test Laptop Rig");
		expect(listedEnv?.connection?.status).toBe("disconnected");

		// 5. Connect daemon via WebSocket with the returned permanent token
		const upgrade = await ScriptedDaemon.upgrade({
			token: redeemed.token,
			envId,
			workspace: "/tmp/run-a",
		});
		expect(upgrade.status).toBe(101);
		const live = await sendRpc("account.toolsEnvs.list", {}, rpcOpts);
		const liveEnv = live.frame.result?.envs.find((e) => e.envId === envId);
		expect(liveEnv?.connection).toMatchObject({
			status: "connected",
			workspacePath: "/tmp/run-a",
		});
		const replaced = await ScriptedDaemon.upgrade({
			token: redeemed.token,
			envId,
			workspace: "/tmp/run-b",
		});
		expect(replaced.status).toBe(101);
		const next = await sendRpc("account.toolsEnvs.list", {}, rpcOpts);
		const nextEnv = next.frame.result?.envs.find((e) => e.envId === envId);
		expect(nextEnv?.connection).toMatchObject({
			status: "connected",
			workspacePath: "/tmp/run-b",
		});
		replaced.peer?.close();
		upgrade.peer?.close();
		expect(upgrade.peer).toBeDefined();

		// 6. Test Replay Prevention: Try redeeming the same pairing token again
		const replayResponse = await workerFetch(
			"http://example.com/tools-env/pair",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					pairingToken: activeToken,
					name: "Second Attempt",
				}),
			},
		);

		expect(replayResponse.status).toBe(400);
		const replayJson = (await replayResponse.json()) as {
			error?: { code?: string };
		};
		expect(replayJson.error?.code).toBe("pairing_expired_or_invalid");

		// 7. Deregister daemon via account.toolsEnvs.deregister
		const deregister = await sendRpc(
			"account.toolsEnvs.deregister",
			{
				envId,
			},
			rpcOpts,
		);

		expect(deregister.frame.ok).toBe(true);
		expect(deregister.frame.result?.deregistered).toBe(envId);

		// 8. Verify subsequent reconnection attempt fails with 401 Unauthorized
		const reconnectAttempt = await ScriptedDaemon.upgrade({
			token: redeemed.token,
			envId,
		});
		expect(reconnectAttempt.status).toBe(401);
	});

	it("lets only the account owner deregister a daemon", async () => {
		const { accountId, token } = await adminScope();
		const rpcOpts = { accountId, token, familyId: "default" };
		const created = await sendRpc(
			"account.toolsEnvs.create",
			{
				kind: "local-daemon",
				persist: true,
				confineToWorkspace: false,
				baseUrl: "http://example.com",
			},
			rpcOpts,
		);
		expect(created.frame.ok).toBe(true);
		const envId = created.frame.result?.env?.envId ?? "";
		const pairingToken = created.frame.result?.pairingToken as string;
		const pairResponse = await workerFetch(
			"http://example.com/tools-env/pair",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ pairingToken, name: "Desk" }),
			},
		);
		expect(pairResponse.status).toBe(200);
		const redeemed = (await pairResponse.json()) as { token: string };
		const upgraded = await ScriptedDaemon.upgrade({
			token: redeemed.token,
			envId,
		});
		expect(upgraded.status).toBe(101);
		const peer = upgraded.peer;
		if (!peer) throw new Error("missing peer");

		const added = await addMemberBearer({ accountId: rpcOpts.accountId });
		expect(added.userId).toBeTruthy();

		const denied = await workerFetch(
			"http://example.com/api/account/toolsEnvs/deregister",
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${added.token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ envId }),
			},
		);
		expect(denied.status).toBe(403);
		expect(await denied.json()).toEqual({
			error: {
				code: "forbidden",
				message: expect.stringContaining("toolsEnv.manage"),
			},
		});

		const rpcDenied = await sendRpc(
			"account.toolsEnvs.deregister",
			{ envId },
			{ token: added.token },
		);
		expect(rpcDenied.status).toBe(400);
		expect(rpcDenied.frame.error).toEqual({
			code: "forbidden",
			message: expect.stringContaining("toolsEnv.manage"),
		});

		const stayedOpen = await Promise.race([
			peer.closed.then(() => "closed" as const),
			new Promise<"open">((resolve) => setTimeout(() => resolve("open"), 200)),
		]);
		expect(stayedOpen).toBe("open");

		const removed = await workerFetch(
			"http://example.com/api/account/toolsEnvs/deregister",
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"x-account-id": accountId,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ envId }),
			},
		);
		expect(removed.status).toBe(200);
		expect(await removed.json()).toEqual({ deregistered: envId });
		await peer.closed;
		expect(peer.closeCode).toBe(1008);
	});
});
