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

async function seed(
	id: string,
	accountId: string,
	at: number,
	extra: { kind?: string; target?: string; action?: string } = {},
) {
	await env.CADMUS_ADMIN_DB.prepare(
		`INSERT INTO cadmus_audit (id, account_id, actor_user_id, actor_kind, action, target_account_id, target, data, at)
     VALUES (?1, ?2, 'usr_seed', ?3, ?4, ?5, ?6, '{"k":"v"}', ?7)`,
	)
		.bind(
			id,
			accountId,
			extra.kind ?? "user",
			extra.action ?? "seed.event",
			extra.target ?? accountId,
			id,
			at,
		)
		.run();
}

async function setup() {
	const s = store();
	const tag = uniqueAccountId("aud");
	const accountId = `${tag}_own`;
	const otherId = `${tag}_other`;
	const admin = `usr_a_${tag}`;
	const member = `usr_m_${tag}`;
	const otherAdmin = `usr_o_${tag}`;
	await s.ensureAccountAndUser({
		accountId,
		userId: admin,
		role: "account-admin",
	});
	await s.ensureAccountAndUser({ accountId, userId: member, role: "user" });
	await s.ensureAccountAndUser({
		accountId: otherId,
		userId: otherAdmin,
		role: "account-admin",
	});
	// No admin mode: audit.read needs no elevation.
	const tokenFor = async (userId: string, acct = accountId) =>
		(await s.createSession({ userId, accountId: acct })).accessToken;
	return { s, tag, accountId, otherId, admin, member, otherAdmin, tokenFor };
}

describe("account.audit.list (issue #3 phase 6)", () => {
	it("returns only rows kept in the caller's own account", async () => {
		const { tag, accountId, otherId, admin, otherAdmin, tokenFor } =
			await setup();
		const t = Date.now() + 1_000_000;
		await seed(`${tag}_own1`, accountId, t + 1);
		await seed(`${tag}_sa`, accountId, t + 2, { kind: "super-admin" });
		await seed(`${tag}_oth1`, otherId, t + 3);
		// System-scope rows about this account stay system scope.
		await seed(`${tag}_sys`, "system", t + 4, {
			kind: "super-admin",
			target: accountId,
			action: "account.rename",
		});
		await env.CADMUS_ADMIN_DB.prepare(
			"UPDATE cadmus_audit SET target_account_id = ?1 WHERE id = ?2",
		)
			.bind(accountId, `${tag}_sys`)
			.run();
		const res = await rpc(await tokenFor(admin), "account.audit.list", {
			limit: 200,
		});
		expect(res.ok).toBe(true);
		const events = res.result?.events ?? [];
		const ids = events.map((e) => e.id);
		expect(ids).toContain(`${tag}_own1`);
		expect(ids).toContain(`${tag}_sa`);
		expect(ids).not.toContain(`${tag}_oth1`);
		expect(ids).not.toContain(`${tag}_sys`);
		for (const e of events) expect(e.accountId).toBe(accountId);
		const sa = events.find((e) => e.id === `${tag}_sa`);
		expect(sa).toMatchObject({ actorKind: "super-admin", data: { k: "v" } });
		// The other tenant sees its own row only.
		const other = await rpc(
			await tokenFor(otherAdmin, otherId),
			"account.audit.list",
			{ limit: 200 },
		);
		const otherIds = (other.result?.events ?? []).map((e) => e.id);
		expect(otherIds).toContain(`${tag}_oth1`);
		expect(otherIds).not.toContain(`${tag}_own1`);
		expect(otherIds).not.toContain(`${tag}_sa`);
	});

	it("routes from the caller, not the payload", async () => {
		const { tag, accountId, otherId, admin, tokenFor } = await setup();
		const t = Date.now() + 2_000_000;
		await seed(`${tag}_oth1`, otherId, t);
		const res = await rpc<{ events: Array<{ id: string; accountId: string }> }>(
			await tokenFor(admin),
			"account.audit.list",
			{
				accountId: otherId,
				limit: 200,
			},
		);
		const ids = res.ok ? (res.result?.events ?? []).map((e) => e.id) : [];
		expect(ids).not.toContain(`${tag}_oth1`);
		for (const e of res.result?.events ?? [])
			expect(e.accountId).toBe(accountId);
	});

	it("pages by (at, id) without skipping equal-millisecond rows", async () => {
		const { tag, accountId, admin, tokenFor } = await setup();
		const token = await tokenFor(admin);
		const t = Date.now() + 3_000_000;
		for (const n of ["a", "b", "c"]) await seed(`${tag}_${n}`, accountId, t);
		await seed(`${tag}_z`, accountId, t + 5);
		const seen: string[] = [];
		let cursor: { before?: number; beforeId?: string } = {};
		for (let i = 0; i < 10; i++) {
			const res = await rpc(token, "account.audit.list", {
				limit: 1,
				...cursor,
			});
			expect(res.ok).toBe(true);
			expect(res.result?.events.length).toBeLessThanOrEqual(1);
			const last = res.result?.events.at(-1);
			if (!last) break;
			seen.push(last.id);
			cursor = { before: last.at, beforeId: last.id };
		}
		const mine = seen.filter((id) => id.startsWith(tag));
		expect(mine.slice(0, 4)).toEqual([
			`${tag}_z`,
			`${tag}_c`,
			`${tag}_b`,
			`${tag}_a`,
		]);
		expect(new Set(seen).size).toBe(seen.length);
	});

	it("caps the page size", async () => {
		const { admin, tokenFor } = await setup();
		const token = await tokenFor(admin);
		const over = await rpc(token, "account.audit.list", { limit: 500 });
		expect(over.ok).not.toBe(true);
		expect(over.result).toBeUndefined();
		const ok = await rpc(token, "account.audit.list", { limit: 2 });
		expect(ok.ok).toBe(true);
		expect(ok.result?.events.length).toBeLessThanOrEqual(2);
	});

	it("refuses a plain user and allows an account-admin", async () => {
		const { admin, member, tokenFor } = await setup();
		const denied = await rpc(await tokenFor(member), "account.audit.list");
		expect(denied.ok).toBe(false);
		const allowed = await rpc(await tokenFor(admin), "account.audit.list");
		expect(allowed.ok).toBe(true);
	});
});
