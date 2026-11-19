import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getEdgeCache } from "../src/edge-cache.js";
import { D1AdminStore } from "../src/store/d1-admin.js";
import { rpc, uniqueAccountId } from "./helpers.js";

function store(): D1AdminStore {
	return new D1AdminStore({
		db: env.CADMUS_ADMIN_DB,
		encryptionKey: env.CADMUS_ENCRYPTION_KEY,
		edgeCache: getEdgeCache(env),
	});
}

async function setup() {
	const s = store();
	const accountId = uniqueAccountId("mem");
	const admin = `usr_a_${accountId}`;
	const second = `usr_b_${accountId}`;
	const member = `usr_m_${accountId}`;
	await s.ensureAccountAndUser({
		accountId,
		userId: admin,
		role: "account-admin",
	});
	await s.ensureAccountAndUser({
		accountId,
		userId: second,
		role: "account-admin",
	});
	await s.ensureAccountAndUser({ accountId, userId: member, role: "user" });
	await s.updateMemberRole({
		accountId,
		userId: admin,
		op: "grant",
		role: "user",
		actor: admin,
	});
	await s.updateMemberRole({
		accountId,
		userId: second,
		op: "grant",
		role: "user",
		actor: admin,
	});
	// Admin sessions are in admin mode, which members.manage needs.
	const as = async (userId: string) => {
		const session = await s.createSession({
			userId,
			accountId,
			activeRole: userId === member ? "user" : "account-admin",
		});
		if (userId !== member) await s.startElevation(session.sessionId);
		return session.accessToken;
	};
	return { s, accountId, admin, second, member, as };
}

describe("last-admin and last-method guards are atomic (issue #3 review R8)", () => {
	it("two concurrent removals or demotions of the two admins leave one", async () => {
		for (const mode of ["remove", "demote"] as const) {
			const { s, accountId, admin, second } = await setup();
			const act = (userId: string) =>
				mode === "remove"
					? s.removeMember({ accountId, userId, actor: admin })
					: s.updateMemberRole({
							accountId,
							userId,
							op: "revoke",
							role: "account-admin",
							actor: admin,
						});
			const results = await Promise.all([act(admin), act(second)]);
			expect(results.filter((r) => r.ok).length).toBe(1);
			const row = await env.CADMUS_ADMIN_DB.prepare(
				`SELECT COUNT(*) AS n FROM cadmus_member_roles
         WHERE account_id = ?1 AND role = 'account-admin'`,
			)
				.bind(accountId)
				.first<{ n: number }>();
			expect(row?.n).toBe(1);
			// The losing call wrote no audit row.
			const audits = await env.CADMUS_ADMIN_DB.prepare(
				`SELECT COUNT(*) AS n FROM cadmus_audit WHERE account_id = ?1 AND action IN ('member.remove','member.role.revoke')`,
			)
				.bind(accountId)
				.first<{ n: number }>();
			expect(audits?.n).toBe(1);
		}
	});

	it("two concurrent revokes of a user's two login methods leave one", async () => {
		const { s, userId } = await (async () => {
			const x = await setup();
			return { s: x.s, userId: x.admin };
		})();
		const now = Date.now();
		const ids = [`lm_a_${userId}`, `lm_b_${userId}`];
		for (const id of ids) {
			await env.CADMUS_ADMIN_DB.prepare(
				`INSERT INTO cadmus_login_methods (id, user_id, provider, subject, display, created_at)
         VALUES (?1, ?2, 'google', ?1, ?1, ?3)`,
			)
				.bind(id, userId, now)
				.run();
		}
		const results = await Promise.all(
			ids.map((id) => s.revokeLoginMethod(userId, id)),
		);
		expect(results.filter((r) => r.ok).length).toBe(1);
		const left = await env.CADMUS_ADMIN_DB.prepare(
			`SELECT COUNT(*) AS n FROM cadmus_login_methods WHERE user_id = ?1 AND revoked_at IS NULL`,
		)
			.bind(userId)
			.first<{ n: number }>();
		expect(left?.n).toBe(1);
	});
});

