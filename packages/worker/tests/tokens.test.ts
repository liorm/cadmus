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

async function seed(role: "user" | "account-admin" = "account-admin") {
	const s = store();
	const accountId = uniqueAccountId("tok");
	const userId = `usr_${accountId}`;
	await s.ensureAccountAndUser({ accountId, userId, role });
	const session = await s.createSession({ userId, accountId });
	return { s, accountId, userId, session };
}

async function elevate(sessionId: string): Promise<void> {
	await env.CADMUS_ADMIN_DB.prepare(
		`UPDATE cadmus_sessions SET elevated_until = ?2 WHERE id = ?1`,
	)
		.bind(sessionId, Date.now() + 600_000)
		.run();
}

function tokenLogin(raw: string, url = `${ORIGIN}/auth/token-login`) {
	return SELF.fetch(url, {
		method: "POST",
		headers: { authorization: `Bearer ${raw}` },
	});
}

describe("API tokens and token login (issue #3 phase 4)", () => {
	it("creates a service token once, lists it without the secret, and logs in", async () => {
		const { session } = await seed();
		await elevate(session.sessionId);
		const created = await rpc(session.accessToken, "auth.tokens.create", {
			kind: "service",
			label: "ci agent",
			grants: ["chat.use", "bot.read"],
			ttlDays: 3,
		});
		expect(created.ok).toBe(true);
		const secret = created.result?.token as string;
		expect(secret.startsWith("cad_svc_")).toBe(true);
		const listed = await rpc(session.accessToken, "auth.tokens.list", {
			all: true,
		});
		const row = listed.result?.tokens.find(
			(t) => t.id === created.result?.summary.id,
		);
		expect(row).toMatchObject({
			kind: "service",
			grants: ["chat.use", "bot.read"],
		});
		expect(JSON.stringify(listed.result)).not.toContain(secret);

		const login = await tokenLogin(secret);
		expect(login.status).toBe(200);
		expect(login.headers.get("set-cookie") ?? "").toContain(
			"__Secure-cadmus_refresh=",
		);
		const body = (await login.json()) as { accessToken: string };
		// Clamped to the token: bot.read works, members.read does not.
		const allowed = await rpc(body.accessToken, "family.list");
		expect(allowed.ok).toBe(true);
		const denied = await rpc(body.accessToken, "account.get");
		expect(denied.ok).toBe(false);
	});

	it("needs admin mode for the tokens.manage uses and leaves personal and own-token use alone", async () => {
		const { s, session, accountId } = await seed();
		const other = `usr_other_${accountId}`;
		await s.ensureAccountAndUser({ accountId, userId: other, role: "user" });
		const otherSession = await s.createSession({
			userId: other,
			accountId,
		});
		const theirs = await rpc(otherSession.accessToken, "auth.tokens.create", {
			kind: "pat",
			label: "theirs",
			grants: ["chat.use"],
			ttlDays: 1,
		});
		expect(theirs.ok).toBe(true);
		const theirId = theirs.result?.summary.id as string;

		// Not in admin mode: the three tokens.manage uses are refused.
		const svc = await rpc(session.accessToken, "auth.tokens.create", {
			kind: "service",
			label: "no admin mode",
			grants: ["chat.use"],
			ttlDays: 3,
		});
		expect(svc.ok).toBe(false);
		expect(svc.error?.code).toBe("elevation_required");
		const listAll = await rpc(session.accessToken, "auth.tokens.list", {
			all: true,
		});
		expect(listAll.ok).toBe(false);
		expect(listAll.error?.code).toBe("elevation_required");
		const revokeOther = await rpc(session.accessToken, "auth.tokens.revoke", {
			tokenId: theirId,
		});
		expect(revokeOther.result).toEqual({ revoked: false });
		expect((await tokenLogin(theirs.result?.token as string)).status).toBe(200);

		// Personal token, own list and own revoke stay available without it.
		const mine = await rpc(session.accessToken, "auth.tokens.create", {
			kind: "pat",
			label: "mine",
			grants: ["chat.use"],
			ttlDays: 1,
		});
		expect(mine.ok).toBe(true);
		expect((await rpc(session.accessToken, "auth.tokens.list")).ok).toBe(true);
		const revokeMine = await rpc(session.accessToken, "auth.tokens.revoke", {
			tokenId: mine.result?.summary.id ?? "",
		});
		expect(revokeMine.result).toEqual({ revoked: true });

		// Positive control: the same calls work once admin mode is on.
		await elevate(session.sessionId);
		const svc2 = await rpc(session.accessToken, "auth.tokens.create", {
			kind: "service",
			label: "admin mode",
			grants: ["chat.use"],
			ttlDays: 3,
		});
		expect(svc2.ok).toBe(true);
		expect(
			(await rpc(session.accessToken, "auth.tokens.list", { all: true })).ok,
		).toBe(true);
		const revokeOther2 = await rpc(session.accessToken, "auth.tokens.revoke", {
			tokenId: theirId,
		});
		expect(revokeOther2.result).toEqual({ revoked: true });
		expect((await tokenLogin(theirs.result?.token as string)).status).toBe(401);
	});

	it("documents the legacy master-secret exemption: no session, so no admin mode is asked of it", async () => {
		const { accountId, userId } = await seed();
		const legacy = await rpc(
			`${accountId}:${userId}:test-cadmus-secret`,
			"auth.tokens.create",
			{
				kind: "service",
				label: "legacy",
				grants: ["chat.use"],
				ttlDays: 3,
			},
		);
		// Phase 9 removes this path. Until then it is exempt, like every other
		// elevated grant (see authorize()).
		expect(legacy.ok).toBe(true);
	});

	it("refuses a legacy member token once its account is suspended or its user disabled", async () => {
		const s = store();
		const accountId = uniqueAccountId("legmem");
		const userId = `usr_${accountId}`;
		const raw = `legacy-member-${accountId}`;
		await s.ensureAccountAndUser({
			accountId,
			userId,
			role: "account-admin",
		});
		await s.addMember({
			accountId,
			userId,
			role: "account-admin",
			rawToken: raw,
		});
		const call = (token: string) =>
			SELF.fetch(`${ORIGIN}/rpc`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					id: crypto.randomUUID(),
					type: "auth.whoami",
					payload: {},
				}),
			});
		// Positive control: the same token works while everything is active.
		expect((await call(raw)).status).toBe(200);
		const db = env.CADMUS_ADMIN_DB;
		const edge = getEdgeCache(env);
		const tokenHash = async (t: string) => {
			const d = await crypto.subtle.digest(
				"SHA-256",
				new TextEncoder().encode(t),
			);
			return Array.from(new Uint8Array(d), (b) =>
				b.toString(16).padStart(2, "0"),
			).join("");
		};
		await db
			.prepare(`UPDATE cadmus_accounts SET status = 'suspended' WHERE id = ?1`)
			.bind(accountId)
			.run();
		// The edge cache may serve a positive result for up to its TTL, so drop it
		// to test the stored check itself.
		await edge.invalidateToken(await tokenHash(raw), true);
		expect((await call(raw)).status).toBe(401);
		await db
			.prepare(`UPDATE cadmus_accounts SET status = 'active' WHERE id = ?1`)
			.bind(accountId)
			.run();
		expect((await call(raw)).status).toBe(200);
		await db
			.prepare(`UPDATE cadmus_users SET disabled_at = 1 WHERE id = ?1`)
			.bind(userId)
			.run();
		await edge.invalidateToken(await tokenHash(raw), true);
		expect((await call(raw)).status).toBe(401);
	});

	it("rejects grant escalation, elevated grants and long service expiry", async () => {
		const { session } = await seed("user");
		const base = { label: "x", ttlDays: 1 };
		const manage = await rpc(session.accessToken, "auth.tokens.create", {
			...base,
			kind: "pat",
			grants: ["members.manage"],
		});
		expect(manage.ok).toBe(false);
		const service = await rpc(session.accessToken, "auth.tokens.create", {
			...base,
			kind: "service",
			grants: ["chat.use"],
		});
		expect(service.ok).toBe(false);
		const admin = await seed();
		await elevate(admin.session.sessionId);
		// Without admin mode an elevated grant is refused (the elevated-token
		// path is covered by its own tests below).
		const unelevated = await seed();
		const elevatedGrant = await rpc(
			unelevated.session.accessToken,
			"auth.tokens.create",
			{ ...base, kind: "pat", grants: ["members.manage"] },
		);
		expect(elevatedGrant.ok).toBe(false);
		expect(elevatedGrant.error?.code).toBe("forbidden");
		expect(elevatedGrant.error?.message).toContain("needs admin mode");
		const long = await rpc(admin.session.accessToken, "auth.tokens.create", {
			label: "long",
			kind: "service",
			grants: ["chat.use"],
			ttlDays: 90,
		});
		expect(long.ok).toBe(false);
		expect(long.error?.code).toBe("invalid");
		const none = await rpc(admin.session.accessToken, "auth.tokens.create", {
			label: "none",
			kind: "pat",
			grants: ["not.a.grant"],
		});
		expect(none.ok).toBe(false);
	});

	it("token-backed sessions cannot mint tokens or manage sessions and login methods", async () => {
		const { session } = await seed();
		const created = await rpc(session.accessToken, "auth.tokens.create", {
			kind: "pat",
			label: "limited",
			grants: ["chat.use", "tokens.self"],
			ttlDays: 1,
		});
		const login = await tokenLogin(created.result?.token as string);
		const { accessToken } = (await login.json()) as { accessToken: string };
		const mint = await rpc(accessToken, "auth.tokens.create", {
			kind: "pat",
			label: "forever",
			grants: ["chat.use"],
		});
		expect(mint.ok).toBe(false);
		expect(mint.error?.code ?? "").toBe("forbidden");
		for (const type of [
			"auth.sessions.list",
			"auth.sessions.revokeOthers",
			"auth.methods.list",
			"auth.memberships.list",
		]) {
			expect((await rpc(accessToken, type)).ok).toBe(false);
		}
		// A real interactive session still can.
		expect((await rpc(session.accessToken, "auth.sessions.list")).ok).toBe(
			true,
		);
	});

	it("clamps session expiry to the token and refuses refresh once the token or user is gone", async () => {
		const { userId, session } = await seed();
		const created = await rpc(session.accessToken, "auth.tokens.create", {
			kind: "pat",
			label: "short",
			grants: ["chat.use"],
			ttlDays: 1,
		});
		const tokenExpires = new Date(
			created.result?.summary.expiresAt ?? 0,
		).getTime();
		const login = await tokenLogin(created.result?.token as string);
		const cookie = login.headers.get("set-cookie") ?? "";
		const refreshToken = /cadmus_refresh=([^;]+)/.exec(cookie)?.[1] ?? "";
		const body = (await login.json()) as { expiresAt: number };
		expect(body.expiresAt).toBeLessThanOrEqual(tokenExpires);
		const rows = await env.CADMUS_ADMIN_DB.prepare(
			`SELECT idle_expires_at, absolute_expires_at FROM cadmus_sessions WHERE token_id = ?1`,
		)
			.bind(created.result?.summary.id ?? "")
			.all<{ idle_expires_at: number; absolute_expires_at: number }>();
		for (const r of rows.results) {
			expect(r.idle_expires_at).toBeLessThanOrEqual(tokenExpires);
			expect(r.absolute_expires_at).toBeLessThanOrEqual(tokenExpires);
		}
		const refresh = (raw: string) =>
			SELF.fetch(`${ORIGIN}/auth/refresh`, {
				method: "POST",
				headers: {
					origin: ORIGIN,
					"x-cadmus-refresh": "1",
					cookie: `__Secure-cadmus_refresh=${raw}`,
				},
			});
		const ok = await refresh(refreshToken);
		expect(ok.status).toBe(200);
		const next =
			/cadmus_refresh=([^;]+)/.exec(ok.headers.get("set-cookie") ?? "")?.[1] ??
			"";
		// Token expired in the past: refresh must fail closed.
		await env.CADMUS_ADMIN_DB.prepare(
			`UPDATE cadmus_auth_tokens SET expires_at = ?2 WHERE id = ?1`,
		)
			.bind(created.result?.summary.id ?? "", Date.now() - 1000)
			.run();
		expect((await refresh(next)).status).toBe(401);

		// A disabled user cannot refresh a plain session either.
		const { s: s2, accountId: acc2, userId: user2 } = await seed();
		const t = await s2.createSession({ userId: user2, accountId: acc2 });
		await env.CADMUS_ADMIN_DB.prepare(
			`UPDATE cadmus_users SET disabled_at = ?2 WHERE id = ?1`,
		)
			.bind(user2, Date.now())
			.run();
		expect((await refresh(t.refreshToken)).status).toBe(401);
		expect(userId).toBeTruthy();
	});

	it("revoking a token ends its sessions; expired and unknown tokens fail", async () => {
		const { s, accountId, userId, session } = await seed();
		const created = await rpc(session.accessToken, "auth.tokens.create", {
			kind: "pat",
			label: "mine",
			grants: ["chat.use", "tokens.self"],
			ttlDays: 1,
		});
		const secret = created.result?.token as string;
		const login = await tokenLogin(secret);
		const { accessToken } = (await login.json()) as { accessToken: string };
		expect((await rpc(accessToken, "auth.tokens.list")).ok).toBe(true);
		const revoked = await rpc(session.accessToken, "auth.tokens.revoke", {
			tokenId: created.result?.summary.id ?? "",
		});
		expect(revoked.result).toEqual({ revoked: true });
		expect((await rpc(accessToken, "auth.tokens.list")).ok).not.toBe(true);
		expect((await tokenLogin(secret)).status).toBe(401);
		expect((await tokenLogin("cad_pat_nope")).status).toBe(401);

		const short = await s.createToken({
			accountId,
			creatorUserId: userId,
			creatorRole: "account-admin",
			creatorGrants: ["chat.use"],
			kind: "service",
			label: "short",
			grants: ["chat.use"],
			ttlMs: 1,
		});
		if (!short.ok) throw new Error("create failed");
		await new Promise((r) => setTimeout(r, 20));
		expect((await tokenLogin(short.token)).status).toBe(401);
	});

	it("refuses token login for a suspended account", async () => {
		const { session, accountId } = await seed();
		const created = await rpc(session.accessToken, "auth.tokens.create", {
			kind: "pat",
			label: "susp",
			grants: ["chat.use"],
			ttlDays: 1,
		});
		const secret = created.result?.token as string;
		expect((await tokenLogin(secret)).status).toBe(200);
		await env.CADMUS_ADMIN_DB.prepare(
			"UPDATE cadmus_accounts SET status = 'suspended' WHERE id = ?1",
		)
			.bind(accountId)
			.run();
		expect((await tokenLogin(secret)).status).toBe(401);
	});

	it("only accepts the token in the Authorization header", async () => {
		const { session } = await seed();
		const created = await rpc(session.accessToken, "auth.tokens.create", {
			kind: "pat",
			label: "q",
			grants: ["chat.use"],
			ttlDays: 1,
		});
		const secret = created.result?.token as string;
		const viaQuery = await tokenLogin(
			secret,
			`${ORIGIN}/auth/token-login?token=${secret}`,
		);
		expect(viaQuery.status).toBe(401);
		const noHeader = await SELF.fetch(`${ORIGIN}/auth/token-login`, {
			method: "POST",
		});
		expect(noHeader.status).toBe(401);
	});

	it("members cannot revoke other members' tokens", async () => {
		const a = await seed("user");
		const b = await seed("user");
		const made = await rpc(a.session.accessToken, "auth.tokens.create", {
			kind: "pat",
			label: "a",
			grants: ["chat.use"],
			ttlDays: 1,
		});
		const res = await rpc(b.session.accessToken, "auth.tokens.revoke", {
			tokenId: made.result?.summary.id ?? "",
		});
		expect(res.result).toEqual({ revoked: false });
	});

	it("a personal token with no elevated grant requires an expiry", async () => {
		const { session } = await seed();
		const missing = await rpc(session.accessToken, "auth.tokens.create", {
			kind: "pat",
			label: "no-ttl",
			grants: ["chat.use"],
		});
		expect(missing.ok).toBe(false);
		expect(missing.error?.code).toBe("invalid");
		const before = Date.now();
		const made = await rpc(session.accessToken, "auth.tokens.create", {
			kind: "pat",
			label: "week",
			grants: ["chat.use"],
			ttlDays: 7,
		});
		expect(made.ok).toBe(true);
		const exp = made.result?.summary.expiresAt as number;
		expect(exp).toBeGreaterThan(before + 6 * 86_400_000);
		expect(exp).toBeLessThanOrEqual(Date.now() + 7 * 86_400_000);
	});

	describe("elevated tokens (decision 13)", () => {
		const mk = (t: string, extra: Record<string, unknown> = {}) =>
			rpc(t, "auth.tokens.create", {
				kind: "pat",
				label: "elev",
				grants: ["family.manage", "tokens.self"],
				...extra,
			});

		it("is created only while elevated, is capped at 30 days, flagged in lists", async () => {
			const { session } = await seed();
			const before = Date.now();
			expect((await mk(session.accessToken)).ok).toBe(false);
			await elevate(session.sessionId);
			const made = await mk(session.accessToken);
			expect(made.ok).toBe(true);
			expect(made.result?.summary.elevated).toBe(true);
			const exp = made.result?.summary.expiresAt as number;
			expect(exp).toBeGreaterThanOrEqual(before + 30 * 86_400_000);
			expect(exp).toBeLessThanOrEqual(Date.now() + 30 * 86_400_000);
			const over = await mk(session.accessToken, { ttlDays: 31 });
			expect(over.ok).toBe(false);
			expect(over.error?.code).toBe("invalid");
			const ok30 = await mk(session.accessToken, { ttlDays: 30 });
			expect(ok30.ok).toBe(true);
			const listed = await rpc(session.accessToken, "auth.tokens.list", {
				all: true,
			});
			const flagged = (
				(listed.result?.tokens ?? []) as { elevated?: boolean }[]
			).filter((t) => t.elevated);
			expect(flagged.length).toBe(2);
			// A non-elevated token keeps its normal flag and TTL rules.
			const plain = await rpc(session.accessToken, "auth.tokens.create", {
				kind: "pat",
				label: "plain",
				grants: ["chat.use"],
				ttlDays: 90,
			});
			expect(plain.ok).toBe(true);
			expect(plain.result?.summary.elevated).toBe(false);
		});

		it("audits every use of an elevated grant by the token session", async () => {
			const { session, accountId } = await seed();
			await elevate(session.sessionId);
			const made = await mk(session.accessToken);
			const login = await tokenLogin(made.result?.token as string);
			const { accessToken } = (await login.json()) as { accessToken: string };
			const fid = `fam_${accountId}`;
			const r = await rpc(accessToken, "family.create", {
				familyId: fid,
				name: fid,
			});
			expect(r.ok).toBe(true);
			const rows = (
				await env.CADMUS_ADMIN_DB.prepare(
					`SELECT action FROM cadmus_audit WHERE action LIKE 'elevated.command%' AND account_id = ?1`,
				)
					.bind(accountId)
					.all<{ action: string }>()
			).results.map((x) => x.action);
			expect(rows).toContain("elevated.command");
			// A non-elevated token cannot run it at all.
			const plain = await rpc(session.accessToken, "auth.tokens.create", {
				kind: "pat",
				label: "p",
				grants: ["chat.use"],
				ttlDays: 1,
			});
			const pl = await tokenLogin(plain.result?.token as string);
			const pa = ((await pl.json()) as { accessToken: string }).accessToken;
			expect(
				(await rpc(pa, "family.create", { familyId: `${fid}x`, name: "x" })).ok,
			).toBe(false);
		});

		it("is not created when the creating session stopped being elevated", async () => {
			const { s, session, userId, accountId } = await seed();
			await elevate(session.sessionId);
			await env.CADMUS_ADMIN_DB.prepare(
				`UPDATE cadmus_sessions SET elevated_until = 1 WHERE id = ?1`,
			)
				.bind(session.sessionId)
				.run();
			const res = await s.createToken({
				accountId,
				creatorUserId: userId,
				creatorRole: "account-admin",
				kind: "pat",
				label: "stale",
				grants: ["family.manage"],
				creatorGrants: ["family.manage"],
				elevatedBySessionId: session.sessionId,
			});
			expect(res.ok).toBe(false);
		});

		it("is not created from a session elevated for a different account", async () => {
			const { s, session, userId, accountId } = await seed();
			await env.CADMUS_ADMIN_DB.prepare(
				`UPDATE cadmus_sessions SET elevated_until = ?2, elevated_account_id = ?3 WHERE id = ?1`,
			)
				.bind(session.sessionId, Date.now() + 600_000, "acct_other")
				.run();
			const input = {
				accountId,
				creatorUserId: userId,
				creatorRole: "account-admin" as const,
				kind: "pat" as const,
				label: "x-acct",
				grants: ["family.manage"],
				creatorGrants: ["family.manage" as const],
				elevatedBySessionId: session.sessionId,
			};
			expect((await s.createToken(input)).ok).toBe(false);
			// Same session elevated for this very account is accepted.
			await env.CADMUS_ADMIN_DB.prepare(
				`UPDATE cadmus_sessions SET elevated_account_id = ?2 WHERE id = ?1`,
			)
				.bind(session.sessionId, accountId)
				.run();
			expect((await s.createToken(input)).ok).toBe(true);
		});

		it("caps an elevated service token at 30 days and defaults it", async () => {
			const { session } = await seed();
			await elevate(session.sessionId);
			const svc = (extra: Record<string, unknown> = {}) =>
				rpc(session.accessToken, "auth.tokens.create", {
					kind: "service",
					label: "svc",
					grants: ["family.manage"],
					...extra,
				});
			const def = await svc();
			expect(def.ok).toBe(true);
			expect(def.result?.summary.elevated).toBe(true);
			const days =
				((def.result?.summary.expiresAt as number) - Date.now()) / 86_400_000;
			expect(days).toBeLessThanOrEqual(30);
			expect(days).toBeGreaterThan(0);
			expect((await svc({ ttlDays: 30 })).ok).toBe(true);
			expect((await svc({ ttlDays: 31 })).ok).toBe(false);
		});

		it("never exceeds the creator's grants, even in admin mode", async () => {
			const { s, session, userId, accountId } = await seed();
			await elevate(session.sessionId);
			const res = await s.createToken({
				accountId,
				creatorUserId: userId,
				creatorRole: "account-admin",
				kind: "pat",
				label: "esc",
				grants: ["family.manage"],
				creatorGrants: ["chat.use"],
				elevatedBySessionId: session.sessionId,
			});
			expect(res.ok).toBe(false);
			if (!res.ok) expect(res.message).toContain("above the creator");
		});

		it("is not created once the creator lost the role that holds the grant", async () => {
			const { s, session, userId, accountId } = await seed();
			await elevate(session.sessionId);
			await env.CADMUS_ADMIN_DB.prepare(
				`UPDATE cadmus_account_members SET role = 'user' WHERE account_id = ?1 AND user_id = ?2`,
			)
				.bind(accountId, userId)
				.run();
			const res = await s.createToken({
				accountId,
				creatorUserId: userId,
				creatorRole: "account-admin",
				kind: "pat",
				label: "demoted",
				grants: ["family.manage"],
				creatorGrants: ["family.manage"],
				elevatedBySessionId: session.sessionId,
			});
			expect(res.ok).toBe(false);
		});

		it("use-time: a demotion or removal after creation takes the elevated grant away", async () => {
			const { session, accountId, userId } = await seed();
			await elevate(session.sessionId);
			const made = await mk(session.accessToken);
			const raw = made.result?.token as string;
			const run = async (suffix: string) => {
				const login = await tokenLogin(raw);
				if (login.status !== 200) return login.status;
				const { accessToken } = (await login.json()) as {
					accessToken: string;
				};
				const fid = `fam_${accountId}${suffix}`;
				return (
					await rpc(accessToken, "family.create", {
						familyId: fid,
						name: fid,
					})
				).ok;
			};
			expect(await run("a")).toBe(true);
			// Demotion (direct row change, so no handler revokes the token): the
			// token's stored grants are clamped to what the role still holds.
			await env.CADMUS_ADMIN_DB.prepare(
				`UPDATE cadmus_account_members SET role = 'user' WHERE account_id = ?1 AND user_id = ?2`,
			)
				.bind(accountId, userId)
				.run();
			expect(await run("b")).toBe(false);
			// Removal: the session no longer resolves at all.
			await env.CADMUS_ADMIN_DB.prepare(
				`DELETE FROM cadmus_account_members WHERE account_id = ?1 AND user_id = ?2`,
			)
				.bind(accountId, userId)
				.run();
			expect(await run("c")).not.toBe(true);
		});

		const elevRows = async (accountId: string) =>
			(
				await env.CADMUS_ADMIN_DB.prepare(
					`SELECT action, data FROM cadmus_audit WHERE account_id = ?1 AND action LIKE 'elevated.command%' ORDER BY at, rowid`,
				)
					.bind(accountId)
					.all<{ action: string; data: string }>()
			).results.map((r) => ({ action: r.action, ...JSON.parse(r.data) }));

		it("audits both dispatch paths: family.create (index) and family.delete (family DO)", async () => {
			const { session, accountId } = await seed();
			await elevate(session.sessionId);
			const made = await mk(session.accessToken);
			const login = await tokenLogin(made.result?.token as string);
			const { accessToken } = (await login.json()) as { accessToken: string };
			const fid = `famp${accountId.slice(-8).replace(/[^a-z0-9]/g, "")}`;
			expect(
				(await rpc(accessToken, "family.create", { familyId: fid, name: fid }))
					.ok,
			).toBe(true);
			const afterCreate = await elevRows(accountId);
			expect(
				afterCreate.filter((r) => r.command === "family.create").length,
			).toBe(2);
			const del = await rpc(accessToken, "family.delete", { familyId: fid });
			expect(del.ok).toBe(true);
			const rows = await elevRows(accountId);
			expect(rows.filter((r) => r.command === "family.delete").length).toBe(2);
		});

		it("an elevated token cannot start admin mode or use passkey routes", async () => {
			const { session } = await seed();
			await elevate(session.sessionId);
			const made = await mk(session.accessToken, {
				grants: ["family.manage", "tokens.self", "admin.elevate"],
			});
			expect(made.ok).toBe(true);
			const login = await tokenLogin(made.result?.token as string);
			const { accessToken } = (await login.json()) as { accessToken: string };
			const el = await rpc(accessToken, "auth.elevate");
			expect(el.ok).toBe(false);
			const pk = await rpc(accessToken, "auth.passkeys.begin", {
				purpose: "elevate",
			});
			expect(pk.ok).toBe(false);
		});

		it("an elevated token revoking another member's token is audited as an elevated use", async () => {
			const a = await seed();
			await elevate(a.session.sessionId);
			const victim = await rpc(a.session.accessToken, "auth.tokens.create", {
				kind: "pat",
				label: "victim",
				grants: ["chat.use"],
				ttlDays: 1,
			});
			const mgr = await mk(a.session.accessToken, {
				grants: ["tokens.manage", "tokens.self"],
			});
			expect(mgr.ok).toBe(true);
			const login = await tokenLogin(mgr.result?.token as string);
			const { accessToken } = (await login.json()) as { accessToken: string };
			const rev = await rpc(accessToken, "auth.tokens.revoke", {
				tokenId: victim.result?.summary.id ?? "",
			});
			expect(rev.ok).toBe(true);
			const rows = await elevRows(a.accountId);
			expect(
				rows
					.filter((r) => r.command === "auth.tokens.revoke")
					.map((r) => r.action),
			).toEqual(["elevated.command", "elevated.command.result"]);
		});

		it("audits human admin-mode tokens.manage uses and leaves personal use alone", async () => {
			const { s, session, accountId } = await seed();
			const other = `usr_other_${accountId}`;
			await s.ensureAccountAndUser({
				accountId,
				userId: other,
				role: "user",
			});
			const otherSession = await s.createSession({ userId: other, accountId });
			const theirs = await rpc(otherSession.accessToken, "auth.tokens.create", {
				kind: "pat",
				label: "theirs",
				grants: ["chat.use"],
				ttlDays: 1,
			});
			expect(theirs.ok).toBe(true);
			const theirId = theirs.result?.summary.id as string;

			// Refused before admin mode: nothing was allowed to start.
			expect(
				(await rpc(session.accessToken, "auth.tokens.list", { all: true }))
					.error?.code,
			).toBe("elevation_required");
			expect(
				(
					await rpc(session.accessToken, "auth.tokens.create", {
						kind: "service",
						label: "no",
						grants: ["chat.use"],
						ttlDays: 3,
					})
				).error?.code,
			).toBe("elevation_required");
			expect(
				(
					await rpc(session.accessToken, "auth.tokens.revoke", {
						tokenId: theirId,
					})
				).result,
			).toEqual({ revoked: false });
			expect(await elevRows(accountId)).toEqual([]);

			await elevate(session.sessionId);
			const mine = await rpc(session.accessToken, "auth.tokens.create", {
				kind: "pat",
				label: "mine",
				grants: ["chat.use"],
				ttlDays: 1,
			});
			expect(mine.ok).toBe(true);
			expect((await rpc(session.accessToken, "auth.tokens.list")).ok).toBe(
				true,
			);
			expect(await elevRows(accountId)).toEqual([]);

			expect(
				(
					await rpc(session.accessToken, "auth.tokens.create", {
						kind: "service",
						label: "svc",
						grants: ["chat.use"],
						ttlDays: 3,
					})
				).ok,
			).toBe(true);
			expect(
				(await rpc(session.accessToken, "auth.tokens.list", { all: true })).ok,
			).toBe(true);
			expect(
				(
					await rpc(session.accessToken, "auth.tokens.revoke", {
						tokenId: theirId,
					})
				).result,
			).toEqual({ revoked: true });

			const rows = await elevRows(accountId);
			for (const command of [
				"auth.tokens.create",
				"auth.tokens.list",
				"auth.tokens.revoke",
			]) {
				expect(rows.filter((r) => r.command === command)).toEqual([
					expect.objectContaining({
						action: "elevated.command",
						outcome: "started",
					}),
					expect.objectContaining({
						action: "elevated.command.result",
						outcome: "completed",
					}),
				]);
			}
			expect(rows).toHaveLength(6);
		});
	});
});

