import { describe, expect, it } from "vitest";
import {
	elevateAccessToken,
	loginDevPassword,
	provisionInvitedMember,
	sendRpc,
	useWorkerFixture,
	workerFetch,
} from "./helpers.js";

describe("member roles", () => {
	useWorkerFixture();

	it("MR-01 grant leaves the open user session", async () => {
		const admin = await provisionInvitedMember({ role: "account-admin" });
		const user = await provisionInvitedMember({
			role: "user",
			email: `both-${crypto.randomUUID()}@example.com`,
		});
		const boss = await loginDevPassword();
		await elevateAccessToken(boss.accessToken);
		await sendRpc(
			"system.members.invite",
			{ accountId: admin.accountId, email: user.email, roles: ["user"] },
			{ token: boss.accessToken },
		);
		const session = await loginDevPassword(user.email);
		await elevateAccessToken(admin.accessToken);
		const granted = await sendRpc(
			"account.members.update",
			{ userId: user.userId, op: "grant", role: "account-admin" },
			{ token: admin.accessToken, accountId: admin.accountId },
		);
		expect(granted.frame.ok).toBe(true);
		const listed = await sendRpc<{
			members: Array<{ userId: string; roles: string[] }>;
		}>(
			"account.members.list",
			{},
			{ token: admin.accessToken, accountId: admin.accountId },
		);
		expect(
			listed.frame.result?.members.find((row) => row.userId === user.userId)
				?.roles,
		).toEqual(["user", "account-admin"]);
		const who = await sendRpc<{
			principal: { role?: string; accountId?: string };
		}>(
			"auth.whoami",
			{},
			{ token: session.accessToken, accountId: admin.accountId },
		);
		expect(who.frame.result?.principal.role).toBe("user");
		expect(who.frame.result?.principal.accountId).toBe(admin.accountId);
	});

	it("MR-02 grant needs elevate and a user hat is forbidden", async () => {
		const admin = await provisionInvitedMember({ role: "account-admin" });
		const user = await provisionInvitedMember({ role: "user" });
		const boss = await loginDevPassword();
		await elevateAccessToken(boss.accessToken);
		await sendRpc(
			"system.members.update",
			{
				accountId: admin.accountId,
				userId: user.userId,
				op: "grant",
				role: "user",
			},
			{ token: boss.accessToken },
		);
		const plain = await sendRpc(
			"account.members.update",
			{ userId: user.userId, op: "grant", role: "account-admin" },
			{ token: admin.accessToken, accountId: admin.accountId },
		);
		expect(plain.frame.error?.code).toBe("elevation_required");
		const asUser = await loginDevPassword(user.email);
		const refused = await sendRpc(
			"account.members.update",
			{ userId: admin.userId, op: "grant", role: "user" },
			{ token: asUser.accessToken, accountId: user.accountId },
		);
		expect(refused.frame.error?.code).toBe("forbidden");
	});

	it("MR-03 revoke admin leaving user, refuse the last admin", async () => {
		const admin = await provisionInvitedMember({ role: "account-admin" });
		const boss = await loginDevPassword();
		await elevateAccessToken(boss.accessToken);
		const email = `second-${crypto.randomUUID()}@example.com`;
		await sendRpc(
			"system.members.invite",
			{ accountId: admin.accountId, email, roles: ["user", "account-admin"] },
			{ token: boss.accessToken },
		);
		const second = await loginDevPassword(email);
		const who = await sendRpc<{ principal: { userId?: string } }>(
			"auth.whoami",
			{},
			{ token: second.accessToken },
		);
		const secondId = who.frame.result?.principal.userId ?? "";
		await elevateAccessToken(admin.accessToken);
		const revoked = await sendRpc(
			"account.members.update",
			{ userId: secondId, op: "revoke", role: "account-admin" },
			{ token: admin.accessToken, accountId: admin.accountId },
		);
		expect(revoked.frame.ok, JSON.stringify(revoked.frame)).toBe(true);
		const listed = await sendRpc<{
			members: Array<{ userId: string; roles: string[] }>;
		}>(
			"account.members.list",
			{},
			{ token: admin.accessToken, accountId: admin.accountId },
		);
		expect(
			listed.frame.result?.members.find((row) => row.userId === secondId)
				?.roles,
		).toEqual(["user"]);
		for (const row of listed.frame.result?.members ?? []) {
			if (row.userId === admin.userId) continue;
			if (!row.roles.includes("account-admin")) continue;
			const gone = await sendRpc(
				"account.members.remove",
				{ userId: row.userId },
				{ token: admin.accessToken, accountId: admin.accountId },
			);
			expect(gone.frame.ok, JSON.stringify(gone.frame)).toBe(true);
		}
		await sendRpc(
			"account.members.update",
			{ userId: admin.userId, op: "grant", role: "user" },
			{ token: admin.accessToken, accountId: admin.accountId },
		);
		const last = await sendRpc(
			"account.members.update",
			{ userId: admin.userId, op: "revoke", role: "account-admin" },
			{ token: admin.accessToken, accountId: admin.accountId },
		);
		expect(last.frame.ok).toBe(false);
		expect(JSON.stringify(last.frame)).toContain("last_admin");
		const still = await sendRpc<{
			members: Array<{ userId: string; roles: string[] }>;
		}>(
			"account.members.list",
			{},
			{ token: admin.accessToken, accountId: admin.accountId },
		);
		expect(
			still.frame.result?.members.find((row) => row.userId === admin.userId)
				?.roles,
		).toContain("account-admin");
	});

	it("MR-04 last role stays, remove drops the session", async () => {
		const admin = await provisionInvitedMember({ role: "account-admin" });
		const boss = await loginDevPassword();
		await elevateAccessToken(boss.accessToken);
		const email = `only-${crypto.randomUUID()}@example.com`;
		await sendRpc(
			"system.members.invite",
			{ accountId: admin.accountId, email, roles: ["user"] },
			{ token: boss.accessToken },
		);
		const session = await loginDevPassword(email);
		const whoUser = await sendRpc<{ principal: { userId?: string } }>(
			"auth.whoami",
			{},
			{ token: session.accessToken },
		);
		const userId = whoUser.frame.result?.principal.userId ?? "";
		await elevateAccessToken(admin.accessToken);
		const last = await sendRpc(
			"account.members.update",
			{ userId, op: "revoke", role: "user" },
			{ token: admin.accessToken, accountId: admin.accountId },
		);
		expect(last.frame.ok).toBe(false);
		const removed = await sendRpc(
			"account.members.remove",
			{ userId },
			{ token: admin.accessToken, accountId: admin.accountId },
		);
		expect(removed.frame.ok).toBe(true);
		const who = await sendRpc(
			"auth.whoami",
			{},
			{ token: session.accessToken },
		);
		expect(who.frame.ok).toBe(false);
	});

	it("MR-05 super-admin and system are refused", async () => {
		const admin = await provisionInvitedMember({ role: "account-admin" });
		await elevateAccessToken(admin.accessToken);
		const grant = await sendRpc(
			"account.members.update",
			{ userId: admin.userId, op: "grant", role: "super-admin" },
			{ token: admin.accessToken, accountId: admin.accountId },
		);
		expect(grant.frame.ok).toBe(false);
		const revoke = await sendRpc(
			"account.members.update",
			{ userId: admin.userId, op: "revoke", role: "super-admin" },
			{ token: admin.accessToken, accountId: admin.accountId },
		);
		expect(revoke.frame.ok).toBe(false);
		const boss = await loginDevPassword();
		await elevateAccessToken(boss.accessToken);
		const system = await sendRpc(
			"system.members.update",
			{ accountId: "system", userId: admin.userId, op: "grant", role: "user" },
			{ token: boss.accessToken },
		);
		expect(system.frame.ok).toBe(false);
	});

	it("MR-06 super-admin grant needs elevate and cannot read the tenant", async () => {
		const user = await provisionInvitedMember({ role: "user" });
		const boss = await loginDevPassword();
		const plain = await sendRpc(
			"system.members.update",
			{
				accountId: user.accountId,
				userId: user.userId,
				op: "grant",
				role: "account-admin",
			},
			{ token: boss.accessToken },
		);
		expect(plain.frame.error?.code).toBe("elevation_required");
		await elevateAccessToken(boss.accessToken);
		const granted = await sendRpc(
			"system.members.update",
			{
				accountId: user.accountId,
				userId: user.userId,
				op: "grant",
				role: "account-admin",
			},
			{ token: boss.accessToken },
		);
		expect(granted.frame.ok).toBe(true);
		const revoked = await sendRpc(
			"system.members.update",
			{
				accountId: user.accountId,
				userId: user.userId,
				op: "revoke",
				role: "account-admin",
			},
			{ token: boss.accessToken },
		);
		expect(revoked.frame.ok).toBe(true);
		const tenant = await sendRpc(
			"family.list",
			{},
			{ token: boss.accessToken },
		);
		expect(tenant.frame.error?.code).toBe("forbidden");
	});

	it("MR-07 invite roles", async () => {
		const admin = await provisionInvitedMember({ role: "account-admin" });
		await elevateAccessToken(admin.accessToken);
		const both = `both-${crypto.randomUUID()}@example.com`;
		const plain = `plain-${crypto.randomUUID()}@example.com`;
		expect(
			(
				await sendRpc(
					"account.members.invite",
					{ email: both, roles: ["user", "account-admin"] },
					{ token: admin.accessToken, accountId: admin.accountId },
				)
			).frame.ok,
		).toBe(true);
		expect(
			(
				await sendRpc(
					"account.members.invite",
					{ email: plain },
					{ token: admin.accessToken, accountId: admin.accountId },
				)
			).frame.ok,
		).toBe(true);
		await loginDevPassword(both);
		await loginDevPassword(plain);
		const listed = await sendRpc<{ members: Array<{ roles: string[] }> }>(
			"account.members.list",
			{},
			{ token: admin.accessToken, accountId: admin.accountId },
		);
		const roles = (listed.frame.result?.members ?? []).map((row) =>
			row.roles.join("+"),
		);
		expect(roles).toContain("user+account-admin");
		expect(roles).toContain("user");
	});

	it("MR-08 add, repeat grant, revoke missing role", async () => {
		const admin = await provisionInvitedMember({ role: "account-admin" });
		await elevateAccessToken(admin.accessToken);
		const userId = `usr_${crypto.randomUUID()}`;
		const added = await sendRpc(
			"account.members.add",
			{ userId, roles: ["user", "account-admin"] },
			{ token: admin.accessToken, accountId: admin.accountId },
		);
		expect(added.frame.ok).toBe(true);
		const again = await sendRpc(
			"account.members.update",
			{ userId, op: "grant", role: "user" },
			{ token: admin.accessToken, accountId: admin.accountId },
		);
		expect(again.frame.ok).toBe(true);
		const listed = await sendRpc<{
			members: Array<{ userId: string; roles: string[] }>;
		}>(
			"account.members.list",
			{},
			{ token: admin.accessToken, accountId: admin.accountId },
		);
		const row = listed.frame.result?.members.find(
			(member) => member.userId === userId,
		);
		expect(row?.roles).toEqual(["user", "account-admin"]);
		const plainId = `usr_${crypto.randomUUID()}`;
		expect(
			(
				await sendRpc(
					"account.members.add",
					{ userId: plainId, roles: ["user"] },
					{ token: admin.accessToken, accountId: admin.accountId },
				)
			).frame.ok,
		).toBe(true);
		const missing = await sendRpc(
			"account.members.update",
			{ userId: plainId, op: "revoke", role: "account-admin" },
			{ token: admin.accessToken, accountId: admin.accountId },
		);
		expect(missing.frame.ok).toBe(true);
		expect(missing.frame.result).toMatchObject({ updated: false });
		const absent = await sendRpc(
			"account.members.update",
			{ userId, op: "revoke", role: "user" },
			{ token: admin.accessToken, accountId: admin.accountId },
		);
		expect(absent.frame.ok).toBe(true);
		const second = await sendRpc(
			"account.members.update",
			{ userId, op: "revoke", role: "user" },
			{ token: admin.accessToken, accountId: admin.accountId },
		);
		expect(second.frame.ok).toBe(true);
		expect(second.frame.result).toMatchObject({ updated: false });
	});

	it("MR-09 service token loses members.manage when admin is revoked", async () => {
		const boss = await loginDevPassword();
		await elevateAccessToken(boss.accessToken);
		const created = await sendRpc<{ account: { id: string } }>(
			"system.accounts.create",
			{
				name: "Clamp",
				ownerEmail: `owner-${crypto.randomUUID()}@example.com`,
			},
			{ token: boss.accessToken },
		);
		const accountId = created.frame.result?.account.id ?? "";
		const ownerEmail = `kept-${crypto.randomUUID()}@example.com`;
		await sendRpc(
			"system.members.invite",
			{ accountId, email: ownerEmail, roles: ["account-admin"] },
			{ token: boss.accessToken },
		);
		const owner = await loginDevPassword(ownerEmail);
		await elevateAccessToken(owner.accessToken);
		const minted = await sendRpc<{ token: string }>(
			"auth.tokens.create",
			{
				kind: "service",
				label: "svc",
				grants: ["members.read", "chat.use", "tokens.self", "members.manage"],
				ttlDays: 1,
			},
			{ token: owner.accessToken, accountId },
		);
		expect(minted.frame.ok, JSON.stringify(minted.frame)).toBe(true);
		const who = await sendRpc<{ principal: { userId?: string } }>(
			"auth.whoami",
			{},
			{ token: owner.accessToken, accountId },
		);
		await sendRpc(
			"system.members.update",
			{
				accountId,
				userId: who.frame.result?.principal.userId,
				op: "grant",
				role: "user",
			},
			{ token: boss.accessToken },
		);
		const peerEmail = `peer-${crypto.randomUUID()}@example.com`;
		await sendRpc(
			"system.members.invite",
			{ accountId, email: peerEmail, roles: ["account-admin"] },
			{ token: boss.accessToken },
		);
		const peer = await loginDevPassword(peerEmail);
		await elevateAccessToken(peer.accessToken);
		const revoked = await sendRpc(
			"account.members.update",
			{
				userId: who.frame.result?.principal.userId,
				op: "revoke",
				role: "account-admin",
			},
			{ token: peer.accessToken, accountId },
		);
		expect(revoked.frame.ok, JSON.stringify(revoked.frame)).toBe(true);
		const service = minted.frame.result?.token ?? "";
		const used = await sendRpc(
			"account.members.list",
			{},
			{ token: service, accountId },
		);
		expect(used.frame.ok, JSON.stringify(used.frame)).toBe(true);
		const manage = await sendRpc(
			"account.members.update",
			{ userId: who.frame.result?.principal.userId, op: "grant", role: "user" },
			{ token: service, accountId },
		);
		expect(manage.frame.ok).toBe(false);
	});

	it("MR-10 owner and member are not roles", async () => {
		const admin = await provisionInvitedMember({ role: "account-admin" });
		await elevateAccessToken(admin.accessToken);
		for (const role of ["owner", "member"]) {
			const update = await workerFetch(
				"http://example.com/api/account/members/update",
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${admin.accessToken}`,
						"Content-Type": "application/json",
						"x-account-id": admin.accountId,
					},
					body: JSON.stringify({ userId: admin.userId, op: "grant", role }),
				},
			);
			expect(update.status).toBeGreaterThanOrEqual(400);
			const invite = await workerFetch(
				"http://example.com/api/account/members/invite",
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${admin.accessToken}`,
						"Content-Type": "application/json",
						"x-account-id": admin.accountId,
					},
					body: JSON.stringify({ email: `${role}@example.com`, roles: [role] }),
				},
			);
			expect(invite.status).toBeGreaterThanOrEqual(400);
			const add = await workerFetch(
				"http://example.com/api/account/members/add",
				{
					method: "POST",
					headers: {
						Authorization: `Bearer ${admin.accessToken}`,
						"Content-Type": "application/json",
						"x-account-id": admin.accountId,
					},
					body: JSON.stringify({ userId: `usr_${role}`, roles: [role] }),
				},
			);
			expect(add.status).toBeGreaterThanOrEqual(400);
		}
	});
});
