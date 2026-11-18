import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getEdgeCache } from "../src/edge-cache.js";
import { D1AdminStore } from "../src/store/d1-admin.js";
import { updateMemberRole } from "../src/store/d1-members.js";
import { rpc, uniqueAccountId } from "./helpers.js";

const ORIGIN = "https://example.com";

function store(): D1AdminStore {
	return new D1AdminStore({
		db: env.CADMUS_ADMIN_DB,
		encryptionKey: env.CADMUS_ENCRYPTION_KEY,
		edgeCache: getEdgeCache(env),
	});
}

async function superAdmin() {
	const s = store();
	await s.initialize();
	const userId = `usr_${uniqueAccountId("sa")}`;
	const now = Date.now();
	await env.CADMUS_ADMIN_DB.batch([
		env.CADMUS_ADMIN_DB.prepare(
			`INSERT INTO cadmus_users (id, name, email, created_at) VALUES (?1, 'Root', NULL, ?2)`,
		).bind(userId, now),
		env.CADMUS_ADMIN_DB.prepare(
			`INSERT INTO cadmus_account_members (account_id, user_id, role, created_at) VALUES ('system', ?1, 'super-admin', ?2)`,
		).bind(userId, now),
	]);
	const session = await s.createSession({ userId, accountId: "system" });
	return { s, userId, session };
}

async function systemAudit(target: string): Promise<string[]> {
	return (
		await env.CADMUS_ADMIN_DB.prepare(
			`SELECT action FROM cadmus_audit WHERE account_id = 'system' AND target_account_id = ?1 ORDER BY at, rowid`,
		)
			.bind(target)
			.all<{ action: string }>()
	).results.map((r) => r.action);
}

