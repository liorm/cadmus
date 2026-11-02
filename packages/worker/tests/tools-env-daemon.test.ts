import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../src/store/d1-admin.js";
import {
	decodePairingToken,
	encodePairingToken,
} from "../src/tools-env/pure.js";
import { sendRpc, uniqueAccountId } from "./helpers.js";

describe("local-daemon tools env D1 storage & pairing token internals", () => {
	it("stores only a token hash in D1 and clears it on deregister", async () => {
		const accountId = uniqueAccountId("daemon-d1-hash");
		const options = { accountId, familyId: "default" };
		await sendRpc("family.update", { harvestDelayMs: 0 }, options);

		const created = await sendRpc<{
			env: { envId: string };
			pairingToken?: string;
		}>(
			"account.toolsEnvs.create",
			{
				kind: "local-daemon",
				baseUrl: "http://example.com",
				label: "A",
				persist: true,
				confineToWorkspace: true,
			},
			options,
		);
		expect(created.frame.ok).toBe(true);
		const envA = created.frame.result?.env.envId ?? "";
		const token = created.frame.result?.pairingToken ?? "";

		const decoded = decodePairingToken(token);
		expect(decoded.accountId).toBe(accountId);
		expect(decoded.envId).toBe(envA);
		expect(decoded).not.toHaveProperty("workspace");
		expect(decoded.persist).toBe(true);
		expect(decoded.confine).toBe(true);
		expect(decoded.nonce).toBeDefined();
		expect(decoded.secret).toBeDefined();

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

		const redeemed = await SELF.fetch("http://example.com/tools-env/pair", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ pairingToken: token, name: "Laptop" }),
		});
		expect(redeemed.status).toBe(200);
		const body = (await redeemed.json()) as { token: string };
		expect(body.token).toMatch(/^cadmus_dk_[0-9a-f]{64}$/);

		const stored = await env.CADMUS_ADMIN_DB.prepare(
			`SELECT workspace_path, persist, confine_to_workspace, shared_workspace, daemon_token_hash
       FROM cadmus_tools_envs WHERE account_id = ? AND env_id = ?`,
		)
			.bind(accountId, envA)
			.first<{
				workspace_path: string | null;
				persist: number;
				confine_to_workspace: number;
				shared_workspace: number;
				daemon_token_hash: string;
			}>();
		expect(stored).toMatchObject({
			workspace_path: null,
			persist: 1,
			confine_to_workspace: 1,
			shared_workspace: 0,
		});
		expect(stored?.daemon_token_hash).toBe(await sha256Hex(body.token));
		expect(stored?.daemon_token_hash).not.toBe(body.token);
		expect(JSON.stringify(stored)).not.toContain(body.token);

		const removed = await sendRpc<{ deregistered: string }>(
			"account.toolsEnvs.deregister",
			{ envId: envA },
			options,
		);
		expect(removed.frame.ok).toBe(true);

		const cleared = await env.CADMUS_ADMIN_DB.prepare(
			`SELECT daemon_token_hash FROM cadmus_tools_envs
       WHERE account_id = ? AND env_id = ?`,
		)
			.bind(accountId, envA)
			.first<{ daemon_token_hash: string | null }>();
		expect(cleared).toBeNull();
	});
});
