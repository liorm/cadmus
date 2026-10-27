import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
	type RpcOptions,
	sendRpc,
	TEST_TOKEN,
	uniqueAccountId,
} from "./helpers.js";
import { ScriptedDaemon } from "./scripted-daemon.js";

const WORKSPACE = "/home/dev/workspace";

interface SecretMeta {
	secretId: string;
	label?: string;
	kind: string;
	updatedAt: number;
	createdAt?: number;
	lastUsedAt?: number;
}

function authHeaders(accountId: string): Record<string, string> {
	return {
		Authorization: `Bearer ${TEST_TOKEN}`,
		"x-account-id": accountId,
		"Content-Type": "application/json",
	};
}

async function listSecrets(accountId: string): Promise<SecretMeta[]> {
	const response = await SELF.fetch(
		"http://example.com/api/account/toolsEnvSecrets/list",
		{ headers: authHeaders(accountId) },
	);
	expect(response.status).toBe(200);
	const body = (await response.json()) as { secrets: SecretMeta[] };
	return body.secrets;
}

async function waitForLastUsed(
	accountId: string,
	secretId: string,
): Promise<number | undefined> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		const secrets = await listSecrets(accountId);
		const lastUsedAt = secrets.find(
			(secret) => secret.secretId === secretId,
		)?.lastUsedAt;
		if (typeof lastUsedAt === "number") return lastUsedAt;
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
	const secrets = await listSecrets(accountId);
	return secrets.find((secret) => secret.secretId === secretId)?.lastUsedAt;
}