describe("system console accounts (issue #3 phase 6b)", () => {
	it("needs admin mode, then creates, renames, suspends and resumes with audit", async () => {
		const { session } = await superAdmin();
		const t = session.accessToken;

		const denied = await rpc(t, "system.accounts.create", {
			name: "Acme",
			ownerEmail: "acme-owner@example.com",
		});
		expect(denied.ok).toBe(false);
		expect(denied.error?.code).toBe("elevation_required");

		// Listing needs no admin mode.
		expect((await rpc(t, "system.accounts.list")).ok).toBe(true);

		expect((await rpc(t, "auth.elevate")).ok).toBe(true);
		const created = await rpc(t, "system.accounts.create", {
			name: " Acme ",
			ownerEmail: "acme-owner@example.com",
		});
		expect(created.ok).toBe(true);
		const account = created.result?.account;
		if (!account) throw new Error("missing created account");
		expect(account).toMatchObject({
			name: "Acme",
			status: "active",
			memberCount: 1,
		});
		expect(account.id).toMatch(/^acc_/);

		const listed = await rpc(t, "system.accounts.list");
		const ids = (listed.result?.accounts ?? []).map((a) => a.id);
		expect(ids).toContain(account.id);
		expect(ids).not.toContain("system");

		const renamed = await rpc(t, "system.accounts.rename", {
			accountId: account.id,
			name: "Acme Inc",
		});
		expect(renamed.result).toMatchObject({ changed: true });
		const again = await rpc(t, "system.accounts.rename", {
			accountId: account.id,
			name: "Acme Inc",
		});
		expect(again.result?.changed).toBe(false);

		const off = await rpc(t, "system.accounts.suspend", {
			accountId: account.id,
		});
		expect(off.result?.account.status).toBe("suspended");
		expect(off.result?.changed).toBe(true);
		expect(
			(await rpc(t, "system.accounts.suspend", { accountId: account.id }))
				.result?.changed,
		).toBe(false);
		const on = await rpc(t, "system.accounts.resume", {
			accountId: account.id,
		});
		expect(on.result?.account.status).toBe("active");

		// One audit row per real change, none for the no-ops.
		expect(await systemAudit(account.id)).toEqual([
			"account.create",
			"account.rename",
			"account.suspend",
			"account.resume",
		]);
		const events = await rpc(t, "system.audit.list", {
			accountId: account.id,
		});
		expect((events.result?.events ?? []).map((e) => e.action)).toEqual([
			"account.resume",
			"account.suspend",
			"account.rename",
			"account.create",
		]);
	});

	it("refuses the system account, unknown accounts and bad input", async () => {
		const { session } = await superAdmin();
		const t = session.accessToken;
		await rpc(t, "auth.elevate");
		for (const type of [
			"system.accounts.suspend",
			"system.accounts.resume",
		] as const) {
			expect((await rpc(t, type, { accountId: "system" })).error?.code).toBe(
				"not_found",
			);
			expect((await rpc(t, type, { accountId: "acc_nope" })).error?.code).toBe(
				"not_found",
			);
		}
		expect(
			(
				await rpc(t, "system.accounts.rename", {
					accountId: "system",
					name: "x",
				})
			).error?.code,
		).toBe("not_found");
		expect(
			(
				await rpc(t, "system.accounts.create", {
					name: "   ",
					ownerEmail: "blank@example.com",
				})
			).ok,
		).toBe(false);
		expect(
			(
				await rpc(t, "system.accounts.create", {
					name: "Zone",
					ownerEmail: "zone@example.com",
					timezone: "Nowhere/Land",
				})
			).ok,
		).toBe(false);
	});

	it("is closed to an account-admin and a plain user and leaves state unchanged", async () => {
		const s = store();
		for (const role of ["account-admin", "user"] as const) {
			const accountId = uniqueAccountId(
				`sys-deny-${role === "user" ? "u" : "a"}`,
			);
			const userId = `usr_${accountId}`;
			await s.ensureAccountAndUser({ accountId, userId, role });
			const sess = await s.createSession({ userId, accountId });
			await rpc(sess.accessToken, "auth.elevate");
			const before = (await s.listSystemAccounts()).length;
			for (const [type, payload] of [
				["system.accounts.list", {}],
				[
					"system.accounts.create",
					{ name: "Sneaky", ownerEmail: "sneaky@example.com" },
				],
				["system.accounts.suspend", { accountId }],
				["system.accounts.resume", { accountId }],
				["system.accounts.rename", { accountId, name: "Mine" }],
				["system.audit.list", {}],
			] as const) {
				const res = await rpc(sess.accessToken, type, payload);
				expect(res.ok).toBe(false);
				expect(res.error?.code).toBe("forbidden");
			}
			expect((await s.listSystemAccounts()).length).toBe(before);
			expect((await s.getAccount(accountId))?.name).toBe(accountId);
		}
	});

	it("gives a super-admin no tenant data access", async () => {
		const { session } = await superAdmin();
		for (const type of ["bot.list", "chat.list", "account.credentials.list"]) {
			const res = await rpc(session.accessToken, type);
			expect(res.ok).toBe(false);
			expect(res.error?.code).toBe("forbidden");
		}
	});

	it("refuses sessions of a suspended account", async () => {
		const { session: sa } = await superAdmin();
		await rpc(sa.accessToken, "auth.elevate");
		const s = store();
		const accountId = uniqueAccountId("sys-susp");
		const userId = `usr_${accountId}`;
		await s.ensureAccountAndUser({ accountId, userId, role: "user" });
		const user = await s.createSession({ userId, accountId });
		expect((await rpc(user.accessToken, "family.list")).ok).toBe(true);
		await rpc(sa.accessToken, "system.accounts.suspend", { accountId });
		const res = await SELF.fetch(`${ORIGIN}/rpc`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${user.accessToken}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ id: "x", type: "family.list", payload: {} }),
		});
		expect(res.status).toBe(401);
		await rpc(sa.accessToken, "system.accounts.resume", { accountId });
		expect((await rpc(user.accessToken, "family.list")).ok).toBe(true);
	});
});

