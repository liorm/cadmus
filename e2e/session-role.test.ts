import { describe, expect, it } from "vitest";
import {
	cookiePair,
	DEV_PASSWORD,
	elevateAccessToken,
	loginDevPassword,
	provisionInvitedMember,
	sendRpc,
	setCookieLines,
	useWorkerFixture,
	workerFetch,
} from "./helpers.js";

const ORIGIN = "http://127.0.0.1";

function maxAge(lines: string[]): number {
	const line = lines.find((entry) =>
		entry.includes("__Secure-cadmus_refresh="),
	);
	const match = /Max-Age=(\d+)/i.exec(line ?? "");
	return match ? Number(match[1]) : -1;
}

async function devLogin(email: string, chooseRole = false) {
	const res = await workerFetch(`${ORIGIN}/api/auth/login/devPassword`, {
		method: "POST",
		headers: { Origin: ORIGIN, "Content-Type": "application/json" },
		body: JSON.stringify({
			id: "dev",
			type: "auth.login.devPassword",
			payload: {
				email,
				password: DEV_PASSWORD,
				...(chooseRole ? { chooseRole: true } : {}),
			},
		}),
	});
	const body = (await res.json()) as {
		accessToken?: string;
		expiresAt?: number;
		provisional?: boolean;
		roles?: unknown;
	};
	return { res, body, cookies: setCookieLines(res) };
}

async function whoami(token: string, accountId?: string) {
	return sendRpc<{
		principal: {
			role?: string;
			provisional?: boolean;
			accountId?: string;
			sessionId?: string;
			elevatedUntil?: number;
		};
	}>("auth.whoami", {}, { token, accountId });
}

async function assume(token: string, role: string, accountId: string) {
	const res = await workerFetch(`${ORIGIN}/api/auth/assumeRole`, {
		method: "POST",
		headers: {
			Origin: ORIGIN,
			"Content-Type": "application/json",
			Authorization: `Bearer ${token}`,
		},
		body: JSON.stringify({
			id: "assume",
			type: "auth.assumeRole",
			payload: { role, accountId },
		}),
	});
	const body = (await res.json()) as {
		accessToken?: string;
		sessionId?: string;
		error?: { code?: string };
	};
	return { res, body, cookies: setCookieLines(res) };
}