describe("pairing secret metadata and revoke", () => {
	it("records created and last-used times and revokes a live daemon over REST", async () => {
		const options: RpcOptions & { accountId: string } = {
			accountId: uniqueAccountId("pair-meta"),
			familyId: "default",
		};
		await sendRpc("family.update", { harvestDelayMs: 0 }, options);

		const mintedAt = Date.now();
		const minted = await sendRpc<{
			secret: SecretMeta;
			token: string;
		}>("account.toolsEnvSecrets.set", { label: "laptop" }, options);
		expect(minted.frame.ok).toBe(true);
		const secretId = minted.frame.result?.secret.secretId ?? "";
		const token = minted.frame.result?.token ?? "";
		expect(secretId.startsWith("hs_")).toBe(true);
		expect(token.startsWith("cadmus_dt_")).toBe(true);

		const beforeUse = await listSecrets(options.accountId);
		const listed = beforeUse.find((secret) => secret.secretId === secretId);
		expect(listed).toMatchObject({
			secretId,
			label: "laptop",
			kind: "daemon_token",
		});
		expect(typeof listed?.createdAt).toBe("number");
		expect(listed?.createdAt ?? 0).toBeGreaterThanOrEqual(mintedAt - 5_000);
		expect(listed?.createdAt ?? 0).toBeLessThanOrEqual(Date.now() + 5_000);
		expect(listed?.lastUsedAt).toBeUndefined();
		expect(JSON.stringify(beforeUse)).not.toContain(token);

		const created = await sendRpc<{ env: { envId: string } }>(
			"account.toolsEnvs.create",
			{
				kind: "local-daemon",
				label: "Desk",
				workspacePath: WORKSPACE,
				secretId,
				persist: true,
				confineToWorkspace: false,
			},
			options,
		);
		expect(created.frame.ok).toBe(true);
		const envId = created.frame.result?.env.envId ?? "";

		const upgraded = await ScriptedDaemon.upgrade({ token, envId });
		expect(upgraded.status).toBe(101);
		const peer = upgraded.peer;
		if (!peer) throw new Error("missing peer");

		const lastUsedAt = await waitForLastUsed(options.accountId, secretId);
		expect(typeof lastUsedAt).toBe("number");
		expect(lastUsedAt ?? 0).toBeGreaterThanOrEqual(listed?.createdAt ?? 0);

		const stored = await env.CADMUS_ADMIN_DB.prepare(
			`SELECT created_at, last_used_at FROM cadmus_tools_env_secrets
       WHERE account_id = ?1 AND secret_id = ?2`,
		)
			.bind(options.accountId, secretId)
			.first<{ created_at: number | null; last_used_at: number | null }>();
		expect(stored?.created_at).toBe(listed?.createdAt);
		expect(stored?.last_used_at).toBe(lastUsedAt);

		const removed = await SELF.fetch(
			"http://example.com/api/account/toolsEnvSecrets/delete",
			{
				method: "POST",
				headers: authHeaders(options.accountId),
				body: JSON.stringify({ secretId }),
			},
		);
		expect(removed.status).toBe(200);
		expect(await removed.json()).toEqual({ deleted: secretId });
		await peer.closed;
		expect(peer.closeCode).toBe(1008);
		expect(peer.closeReason).toContain("Pairing secret revoked");

		const again = await ScriptedDaemon.upgrade({ token, envId });
		expect(again.status).toBe(401);
		expect(again.peer).toBeUndefined();

		const left = await listSecrets(options.accountId);
		expect(left.some((secret) => secret.secretId === secretId)).toBe(false);

		const unknownId = `hs_${crypto.randomUUID()}`;
		const missing = await SELF.fetch(
			"http://example.com/api/account/toolsEnvSecrets/delete",
			{
				method: "POST",
				headers: authHeaders(options.accountId),
				body: JSON.stringify({ secretId: unknownId }),
			},
		);
		expect(missing.status).toBe(404);
		expect(await missing.json()).toEqual({
			error: {
				code: "not_found",
				message: `Unknown tools env secret '${unknownId}'`,
			},
		});
	}, 20_000);

	it("lets only the account owner revoke a pairing secret", async () => {
		const options: RpcOptions & { accountId: string } = {
			accountId: uniqueAccountId("pair-owner"),
			familyId: "default",
		};
		const minted = await sendRpc<{
			secret: SecretMeta;
			token: string;
		}>("account.toolsEnvSecrets.set", { label: "laptop" }, options);
		expect(minted.frame.ok).toBe(true);
		const secretId = minted.frame.result?.secret.secretId ?? "";
		const token = minted.frame.result?.token ?? "";

		const created = await sendRpc<{ env: { envId: string } }>(
			"account.toolsEnvs.create",
			{
				kind: "local-daemon",
				label: "Desk",
				workspacePath: WORKSPACE,
				secretId,
				persist: true,
				confineToWorkspace: false,
			},
			options,
		);
		expect(created.frame.ok).toBe(true);
		const envId = created.frame.result?.env.envId ?? "";

		const upgraded = await ScriptedDaemon.upgrade({ token, envId });
		expect(upgraded.status).toBe(101);
		const peer = upgraded.peer;
		if (!peer) throw new Error("missing peer");

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

		const denied = await SELF.fetch(
			"http://example.com/api/account/toolsEnvSecrets/delete",
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${memberToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ secretId }),
			},
		);
		expect(denied.status).toBe(403);
		expect(await denied.json()).toEqual({
			error: {
				code: "forbidden",
				message: "Only account owners can revoke pairing secrets",
			},
		});

		const rpcDenied = await sendRpc(
			"account.toolsEnvSecrets.delete",
			{ secretId },
			{ token: memberToken },
		);
		expect(rpcDenied.status).toBe(400);
		expect(rpcDenied.frame.ok).toBe(false);
		expect(rpcDenied.frame.error).toEqual({
			code: "forbidden",
			message: "Only account owners can revoke pairing secrets",
		});

		const still = await listSecrets(options.accountId);
		expect(still.some((secret) => secret.secretId === secretId)).toBe(true);

		const stayedOpen = await Promise.race([
			peer.closed.then(() => "closed" as const),
			new Promise<"open">((resolve) => setTimeout(() => resolve("open"), 200)),
		]);
		expect(stayedOpen).toBe("open");
		expect(peer.closeCode).toBe(0);

		const again = await ScriptedDaemon.upgrade({ token, envId });
		expect(again.status).toBe(101);
		expect(again.peer).toBeDefined();

		const removed = await SELF.fetch(
			"http://example.com/api/account/toolsEnvSecrets/delete",
			{
				method: "POST",
				headers: authHeaders(options.accountId),
				body: JSON.stringify({ secretId }),
			},
		);
		expect(removed.status).toBe(200);
		await again.peer?.closed;
		expect(again.peer?.closeCode).toBe(1008);
	}, 20_000);
});