describe("system console audit integrity (issue #3 phase 6b)", () => {
	it("records the real previous name when renames race", async () => {
		const { s, userId } = await superAdmin();
		const created = await s.createSystemAccount({
			name: "A",
			actor: userId,
			ownerEmail: `a-${crypto.randomUUID().slice(0, 8)}@example.com`,
		});
		if (!created.ok) throw new Error("create failed");
		const id = created.account.id;
		await Promise.all([
			s.renameSystemAccount({ accountId: id, name: "B", actor: userId }),
			s.renameSystemAccount({ accountId: id, name: "C", actor: userId }),
		]);
		const rows = (
			await env.CADMUS_ADMIN_DB.prepare(
				`SELECT data FROM cadmus_audit WHERE action = 'account.rename' AND target_account_id = ?1 ORDER BY at, rowid`,
			)
				.bind(id)
				.all<{ data: string }>()
		).results.map((r) => JSON.parse(r.data) as { from: string; to: string });
		const final = (await s.listSystemAccounts()).find((a) => a.id === id);
		// The chain of from -> to is unbroken and ends at the stored name.
		expect(rows[0]?.from).toBe("A");
		expect(rows.length).toBe(2);
		expect(rows[1]?.from).toBe(rows[0]?.to);
		expect(rows[1]?.to).toBe(final?.name);
	});

	it("pages through events with the same millisecond without losing any", async () => {
		const { s, userId } = await superAdmin();
		const created = await s.createSystemAccount({
			name: "P",
			actor: userId,
			ownerEmail: `p-${crypto.randomUUID().slice(0, 8)}@example.com`,
		});
		if (!created.ok) throw new Error("create failed");
		const id = created.account.id;
		const at = Date.now();
		await env.CADMUS_ADMIN_DB.batch(
			["aud_pg1", "aud_pg2", "aud_pg3"].map((aid) =>
				env.CADMUS_ADMIN_DB.prepare(
					`INSERT INTO cadmus_audit (id, account_id, actor_user_id, actor_kind, action, target_account_id, target, data, at)
           VALUES (?1 || ?2, 'system', ?3, 'user', 'account.rename', ?2, ?2, '{}', ?4)`,
				).bind(aid, id, userId, at + 10_000),
			),
		);
		const seen: string[] = [];
		let cursor: { before?: number; beforeId?: string } = {};
		for (let i = 0; i < 10; i++) {
			const page = await s.listSystemAudit({
				limit: 1,
				accountId: id,
				...cursor,
			});
			const last = page[page.length - 1];
			if (!last) break;
			seen.push(last.id);
			cursor = { before: last.at, beforeId: last.id };
		}
		expect(seen.length).toBe(4); // three crafted rows and account.create
		expect(new Set(seen).size).toBe(4);
		expect(seen.slice(0, 3)).toEqual([
			`aud_pg3${id}`,
			`aud_pg2${id}`,
			`aud_pg1${id}`,
		]);
	});
});

