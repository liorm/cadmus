import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
	decodePairingToken,
	encodePairingToken,
} from "../packages/worker/src/tools-env/pure.js";
import { sendRpc, uniqueAccountId } from "./helpers.js";
import { ScriptedDaemon } from "./scripted-daemon.js";

describe("tools-env automated pairing and registration", () => {
	it("completes full pairing, key exchange, replay prevention, and deregistration", async () => {
		const accountId = uniqueAccountId("pairing");
		const rpcOpts = { accountId, familyId: "default" };

		// 1. Create a local-daemon env without a secretId (unpaired)
		const created = await sendRpc(
			"account.toolsEnvs.create",
			{
				kind: "local-daemon",
				workspacePath: "/tmp/project",
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
		expect(env?.secretMissing).toBe(true);
		expect(created.frame.result?.pairingToken).toMatch(/^cadmus_pt_/);
		expect(created.frame.result?.command).toContain(
			"cadmus-daemon pair cadmus_pt_",
		);
		expect(created.frame.result?.expiresAt).toBeGreaterThan(Date.now());

		const initialToken = created.frame.result?.pairingToken as string;
		const decoded = decodePairingToken(initialToken);
		expect(decoded.accountId).toBe(accountId);
		expect(decoded.envId).toBe(envId);
		expect(decoded.workspace).toBe("/tmp/project");
		expect(decoded.persist).toBe(true);
		expect(decoded.confine).toBe(false);
		expect(decoded.nonce).toBeDefined();
		expect(decoded.secret).toBeDefined();

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
		const pairResponse = await SELF.fetch("http://example.com/tools-env/pair", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				pairingToken: activeToken,
				name: "Test Laptop Rig",
			}),
		});

		expect(pairResponse.status).toBe(200);
		const redeemed = (await pairResponse.json()) as {
			ok: boolean;
			token: string;
			envId: string;
			url: string;
			wsUrl: string;
			workspacePath: string;
			persist: boolean;
			confineToWorkspace: boolean;
			name: string;
		};

		expect(redeemed.ok).toBe(true);
		expect(redeemed.token).toMatch(/^cadmus_dt_[0-9a-f]{64}$/);
		expect(redeemed.envId).toBe(envId);
		expect(redeemed.name).toBe("Test Laptop Rig");
		expect(redeemed.workspacePath).toBe("/tmp/project");

		// 4. Verify environment status in account.toolsEnvs.list
		const listed = await sendRpc("account.toolsEnvs.list", {}, rpcOpts);
		expect(listed.frame.ok).toBe(true);
		const listedEnv = listed.frame.result?.envs.find((e) => e.envId === envId);
		expect(listedEnv).toBeDefined();
		expect(listedEnv?.label).toBe("Test Laptop Rig");
		expect(listedEnv?.secretMissing).toBeFalsy();
		expect(listedEnv?.secretId).toBeDefined();

		// 5. Connect daemon via WebSocket with the returned permanent token
		const upgrade = await ScriptedDaemon.upgrade({
			token: redeemed.token,
			envId,
		});
		expect(upgrade.status).toBe(101);
		expect(upgrade.peer).toBeDefined();

		// 6. Test Replay Prevention: Try redeeming the same pairing token again
		const replayResponse = await SELF.fetch(
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

		// 7. Test Expiration: Attempt redemption with an expired token
		const expiredToken = encodePairingToken({
			...decoded,
			exp: Date.now() - 5000,
		});
		const expiredResponse = await SELF.fetch(
			"http://example.com/tools-env/pair",
			{
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					pairingToken: expiredToken,
					name: "Expired Attempt",
				}),
			},
		);

		expect(expiredResponse.status).toBe(400);
		const expiredJson = (await expiredResponse.json()) as {
			error?: { code?: string };
		};
		expect(expiredJson.error?.code).toBe("pairing_expired");

		// 8. Deregister daemon via account.toolsEnvs.deregister
		const deregister = await sendRpc(
			"account.toolsEnvs.deregister",
			{
				envId,
			},
			rpcOpts,
		);

		expect(deregister.frame.ok).toBe(true);
		expect(deregister.frame.result?.deregistered).toBe(envId);

		// 9. Verify subsequent reconnection attempt fails with 401 Unauthorized
		const reconnectAttempt = await ScriptedDaemon.upgrade({
			token: redeemed.token,
			envId,
		});
		expect(reconnectAttempt.status).toBe(401);
	});
});
