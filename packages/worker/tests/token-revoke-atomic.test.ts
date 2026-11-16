import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getEdgeCache } from "../src/edge-cache.js";
import { D1AdminStore } from "../src/store/d1-admin.js";
import { revokeTokenById } from "../src/store/d1-tokens.js";
import { uniqueAccountId } from "./helpers.js";

const db = env.CADMUS_ADMIN_DB;

function store(): D1AdminStore {
	return new D1AdminStore({
		db,
		encryptionKey: env.CADMUS_ENCRYPTION_KEY,
		edgeCache: getEdgeCache(env),
	});
}

/** A PAT, plus a session started from it by token login. */
async function seedTokenWithSession() {
	const s = store();
	const accountId = uniqueAccountId("rev");
	const userId = `usr_${accountId}`;
	await s.ensureAccountAndUser({ accountId, userId, role: "account-admin" });
	const created = await s.createToken({
		accountId,
		creatorUserId: userId,
		creatorRole: "account-admin",
		creatorGrants: ["chat.use", "tokens.self"],
		kind: "pat",
		label: "atomic",
		grants: ["chat.use"],
		ttlMs: 86_400_000,
	} as Parameters<D1AdminStore["createToken"]>[0]);
	if (!("token" in created) || !created.summary) {
		throw new Error("token was not created");
	}
	const login = await s.tokenLogin(created.token as string, {});
	if (!login.ok) throw new Error("token login failed");
	return { s, accountId, userId, tokenId: created.summary.id as string };
}

async function state(accountId: string, tokenId: string) {
	const token = await db
		.prepare(`SELECT revoked_at FROM cadmus_auth_tokens WHERE id = ?1`)
		.bind(tokenId)
		.first<{ revoked_at: number | null }>();
	const sessions = await db
		.prepare(
			`SELECT COUNT(*) AS total, SUM(revoked_at IS NULL) AS live
         FROM cadmus_sessions WHERE token_id = ?1`,
		)
		.bind(tokenId)
		.first<{ total: number; live: number | null }>();
	const audit = await db
		.prepare(
			`SELECT COUNT(*) AS n FROM cadmus_audit
        WHERE account_id = ?1 AND action = 'token.revoke' AND target = ?2`,
		)
		.bind(accountId, tokenId)
		.first<{ n: number }>();
	return {
		tokenRevoked: token?.revoked_at != null,
		sessions: sessions?.total ?? 0,
		liveSessions: sessions?.live ?? 0,
		audits: audit?.n ?? 0,
	};
}

describe("auth.tokens.revoke is one transaction", () => {
	it("revokes the token, its sessions and writes one audit row together", async () => {
		const { accountId, userId, tokenId } = await seedTokenWithSession();
		expect(await state(accountId, tokenId)).toEqual({
			tokenRevoked: false,
			sessions: 1,
			liveSessions: 1,
			audits: 0,
		});
		expect(
			await revokeTokenById(db, { accountId, userId, tokenId, all: false }),
		).toBe(true);
		expect(await state(accountId, tokenId)).toEqual({
			tokenRevoked: true,
			sessions: 1,
			liveSessions: 0,
			audits: 1,
		});
	});

	it("leaves token, sessions and audit untouched when the audit write fails", async () => {
		const { accountId, userId, tokenId } = await seedTokenWithSession();
		const trigger = `fail_revoke_audit_${crypto.randomUUID().replaceAll("-", "")}`;
		await db
			.prepare(
				`CREATE TRIGGER ${trigger} BEFORE INSERT ON cadmus_audit
         WHEN NEW.action = 'token.revoke' AND NEW.target = '${tokenId}'
         BEGIN SELECT RAISE(ABORT, 'injected audit failure'); END`,
			)
			.run();
		try {
			await expect(
				revokeTokenById(db, { accountId, userId, tokenId, all: false }),
			).rejects.toThrow();
			// Rolled back as a whole: still live, no half-applied revoke.
			expect(await state(accountId, tokenId)).toEqual({
				tokenRevoked: false,
				sessions: 1,
				liveSessions: 1,
				audits: 0,
			});
		} finally {
			await db.prepare(`DROP TRIGGER IF EXISTS ${trigger}`).run();
		}
		// Positive control: with the fault removed the same call succeeds.
		expect(
			await revokeTokenById(db, { accountId, userId, tokenId, all: false }),
		).toBe(true);
		expect(await state(accountId, tokenId)).toEqual({
			tokenRevoked: true,
			sessions: 1,
			liveSessions: 0,
			audits: 1,
		});
	});

	it("writes exactly one audit row when two revokes race, even at the same millisecond", async () => {
		const { accountId, userId, tokenId } = await seedTokenWithSession();
		const now = Date.now();
		const results = await Promise.all([
			revokeTokenById(db, { accountId, userId, tokenId, all: false, now }),
			revokeTokenById(db, { accountId, userId, tokenId, all: false, now }),
			revokeTokenById(db, { accountId, userId, tokenId, all: false, now }),
		]);
		expect(results.filter(Boolean)).toHaveLength(1);
		expect(await state(accountId, tokenId)).toEqual({
			tokenRevoked: true,
			sessions: 1,
			liveSessions: 0,
			audits: 1,
		});
	});

	it("a refused revoke changes nothing and writes no audit row", async () => {
		const { accountId, tokenId } = await seedTokenWithSession();
		// Not the owner and no manage-others right: refused.
		expect(
			await revokeTokenById(db, {
				accountId,
				userId: "usr_someone_else",
				tokenId,
				all: false,
			}),
		).toBe(false);
		// Wrong account: refused.
		expect(
			await revokeTokenById(db, {
				accountId: `${accountId}-other`,
				userId: "usr_someone_else",
				tokenId,
				all: true,
			}),
		).toBe(false);
		expect(await state(accountId, tokenId)).toEqual({
			tokenRevoked: false,
			sessions: 1,
			liveSessions: 1,
			audits: 0,
		});
	});
});
