import { describe, expect, it } from "vitest";
import {
	elevateAccessToken,
	loginDevPassword,
	sendRpc,
	useWorkerFixture,
	WORKER_BASE_URL,
	workerFetch,
} from "./helpers.js";

describe("login methods in the contract", () => {
	useWorkerFixture();

	it("rejects system.accounts.create without ownerEmail and creates an owner with no method", async () => {
		const boss = await loginDevPassword();
		await elevateAccessToken(boss.accessToken);
		const missing = await sendRpc(
			"system.accounts.create",
			{ name: "No owner" },
			{ token: boss.accessToken },
		);
		expect(missing.frame.ok).toBe(false);
		const email = `owner-${crypto.randomUUID()}@example.com`;
		const created = await sendRpc<{ account: { id: string } }>(
			"system.accounts.create",
			{ name: "Owned", ownerEmail: email },
			{ token: boss.accessToken },
		);
		expect(created.frame.ok).toBe(true);
		const again = await sendRpc<{ account: { id: string } }>(
			"system.accounts.create",
			{ name: "Owned again", ownerEmail: email },
			{ token: boss.accessToken },
		);
		expect(again.frame.ok).toBe(true);
		expect(again.frame.result?.account.id).not.toBe(
			created.frame.result?.account.id,
		);
	});

	it("treats removed login commands and /auth paths as unknown", async () => {
		const boss = await loginDevPassword();
		for (const type of [
			"auth.methods.link.start",
			"auth.passkeys.begin",
			"account.oauth.start",
		] as const) {
			const res = await sendRpc(type, {}, { token: boss.accessToken });
			expect(res.frame.ok, type).toBe(false);
		}
		const headers = { Authorization: `Bearer ${boss.accessToken}` };
		for (const path of [
			"/auth/login/google",
			"/auth/callback/google",
			"/auth/providers",
		]) {
			const res = await workerFetch(`${WORKER_BASE_URL}${path}`, { headers });
			expect(res.status, path).toBe(404);
		}
		for (const path of [
			"/auth/login/dev-password",
			"/auth/token-login",
			"/auth/refresh",
		]) {
			const res = await workerFetch(`${WORKER_BASE_URL}${path}`, {
				method: "POST",
				headers,
			});
			expect(res.status, path).toBe(404);
		}
	});

	it("refuses dev-password on a non-local host", async () => {
		const res = await workerFetch(
			"https://example.com/api/auth/login/devPassword",
			{
				method: "POST",
				headers: {
					Origin: "https://example.com",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					type: "auth.login.devPassword",
					payload: { password: "dev-pass" },
				}),
			},
		);
		expect(res.status).toBe(500);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("dev_password_unsafe_environment");
	});

	it("auth.methods.delete refuses the last method", async () => {
		const boss = await loginDevPassword();
		await elevateAccessToken(boss.accessToken);
		const email = `sole-${crypto.randomUUID()}@example.com`;
		const created = await sendRpc<{ account: { id: string } }>(
			"system.accounts.create",
			{ name: "Sole", ownerEmail: email },
			{ token: boss.accessToken },
		);
		expect(created.frame.ok).toBe(true);
		const owner = await loginDevPassword(email);
		const listed = await sendRpc<{ methods: { id: string }[] }>(
			"auth.methods.list",
			{},
			{ token: owner.accessToken },
		);
		expect(listed.frame.ok).toBe(true);
		const methodId = listed.frame.result?.methods[0]?.id ?? "";
		expect(methodId).not.toBe("");
		const deleted = await sendRpc(
			"auth.methods.delete",
			{ methodId },
			{ token: owner.accessToken },
		);
		expect(deleted.frame.ok).toBe(false);
		expect(JSON.stringify(deleted.frame)).toContain("last_login_method");
		const still = await sendRpc<{ methods: unknown[] }>(
			"auth.methods.list",
			{},
			{ token: owner.accessToken },
		);
		expect(still.frame.result?.methods).toHaveLength(1);
	});
});