describe("session hats", () => {
	useWorkerFixture();

	it("SR-01 wrong password has no roles or token", async () => {
		const res = await workerFetch(`${ORIGIN}/api/auth/login/devPassword`, {
			method: "POST",
			headers: { Origin: ORIGIN, "Content-Type": "application/json" },
			body: JSON.stringify({
				id: "dev",
				type: "auth.login.devPassword",
				payload: { email: "nobody@example.com", password: "nope" },
			}),
		});
		const body = (await res.json()) as Record<string, unknown>;
		expect(res.status).toBe(401);
		expect(body.roles).toBeUndefined();
		expect(body.accessToken).toBeUndefined();
		expect(body.provisional).toBeUndefined();
	});

	it("SR-02 only account-admin is a full session", async () => {
		const member = await provisionInvitedMember({ role: "account-admin" });
		const login = await devLogin(member.email);
		expect(login.res.status).toBe(200);
		expect(login.body.provisional).toBeUndefined();
		expect(maxAge(login.cookies)).toBeGreaterThan(60 * 60);
		const who = await whoami(login.body.accessToken ?? "");
		expect(who.frame.ok).toBe(true);
		expect(who.frame.result?.principal.role).toBe("account-admin");
		expect(who.frame.result?.principal.provisional).toBeUndefined();
	});

	it("SR-03 grant user does not change the open admin session", async () => {
		const member = await provisionInvitedMember({ role: "account-admin" });
		const before = await devLogin(member.email);
		const boss = await loginDevPassword();
		await elevateAccessToken(boss.accessToken);
		const granted = await sendRpc(
			"system.members.update",
			{
				accountId: member.accountId,
				userId: member.userId,
				op: "grant",
				role: "user",
			},
			{ token: boss.accessToken },
		);
		expect(granted.frame.ok).toBe(true);
		const still = await whoami(before.body.accessToken ?? "");
		expect(still.frame.result?.principal.role).toBe("account-admin");
		const next = await devLogin(member.email);
		const who = await whoami(next.body.accessToken ?? "");
		expect(who.frame.result?.principal.role).toBe("user");
		expect(who.frame.result?.principal.accountId).toBe(member.accountId);
	});

	it("SR-04 chooseRole with two hats is provisional", async () => {
		const member = await provisionInvitedMember({ role: "account-admin" });
		const boss = await loginDevPassword();
		await elevateAccessToken(boss.accessToken);
		await sendRpc(
			"system.members.update",
			{
				accountId: member.accountId,
				userId: member.userId,
				op: "grant",
				role: "user",
			},
			{ token: boss.accessToken },
		);
		const login = await devLogin(member.email, true);
		expect(login.body.accessToken).toBeTruthy();
		expect(login.body.provisional).toBe(true);
		expect(maxAge(login.cookies)).toBeLessThanOrEqual(15 * 60);
		expect((login.body.expiresAt ?? 0) - Date.now()).toBeLessThanOrEqual(
			15 * 60 * 1000,
		);
		const who = await whoami(login.body.accessToken ?? "");
		expect(who.frame.result?.principal.role).toBe("user");
		expect(who.frame.result?.principal.provisional).toBe(true);
		const listed = await sendRpc<{ memberships: Array<{ roles: string[] }> }>(
			"auth.memberships.list",
			{},
			{ token: login.body.accessToken ?? "" },
		);
		expect(
			listed.frame.result?.memberships.some(
				(row) =>
					row.roles.includes("user") && row.roles.includes("account-admin"),
			),
		).toBe(true);
	});

	it("SR-05 chooseRole with one hat is not provisional", async () => {
		const member = await provisionInvitedMember({ role: "user" });
		const login = await devLogin(member.email, true);
		expect(login.body.provisional).toBeUndefined();
		expect(maxAge(login.cookies)).toBeGreaterThan(60 * 60);
		const who = await whoami(login.body.accessToken ?? "");
		expect(who.frame.result?.principal.provisional).toBeUndefined();
	});

	it("SR-06 provisional user cannot manage or elevate", async () => {
		const member = await provisionInvitedMember({ role: "account-admin" });
		const boss = await loginDevPassword();
		await elevateAccessToken(boss.accessToken);
		await sendRpc(
			"system.members.update",
			{
				accountId: member.accountId,
				userId: member.userId,
				op: "grant",
				role: "user",
			},
			{ token: boss.accessToken },
		);
		const login = await devLogin(member.email, true);
		const token = login.body.accessToken ?? "";
		expect((await whoami(token)).frame.ok).toBe(true);
		expect(
			(await sendRpc("auth.memberships.list", {}, { token })).frame.ok,
		).toBe(true);
		const manage = await sendRpc(
			"account.members.update",
			{ userId: member.userId, op: "grant", role: "user" },
			{ token, accountId: member.accountId },
		);
		expect(manage.frame.ok).toBe(false);
		expect(manage.frame.error?.code).toBe("forbidden");
		const elevate = await sendRpc(
			"auth.elevate",
			{},
			{ token, accountId: member.accountId },
		);
		expect(elevate.frame.ok).toBe(false);
		expect(elevate.frame.error?.code).toBe("forbidden");
	});

	it("SR-07 refresh keeps the provisional cap", async () => {
		const member = await provisionInvitedMember({ role: "account-admin" });
		const boss = await loginDevPassword();
		await elevateAccessToken(boss.accessToken);
		await sendRpc(
			"system.members.update",
			{
				accountId: member.accountId,
				userId: member.userId,
				op: "grant",
				role: "user",
			},
			{ token: boss.accessToken },
		);
		const login = await devLogin(member.email, true);
		const started = Date.now();
		const cookie = cookiePair(login.cookies, "__Secure-cadmus_refresh");
		const refreshed = await workerFetch(`${ORIGIN}/api/auth/session/refresh`, {
			method: "POST",
			headers: { Origin: ORIGIN, "X-Cadmus-Refresh": "1", Cookie: cookie },
		});
		const body = (await refreshed.json()) as { accessToken?: string };
		expect(refreshed.status).toBe(200);
		expect(body.accessToken).toBeTruthy();
		expect(body.accessToken).not.toBe(login.body.accessToken);
		const age = maxAge(setCookieLines(refreshed));
		expect(age).toBeLessThanOrEqual(15 * 60);
		expect(started + age * 1000).toBeLessThanOrEqual(started + 15 * 60 * 1000);
		const who = await whoami(body.accessToken ?? "");
		expect(who.frame.result?.principal.provisional).toBe(true);
	});

	it("SR-08 confirming the provisional hat opens a full session", async () => {
		const member = await provisionInvitedMember({ role: "account-admin" });
		const boss = await loginDevPassword();
		await elevateAccessToken(boss.accessToken);
		await sendRpc(
			"system.members.update",
			{
				accountId: member.accountId,
				userId: member.userId,
				op: "grant",
				role: "user",
			},
			{ token: boss.accessToken },
		);
		const login = await devLogin(member.email, true);
		const old = login.body.accessToken ?? "";
		const before = await whoami(old);
		const next = await assume(old, "user", member.accountId);
		expect(next.res.status).toBe(200);
		expect(next.body.sessionId).not.toBe(
			before.frame.result?.principal.sessionId,
		);
		expect(maxAge(next.cookies)).toBeGreaterThan(60 * 60);
		const who = await whoami(next.body.accessToken ?? "");
		expect(who.frame.result?.principal.role).toBe("user");
		expect(who.frame.result?.principal.provisional).toBeUndefined();
		expect(who.frame.result?.principal.elevatedUntil).toBeUndefined();
		expect((await whoami(old)).frame.ok).toBe(false);
	});

	it("SR-09 assume account-admin then elevate keeps the hat", async () => {
		const member = await provisionInvitedMember({ role: "account-admin" });
		const boss = await loginDevPassword();
		await elevateAccessToken(boss.accessToken);
		await sendRpc(
			"system.members.update",
			{
				accountId: member.accountId,
				userId: member.userId,
				op: "grant",
				role: "user",
			},
			{ token: boss.accessToken },
		);
		const login = await devLogin(member.email, true);
		const old = login.body.accessToken ?? "";
		const next = await assume(old, "account-admin", member.accountId);
		expect(next.res.status).toBe(200);
		expect((await whoami(old)).frame.ok).toBe(false);
		const token = next.body.accessToken ?? "";
		const blocked = await sendRpc(
			"bot.delete",
			{ botId: "bot_missing" },
			{ token, accountId: member.accountId },
		);
		expect(blocked.frame.error?.code).toBe("elevation_required");
		const elevate = await sendRpc(
			"auth.elevate",
			{},
			{ token, accountId: member.accountId },
		);
		expect(elevate.frame.ok).toBe(true);
		const after = await whoami(token);
		expect(after.frame.result?.principal.role).toBe("account-admin");
		expect(after.frame.result?.principal.elevatedUntil).toBeTruthy();
	});

	it("SR-10 same hat on a full session is role_unchanged", async () => {
		const member = await provisionInvitedMember({ role: "account-admin" });
		const login = await devLogin(member.email);
		const token = login.body.accessToken ?? "";
		const before = await whoami(token);
		const same = await assume(token, "account-admin", member.accountId);
		expect(same.res.status).toBe(409);
		expect(same.body.error?.code).toBe("role_unchanged");
		const after = await whoami(token);
		expect(after.frame.result?.principal.sessionId).toBe(
			before.frame.result?.principal.sessionId,
		);
	});

	it("SR-11 assume user drops elevation", async () => {
		const member = await provisionInvitedMember({ role: "account-admin" });
		const boss = await loginDevPassword();
		await elevateAccessToken(boss.accessToken);
		await sendRpc(
			"system.members.update",
			{
				accountId: member.accountId,
				userId: member.userId,
				op: "grant",
				role: "user",
			},
			{ token: boss.accessToken },
		);
		const login = await devLogin(member.email);
		const old = login.body.accessToken ?? "";
		expect((await whoami(old)).frame.result?.principal.role).toBe("user");
		const admin = await assume(old, "account-admin", member.accountId);
		const adminToken = admin.body.accessToken ?? "";
		await elevateAccessToken(adminToken);
		expect(
			(await whoami(adminToken)).frame.result?.principal.elevatedUntil,
		).toBeTruthy();
		const user = await assume(adminToken, "user", member.accountId);
		expect((await whoami(adminToken)).frame.ok).toBe(false);
		const who = await whoami(user.body.accessToken ?? "");
		expect(who.frame.result?.principal.role).toBe("user");
		expect(who.frame.result?.principal.provisional).toBeUndefined();
		expect(who.frame.result?.principal.elevatedUntil).toBeUndefined();
		const elevate = await sendRpc(
			"auth.elevate",
			{},
			{ token: user.body.accessToken ?? "" },
		);
		expect(elevate.frame.error?.code).toBe("forbidden");
	});

	it("SR-12 missing user hat is forbidden and the session stays", async () => {
		const onlyAdmin = await provisionInvitedMember({ role: "account-admin" });
		const login = await devLogin(onlyAdmin.email);
		const token = login.body.accessToken ?? "";
		const before = await whoami(token);
		const refused = await assume(token, "user", onlyAdmin.accountId);
		expect(refused.res.status).toBe(403);
		expect(refused.body.error?.code).toBe("forbidden");
		const after = await whoami(token);
		expect(after.frame.result?.principal.sessionId).toBe(
			before.frame.result?.principal.sessionId,
		);
	});

	it("SR-13 super-admin and system account-admin are forbidden", async () => {
		const member = await provisionInvitedMember({ role: "user" });
		const login = await devLogin(member.email);
		const token = login.body.accessToken ?? "";
		const before = await whoami(token);
		const superAdmin = await assume(token, "super-admin", "system");
		expect(superAdmin.body.error?.code).toBe("forbidden");
		const systemAdmin = await assume(token, "account-admin", "system");
		expect(systemAdmin.body.error?.code).toBe("forbidden");
		const after = await whoami(token);
		expect(after.frame.result?.principal.sessionId).toBe(
			before.frame.result?.principal.sessionId,
		);
	});

	it("SR-14 missing bearer, rejected bearer, and token session", async () => {
		const missing = await workerFetch(`${ORIGIN}/api/auth/assumeRole`, {
			method: "POST",
			headers: { Origin: ORIGIN, "Content-Type": "application/json" },
			body: JSON.stringify({
				id: "assume",
				type: "auth.assumeRole",
				payload: { role: "user", accountId: "x" },
			}),
		});
		expect(missing.status).toBe(401);
		const rejected = await assume(
			"rejected-bearer",
			"user",
			"default-account",
		);
		expect(rejected.res.status).toBe(401);
		expect(rejected.body.error?.code).toBe("unauthorized");
		const member = await provisionInvitedMember({ role: "user" });
		const session = await devLogin(member.email);
		const minted = await sendRpc<{ token: string }>(
			"auth.tokens.create",
			{
				kind: "pat",
				label: "hat",
				grants: ["chat.use", "tokens.self"],
				ttlDays: 1,
			},
			{ token: session.body.accessToken ?? "" },
		);
		expect(minted.frame.ok, JSON.stringify(minted.frame)).toBe(true);
		const tokenLogin = await workerFetch(`${ORIGIN}/api/auth/login/token`, {
			method: "POST",
			headers: { Authorization: `Bearer ${minted.frame.result?.token ?? ""}` },
		});
		expect(tokenLogin.status).toBe(200);
		const opened = (await tokenLogin.json()) as { accessToken?: string };
		const before = await whoami(opened.accessToken ?? "");
		expect(before.frame.ok).toBe(true);
		const refused = await assume(
			opened.accessToken ?? "",
			"user",
			member.accountId,
		);
		expect(refused.body.error?.code).toBe("forbidden");
		const after = await whoami(opened.accessToken ?? "");
		expect(after.frame.result?.principal.sessionId).toBe(
			before.frame.result?.principal.sessionId,
		);
	});

	it("SR-15 unknown role is a validation error", async () => {
		const member = await provisionInvitedMember({ role: "user" });
		const login = await devLogin(member.email);
		const token = login.body.accessToken ?? "";
		const res = await workerFetch(`${ORIGIN}/api/auth/assumeRole`, {
			method: "POST",
			headers: {
				Origin: ORIGIN,
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				id: "assume",
				type: "auth.assumeRole",
				payload: { role: "owner", accountId: member.accountId },
			}),
		});
		expect(res.status).toBe(400);
		const missingAccount = await workerFetch(`${ORIGIN}/api/auth/assumeRole`, {
			method: "POST",
			headers: {
				Origin: ORIGIN,
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({
				id: "assume",
				type: "auth.assumeRole",
				payload: { role: "user" },
			}),
		});
		expect(missingAccount.status).toBe(400);
		expect((await whoami(token)).frame.ok).toBe(true);
	});

	it("SR-16 account switch does not wear a different hat", async () => {
		const user = await provisionInvitedMember({ role: "user" });
		const boss = await loginDevPassword();
		await elevateAccessToken(boss.accessToken);
		const created = await sendRpc<{ account: { id: string } }>(
			"system.accounts.create",
			{ name: "Other", ownerEmail: `o-${crypto.randomUUID()}@example.com` },
			{ token: boss.accessToken },
		);
		const other = created.frame.result?.account.id ?? "";
		await sendRpc(
			"system.members.invite",
			{ accountId: other, email: user.email, roles: ["account-admin"] },
			{ token: boss.accessToken },
		);
		const login = await devLogin(user.email);
		const res = await workerFetch("http://example.com/api/auth/whoami", {
			headers: {
				Authorization: `Bearer ${login.body.accessToken ?? ""}`,
				"x-account-id": other,
			},
		});
		expect(res.status).toBe(401);
	});

	it("SR-17 the second assume with the provisional bearer is 401", async () => {
		const member = await provisionInvitedMember({ role: "account-admin" });
		const boss = await loginDevPassword();
		await elevateAccessToken(boss.accessToken);
		await sendRpc(
			"system.members.update",
			{
				accountId: member.accountId,
				userId: member.userId,
				op: "grant",
				role: "user",
			},
			{ token: boss.accessToken },
		);
		const login = await devLogin(member.email, true);
		const token = login.body.accessToken ?? "";
		expect(
			(await assume(token, "account-admin", member.accountId)).res.status,
		).toBe(200);
		expect((await assume(token, "user", member.accountId)).res.status).toBe(
			401,
		);
	});

	it("SR-18 revoking account-admin kills that hat and personal tokens", async () => {
		const member = await provisionInvitedMember({ role: "account-admin" });
		const boss = await loginDevPassword();
		await elevateAccessToken(boss.accessToken);
		await sendRpc(
			"system.members.update",
			{
				accountId: member.accountId,
				userId: member.userId,
				op: "grant",
				role: "user",
			},
			{ token: boss.accessToken },
		);
		const admin = await devLogin(member.email);
		const asAdmin = await assume(
			admin.body.accessToken ?? "",
			"account-admin",
			member.accountId,
		);
		const user = await devLogin(member.email);
		const minted = await sendRpc<{ token: string }>(
			"auth.tokens.create",
			{ kind: "pat", label: "mine", grants: ["chat.use"], ttlDays: 1 },
			{ token: asAdmin.body.accessToken ?? "", accountId: member.accountId },
		);
		await sendRpc(
			"system.members.update",
			{
				accountId: member.accountId,
				userId: member.userId,
				op: "revoke",
				role: "account-admin",
			},
			{ token: boss.accessToken },
		);
		expect((await whoami(asAdmin.body.accessToken ?? "")).frame.ok).toBe(false);
		expect(
			(await whoami(user.body.accessToken ?? "")).frame.result?.principal.role,
		).toBe("user");
		const again = await workerFetch(`${ORIGIN}/api/auth/login/token`, {
			method: "POST",
			headers: { Authorization: `Bearer ${minted.frame.result?.token ?? ""}` },
		});
		expect(again.status).toBe(401);
	});

	it("SR-19 provisional hat is the lowest role, not the last-used account", async () => {
		const member = await provisionInvitedMember({ role: "user" });
		const boss = await loginDevPassword();
		await elevateAccessToken(boss.accessToken);
		const created = await sendRpc<{ account: { id: string } }>(
			"system.accounts.create",
			{ name: "Higher", ownerEmail: `h-${crypto.randomUUID()}@example.com` },
			{ token: boss.accessToken },
		);
		const higher = created.frame.result?.account.id ?? "";
		await sendRpc(
			"system.members.invite",
			{ accountId: higher, email: member.email, roles: ["account-admin"] },
			{ token: boss.accessToken },
		);
		const asAdmin = await devLogin(member.email);
		await assume(asAdmin.body.accessToken ?? "", "account-admin", higher);
		const chosen = await devLogin(member.email, true);
		const who = await whoami(chosen.body.accessToken ?? "");
		expect(who.frame.result?.principal.role).toBe("user");
		expect(who.frame.result?.principal.provisional).toBe(true);
	});
});
