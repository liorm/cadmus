import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getEdgeCache } from "../src/edge-cache.js";
import { D1AdminStore } from "../src/store/d1-admin.js";
import { rpc, uniqueAccountId } from "./helpers.js";

/**
 * Issue #3 L150 (audit list), write side: one real operation per action that
 * had no test asserting its audit row. The other L150 actions are asserted
 * elsewhere (see the PR scope matrix). Each case runs the real command through
 * /rpc and reads the row back from cadmus_audit by actor and action.
 */
function store(): D1AdminStore {
	return new D1AdminStore({
		db: env.CADMUS_ADMIN_DB,
		encryptionKey: env.CADMUS_ENCRYPTION_KEY,
		edgeCache: getEdgeCache(env),
	});
}

async function rows(userId: string, action: string) {
	const found = await env.CADMUS_ADMIN_DB.prepare(
		`SELECT account_id, actor_user_id, actor_kind, action, target, data FROM cadmus_audit
     WHERE actor_user_id = ?1 AND action = ?2`,
	)
		.bind(userId, action)
		.all<{
			account_id: string;
			actor_user_id: string;
			actor_kind: string;
			action: string;
			target: string;
			data: string;
		}>();
	return found.results;
}

describe("audit rows for invites, method revoke and admin mode end (issue #3 L150)", () => {
	it("writes member.invite, member.invite.revoke, method.revoke and auth.elevation.end rows", async () => {
		const s = store();
		const tag = uniqueAccountId("audw");
		const accountId = `${tag}_acct`;
		const admin = `usr_${tag}`;
		await s.ensureAccountAndUser({
			accountId,
			userId: admin,
			role: "account-admin",
		});
		const now = Date.now();
		for (const id of [`lm_a_${tag}`, `lm_b_${tag}`]) {
			await env.CADMUS_ADMIN_DB.prepare(
				`INSERT INTO cadmus_login_methods (id, user_id, provider, subject, display, created_at)
         VALUES (?1, ?2, 'google', ?1, ?1, ?3)`,
			)
				.bind(id, admin, now)
				.run();
		}
		const { accessToken } = await s.createSession({
			userId: admin,
			accountId,
			loginMethodId: `lm_a_${tag}`,
		});

		// Admin mode on first: member management needs it.
		const on = await rpc(accessToken, "auth.elevate", {});
		expect(on.ok).toBe(true);
		expect(await rows(admin, "auth.elevate")).toHaveLength(1);
		const invite = await rpc(accessToken, "account.members.invite", {
			email: `${tag}@example.com`,
		});
		expect(invite.ok).toBe(true);
		const inviteId = (invite.result as { invite: { id: string } }).invite.id;
		expect(await rows(admin, "member.invite")).toMatchObject([
			{ account_id: accountId, actor_kind: "user", target: inviteId },
		]);
		const [inviteRow] = await rows(admin, "member.invite");
		expect(JSON.parse(inviteRow?.data ?? "{}")).toMatchObject({
			email: `${tag}@example.com`,
		});

		const revoked = await rpc(accessToken, "account.invites.revoke", {
			inviteId,
		});
		expect(revoked.result).toEqual({ revoked: true });
		expect(await rows(admin, "member.invite.revoke")).toMatchObject([
			{ account_id: accountId, actor_kind: "user", target: inviteId },
		]);

		// Revoking the other method (not the one this session used).
		const method = await rpc(accessToken, "auth.methods.delete", {
			methodId: `lm_b_${tag}`,
		});
		expect(method.ok).toBe(true);
		expect(await rows(admin, "method.delete")).toMatchObject([
			{ account_id: accountId, actor_kind: "user", target: `lm_b_${tag}` },
		]);

		// Admin mode off: the end is its own row, written once.
		const off = await rpc(accessToken, "auth.elevation.end", {});
		expect(off.ok).toBe(true);
		expect(await rows(admin, "auth.elevation.end")).toHaveLength(1);
		// A second end finds nothing to end and writes nothing.
		await rpc(accessToken, "auth.elevation.end", {});
		expect(await rows(admin, "auth.elevation.end")).toHaveLength(1);
	});
});
