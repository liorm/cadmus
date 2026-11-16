import { env, SELF } from "cloudflare:test";
import { ROLE_GRANTS } from "@cadmus/contract/grants";
import { describe, expect, it } from "vitest";
import { getEdgeCache } from "../src/edge-cache.js";
import { D1AdminStore } from "../src/store/d1-admin.js";
import { ELEVATION_MS } from "../src/store/d1-sessions.js";
import { sendRpc, TEST_TOKEN, uniqueAccountId } from "./helpers.js";

const ORIGIN = "https://example.com";

function store(): D1AdminStore {
	return new D1AdminStore({
		db: env.CADMUS_ADMIN_DB,
		encryptionKey: env.CADMUS_ENCRYPTION_KEY,
		edgeCache: getEdgeCache(env),
	});
}

async function seed(role: "user" | "account-admin" | "super-admin") {
	const s = store();
	const accountId = uniqueAccountId("elev");
	const userId = `usr_${accountId}`;
	await s.ensureAccountAndUser({ accountId, userId, role });
	const session = await s.createSession({ userId, accountId });
	return { s, accountId, userId, session };
}

type Frame = {
	ok: boolean;
	result?: {
		elevatedUntil?: number;
		ended?: boolean;
		ticket?: string;
		principal?: { elevatedUntil?: number; viaToken?: boolean };
	};
	error?: { code: string };
};

const rpc = (token: string, type: string, payload?: Record<string, unknown>) =>
	sendRpc<{
		elevatedUntil?: number;
		ended?: boolean;
		ticket?: string;
		principal?: { elevatedUntil?: number; viaToken?: boolean };
	}>(type, payload, { token });

async function audit(sessionId: string): Promise<string[]> {
	return (
		await env.CADMUS_ADMIN_DB.prepare(
			`SELECT action FROM cadmus_audit WHERE target = ?1 ORDER BY at, rowid`,
		)
			.bind(sessionId)
			.all<{ action: string }>()
	).results.map((r) => r.action);
}

async function familyIds(accountId: string): Promise<string[]> {
	return (
		await env.CADMUS_ADMIN_DB.prepare(
			`SELECT family_id FROM cadmus_families WHERE account_id = ?1`,
		)
			.bind(accountId)
			.all<{ family_id: string }>()
	).results.map((r) => r.family_id);
}

const createFamily = (token: string, familyId: string) =>
	rpc(token, "family.create", { familyId, name: familyId });

async function ops(sessionId: string) {
	const rows = (
		await env.CADMUS_ADMIN_DB.prepare(
			`SELECT action, data FROM cadmus_audit WHERE target = ?1 AND action LIKE 'elevated.command%' ORDER BY at, rowid`,
		)
			.bind(sessionId)
			.all<{ action: string; data: string }>()
	).results;
	return rows.map((r) => ({ action: r.action, ...JSON.parse(r.data) }));
}

