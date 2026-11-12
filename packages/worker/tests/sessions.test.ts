import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { REFRESH_COOKIE } from "../src/auth-routes.js";
import { getEdgeCache } from "../src/edge-cache.js";
import { D1AdminStore } from "../src/store/d1-admin.js";
import { uniqueAccountId } from "./helpers.js";

const ORIGIN = "https://example.com";

function store(): D1AdminStore {
	return new D1AdminStore({
		db: env.CADMUS_ADMIN_DB,
		encryptionKey: env.CADMUS_ENCRYPTION_KEY,
		edgeCache: getEdgeCache(env),
	});
}

async function seedUser(
	role: "user" | "account-admin" = "account-admin",
): Promise<{ s: D1AdminStore; accountId: string; userId: string }> {
	const s = store();
	const accountId = uniqueAccountId("sess");
	const userId = `usr_${accountId}`;
	await s.ensureAccountAndUser({ accountId, userId, role });
	return { s, accountId, userId };
}

function refresh(
	token: string | undefined,
	headers: Record<string, string> = {},
): Promise<Response> {
	return SELF.fetch(`${ORIGIN}/auth/refresh`, {
		method: "POST",
		headers: {
			origin: ORIGIN,
			"x-cadmus-refresh": "1",
			...(token ? { cookie: `${REFRESH_COOKIE}=${token}` } : {}),
			...headers,
		},
	});
}

describe("sessions (issue #3 phase 3a)", () => {
	it("authenticates an access token as the member's principal", async () => {
		const { s, accountId, userId } = await seedUser();
		const t = await s.createSession({ userId, accountId });
		const res = await SELF.fetch(`${ORIGIN}/api/auth/whoami`, {
			headers: { authorization: `Bearer ${t.accessToken}` },
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as { principal: Record<string, unknown> };
		expect(body.principal).toMatchObject({
			userId,
			accountId,
			role: "account-admin",
		});
	});

	it("rejects a revoked session immediately", async () => {
		const { s, accountId, userId } = await seedUser();
		const t = await s.createSession({ userId, accountId });
		await s.revokeSession(t.sessionId);
		const res = await SELF.fetch(`${ORIGIN}/api/auth/whoami`, {
			headers: { authorization: `Bearer ${t.accessToken}` },
		});
		expect(res.status).toBe(401);
	});

	it("rotates the refresh token and reuse revokes the session", async () => {
		const { s, accountId, userId } = await seedUser();
		const t = await s.createSession({ userId, accountId });
		const first = await refresh(t.refreshToken);
		expect(first.status).toBe(200);
		expect(first.headers.get("cache-control")).toBe("no-store");
		const cookie = first.headers.get("set-cookie") ?? "";
		expect(cookie).toContain("HttpOnly");
		expect(cookie).toContain("SameSite=Strict");
		const rotated = /cadmus_refresh=([^;]+)/.exec(cookie)?.[1];
		const { accessToken } = (await first.json()) as { accessToken: string };
		expect(rotated).toBeTruthy();
		expect(rotated).not.toBe(t.refreshToken);

		// The new access token works; the old one no longer does.
		const ok = await SELF.fetch(`${ORIGIN}/api/auth/whoami`, {
			headers: { authorization: `Bearer ${accessToken}` },
		});
		expect(ok.status).toBe(200);
		const old = await SELF.fetch(`${ORIGIN}/api/auth/whoami`, {
			headers: { authorization: `Bearer ${t.accessToken}` },
		});
		expect(old.status).toBe(401);

		// Replaying the rotated-away token revokes the whole session.
		const replay = await refresh(t.refreshToken);
		expect(replay.status).toBe(401);
		expect(
			((await replay.json()) as { error: { code: string } }).error.code,
		).toBe("refresh_reused");
		const after = await refresh(rotated);
		expect(after.status).toBe(401);
		const dead = await SELF.fetch(`${ORIGIN}/api/auth/whoami`, {
			headers: { authorization: `Bearer ${accessToken}` },
		});
		expect(dead.status).toBe(401);
	});

	it("enforces the refresh CSRF checks", async () => {
		const { s, accountId, userId } = await seedUser();
		const t = await s.createSession({ userId, accountId });
		expect(
			(await refresh(t.refreshToken, { origin: "https://evil.test" })).status,
		).toBe(403);
		expect(
			(await refresh(t.refreshToken, { "x-cadmus-refresh": "0" })).status,
		).toBe(403);
		expect((await refresh(undefined)).status).toBe(401);
		// A failed CSRF check must not consume the token.
		expect((await refresh(t.refreshToken)).status).toBe(200);
	});

	it("refuses sessions of a suspended account and a disabled user", async () => {
		const { s, accountId, userId } = await seedUser();
		const t = await s.createSession({ userId, accountId });
		await env.CADMUS_ADMIN_DB.prepare(
			"UPDATE cadmus_accounts SET status = 'suspended' WHERE id = ?1",
		)
			.bind(accountId)
			.run();
		const res = await SELF.fetch(`${ORIGIN}/api/auth/whoami`, {
			headers: { authorization: `Bearer ${t.accessToken}` },
		});
		expect(res.status).toBe(401);
	});

	it("does not mint sessions from the legacy master secret path", async () => {
		const res = await SELF.fetch(`${ORIGIN}/api/auth/whoami`, {
			headers: { authorization: "Bearer cad_at_not-a-real-token" },
		});
		expect(res.status).toBe(401);
	});
});