describe("rollback safety of API token rows (issue #3 phase 4)", () => {
	// The exact lookup the Worker before this change ran for every bearer
	// (origin/main 7e98ae0, packages/worker/src/store/d1-admin.ts resolveToken,
	// lines 868-876). It ignores revoked_at, expires_at, grants and kind.
	const OLD_WORKER_LOOKUP = `SELECT t.user_id, t.account_id, m.role
         FROM cadmus_auth_tokens t
         JOIN cadmus_account_members m
           ON m.account_id = t.account_id AND m.user_id = t.user_id
         WHERE t.token_hash = ?1`;
	async function oldWorkerResolves(raw: string): Promise<boolean> {
		const bytes = new TextEncoder().encode(raw);
		const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
		const hex = [...digest]
			.map((b) => b.toString(16).padStart(2, "0"))
			.join("");
		const row = await env.CADMUS_ADMIN_DB.prepare(OLD_WORKER_LOOKUP)
			.bind(hex)
			.first();
		return row !== null;
	}

	it("no pat or service token, live, revoked or expired, matches the previous Worker's lookup; a legacy member token does (control)", async () => {
		const { s, accountId, userId } = await seed();
		const made: Record<string, string> = {};
		for (const kind of ["pat", "service"] as const) {
			const r = await s.createToken({
				accountId,
				creatorUserId: userId,
				creatorRole: "account-admin",
				creatorGrants: ["chat.use"],
				kind,
				label: `rb-${kind}`,
				grants: ["chat.use"],
				...(kind === "pat" ? { ttlMs: 86_400_000 } : {}),
			});
			if (!r.ok) throw new Error("create failed");
			made[kind] = r.token;
		}
		// A live token still logs in through the new path (the control that the
		// separated hash is the one the new Worker reads).
		expect((await tokenLogin(made.pat as string)).status).toBe(200);
		await env.CADMUS_ADMIN_DB.prepare(
			`UPDATE cadmus_auth_tokens SET revoked_at = ?1 WHERE label = 'rb-service'`,
		)
			.bind(Date.now())
			.run();
		expect((await tokenLogin(made.service as string)).status).toBe(401);
		for (const [kind, raw] of Object.entries(made)) {
			expect(await oldWorkerResolves(raw), `old lookup ${kind}`).toBe(false);
		}
		const legacy = `legacy-rb-${accountId}`;
		await s.addMember({ accountId, userId: `${userId}-m`, rawToken: legacy });
		expect(await oldWorkerResolves(legacy)).toBe(true);
	});

	// The base Worker's session lookups (origin/main 7e98ae0 d1-sessions.ts:
	// resolveAccessToken ~112-121 by access_hash, rotateRefreshToken ~182 by
	// refresh_hash). They ignore the token grant clamp.
	async function sha(raw: string): Promise<string> {
		const d = new Uint8Array(
			await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw)),
		);
		return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
	}
	async function oldSessionLookups(access: string, refresh: string) {
		const byAccess = await env.CADMUS_ADMIN_DB.prepare(
			`SELECT s.id FROM cadmus_sessions s
       JOIN cadmus_account_members m ON m.account_id = s.account_id AND m.user_id = s.user_id
       WHERE s.access_hash = ?1`,
		)
			.bind(await sha(access))
			.first();
		const byRefresh = await env.CADMUS_ADMIN_DB.prepare(
			`SELECT id FROM cadmus_sessions WHERE refresh_hash = ?1 OR previous_refresh_hash = ?1`,
		)
			.bind(await sha(refresh))
			.first();
		return { access: byAccess !== null, refresh: byRefresh !== null };
	}

	it("a token-backed session's access and refresh tokens, issued and refreshed, do not match the previous Worker's lookups; a user session does (control)", async () => {
		const { s, accountId, userId, session } = await seed();
		await elevate(session.sessionId);
		const made = await s.createToken({
			accountId,
			creatorUserId: userId,
			creatorRole: "account-admin",
			creatorGrants: ["chat.use"],
			kind: "pat",
			label: "rb-session",
			grants: ["chat.use"],
			ttlMs: 86_400_000,
		});
		if (!made.ok) throw new Error("create failed");
		const login = await s.tokenLogin(made.token, {});
		if (!login.ok) throw new Error("login failed");
		const first = await oldSessionLookups(
			login.tokens.accessToken,
			login.tokens.refreshToken,
		);
		expect(first).toEqual({ access: false, refresh: false });
		// The new Worker still resolves and refreshes it.
		expect((await rpc(login.tokens.accessToken, "chat.list")).ok).toBe(true);
		const rotated = await s.rotateRefreshToken(login.tokens.refreshToken);
		if (!rotated.ok) throw new Error("refresh failed");
		const second = await oldSessionLookups(
			rotated.tokens.accessToken,
			rotated.tokens.refreshToken,
		);
		expect(second).toEqual({ access: false, refresh: false });
		expect((await rpc(rotated.tokens.accessToken, "chat.list")).ok).toBe(true);
		// Control: an ordinary user session matches the old lookups.
		const user = await s.createSession({ userId, accountId });
		expect(
			await oldSessionLookups(user.accessToken, user.refreshToken),
		).toEqual({ access: true, refresh: true });
	});

	async function tokenSession(label: string) {
		const ctx = await seed();
		await elevate(ctx.session.sessionId);
		const made = await ctx.s.createToken({
			accountId: ctx.accountId,
			creatorUserId: ctx.userId,
			creatorRole: "account-admin",
			creatorGrants: ["chat.use"],
			kind: "pat",
			label,
			grants: ["chat.use"],
			ttlMs: 86_400_000,
		});
		if (!made.ok) throw new Error("create failed");
		const login = await ctx.s.tokenLogin(made.token, {});
		if (!login.ok) throw new Error("login failed");
		return { ...ctx, login };
	}
	const sessionHashes = async (id: string) =>
		(await env.CADMUS_ADMIN_DB.prepare(
			"SELECT access_hash, refresh_hash, previous_refresh_hash FROM cadmus_sessions WHERE id = ?1",
		)
			.bind(id)
			.first<{
				access_hash: string;
				refresh_hash: string;
				previous_refresh_hash: string | null;
			}>()) ?? {
			access_hash: "",
			refresh_hash: "",
			previous_refresh_hash: null,
		};
	async function sessionIdFor(accessToken: string): Promise<string> {
		const hashes = [await sha(accessToken)];
		const row = await env.CADMUS_ADMIN_DB.prepare(
			"SELECT id FROM cadmus_sessions WHERE access_hash = ?1 OR access_hash = ?2",
		)
			.bind(hashes[0], await sha(`cadmus-token-session-v1:${accessToken}`))
			.first<{ id: string }>();
		return row?.id ?? "";
	}

	it("a token session issued before the separated hash (plain hashes) still resolves, refreshes into the separated form and keeps reuse detection", async () => {
		const { s, login } = await tokenSession("compat-plain");
		const id = await sessionIdFor(login.tokens.accessToken);
		expect(id).not.toBe("");
		// New rows are stored under the domain-separated hash, never the plain one.
		const stored = await sessionHashes(id);
		expect(stored.access_hash).toBe(
			await sha(`cadmus-token-session-v1:${login.tokens.accessToken}`),
		);
		expect(stored.access_hash).not.toBe(await sha(login.tokens.accessToken));
		// Rewrite the row the way an earlier build stored it (plain hashes).
		await env.CADMUS_ADMIN_DB.prepare(
			"UPDATE cadmus_sessions SET access_hash = ?2, refresh_hash = ?3 WHERE id = ?1",
		)
			.bind(
				id,
				await sha(login.tokens.accessToken),
				await sha(login.tokens.refreshToken),
			)
			.run();
		// Still resolves and refreshes.
		expect((await rpc(login.tokens.accessToken, "chat.list")).ok).toBe(true);
		const r1 = await s.rotateRefreshToken(login.tokens.refreshToken);
		if (!r1.ok) throw new Error(`refresh failed: ${r1.code}`);
		// After the refresh the row holds the separated form: the previous
		// Worker's lookups no longer match either token.
		expect(
			await oldSessionLookups(r1.tokens.accessToken, r1.tokens.refreshToken),
		).toEqual({ access: false, refresh: false });
		const after = await sessionHashes(id);
		expect(after.refresh_hash).toBe(
			await sha(`cadmus-token-session-v1:${r1.tokens.refreshToken}`),
		);
		// Replaying the rotated-out (plain) refresh token is reuse and revokes the session.
		const reuse = await s.rotateRefreshToken(login.tokens.refreshToken);
		expect(reuse).toEqual({ ok: false, code: "refresh_reused" });
		expect((await rpc(r1.tokens.accessToken, "chat.list")).ok).not.toBe(true);
	});

	it("logout revocation and refresh-token reuse work on the separated form", async () => {
		const a = await tokenSession("sep-reuse");
		const r1 = await a.s.rotateRefreshToken(a.login.tokens.refreshToken);
		if (!r1.ok) throw new Error("refresh failed");
		const r2 = await a.s.rotateRefreshToken(r1.tokens.refreshToken);
		if (!r2.ok) throw new Error("second refresh failed");
		// The token from two rotations ago is no longer known; the previous one is reuse.
		expect(await a.s.rotateRefreshToken(r1.tokens.refreshToken)).toEqual({
			ok: false,
			code: "refresh_reused",
		});
		expect((await rpc(r2.tokens.accessToken, "chat.list")).ok).not.toBe(true);
		const b = await tokenSession("sep-revoke");
		expect((await rpc(b.login.tokens.accessToken, "chat.list")).ok).toBe(true);
		const logout = await SELF.fetch(`${ORIGIN}/auth/logout`, {
			method: "POST",
			headers: {
				origin: ORIGIN,
				"x-cadmus-refresh": "1",
				authorization: `Bearer ${b.login.tokens.accessToken}`,
			},
		});
		expect(logout.status).toBe(200);
		expect((await logout.json()) as { revoked: boolean }).toEqual({
			revoked: true,
		});
		expect((await rpc(b.login.tokens.accessToken, "chat.list")).ok).not.toBe(
			true,
		);
		expect(
			await b.s.rotateRefreshToken(b.login.tokens.refreshToken),
		).toMatchObject({ ok: false });
	});
});