describe("admin mode (issue #3 phase 6)", () => {
	it("refuses an elevated command until the admin turns admin mode on", async () => {
		const { accountId, session } = await seed("account-admin");
		const denied = await createFamily(session.accessToken, "locked");
		expect(denied.frame.ok).toBe(false);
		expect(denied.frame.error?.code).toBe("elevation_required");
		// State is unchanged on denial and no elevated command was recorded.
		expect(await familyIds(accountId)).not.toContain("locked");
		expect(await audit(session.sessionId)).toEqual(["session.create"]);
		// Commands that do not need admin mode keep working.
		const list = await rpc(session.accessToken, "family.list");
		expect(list.frame.ok).toBe(true);
	});

	it("allows elevated commands once elevated and audits start and each command", async () => {
		const { accountId, session } = await seed("account-admin");
		const before = Date.now();
		const on = await rpc(session.accessToken, "auth.elevate");
		expect(on.frame.ok).toBe(true);
		const until = on.frame.result?.elevatedUntil as number;
		expect(until).toBeGreaterThanOrEqual(before + ELEVATION_MS);
		expect(until).toBeLessThanOrEqual(Date.now() + ELEVATION_MS);

		const who = await rpc(session.accessToken, "auth.whoami");
		expect(who.frame.result?.principal?.elevatedUntil).toBe(until);

		expect((await createFamily(session.accessToken, "unlocked")).frame.ok).toBe(
			true,
		);
		expect(await familyIds(accountId)).toContain("unlocked");
		expect(await audit(session.sessionId)).toEqual([
			"session.create",
			"auth.elevate",
			"elevated.command",
			"elevated.command.result",
		]);
	});

	it("ends admin mode on request and refuses again", async () => {
		const { session } = await seed("account-admin");
		await rpc(session.accessToken, "auth.elevate");
		const off = await rpc(session.accessToken, "auth.elevation.end");
		expect(off.frame.result?.ended).toBe(true);
		const denied = await createFamily(session.accessToken, "after-end");
		expect(denied.frame.error?.code).toBe("elevation_required");
		const who = await rpc(session.accessToken, "auth.whoami");
		expect(who.frame.result?.principal?.elevatedUntil).toBeUndefined();
		// Ending twice is a no-op and writes one audit row.
		const again = await rpc(session.accessToken, "auth.elevation.end");
		expect(again.frame.result?.ended).toBe(false);
		expect(
			(await audit(session.sessionId)).filter(
				(a) => a === "auth.elevation.end",
			),
		).toHaveLength(1);
	});

	it("expires admin mode after its lifetime", async () => {
		const { session } = await seed("account-admin");
		await rpc(session.accessToken, "auth.elevate");
		await env.CADMUS_ADMIN_DB.prepare(
			`UPDATE cadmus_sessions SET elevated_until = ?2 WHERE id = ?1`,
		)
			.bind(session.sessionId, Date.now() - 1_000)
			.run();
		const denied = await createFamily(session.accessToken, "expired");
		expect(denied.frame.error?.code).toBe("elevation_required");
		const who = await rpc(session.accessToken, "auth.whoami");
		expect(who.frame.result?.principal?.elevatedUntil).toBeUndefined();
		expect(await audit(session.sessionId)).not.toContain("elevated.command");
	});

	it("keeps the audit rows when admin mode ends before the outcome is written", async () => {
		const { s, session } = await seed("account-admin");
		await rpc(session.accessToken, "auth.elevate");
		const op = { id: "op-1", familyId: "f1" };
		await s.auditElevatedCommand(
			session.sessionId,
			"family.create",
			"attempt",
			op,
		);
		// The mode ends (here: expires) while the command is still running.
		await env.CADMUS_ADMIN_DB.prepare(
			`UPDATE cadmus_sessions SET elevated_until = ?2 WHERE id = ?1`,
		)
			.bind(session.sessionId, Date.now() - 1_000)
			.run();
		await s.auditElevatedCommand(session.sessionId, "family.create", "ok", op);
		expect(await audit(session.sessionId)).toEqual([
			"session.create",
			"auth.elevate",
			"elevated.command",
			"elevated.command.result",
		]);
		const row = await env.CADMUS_ADMIN_DB.prepare(
			`SELECT data FROM cadmus_audit WHERE target = ?1 AND action = 'elevated.command.result'`,
		)
			.bind(session.sessionId)
			.first<{ data: string }>();
		expect(JSON.parse(row?.data ?? "{}")).toEqual({
			command: "family.create",
			op: "op-1",
			family: "f1",
			outcome: "completed",
		});
	});

	it("refuses the command and changes nothing when the attempt audit cannot be written", async () => {
		const { accountId, session } = await seed("account-admin");
		await rpc(session.accessToken, "auth.elevate");
		const db = env.CADMUS_ADMIN_DB;
		await db
			.prepare(
				`CREATE TRIGGER zz_fail_attempt BEFORE INSERT ON cadmus_audit WHEN NEW.action = 'elevated.command' BEGIN SELECT RAISE(ABORT, 'audit down'); END`,
			)
			.run();
		try {
			// The edge path has no handler to turn the failure into a frame, so the
			// request errors out; what matters is that nothing was created.
			await expect(
				createFamily(session.accessToken, "no-audit"),
			).rejects.toThrow();
			expect(await familyIds(accountId)).not.toContain("no-audit");
		} finally {
			await db.prepare(`DROP TRIGGER zz_fail_attempt`).run();
		}
	});

	it("keeps a committed action successful when only the outcome audit is lost", async () => {
		const { accountId, session } = await seed("account-admin");
		await rpc(session.accessToken, "auth.elevate");
		const db = env.CADMUS_ADMIN_DB;
		await db
			.prepare(
				`CREATE TRIGGER zz_fail_result BEFORE INSERT ON cadmus_audit WHEN NEW.action = 'elevated.command.result' BEGIN SELECT RAISE(ABORT, 'audit down'); END`,
			)
			.run();
		try {
			const res = await createFamily(session.accessToken, "result-lost");
			expect(res.frame.ok).toBe(true);
			expect(await familyIds(accountId)).toContain("result-lost");
			const rows = await audit(session.sessionId);
			expect(rows).toContain("elevated.command");
			expect(rows).not.toContain("elevated.command.result");
		} finally {
			await db.prepare(`DROP TRIGGER zz_fail_result`).run();
		}
	});

	it("records the outcome of a command whose admin mode ended while it ran", async () => {
		const { accountId, session } = await seed("account-admin");
		await rpc(session.accessToken, "auth.elevate");
		const db = env.CADMUS_ADMIN_DB;
		// Ends the mode right after the attempt row is written, i.e. in flight.
		await db
			.prepare(
				`CREATE TRIGGER zz_expire AFTER INSERT ON cadmus_audit WHEN NEW.action = 'elevated.command' BEGIN UPDATE cadmus_sessions SET elevated_until = 1 WHERE id = NEW.target; END`,
			)
			.run();
		try {
			const res = await createFamily(session.accessToken, "in-flight");
			expect(res.frame.ok).toBe(true);
			expect(await familyIds(accountId)).toContain("in-flight");
			const rows = await ops(session.sessionId);
			expect(rows.map((r) => r.action)).toEqual([
				"elevated.command",
				"elevated.command.result",
			]);
			expect(rows[0]?.op).toBe(rows[1]?.op);
			expect(rows[1]?.outcome).toBe("completed");
			expect(rows[1]?.family).toBe("in-flight");
		} finally {
			await db.prepare(`DROP TRIGGER zz_expire`).run();
		}
	});

	it("pairs attempt and outcome per operation, with the target, on the DO path", async () => {
		const { session } = await seed("account-admin");
		await rpc(session.accessToken, "auth.elevate");
		const ok = await rpc(session.accessToken, "account.members.invite", {
			email: "pair@example.com",
		});
		expect(ok.frame.ok).toBe(true);
		// The handler throws on a bad address: recorded as threw, not as a rollback.
		const bad = await rpc(session.accessToken, "account.members.invite", {
			email: "not-an-email",
		});
		expect(bad.frame.ok).toBe(false);
		const rows = await ops(session.sessionId);
		const attempts = rows.filter((r) => r.action === "elevated.command");
		const results = rows.filter((r) => r.action === "elevated.command.result");
		expect(attempts).toHaveLength(2);
		expect(results).toHaveLength(2);
		for (const a of attempts) {
			expect(a.command).toBe("account.members.invite");
			expect(typeof a.op).toBe("string");
			expect(results.filter((r) => r.op === a.op)).toHaveLength(1);
		}
		expect(new Set(attempts.map((a) => a.op)).size).toBe(2);
		expect(results.map((r) => r.outcome).sort()).toEqual([
			"completed",
			"threw",
		]);
	});

	it("keeps two concurrent same-command operations apart by family", async () => {
		const { accountId, session } = await seed("account-admin");
		await rpc(session.accessToken, "auth.elevate");
		const [a, b] = await Promise.all([
			createFamily(session.accessToken, "conc-a"),
			createFamily(session.accessToken, "conc-b"),
		]);
		expect(a.frame.ok && b.frame.ok).toBe(true);
		expect(await familyIds(accountId)).toEqual(
			expect.arrayContaining(["conc-a", "conc-b"]),
		);
		const rows = await ops(session.sessionId);
		for (const family of ["conc-a", "conc-b"]) {
			const mine = rows.filter((r) => r.family === family);
			expect(mine.map((r) => r.action).sort()).toEqual([
				"elevated.command",
				"elevated.command.result",
			]);
			expect(new Set(mine.map((r) => r.op)).size).toBe(1);
		}
	});

	it("is only for admins on a user session", async () => {
		const plain = await seed("user");
		const user = await rpc(plain.session.accessToken, "auth.elevate");
		expect(user.frame.ok).toBe(false);
		expect(user.frame.error?.code).toBe("forbidden");

		const admin = await seed("account-admin");
		const token = await admin.s.createToken({
			accountId: admin.accountId,
			creatorUserId: admin.userId,
			creatorRole: "account-admin",
			creatorGrants: ROLE_GRANTS["account-admin"],
			kind: "pat",
			label: "no elevate",
			grants: ["chat.use", "tokens.self"],
			ttlMs: 86_400_000,
		});
		if (!token.ok) throw new Error(token.message);
		const login = await SELF.fetch(`${ORIGIN}/auth/token-login`, {
			method: "POST",
			headers: { authorization: `Bearer ${token.token}` },
		});
		expect(login.status).toBe(200);
		const { accessToken } = (await login.json()) as { accessToken: string };
		const viaToken = await rpc(accessToken, "auth.elevate");
		expect(viaToken.frame.ok).toBe(false);
		const who = await rpc(accessToken, "auth.whoami");
		expect(who.frame.result?.principal?.viaToken).toBe(true);
	});

	it("applies to a socket opened before admin mode was turned on, and when it ends", async () => {
		const { session } = await seed("account-admin");
		const issued = await rpc(session.accessToken, "auth.ticket", {
			target: "ws",
		});
		const res = await SELF.fetch(
			`${ORIGIN}/ws?ticket=${issued.frame.result?.ticket}`,
			{ headers: { upgrade: "websocket" } },
		);
		const ws = res.webSocket;
		if (!ws) throw new Error(`expected 101, got ${res.status}`);
		ws.accept();
		const pending = new Map<string, (frame: Frame) => void>();
		ws.addEventListener("message", (ev) => {
			const frame = JSON.parse(ev.data as string);
			pending.get(frame.id)?.(frame);
		});
		const send = (type: string, payload: Record<string, unknown> = {}) =>
			new Promise<Frame>((resolve) => {
				const id = crypto.randomUUID();
				pending.set(id, resolve);
				ws.send(JSON.stringify({ id, type, payload }));
			});
		const make = (id: string) =>
			send("family.create", { familyId: id, name: id });

		expect((await make("ws-before")).error?.code).toBe("elevation_required");
		await rpc(session.accessToken, "auth.elevate");
		expect((await make("ws-during")).ok).toBe(true);
		await rpc(session.accessToken, "auth.elevation.end");
		expect((await make("ws-after")).error?.code).toBe("elevation_required");
		ws.close();
	});

	it("does not ask the legacy master secret to elevate", async () => {
		const accountId = uniqueAccountId("elev-master");
		const res = await SELF.fetch(`${ORIGIN}/rpc`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${TEST_TOKEN}`,
				"content-type": "application/json",
				"x-account-id": accountId,
			},
			body: JSON.stringify({
				id: crypto.randomUUID(),
				type: "family.create",
				payload: { familyId: "legacy", name: "legacy" },
			}),
		});
		expect(((await res.json()) as Frame).ok).toBe(true);
	});
});
