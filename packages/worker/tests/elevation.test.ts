import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getEdgeCache } from "../src/edge-cache.js";
import { D1AdminStore } from "../src/store/d1-admin.js";
import { ELEVATION_MS } from "../src/store/d1-sessions.js";
import { sendRpc, uniqueAccountId } from "./helpers.js";

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
		principal?: { elevatedUntil?: number };
	};
	error?: { code: string };
};

const rpc = (
	token: string,
	type: string,
	payload?: Record<string, unknown>,
	familyId?: string,
) =>
	sendRpc<{
		elevatedUntil?: number;
		ended?: boolean;
		ticket?: string;
		principal?: { elevatedUntil?: number };
	}>(type, payload, { token, ...(familyId ? { familyId } : {}) });

async function audit(sessionId: string): Promise<string[]> {
	return (
		await env.CADMUS_ADMIN_DB.prepare(
			`SELECT action FROM cadmus_audit WHERE target = ?1 ORDER BY at, rowid`,
		)
			.bind(sessionId)
			.all<{ action: string }>()
	).results.map((r) => r.action);
}

async function invitedEmails(accountId: string): Promise<string[]> {
	return (
		await env.CADMUS_ADMIN_DB.prepare(
			`SELECT email FROM cadmus_invites WHERE account_id = ?1`,
		)
			.bind(accountId)
			.all<{ email: string }>()
	).results.map((r) => r.email);
}

const inviteMember = (token: string, email: string, familyId?: string) =>
	rpc(token, "account.members.invite", { email }, familyId);

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
		const denied = await inviteMember(
			session.accessToken,
			"locked@example.com",
		);
		expect(denied.frame.ok).toBe(false);
		expect(denied.frame.error?.code).toBe("elevation_required");
		// State is unchanged on denial and no elevated command was recorded.
		expect(await invitedEmails(accountId)).not.toContain("locked@example.com");
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

		expect(
			(await inviteMember(session.accessToken, "unlocked@example.com")).frame
				.ok,
		).toBe(true);
		expect(await invitedEmails(accountId)).toContain("unlocked@example.com");
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
		const denied = await inviteMember(
			session.accessToken,
			"after-end@example.com",
		);
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
		const denied = await inviteMember(
			session.accessToken,
			"expired@example.com",
		);
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
			"account.members.invite",
			"attempt",
			op,
		);
		// The mode ends (here: expires) while the command is still running.
		await env.CADMUS_ADMIN_DB.prepare(
			`UPDATE cadmus_sessions SET elevated_until = ?2 WHERE id = ?1`,
		)
			.bind(session.sessionId, Date.now() - 1_000)
			.run();
		await s.auditElevatedCommand(
			session.sessionId,
			"account.members.invite",
			"ok",
			op,
		);
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
			command: "account.members.invite",
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
			const res = await inviteMember(
				session.accessToken,
				"no-audit@example.com",
			).catch(() => undefined);
			if (res) {
				expect(res.frame.ok).toBe(false);
			}
			expect(await invitedEmails(accountId)).not.toContain(
				"no-audit@example.com",
			);
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
			const res = await inviteMember(
				session.accessToken,
				"result-lost@example.com",
			);
			expect(res.frame.ok).toBe(true);
			expect(await invitedEmails(accountId)).toContain(
				"result-lost@example.com",
			);
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
			const res = await inviteMember(
				session.accessToken,
				"in-flight@example.com",
			);
			expect(res.frame.ok).toBe(true);
			expect(await invitedEmails(accountId)).toContain("in-flight@example.com");
			const rows = await ops(session.sessionId);
			expect(rows.map((r) => r.action)).toEqual([
				"elevated.command",
				"elevated.command.result",
			]);
			expect(rows[0]?.op).toBe(rows[1]?.op);
			expect(rows[1]?.outcome).toBe("completed");
			expect(rows[1]?.family).toBe("default");
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
		expect(
			(
				await rpc(session.accessToken, "family.create", {
					familyId: "conc-a",
					name: "conc-a",
				})
			).frame.ok,
		).toBe(true);
		expect(
			(
				await rpc(session.accessToken, "family.create", {
					familyId: "conc-b",
					name: "conc-b",
				})
			).frame.ok,
		).toBe(true);
		await rpc(session.accessToken, "auth.elevate");
		const [a, b] = await Promise.all([
			inviteMember(session.accessToken, "conc-a@example.com", "conc-a"),
			inviteMember(session.accessToken, "conc-b@example.com", "conc-b"),
		]);
		expect(a.frame.ok && b.frame.ok).toBe(true);
		expect(await invitedEmails(accountId)).toEqual(
			expect.arrayContaining(["conc-a@example.com", "conc-b@example.com"]),
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
		const who = await rpc(admin.session.accessToken, "auth.whoami");
		expect(who.frame.ok).toBe(true);
		expect(who.frame.result?.principal).not.toHaveProperty("viaToken");
		expect(who.frame.result?.principal).toMatchObject({
			role: "account-admin",
		});
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
			send("account.members.invite", { email: `${id}@example.com` });

		expect((await make("ws-before")).error?.code).toBe("elevation_required");
		await rpc(session.accessToken, "auth.elevate");
		expect((await make("ws-during")).ok).toBe(true);
		await rpc(session.accessToken, "auth.elevation.end");
		expect((await make("ws-after")).error?.code).toBe("elevation_required");
		ws.close();
	});

	it("a raw shared secret cannot run an elevated command", async () => {
		const accountId = uniqueAccountId("elev-master");
		const res = await SELF.fetch(`${ORIGIN}/rpc`, {
			method: "POST",
			headers: {
				authorization: `Bearer raw-${crypto.randomUUID()}`,
				"content-type": "application/json",
				"x-account-id": accountId,
			},
			body: JSON.stringify({
				id: crypto.randomUUID(),
				type: "family.create",
				payload: { familyId: "legacy", name: "legacy" },
			}),
		});
		expect(res.status).toBe(401);
		expect(await res.json()).toMatchObject({
			type: "protocol.error",
			payload: { code: "unauthorized" },
		});
	});
});