describe("system account creation is all or nothing (issue #3 phase 6b)", () => {
	it("leaves no account or audit row when seeding fails, and a retry creates exactly one seeded account", async () => {
		const { userId } = await superAdmin();
		const name = `Atomic ${crypto.randomUUID()}`;
		// A database whose default-env seed insert always fails.
		const failing = new Proxy(env.CADMUS_ADMIN_DB, {
			get(target, prop) {
				if (prop === "prepare") {
					return (sql: string) =>
						target.prepare(
							sql.includes("INSERT OR IGNORE INTO cadmus_tools_envs")
								? "INSERT INTO cadmus_missing_table VALUES (1)"
								: sql,
						);
				}
				if (prop === "batch") return target.batch.bind(target);
				const value = Reflect.get(target, prop, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		const broken = new D1AdminStore({
			db: failing,
			encryptionKey: env.CADMUS_ENCRYPTION_KEY,
			edgeCache: getEdgeCache(env),
		});
		await store().initialize();
		await expect(
			broken.createSystemAccount({
				name,
				actor: userId,
				ownerEmail: `atomic-${crypto.randomUUID().slice(0, 8)}@example.com`,
			}),
		).rejects.toThrow();
		const count = async () =>
			(
				await env.CADMUS_ADMIN_DB.prepare(
					`SELECT COUNT(*) AS n FROM cadmus_accounts WHERE name = ?1`,
				)
					.bind(name)
					.first<{ n: number }>()
			)?.n;
		expect(await count()).toBe(0);
		expect(
			(
				await env.CADMUS_ADMIN_DB.prepare(
					`SELECT COUNT(*) AS n FROM cadmus_audit WHERE action = 'account.create' AND data LIKE ?1`,
				)
					.bind(`%${name}%`)
					.first<{ n: number }>()
			)?.n,
		).toBe(0);

		const ok = await store().createSystemAccount({
			name,
			actor: userId,
			ownerEmail: `atomic-ok-${crypto.randomUUID().slice(0, 8)}@example.com`,
		});
		expect(ok.ok).toBe(true);
		expect(await count()).toBe(1);
		const env1 = await env.CADMUS_ADMIN_DB.prepare(
			`SELECT COUNT(*) AS n FROM cadmus_tools_envs WHERE account_id = ?1 AND env_id = 'jb_default'`,
		)
			.bind(ok.ok ? ok.account.id : "")
			.first<{ n: number }>();
		expect(env1?.n).toBe(1);
	});
});

describe("suspended accounts and disabled users lose live sockets (issue #3 phase 6b)", () => {
	async function openSocket(accessToken: string) {
		const issued = await rpc(accessToken, "auth.ticket", { target: "ws" });
		const res = await SELF.fetch(
			`${ORIGIN}/ws?ticket=${issued.result?.ticket as string}`,
			{ headers: { upgrade: "websocket" } },
		);
		const ws = res.webSocket;
		if (!ws) throw new Error(`expected 101, got ${res.status}`);
		ws.accept();
		const seen = {
			frames: [] as {
				type: string;
				ok?: boolean;
				payload?: { code?: string };
			}[],
			closeCode: undefined as number | undefined,
		};
		ws.addEventListener("message", (ev) => {
			seen.frames.push(JSON.parse(ev.data as string));
		});
		ws.addEventListener("close", (ev) => {
			seen.closeCode = ev.code;
		});
		const send = () =>
			ws.send(
				JSON.stringify({
					id: crypto.randomUUID(),
					type: "auth.sessions.list",
					payload: {},
				}),
			);
		const waitClosed = async () => {
			for (let i = 0; i < 150 && seen.closeCode === undefined; i++) {
				await new Promise((r) => setTimeout(r, 20));
			}
		};
		return { ws, seen, send, waitClosed };
	}

	async function seedTenantUser() {
		const s = store();
		const accountId = uniqueAccountId("sock");
		const userId = `usr_${accountId}`;
		await s.ensureAccountAndUser({ accountId, userId, role: "user" });
		const session = await s.createSession({ userId, accountId });
		return { accountId, userId, session };
	}

	it("closes 4403 with a forbidden error after the account is suspended", async () => {
		const { session: sa } = await superAdmin();
		await rpc(sa.accessToken, "auth.elevate");
		const { accountId, session } = await seedTenantUser();
		const sock = await openSocket(session.accessToken);
		sock.send();
		for (let i = 0; i < 100 && sock.seen.frames.length === 0; i++) {
			await new Promise((r) => setTimeout(r, 20));
		}
		expect(sock.seen.frames[0]?.ok).toBe(true);

		await rpc(sa.accessToken, "system.accounts.suspend", { accountId });
		sock.seen.frames.length = 0;
		sock.send();
		await sock.waitClosed();
		expect(sock.seen.closeCode).toBe(4403);
		expect(sock.seen.frames.some((f) => f.ok === true)).toBe(false);
		expect(
			sock.seen.frames.find((f) => f.type === "protocol.error")?.payload?.code,
		).toBe("forbidden");
	});

	it("closes 4403 after the user is disabled and 4401 after the session is revoked", async () => {
		const first = await seedTenantUser();
		const sockA = await openSocket(first.session.accessToken);
		await env.CADMUS_ADMIN_DB.prepare(
			`UPDATE cadmus_users SET disabled_at = ?2 WHERE id = ?1`,
		)
			.bind(first.userId, Date.now())
			.run();
		sockA.send();
		await sockA.waitClosed();
		expect(sockA.seen.closeCode).toBe(4403);

		const second = await seedTenantUser();
		const sockB = await openSocket(second.session.accessToken);
		await store().revokeSession(second.session.sessionId);
		sockB.send();
		await sockB.waitClosed();
		expect(sockB.seen.closeCode).toBe(4401);
	});
});

describe("system console members and users (issue #3 phase 6b)", () => {
	async function tenant() {
		const { session, userId } = await superAdmin();
		const t = session.accessToken;
		await rpc(t, "auth.elevate");
		const created = await rpc(t, "system.accounts.create", {
			name: "Org",
			ownerEmail: `org-${crypto.randomUUID().slice(0, 8)}@example.com`,
		});
		return { t, accountId: created.result?.account.id as string, userId };
	}

	async function addMember(accountId: string, role: "user" | "account-admin") {
		const s = store();
		const userId = `usr_${uniqueAccountId("m")}`;
		await s.ensureAccountAndUser({ accountId, userId, role });
		const session = await s.createSession({ userId, accountId });
		return { userId, session };
	}

	async function audit(action: string, target?: string) {
		return (
			await env.CADMUS_ADMIN_DB.prepare(
				`SELECT actor_kind, account_id, target FROM cadmus_audit WHERE action = ?1 ${target ? "AND (target = ?2 OR target_account_id = ?2)" : ""} ORDER BY at, rowid`,
			)
				.bind(...(target ? [action, target] : [action]))
				.all<{ actor_kind: string; account_id: string; target: string }>()
		).results;
	}

	it("needs admin mode and is denied to account-admins and users", async () => {
		const { session: sa } = await superAdmin();
		const { accountId } = await tenant();
		const admin = await addMember(accountId, "account-admin");
		const user = await addMember(accountId, "user");
		const calls: [string, Record<string, unknown>][] = [
			["system.members.list", { accountId }],
			["system.members.invite", { accountId, email: "a@example.com" }],
			[
				"system.members.update",
				{ accountId, userId: user.userId, role: "account-admin" },
			],
			["system.members.remove", { accountId, userId: user.userId }],
			["system.users.disable", { userId: user.userId }],
			["system.users.enable", { userId: user.userId }],
			["system.users.revokeSessions", { userId: user.userId }],
		];
		for (const [type, payload] of calls) {
			const notElevated = await rpc(sa.accessToken, type, payload);
			expect(notElevated.error?.code).toBe("elevation_required");
			for (const who of [admin, user]) {
				const r = await rpc(who.session.accessToken, type, payload);
				expect(r.ok).toBe(false);
				expect(r.error?.code).toBe("forbidden");
			}
		}
	});

	it("assigns an account-admin with a super-admin audit row, refuses the system account", async () => {
		const { t, accountId } = await tenant();
		const user = await addMember(accountId, "user");
		const listed = await rpc(t, "system.members.list", { accountId });
		expect((listed.result?.members ?? []).map((m) => m.role).sort()).toEqual([
			"account-admin",
			"user",
		]);

		const up = await rpc(t, "system.members.update", {
			accountId,
			userId: user.userId,
			role: "account-admin",
		});
		expect(up.result?.updated).toBe(true);
		const rows = await audit("member.role", user.userId);
		expect(rows.at(-1)?.actor_kind).toBe("super-admin");
		const events = await rpc(t, "system.audit.list", { accountId });
		expect(
			(events.result?.events ?? []).some((e) => e.actorKind === "super-admin"),
		).toBe(true);

		const invited = await rpc(t, "system.members.invite", {
			accountId,
			email: "first@example.com",
			role: "account-admin",
		});
		expect(invited.ok).toBe(true);
		expect(invited.result?.invite.role).toBe("account-admin");

		for (const type of [
			"system.members.list",
			"system.members.invite",
			"system.members.update",
			"system.members.remove",
		]) {
			const r = await rpc(t, type, {
				accountId: "system",
				userId: user.userId,
				email: "x@example.com",
				role: "user",
			});
			expect(r.ok).toBe(false);
			expect(r.error?.code).toBe("not_found");
		}
	});

	it("keeps the last-admin guard and refuses super-admin roles", async () => {
		const { t, accountId } = await tenant();
		const admin = await addMember(accountId, "account-admin");
		const owners = await env.CADMUS_ADMIN_DB.prepare(
			`SELECT user_id FROM cadmus_account_members WHERE account_id = ?1 AND role = 'account-admin' AND user_id != ?2`,
		)
			.bind(accountId, admin.userId)
			.all<{ user_id: string }>();
		for (const row of owners.results) {
			await rpc(t, "system.members.update", {
				accountId,
				userId: row.user_id,
				role: "user",
			});
		}
		const demote = await rpc(t, "system.members.update", {
			accountId,
			userId: admin.userId,
			role: "user",
		});
		expect(demote.ok).toBe(false);
		const remove = await rpc(t, "system.members.remove", {
			accountId,
			userId: admin.userId,
		});
		expect(remove.ok).toBe(false);
		const bad = await rpc(t, "system.members.update", {
			accountId,
			userId: admin.userId,
			role: "super-admin",
		});
		expect(bad.ok).not.toBe(true);
	});

	it("disables and enables with audit only on change, and refuses self and super-admins", async () => {
		const { t, userId: selfId, accountId } = await tenant();
		const user = await addMember(accountId, "user");
		expect(
			(await rpc(t, "system.users.disable", { userId: user.userId })).result
				?.changed,
		).toBe(true);
		expect(
			(await rpc(t, "system.users.disable", { userId: user.userId })).result
				?.changed,
		).toBe(false);
		expect(
			(await rpc(t, "system.users.enable", { userId: user.userId })).result
				?.changed,
		).toBe(true);
		expect(
			(await rpc(t, "system.users.enable", { userId: user.userId })).result
				?.changed,
		).toBe(false);
		expect((await audit("user.disable", user.userId)).length).toBe(1);
		expect((await audit("user.enable", user.userId)).length).toBe(1);

		const other = await superAdmin();
		const superTarget = await rpc(t, "system.users.disable", {
			userId: other.userId,
		});
		expect(superTarget.ok).toBe(false);
		const self = await rpc(t, "system.users.disable", {
			userId: selfId,
		});
		expect(self.ok).toBe(false);
		const missing = await rpc(t, "system.users.disable", {
			userId: "usr_missing",
		});
		expect(missing.error?.code).toBe("not_found");
	});

	it("revokes live sessions and reports the count", async () => {
		const { t, accountId } = await tenant();
		const user = await addMember(accountId, "user");
		await store().createSession({ userId: user.userId, accountId });
		const r = await rpc(t, "system.users.revokeSessions", {
			userId: user.userId,
		});
		expect(r.result?.revoked).toBe(2);
		expect((await rpc(user.session.accessToken, "auth.whoami")).ok).not.toBe(
			true,
		);
		const again = await rpc(t, "system.users.revokeSessions", {
			userId: user.userId,
		});
		expect(again.result?.revoked).toBe(0);
		expect((await audit("user.sessions.revoke", user.userId)).length).toBe(1);
	});

	it("audits a concurrent identical update or removal once, and keeps the last-admin race safe", async () => {
		const { accountId } = await tenant();
		const s = store();
		const user = await addMember(accountId, "user");
		const results = await Promise.all(
			[1, 2].map((n) =>
				s.updateMemberRole({
					accountId,
					userId: user.userId,
					role: "account-admin",
					actor: `usr_actor${n}`,
					actorKind: "super-admin",
				}),
			),
		);
		expect(results.every((r) => r.ok)).toBe(true);
		expect(results.filter((r) => r.ok && r.changed).length).toBe(1);
		expect((await audit("member.role", user.userId)).length).toBe(1);

		// Two admins demoted at once: at least one admin must remain.
		// The account owner is already an admin. Demote that owner first so the
		// race is only the two members this test added.
		const owners = await env.CADMUS_ADMIN_DB.prepare(
			`SELECT user_id FROM cadmus_account_members WHERE account_id = ?1 AND role = 'account-admin' AND user_id != ?2`,
		)
			.bind(accountId, user.userId)
			.all<{ user_id: string }>();
		for (const row of owners.results) {
			await s.updateMemberRole({
				accountId,
				userId: row.user_id,
				role: "user",
				actor: "usr_actor",
				actorKind: "super-admin",
			});
		}
		const second = await addMember(accountId, "account-admin");
		const demotes = await Promise.all(
			[user.userId, second.userId].map((userId) =>
				s.updateMemberRole({
					accountId,
					userId,
					role: "user",
					actor: "usr_actor",
					actorKind: "super-admin",
				}),
			),
		);
		expect(demotes.filter((r) => r.ok && r.changed).length).toBe(1);
		const admins = await env.CADMUS_ADMIN_DB.prepare(
			`SELECT COUNT(*) AS n FROM cadmus_account_members WHERE account_id = ?1 AND role = 'account-admin'`,
		)
			.bind(accountId)
			.first<{ n: number }>();
		expect(admins?.n).toBe(1);

		const victim = await addMember(accountId, "user");
		const removes = await Promise.all(
			[1, 2].map((n) =>
				s.removeMember({
					accountId,
					userId: victim.userId,
					actor: `usr_actor${n}`,
					actorKind: "super-admin",
				}),
			),
		);
		expect(removes.every((r) => r.ok)).toBe(true);
		expect(removes.filter((r) => r.ok && r.changed).length).toBe(1);
		expect((await audit("member.remove", victim.userId)).length).toBe(1);
	});

	it("a losing demotion does not revoke a token created after the winner", async () => {
		const { accountId } = await tenant();
		const s = store();
		const target = await addMember(accountId, "account-admin");
		await addMember(accountId, "account-admin");
		const db = env.CADMUS_ADMIN_DB;
		let injected = false;
		const racing = new Proxy(db, {
			get(obj, prop) {
				if (prop === "batch") {
					return async (stmts: D1PreparedStatement[]) => {
						if (!injected) {
							injected = true;
							// The winner commits, then a fresh personal token appears, before the loser's batch runs.
							const win = await updateMemberRole(db, {
								accountId,
								userId: target.userId,
								role: "user",
								actor: "usr_winner",
							});
							expect(win.ok && win.changed).toBe(true);
							const made = await s.createToken({
								accountId,
								creatorUserId: target.userId,
								creatorRole: "user",
								creatorGrants: ["chat.use"],
								kind: "pat",
								label: "fresh",
								grants: ["chat.use"],
								ttlMs: 86_400_000,
							});
							expect(made.ok).toBe(true);
						}
						return db.batch(stmts);
					};
				}
				const v = Reflect.get(obj, prop, obj);
				return typeof v === "function" ? v.bind(obj) : v;
			},
		}) as D1Database;
		const loser = await updateMemberRole(racing, {
			accountId,
			userId: target.userId,
			role: "user",
			actor: "usr_loser",
		});
		expect(loser).toMatchObject({ ok: true, changed: false });
		const live = await db
			.prepare(
				`SELECT COUNT(*) AS n FROM cadmus_auth_tokens WHERE account_id = ?1 AND user_id = ?2 AND kind = 'pat' AND revoked_at IS NULL`,
			)
			.bind(accountId, target.userId)
			.first<{ n: number }>();
		expect(live?.n).toBe(1);
		expect((await audit("member.role", target.userId)).length).toBe(1);
	});
});