describe("members and invites (issue #3 phase 4)", () => {
	it("invites, lists and revokes; users cannot invite; duplicates conflict", async () => {
		const { admin, member, as } = await setup();
		const adminToken = await as(admin);
		const created = await rpc(adminToken, "account.members.invite", {
			email: "New.Person@Example.com",
		});
		expect(created.ok, JSON.stringify(created)).toBe(true);
		expect(created.result?.invite).toMatchObject({
			email: "new.person@example.com",
			roles: ["user"],
		});
		const dup = await rpc(adminToken, "account.members.invite", {
			email: "new.person@example.com",
		});
		expect(dup.ok).toBe(false);
		const listed = await rpc(adminToken, "account.invites.list");
		expect(listed.result?.invites).toHaveLength(1);
		const denied = await rpc(await as(member), "account.members.invite", {
			email: "x@example.com",
		});
		expect(denied.ok).toBe(false);
		const revoked = await rpc(adminToken, "account.invites.revoke", {
			inviteId: created.result?.invite.id ?? "",
		});
		expect(revoked.result).toEqual({ revoked: true });
		const bad = await rpc(adminToken, "account.members.invite", {
			email: "not-an-email",
		});
		expect(bad.ok).toBe(false);
	});

	it("demoting an admin revokes their account-admin sessions", async () => {
		const { s, accountId, admin, second, as } = await setup();
		const secondToken = await as(second);
		const res = await rpc(await as(admin), "account.members.update", {
			userId: second,
			op: "revoke",
			role: "account-admin",
		});
		expect(res.result, JSON.stringify(res)).toEqual({ updated: true });
		expect((await rpc(secondToken, "auth.sessions.list")).ok).not.toBe(true);
		const row = await env.CADMUS_ADMIN_DB.prepare(
			`SELECT revoked_at FROM cadmus_sessions
        WHERE account_id = ?1 AND user_id = ?2`,
		)
			.bind(accountId, second)
			.first<{ revoked_at: number | null }>();
		expect(row?.revoked_at).not.toBeNull();
		const members = await s.listMembers(accountId);
		expect(members.find((m) => m.userId === second)?.roles).toEqual(["user"]);
	});

	it("keeps the last account-admin", async () => {
		const { s, accountId, admin, second, as } = await setup();
		const token = await as(admin);
		expect(
			(await rpc(token, "account.members.remove", { userId: second })).ok,
		).toBe(true);
		const demote = await rpc(token, "account.members.update", {
			userId: admin,
			op: "revoke",
			role: "account-admin",
		});
		expect(demote.ok, JSON.stringify(demote)).toBe(false);
		expect(JSON.stringify(demote)).toContain("last_admin");
		const remove = await rpc(token, "account.members.remove", {
			userId: admin,
		});
		expect(remove.ok).toBe(false);
		expect(
			(await s.listMembers(accountId)).some((m) => m.userId === admin),
		).toBe(true);
	});

	it("keeps the last active account-admin when another admin is disabled", async () => {
		const { s, accountId, admin, second } = await setup();

		// Disable the second admin. Only `admin` remains active.
		await env.CADMUS_ADMIN_DB.prepare(
			"UPDATE cadmus_users SET disabled_at = ?2 WHERE id = ?1",
		)
			.bind(second, Date.now())
			.run();

		// Removing or demoting the sole active admin must fail with last_admin
		// rather than deleting the membership and assigning NULL to user_id.
		const removedActive = await s.removeMember({
			accountId,
			userId: admin,
			actor: admin,
		});
		expect(removedActive).toMatchObject({
			ok: false,
			code: "conflict",
		});
		expect(removedActive.ok ? "" : removedActive.message).toContain(
			"last_admin",
		);
		await s.updateMemberRole({
			accountId,
			userId: admin,
			op: "grant",
			role: "user",
			actor: admin,
		});
		const demotedActive = await s.updateMemberRole({
			accountId,
			userId: admin,
			op: "revoke",
			role: "account-admin",
			actor: admin,
		});
		expect(demotedActive).toMatchObject({
			ok: false,
			code: "conflict",
		});
		expect(demotedActive.ok ? "" : demotedActive.message).toContain(
			"last_admin",
		);

		// Removing the disabled admin is still allowed because `admin` is active.
		const removedDisabled = await s.removeMember({
			accountId,
			userId: second,
			actor: admin,
		});
		expect(removedDisabled).toMatchObject({ ok: true, changed: true });
	});

	it("removal ends the member's sessions", async () => {
		const { admin, member, as } = await setup();
		const memberToken = await as(member);
		const res = await rpc(await as(admin), "account.members.remove", {
			userId: member,
		});
		expect(res.result?.removed).toBe(true);
		expect(res.result?.sessionsRevoked).toBe(1);
		expect((await rpc(memberToken, "auth.sessions.list")).ok).not.toBe(true);
	});

	it("refuses API-token and prefix-less bearers", async () => {
		for (const token of ["cad_pat_x", "cad_svc_x", "not-a-session-secret"]) {
			const res = await rpc(token, "family.list");
			expect(res.ok, token).not.toBe(true);
		}
	});
});