describe("every API token login is audited (issue #3 phase 4, L138/L150 token logins)", () => {
	// `cad_pat_` and `cad_svc_` are also accepted as `Authorization: Bearer`.
	// This block covers `/auth/token-login` only: each successful login writes
	// one `token.login` row, and a refused login writes none. A token session's
	// later non-elevated commands are not audited individually (elevated ones
	// are, as `elevated.command` rows). Direct bearer uses of a service token
	// or an elevated token are audited as `token.use`.
	it("writes one token.login audit row per successful login and none for a refused one", async () => {
		const { session, accountId } = await seed();
		await elevate(session.sessionId);
		const made = await rpc(session.accessToken, "auth.tokens.create", {
			kind: "service",
			label: "audit probe",
			grants: ["chat.use"],
			ttlDays: 1,
		});
		expect(made.ok).toBe(true);
		const secret = made.result?.token as string;
		const tokenId = made.result?.summary.id as string;
		const rows = async () =>
			(
				await env.CADMUS_ADMIN_DB.prepare(
					`SELECT actor_kind, action, target, target_account_id, data FROM cadmus_audit WHERE action = 'token.login' AND target = ?1`,
				)
					.bind(tokenId)
					.all<{
						actor_kind: string;
						action: string;
						target: string;
						target_account_id: string;
						data: string;
					}>()
			).results;
		expect(await rows()).toHaveLength(0);

		const first = await tokenLogin(secret);
		expect(first.status).toBe(200);
		const second = await tokenLogin(secret);
		expect(second.status).toBe(200);
		const audited = await rows();
		expect(audited).toHaveLength(2);
		for (const row of audited) {
			expect(row.actor_kind).toBe("token");
			expect(row.target_account_id).toBe(accountId);
			expect(JSON.parse(row.data)).toHaveProperty("sessionId");
		}
		// Two distinct sessions, one row each.
		expect(new Set(audited.map((r) => JSON.parse(r.data).sessionId)).size).toBe(
			2,
		);

		// Refused uses leave no token.login row: a wrong token and a revoked one.
		expect((await tokenLogin(`${secret}x`)).status).toBe(401);
		const revoked = await rpc(session.accessToken, "auth.tokens.revoke", {
			tokenId,
		});
		expect(revoked.ok).toBe(true);
		expect((await tokenLogin(secret)).status).toBe(401);
		expect(await rows()).toHaveLength(2);
	});

	it("fails closed when the token.login audit row cannot be written, and a retry works", async () => {
		const { session, accountId } = await seed();
		await elevate(session.sessionId);
		const made = await rpc(session.accessToken, "auth.tokens.create", {
			kind: "service",
			label: "audit down probe",
			grants: ["chat.use"],
			ttlDays: 1,
		});
		const secret = made.result?.token as string;
		const tokenId = made.result?.summary.id as string;
		const count = async () =>
			(
				await env.CADMUS_ADMIN_DB.prepare(
					`SELECT count(*) AS n FROM cadmus_audit WHERE action = 'token.login' AND target = ?1`,
				)
					.bind(tokenId)
					.first<{ n: number }>()
			)?.n;
		const trigger = `zz_audit_down_${accountId.replace(/\W/g, "_")}`;
		await env.CADMUS_ADMIN_DB.exec(
			`CREATE TRIGGER ${trigger} BEFORE INSERT ON cadmus_audit WHEN NEW.action = 'token.login' AND NEW.target = '${tokenId}' BEGIN SELECT RAISE(ABORT, 'audit down'); END`,
		);
		let delivered = "";
		let status: number | "threw" = "threw";
		try {
			const res = await tokenLogin(secret);
			status = res.status;
			delivered = `${await res.text()} ${res.headers.get("set-cookie") ?? ""}`;
		} catch {
			// The worker threw: nothing was returned to the client either.
		} finally {
			await env.CADMUS_ADMIN_DB.exec(`DROP TRIGGER ${trigger}`);
		}
		// Assertions sit outside the catch so they can fail. A response, if one
		// comes back at all, is an error and carries no credential or cookie.
		expect(status === "threw" || status >= 400).toBe(true);
		expect(delivered).not.toMatch(/cad_at_|cad_rt_/);
		expect(await count()).toBe(0);
		// The token was not consumed: a retry succeeds and is audited once. This
		// does not claim the session row from the failed attempt is cleaned up.
		expect((await tokenLogin(secret)).status).toBe(200);
		expect(await count()).toBe(1);
	});
});

