import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getEdgeCache } from "../src/edge-cache.js";
import { D1AdminStore } from "../src/store/d1-admin.js";
import { rpc, uniqueAccountId } from "./helpers.js";

const ORIGIN = "https://example.com";

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

	it("demoting an admin revokes personal tokens and their sessions", async () => {
		const { s, accountId, admin, second, as } = await setup();
		const secondToken = await as(second);
		const pat = await rpc(secondToken, "auth.tokens.create", {
			kind: "pat",
			label: "mine",
			grants: ["chat.use", "tokens.self"],
			ttlDays: 1,
		});
		const login = await SELF.fetch(`${ORIGIN}/api/auth/login/token`, {
			method: "POST",
			headers: { authorization: `Bearer ${pat.result?.token ?? ""}` },
		});
		const { accessToken } = (await login.json()) as { accessToken: string };
		expect((await rpc(accessToken, "auth.tokens.list")).ok).toBe(true);

		const res = await rpc(await as(admin), "account.members.update", {
			userId: second,
			op: "revoke",
			role: "account-admin",
		});
		expect(res.result, JSON.stringify(res)).toEqual({
			updated: true,
			tokensRevoked: 1,
		});
		expect((await rpc(accessToken, "auth.tokens.list")).ok).not.toBe(true);
		expect(
			(
				await SELF.fetch(`${ORIGIN}/api/auth/login/token`, {
					method: "POST",
					headers: { authorization: `Bearer ${pat.result?.token ?? ""}` },
				})
			).status,
		).toBe(401);
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

	it("keeps the last active account-admin when another admin is disabled (service-token transfer safe)", async () => {
		const { s, accountId, admin, second } = await setup();
		const svc = await s.createToken({
			accountId,
			creatorUserId: admin,
			creatorRole: "account-admin",
			creatorGrants: ["chat.use"],
			kind: "service",
			label: "keep-alive",
			grants: ["chat.use"],
		});
		if (!svc.ok) throw new Error("create failed");

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

		const tokenRow = await env.CADMUS_ADMIN_DB.prepare(
			"SELECT user_id FROM cadmus_auth_tokens WHERE id = ?1",
		)
			.bind(svc.summary.id)
			.first<{ user_id: string }>();
		expect(tokenRow?.user_id).toBe(admin);

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

	it("refuses an API token used directly as a bearer", async () => {
		const { admin, as } = await setup();
		const pat = await rpc(await as(admin), "auth.tokens.create", {
			kind: "pat",
			label: "direct",
			grants: ["chat.use"],
			ttlDays: 1,
		});
		const res = await rpc(pat.result?.token ?? "", "family.list");
		expect(res.ok).not.toBe(true);
	});
});

describe("service tokens survive creator removal (issue #3 decision 14)", () => {
	it("moves the token to an account admin and keeps its minted grants", async () => {
		const { s, accountId, admin, member } = await setup();
		const made = await s.createToken({
			accountId,
			creatorUserId: member,
			creatorRole: "user",
			creatorGrants: ["chat.use", "bot.read"],
			kind: "service",
			label: "automation",
			grants: ["chat.use"],
		});
		if (!made.ok) throw new Error("create failed");
		const pat = await s.createToken({
			accountId,
			creatorUserId: member,
			creatorRole: "user",
			creatorGrants: ["chat.use"],
			kind: "pat",
			label: "personal",
			grants: ["chat.use"],
			ttlMs: 86_400_000,
		});
		if (!pat.ok) throw new Error("create failed");
		const login = (secret: string) =>
			SELF.fetch(`${ORIGIN}/api/auth/login/token`, {
				method: "POST",
				headers: { authorization: `Bearer ${secret}` },
			});
		expect((await login(made.token)).status).toBe(200);

		const removed = await s.removeMember({
			accountId,
			userId: member,
			actor: admin,
		});
		expect(removed.ok).toBe(true);

		// The personal token dies with the creator's access; the service token lives
		// on under an admin, with only the grants it was minted with.
		expect((await login(pat.token)).status).toBe(401);
		const after = await login(made.token);
		expect(after.status).toBe(200);
		const { accessToken } = (await after.json()) as { accessToken: string };
		const who = await rpc(accessToken, "auth.whoami");
		expect(who.ok).toBe(false);
		const members = await rpc(accessToken, "account.members.list");
		expect(members.ok).toBe(false);
		const owner = await env.CADMUS_ADMIN_DB.prepare(
			"SELECT user_id, created_by FROM cadmus_auth_tokens WHERE id = ?1",
		)
			.bind(made.summary.id)
			.first<{ user_id: string; created_by: string }>();
		expect(owner?.created_by).toBe(member);
		expect([admin, `usr_b_${accountId}`]).toContain(owner?.user_id);
	});
});

describe("service-token grants only ever shrink (issue #3 decision 14)", () => {
	it("admin mint -> demote -> remove -> transfer never restores lost grants", async () => {
		const { s, accountId, admin, second, member } = await setup();
		await s.updateMemberRole({
			accountId,
			userId: member,
			op: "grant",
			role: "account-admin",
			actor: admin,
		});
		const made = await s.createToken({
			accountId,
			creatorUserId: member,
			creatorRole: "account-admin",
			creatorGrants: ["chat.use", "audit.read"],
			kind: "service",
			label: "audit bot",
			grants: ["chat.use", "audit.read"],
		});
		if (!made.ok) throw new Error(`create failed ${JSON.stringify(made)}`);
		const stored = async () =>
			JSON.parse(
				(
					await env.CADMUS_ADMIN_DB.prepare(
						"SELECT grants FROM cadmus_auth_tokens WHERE id = ?1",
					)
						.bind(made.summary.id)
						.first<{ grants: string }>()
				)?.grants ?? "[]",
			) as string[];
		expect(await stored()).toContain("audit.read");
		await s.updateMemberRole({
			accountId,
			userId: member,
			op: "revoke",
			role: "account-admin",
			actor: admin,
		});
		expect(await stored()).not.toContain("audit.read");
		await s.updateMemberRole({
			accountId,
			userId: member,
			op: "grant",
			role: "account-admin",
			actor: admin,
		});
		expect(await stored()).not.toContain("audit.read");
		await s.removeMember({ accountId, userId: member, actor: admin });
		expect(await stored()).not.toContain("audit.read");
		const audit = await env.CADMUS_ADMIN_DB.prepare(
			"SELECT action, data FROM cadmus_audit WHERE account_id = ?1 AND action = 'token.transfer'",
		)
			.bind(accountId)
			.all<{ action: string; data: string }>();
		expect(audit.results?.length).toBe(1);
		expect([admin, second]).toContain(
			JSON.parse(audit.results?.[0]?.data ?? "{}").to,
		);
	});
});

describe("credential minting cannot outrun a role change (issue #3 review C3)", () => {
	it("a mint holding a stale grant snapshot is refused after demotion, and removal then transfer keeps the clamp", async () => {
		const { s, accountId, admin, member } = await setup();
		await s.updateMemberRole({
			accountId,
			userId: member,
			op: "grant",
			role: "account-admin",
			actor: admin,
		});
		// A service token minted just before the demotion lands...
		const before = await s.createToken({
			accountId,
			creatorUserId: member,
			creatorRole: "account-admin",
			creatorGrants: ["chat.use", "audit.read"],
			kind: "service",
			label: "before",
			grants: ["chat.use", "audit.read"],
		});
		if (!before.ok) throw new Error("create failed");
		await s.updateMemberRole({
			accountId,
			userId: member,
			op: "revoke",
			role: "account-admin",
			actor: admin,
		});
		// ...is clamped by the demotion itself, and a mint that still carries the
		// old admin snapshot fails closed, leaving no credential or audit row.
		const stale = await s.createToken({
			accountId,
			creatorUserId: member,
			creatorRole: "account-admin",
			creatorGrants: ["chat.use", "audit.read"],
			kind: "service",
			label: "stale",
			grants: ["audit.read"],
		});
		expect(stale.ok).toBe(false);
		const rows = await env.CADMUS_ADMIN_DB.prepare(
			"SELECT label, grants FROM cadmus_auth_tokens WHERE account_id = ?1 ORDER BY label",
		)
			.bind(accountId)
			.all<{ label: string; grants: string }>();
		expect(rows.results?.map((r) => r.label)).toEqual(["before"]);
		expect(rows.results?.[0]?.grants).not.toContain("audit.read");
		const audits = await env.CADMUS_ADMIN_DB.prepare(
			"SELECT COUNT(*) AS n FROM cadmus_audit WHERE account_id = ?1 AND action = 'token.create'",
		)
			.bind(accountId)
			.first<{ n: number }>();
		expect(audits?.n).toBe(1);
		await s.updateMemberRole({
			accountId,
			userId: member,
			op: "grant",
			role: "account-admin",
			actor: admin,
		});
		await s.removeMember({ accountId, userId: member, actor: admin });
		const after = await env.CADMUS_ADMIN_DB.prepare(
			"SELECT grants FROM cadmus_auth_tokens WHERE id = ?1",
		)
			.bind(before.summary.id)
			.first<{ grants: string }>();
		expect(after?.grants).not.toContain("audit.read");
		expect(after?.grants).toContain("chat.use");
	});
});

describe("service-token transfers and disabled-admin orphan cleanup (review round 2)", () => {
	it("audits chained transfers accurately and does not re-audit when the original creator is re-invited and removed", async () => {
		const s = store();
		const accountId = uniqueAccountId("chain");
		const adminA = `usr_a_${accountId}`;
		const adminB = `usr_b_${accountId}`;
		const adminC = `usr_c_${accountId}`;
		await s.ensureAccountAndUser({
			accountId,
			userId: adminA,
			role: "account-admin",
		});
		await s.ensureAccountAndUser({
			accountId,
			userId: adminB,
			role: "account-admin",
		});
		await s.ensureAccountAndUser({
			accountId,
			userId: adminC,
			role: "account-admin",
		});
		const made = await s.createToken({
			accountId,
			creatorUserId: adminA,
			creatorRole: "account-admin",
			creatorGrants: ["chat.use", "bot.read"],
			kind: "service",
			label: "chained",
			grants: ["chat.use"],
		});
		if (!made.ok) throw new Error("create failed");

		// 1. Remove A -> transfers to B (lowest sorted admin id).
		const remA1 = await s.removeMember({
			accountId,
			userId: adminA,
			actor: adminB,
		});
		expect(remA1).toMatchObject({ ok: true, changed: true });

		// 2. Re-invite/add A as a regular user and remove A again -> must NOT write a bogus transfer audit.
		await s.ensureAccountAndUser({
			accountId,
			userId: adminA,
			role: "user",
		});
		const remA2 = await s.removeMember({
			accountId,
			userId: adminA,
			actor: adminB,
		});
		expect(remA2).toMatchObject({ ok: true, changed: true });

		// 3. Remove B -> transfers to C and MUST write a B -> C token.transfer audit row.
		const remB = await s.removeMember({
			accountId,
			userId: adminB,
			actor: adminC,
		});
		expect(remB).toMatchObject({ ok: true, changed: true });

		const transfers = await env.CADMUS_ADMIN_DB.prepare(
			`SELECT data FROM cadmus_audit
        WHERE account_id = ?1 AND action = 'token.transfer' AND target = ?2
        ORDER BY rowid`,
		)
			.bind(accountId, made.summary.id)
			.all<{ data: string }>();
		expect(
			(transfers.results ?? []).map(
				(r) => JSON.parse(r.data) as { from: string; to: string },
			),
		).toEqual([
			expect.objectContaining({ from: adminA, to: adminB }),
			expect.objectContaining({ from: adminB, to: adminC }),
		]);

		const owner = await env.CADMUS_ADMIN_DB.prepare(
			"SELECT user_id, created_by FROM cadmus_auth_tokens WHERE id = ?1",
		)
			.bind(made.summary.id)
			.first<{ user_id: string; created_by: string }>();
		expect(owner).toEqual({ user_id: adminC, created_by: adminA });
	});

	it("revokes an orphaned service token and its sessions when removing a user while all remaining admins are disabled", async () => {
		const { s, accountId, admin, second, member } = await setup();
		await s.updateMemberRole({
			accountId,
			userId: member,
			op: "grant",
			role: "account-admin",
			actor: admin,
		});
		const svc = await s.createToken({
			accountId,
			creatorUserId: member,
			creatorRole: "account-admin",
			creatorGrants: ["chat.use"],
			kind: "service",
			label: "orphan-svc",
			grants: ["chat.use"],
		});
		if (!svc.ok) throw new Error("create failed");

		// Mint a session using that service token.
		const login = await SELF.fetch(`${ORIGIN}/api/auth/login/token`, {
			method: "POST",
			headers: { authorization: `Bearer ${svc.token}` },
		});
		expect(login.status).toBe(200);
		const { accessToken } = (await login.json()) as { accessToken: string };

		// Demote `member` to user, then disable every remaining account-admin.
		await s.updateMemberRole({
			accountId,
			userId: member,
			op: "revoke",
			role: "account-admin",
			actor: admin,
		});
		await env.CADMUS_ADMIN_DB.prepare(
			"UPDATE cadmus_users SET disabled_at = ?1 WHERE id IN (?2, ?3)",
		)
			.bind(Date.now(), admin, second)
			.run();

		const removed = await s.removeMember({
			accountId,
			userId: member,
			actor: "usr_sysadmin",
			actorKind: "super-admin",
		});
		expect(removed).toMatchObject({
			ok: true,
			changed: true,
			tokensRevoked: 1,
		});

		const row = await env.CADMUS_ADMIN_DB.prepare(
			"SELECT user_id, revoked_at FROM cadmus_auth_tokens WHERE id = ?1",
		)
			.bind(svc.summary.id)
			.first<{ user_id: string; revoked_at: number | null }>();
		expect(row?.user_id).toBe(member);
		expect(row?.revoked_at).not.toBeNull();

		// Both the token and its active session are dead.
		expect((await rpc(accessToken, "chat.list")).ok).not.toBe(true);
		const retryLogin = await SELF.fetch(`${ORIGIN}/api/auth/login/token`, {
			method: "POST",
			headers: { authorization: `Bearer ${svc.token}` },
		});
		expect(retryLogin.status).toBe(401);

		const revokeAudit = await env.CADMUS_ADMIN_DB.prepare(
			`SELECT actor_kind, target FROM cadmus_audit
        WHERE account_id = ?1 AND action = 'token.revoke' AND target = ?2`,
		)
			.bind(accountId, svc.summary.id)
			.first<{ actor_kind: string; target: string }>();
		expect(revokeAudit).toEqual({
			actor_kind: "super-admin",
			target: svc.summary.id,
		});
	});
});
