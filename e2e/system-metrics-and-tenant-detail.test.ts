import { describe, expect, it } from "vitest";
import {
	addMemberBearer,
	adminScope,
	elevateAccessToken,
	loginDevPassword,
	sendRpc,
	useWorkerFixture,
	workerFetch,
} from "./helpers.js";

describe("System metrics, tenant detail, session revocation & infra-light grants (Issue #110)", () => {
	useWorkerFixture();

	it("returns super-admin system.metrics and system.accounts.get and forbids non-super-admins", async () => {
		const scope = await adminScope("default");
		await sendRpc(
			"bot.create",
			{ slug: "alpha-bot", name: "Alpha Bot", model: "faux/echo" },
			scope,
		);
		await sendRpc(
			"turn.submit",
			{ chatKey: "bot:alpha-bot", text: "Hello metrics!" },
			scope,
		);

		const member = await addMemberBearer({ accountId: scope.accountId });
		const deniedMetrics = await sendRpc(
			"system.metrics",
			{},
			{ token: member.token },
		);
		expect(deniedMetrics.frame.ok).toBe(false);
		expect(deniedMetrics.frame.error?.code).toBe("forbidden");

		const deniedDetail = await sendRpc(
			"system.accounts.get",
			{ accountId: scope.accountId },
			{ token: member.token },
		);
		expect(deniedDetail.frame.ok).toBe(false);
		expect(deniedDetail.frame.error?.code).toBe("forbidden");

		const boss = await loginDevPassword();
		const metrics = await sendRpc<{
			totalAccounts: number;
			activeAccounts: number;
			totalUsers: number;
			totalFamilies: number;
			activeSessions: number;
			perAccount: Array<{
				accountId: string;
				memberCount: number;
				familyCount: number;
			}>;
		}>("system.metrics", {}, { token: boss.accessToken });
		expect(metrics.frame.ok).toBe(true);
		expect(metrics.frame.result?.totalAccounts).toBeGreaterThanOrEqual(1);
		const acctMetric = metrics.frame.result?.perAccount.find(
			(a) => a.accountId === scope.accountId,
		);
		expect(acctMetric).toBeDefined();
		expect(acctMetric?.memberCount).toBeGreaterThanOrEqual(1);
		expect(acctMetric?.familyCount).toBeGreaterThanOrEqual(1);

		const detail = await sendRpc<{
			account: { id: string };
			familyCount: number;
			pendingInviteCount: number;
			activeSessionCount: number;
			connectedProviders: string[];
			auditEvents24h: number;
			activeSessions: Array<{
				id: string;
				userId: string;
				userEmail?: string;
				client: string;
			}>;
		}>(
			"system.accounts.get",
			{ accountId: scope.accountId },
			{ token: boss.accessToken },
		);
		expect(detail.frame.ok).toBe(true);
		expect(detail.frame.result?.account.id).toBe(scope.accountId);
		expect(detail.frame.result?.familyCount).toBeGreaterThanOrEqual(1);
		expect(
			detail.frame.result?.activeSessions.some(
				(s) => s.userId === member.userId,
			),
		).toBe(true);
		expect(Array.isArray(detail.frame.result?.connectedProviders)).toBe(true);

		// REST GET parity for system.metrics & system.accounts.get
		const restMetrics = await workerFetch(
			"http://example.com/api/system/metrics",
			{ headers: { Authorization: `Bearer ${boss.accessToken}` } },
		);
		expect(restMetrics.status).toBe(200);

		const restDetail = await workerFetch(
			`http://example.com/api/system/accounts/get?accountId=${encodeURIComponent(scope.accountId)}`,
			{ headers: { Authorization: `Bearer ${boss.accessToken}` } },
		);
		expect(restDetail.status).toBe(200);
	});

	it("requires elevation for system.sessions.revoke and invalidates the revoked bearer session", async () => {
		const scope = await adminScope("default");
		const member = await addMemberBearer({ accountId: scope.accountId });
		const boss = await loginDevPassword();

		const detail = await sendRpc<{
			activeSessions: Array<{ id: string; userId: string }>;
		}>(
			"system.accounts.get",
			{ accountId: scope.accountId },
			{ token: boss.accessToken },
		);
		const targetSession = detail.frame.result?.activeSessions.find(
			(s) => s.userId === member.userId,
		);
		if (!targetSession) throw new Error("expected active member session");

		// Requires super-admin elevation
		const unelevated = await sendRpc(
			"system.sessions.revoke",
			{ sessionId: targetSession.id, accountId: scope.accountId },
			{ token: boss.accessToken },
		);
		expect(unelevated.frame.ok).toBe(false);
		expect(unelevated.frame.error?.code).toBe("elevation_required");

		await elevateAccessToken(boss.accessToken);
		const revoked = await sendRpc<{ revoked: boolean; sessionId: string }>(
			"system.sessions.revoke",
			{ sessionId: targetSession.id, accountId: scope.accountId },
			{ token: boss.accessToken },
		);
		expect(revoked.frame.ok).toBe(true);
		expect(revoked.frame.result?.revoked).toBe(true);
		expect(revoked.frame.result?.sessionId).toBe(targetSession.id);

		// Member session is immediately rejected on subsequent call
		const afterRevoke = await sendRpc(
			"auth.whoami",
			{},
			{ token: member.token },
		);
		expect(afterRevoke.status).toBe(401);
	});

	it("enriches account.members.list with email/name and lets user role manage bots, families, and toolsEnvs without elevation", async () => {
		const scope = await adminScope("default");
		const member = await addMemberBearer({ accountId: scope.accountId });

		const listed = await sendRpc<{
			members: Array<{
				userId: string;
				email?: string;
				name?: string;
				role: string;
				disabledAt?: number;
			}>;
		}>("account.members.list", {}, { token: member.token });
		expect(listed.frame.ok).toBe(true);
		const selfMember = listed.frame.result?.members.find(
			(m) => m.userId === member.userId,
		);
		expect(selfMember?.email).toBe(member.email);
		expect(selfMember?.disabledAt).toBeUndefined();

		// User creates and deletes a bot group (family) without elevation
		const famCreate = await sendRpc(
			"family.create",
			{ familyId: "project-x", name: "Project X" },
			{ token: member.token },
		);
		expect(famCreate.frame.ok).toBe(true);

		const botCreate = await sendRpc(
			"bot.create",
			{ slug: "temp-bot", name: "Temp", model: "faux/echo" },
			{ token: member.token, familyId: "project-x" },
		);
		expect(botCreate.frame.ok).toBe(true);

		const botDelete = await sendRpc(
			"bot.delete",
			{ botId: "temp-bot" },
			{ token: member.token, familyId: "project-x" },
		);
		expect(botDelete.frame.ok).toBe(true);

		const famDelete = await sendRpc(
			"family.delete",
			{ familyId: "project-x" },
			{ token: member.token },
		);
		expect(famDelete.frame.ok).toBe(true);

		// User creates and deregisters a toolsEnv without elevation
		const envCreate = await sendRpc<{ env: { envId: string } }>(
			"account.toolsEnvs.create",
			{ kind: "just-bash", label: "User Sandbox", persist: true },
			{ token: member.token },
		);
		expect(envCreate.frame.ok).toBe(true);
		const envId = envCreate.frame.result?.env.envId ?? "";
		const envDel = await sendRpc(
			"account.toolsEnvs.deregister",
			{ envId },
			{ token: member.token },
		);
		expect(envDel.frame.ok).toBe(true);
	});
});