describe("API token use re-checks liveness on every command", () => {
	it("refuses a disabled user, a suspended account, and a removed member", async () => {
		const { s, accountId, userId, session } = await seed();
		await elevate(session.sessionId);
		const created = await rpc(session.accessToken, "auth.tokens.create", {
			kind: "service",
			label: "liveness",
			grants: ["bot.read"],
			ttlDays: 1,
		});
		expect(created.ok).toBe(true);
		const secret = created.result?.token as string;
		const tokenId = created.result?.summary.id as string;
		const resolved = await s.resolveApiToken(secret);
		expect(resolved?.credential).toBeTruthy();
		const use = () =>
			s.recordApiTokenUse({
				credential: resolved?.credential ?? "",
				userId,
				accountId,
				use: "bot.list",
			});
		const usedAt = async () =>
			(
				await env.CADMUS_ADMIN_DB.prepare(
					`SELECT last_used_at FROM cadmus_auth_tokens WHERE id = ?1`,
				)
					.bind(tokenId)
					.first<{ last_used_at: number | null }>()
			)?.last_used_at ?? null;
		const useRows = async () =>
			(
				await env.CADMUS_ADMIN_DB.prepare(
					`SELECT count(*) AS n FROM cadmus_audit WHERE action = 'token.use' AND target = ?1`,
				)
					.bind(tokenId)
					.first<{ n: number }>()
			)?.n ?? 0;

		expect(await use()).toBe(true);
		const stamped = await usedAt();
		expect(stamped).toEqual(expect.any(Number));
		expect(await useRows()).toBe(1);

		const db = env.CADMUS_ADMIN_DB;
		await db
			.prepare(`UPDATE cadmus_users SET disabled_at = ?2 WHERE id = ?1`)
			.bind(userId, Date.now())
			.run();
		expect(await use()).toBe(false);
		expect(await usedAt()).toBe(stamped);
		expect(await useRows()).toBe(1);

		await db
			.prepare(`UPDATE cadmus_users SET disabled_at = NULL WHERE id = ?1`)
			.bind(userId)
			.run();
		await db
			.prepare(`UPDATE cadmus_accounts SET status = 'suspended' WHERE id = ?1`)
			.bind(accountId)
			.run();
		expect(await use()).toBe(false);
		expect(await useRows()).toBe(1);

		await db
			.prepare(`UPDATE cadmus_accounts SET status = 'active' WHERE id = ?1`)
			.bind(accountId)
			.run();
		await db
			.prepare(
				`DELETE FROM cadmus_account_members WHERE account_id = ?1 AND user_id = ?2`,
			)
			.bind(accountId, userId)
			.run();
		expect(await use()).toBe(false);
		expect(await usedAt()).toBe(stamped);
		expect(await useRows()).toBe(1);
	});

	it("family.create refuses a cached bearer revoked directly in D1", async () => {
		const { session } = await seed();
		await elevate(session.sessionId);
		const created = await rpc(session.accessToken, "auth.tokens.create", {
			kind: "service",
			label: "family maker",
			grants: ["family.manage", "bot.read"],
			ttlDays: 7,
		});
		expect(created.ok).toBe(true);
		const secret = created.result?.token as string;
		const tokenId = created.result?.summary.id as string;
		const familyId = `fam-${crypto.randomUUID().slice(0, 8)}`;
		const made = await rpc(secret, "family.create", {
			familyId,
			name: "One",
		});
		expect(made.ok).toBe(true);

		// Leave the edge cache populated. The revoke API would drop it; a direct
		// row update is what another isolate still holding the 60s entry sees.
		await env.CADMUS_ADMIN_DB.prepare(
			`UPDATE cadmus_auth_tokens SET revoked_at = ?2 WHERE id = ?1`,
		)
			.bind(tokenId, Date.now())
			.run();
		const againId = `${familyId}-2`;
		const again = await rpc(secret, "family.create", {
			familyId: againId,
			name: "Two",
		});
		expect(again.ok).toBe(false);
		expect(again.error?.code).toBe("unauthorized");
		const families = await rpc(session.accessToken, "family.list");
		expect(families.ok).toBe(true);
		const ids = (families.result?.families ?? []).map(
			(family: { familyId: string }) => family.familyId,
		);
		expect(ids).toContain(familyId);
		expect(ids).not.toContain(againId);
	});
});
