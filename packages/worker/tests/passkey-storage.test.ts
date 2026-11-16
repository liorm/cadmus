import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getEdgeCache } from "../src/edge-cache.js";
import {
	CADMUS_SCHEMA_VERSION,
	D1AdminStore,
	ensureD1Schema,
	readSchemaVersion,
	resetD1InitializationCache,
} from "../src/store/d1-admin.js";
import {
	canEnrollPasskey,
	consumeChallenge,
	finishElevation,
	finishRegistration,
	finishRemoval,
	getActivePasskey,
	issueChallenge,
	MAX_LIVE_CHALLENGES,
	newAttemptId,
	PASSKEY_CHALLENGE_TTL_MS,
	userHandleFor,
} from "../src/store/d1-passkeys.js";
import { ELEVATION_MS } from "../src/store/d1-sessions.js";
import { uniqueAccountId } from "./helpers.js";

const db = () => env.CADMUS_ADMIN_DB;
const RP = { id: "app.example.com", origin: "https://app.example.com" };
const NOW = Date.now();

function store(): D1AdminStore {
	return new D1AdminStore({
		db: db(),
		encryptionKey: env.CADMUS_ENCRYPTION_KEY,
		edgeCache: getEdgeCache(env),
	});
}

async function seed() {
	const accountId = uniqueAccountId("pk");
	const userId = `usr_${accountId}`;
	const s = store();
	await s.ensureAccountAndUser({ accountId, userId, role: "super-admin" });
	// A session from a fresh Google sign-in: the only kind that may enroll a first passkey.
	const loginMethodId = `lm_${crypto.randomUUID()}`;
	await db()
		.prepare(
			`INSERT INTO cadmus_login_methods (id, user_id, provider, subject, display, created_at, last_used_at)
       VALUES (?1, ?2, 'google', ?3, 'test', ?4, ?4)`,
		)
		.bind(loginMethodId, userId, `g-${userId}`, Date.now())
		.run();
	const session = await s.createSession({
		userId,
		accountId,
		loginMethodId,
		freshGoogleAt: Date.now(),
	});
	return { s, accountId, userId, sessionId: session.sessionId };
}

const count = async (sql: string, ...binds: unknown[]) =>
	(
		await db()
			.prepare(sql)
			.bind(...binds)
			.first<{ n: number }>()
	)?.n ?? -1;

/** Issue a challenge and burn it for an attempt, as a route would before verifying. */
async function burn(
	purpose: "register" | "elevate" | "remove",
	who: { userId: string; sessionId: string },
	now = NOW,
	targetMethodId?: string,
) {
	const issued = await issueChallenge(db(), {
		purpose,
		...who,
		rp: RP,
		now,
		...(targetMethodId ? { targetMethodId } : {}),
	});
	if (!issued) throw new Error("issue refused");
	const attemptId = newAttemptId();
	const challenge = await consumeChallenge(db(), {
		id: issued.id,
		purpose,
		...who,
		rp: RP,
		attemptId,
		now,
	});
	return { challengeId: issued.id, attemptId, challenge, issued };
}

async function register(
	u: Awaited<ReturnType<typeof seed>>,
	credentialId: string,
	opts: { counter?: number; now?: number } = {},
) {
	// Additional passkeys need an elevated session; stand in for a passkey-proved one.
	if (
		(await count(
			`SELECT count(*) AS n FROM cadmus_passkeys WHERE user_id = ?1`,
			u.userId,
		)) > 0
	) {
		await db()
			.prepare(
				`UPDATE cadmus_sessions SET elevated_until = ?2 WHERE id = ?1 AND (elevated_until IS NULL OR elevated_until <= ?3)`,
			)
			.bind(u.sessionId, Date.now() + 3_600_000, Date.now())
			.run();
	}
	const b = await burn("register", u, opts.now);
	return finishRegistration(db(), {
		attemptId: b.attemptId,
		challengeId: b.challengeId,
		userId: u.userId,
		sessionId: u.sessionId,
		accountId: u.accountId,
		credential: {
			id: credentialId,
			publicKey: "cHVibGljLWtleQ",
			counter: opts.counter ?? 7,
			transports: ["internal", "hybrid"],
			deviceType: "multiDevice",
			backedUp: true,
		},
		display: "Test passkey",
		now: opts.now ?? NOW,
	});
}

const cred = () => `cred_${crypto.randomUUID()}`;

describe("challenges", () => {
	it("issues, burns exactly once, and binds user, session, purpose and relying party", async () => {
		const u = await seed();
		const other = await seed();
		const issued = await issueChallenge(db(), {
			purpose: "elevate",
			...u,
			rp: RP,
			now: NOW,
		});
		expect(issued).not.toBeNull();
		if (!issued) return;
		expect(issued.expiresAt).toBe(NOW + PASSKEY_CHALLENGE_TTL_MS);
		const consume = (over: Record<string, unknown> = {}, now = NOW + 1) =>
			consumeChallenge(db(), {
				id: issued.id,
				purpose: "elevate",
				userId: u.userId,
				sessionId: u.sessionId,
				rp: RP,
				attemptId: newAttemptId(),
				now,
				...over,
			});
		expect(await consume({ purpose: "register" })).toBeNull();
		expect(await consume({ userId: other.userId })).toBeNull();
		expect(await consume({ sessionId: other.sessionId })).toBeNull();
		expect(await consume({ rp: { ...RP, id: "evil.example.com" } })).toBeNull();
		expect(
			await consume({ rp: { ...RP, origin: "https://evil.example.com" } }),
		).toBeNull();
		expect(await consume({}, issued.expiresAt)).toBeNull();
		expect(await consume()).toBe(issued.challenge);
		expect(await consume()).toBeNull();
	});

	it("caps live challenges per user and purpose, ignores expired and consumed ones, and purges old rows", async () => {
		const u = await seed();
		const issue = (purpose: "register" | "elevate", now = NOW) =>
			issueChallenge(db(), { purpose, ...u, rp: RP, now });
		for (let i = 0; i < MAX_LIVE_CHALLENGES; i++)
			expect(await issue("elevate")).not.toBeNull();
		expect(await issue("elevate")).toBeNull();
		expect(await issue("register")).not.toBeNull();
		// After expiry the cap frees up again.
		const later = NOW + PASSKEY_CHALLENGE_TTL_MS + 1;
		expect(await issue("elevate", later)).not.toBeNull();
		// Rows expired for more than an hour are purged on the next issue.
		const old = NOW + PASSKEY_CHALLENGE_TTL_MS + 3_600_000 + 1;
		expect(
			await count(
				`SELECT COUNT(*) AS n FROM cadmus_passkey_challenges WHERE user_id = ?1 AND purpose = 'elevate'`,
				u.userId,
			),
		).toBe(MAX_LIVE_CHALLENGES + 1);
		expect(await issue("elevate", old)).not.toBeNull();
		// The five rows from NOW (expired over an hour) are gone; the row issued at
		// `later` (not yet an hour past expiry) and the new one remain.
		expect(
			await count(
				`SELECT COUNT(*) AS n FROM cadmus_passkey_challenges WHERE user_id = ?1 AND purpose = 'elevate' AND created_at = ?2`,
				u.userId,
				NOW,
			),
		).toBe(0);
		expect(
			await count(
				`SELECT COUNT(*) AS n FROM cadmus_passkey_challenges WHERE user_id = ?1 AND purpose = 'elevate'`,
				u.userId,
			),
		).toBe(2);
	});

	it("does not issue for a revoked session, a token session or a disabled user", async () => {
		const u = await seed();
		const s2 = await store().createSession({
			userId: u.userId,
			accountId: u.accountId,
		});
		await store().revokeSession(s2.sessionId);
		expect(
			await issueChallenge(db(), {
				purpose: "elevate",
				userId: u.userId,
				sessionId: s2.sessionId,
				rp: RP,
				now: NOW,
			}),
		).toBeNull();
		await db()
			.prepare(`UPDATE cadmus_users SET disabled_at = ?2 WHERE id = ?1`)
			.bind(u.userId, NOW)
			.run();
		expect(
			await issueChallenge(db(), {
				purpose: "elevate",
				...u,
				rp: RP,
				now: NOW,
			}),
		).toBeNull();
	});
});

describe("registration", () => {
	it("stores the typed passkey, its login method and an audit row, and round-trips the key", async () => {
		const u = await seed();
		const id = cred();
		const result = await register(u, id);
		expect(result.ok).toBe(true);
		const found = await getActivePasskey(db(), id);
		expect(found).toMatchObject({
			userId: u.userId,
			credentialId: id,
			publicKey: "cHVibGljLWtleQ",
			counter: 7,
			transports: ["internal", "hybrid"],
			deviceType: "multiDevice",
			backedUp: true,
		});
		expect(found?.userHandle.length).toBeGreaterThan(20);
		const method = await db()
			.prepare(
				`SELECT provider, subject, user_id FROM cadmus_login_methods WHERE id = ?1`,
			)
			.bind(found?.loginMethodId)
			.first();
		expect(method).toEqual({
			provider: "passkey",
			subject: id,
			user_id: u.userId,
		});
		expect(
			await count(
				`SELECT COUNT(*) AS n FROM cadmus_audit WHERE action = 'auth.passkey.register' AND actor_user_id = ?1`,
				u.userId,
			),
		).toBe(1);
	});

	it("reuses one opaque user handle for a user's later passkeys and a different one per user", async () => {
		const a = await seed();
		const b = await seed();
		await register(a, cred());
		await register(a, cred());
		await register(b, cred());
		const handle = async (uid: string) =>
			(
				await db()
					.prepare(
						`SELECT DISTINCT user_handle AS h FROM cadmus_passkeys WHERE user_id = ?1`,
					)
					.bind(uid)
					.all<{ h: string }>()
			).results.map((r) => r.h);
		const ha = await handle(a.userId);
		const hb = await handle(b.userId);
		expect(ha).toHaveLength(1);
		expect(hb).toHaveLength(1);
		expect(ha[0]).not.toBe(hb[0]);
		expect(ha[0]).not.toContain(a.userId);
	});

	it("rolls back everything and reports a duplicate credential id", async () => {
		const u = await seed();
		const id = cred();
		expect((await register(u, id)).ok).toBe(true);
		const before = await count(
			`SELECT COUNT(*) AS n FROM cadmus_login_methods WHERE user_id = ?1`,
			u.userId,
		);
		const audits = await count(
			`SELECT COUNT(*) AS n FROM cadmus_audit WHERE action = 'auth.passkey.register' AND actor_user_id = ?1`,
			u.userId,
		);
		expect(await register(u, id)).toEqual({
			ok: false,
			reason: "duplicate_credential",
		});
		expect(
			await count(
				`SELECT COUNT(*) AS n FROM cadmus_login_methods WHERE user_id = ?1`,
				u.userId,
			),
		).toBe(before);
		expect(
			await count(
				`SELECT COUNT(*) AS n FROM cadmus_audit WHERE action = 'auth.passkey.register' AND actor_user_id = ?1`,
				u.userId,
			),
		).toBe(audits);
	});

	it("leaves no rows when the session is revoked or the user disabled between verify and effect", async () => {
		const a = await seed();
		const idA = cred();
		const bA = await burn("register", a);
		await store().revokeSession(a.sessionId);
		const rA = await finishRegistration(db(), {
			attemptId: bA.attemptId,
			challengeId: bA.challengeId,
			userId: a.userId,
			sessionId: a.sessionId,
			accountId: a.accountId,
			credential: {
				id: idA,
				publicKey: "k",
				counter: 0,
				transports: [],
				deviceType: "singleDevice",
				backedUp: false,
			},
			display: "d",
			now: NOW,
		});
		expect(rA).toEqual({ ok: false, reason: "refused" });
		expect(await getActivePasskey(db(), idA)).toBeNull();
		expect(
			await count(
				`SELECT COUNT(*) AS n FROM cadmus_login_methods WHERE subject = ?1`,
				idA,
			),
		).toBe(0);
		expect(
			await count(
				`SELECT COUNT(*) AS n FROM cadmus_audit WHERE actor_user_id = ?1 AND action = 'auth.passkey.register'`,
				a.userId,
			),
		).toBe(0);

		const b = await seed();
		const idB = cred();
		const bB = await burn("register", b);
		await db()
			.prepare(`UPDATE cadmus_users SET disabled_at = ?2 WHERE id = ?1`)
			.bind(b.userId, NOW)
			.run();
		const rB = await finishRegistration(db(), {
			attemptId: bB.attemptId,
			challengeId: bB.challengeId,
			userId: b.userId,
			sessionId: b.sessionId,
			accountId: b.accountId,
			credential: {
				id: idB,
				publicKey: "k",
				counter: 0,
				transports: [],
				deviceType: "singleDevice",
				backedUp: false,
			},
			display: "d",
			now: NOW,
		});
		expect(rB).toEqual({ ok: false, reason: "refused" });
		expect(
			await count(
				`SELECT COUNT(*) AS n FROM cadmus_passkeys WHERE credential_id = ?1`,
				idB,
			),
		).toBe(0);
	});

	it("refuses an attempt id that did not burn the challenge", async () => {
		const u = await seed();
		const id = cred();
		const b = await burn("register", u);
		const r = await finishRegistration(db(), {
			attemptId: newAttemptId(),
			challengeId: b.challengeId,
			userId: u.userId,
			sessionId: u.sessionId,
			accountId: u.accountId,
			credential: {
				id,
				publicKey: "k",
				counter: 0,
				transports: [],
				deviceType: "singleDevice",
				backedUp: false,
			},
			display: "d",
			now: NOW,
		});
		expect(r).toEqual({ ok: false, reason: "refused" });
		expect(await getActivePasskey(db(), id)).toBeNull();
	});
});

async function elevate(
	u: { userId: string; sessionId: string },
	credentialId: string,
	verified: number,
	next: number,
	over: { sessionId?: string; attemptId?: string; now?: number } = {},
) {
	const b = await burn("elevate", {
		userId: u.userId,
		sessionId: over.sessionId ?? u.sessionId,
	});
	return finishElevation(db(), {
		attemptId: over.attemptId ?? b.attemptId,
		challengeId: b.challengeId,
		credentialId,
		verifiedAgainstCounter: verified,
		newCounter: next,
		sessionId: over.sessionId ?? u.sessionId,
		elevationMs: ELEVATION_MS,
		now: over.now ?? NOW,
	});
}
const elevatedUntil = async (sessionId: string) =>
	(
		await db()
			.prepare(`SELECT elevated_until AS e FROM cadmus_sessions WHERE id = ?1`)
			.bind(sessionId)
			.first<{ e: number | null }>()
	)?.e ?? null;
const counterOf = async (id: string) =>
	(
		await db()
			.prepare(
				`SELECT counter AS c FROM cadmus_passkeys WHERE credential_id = ?1`,
			)
			.bind(id)
			.first<{ c: number }>()
	)?.c;

describe("elevation", () => {
	it("elevates the session, advances the counter and audits, in one effect", async () => {
		const u = await seed();
		const id = cred();
		await register(u, id, { counter: 7 });
		const r = await elevate(u, id, 7, 9);
		expect(r).toEqual({ ok: true, elevatedUntil: NOW + ELEVATION_MS });
		expect(await elevatedUntil(u.sessionId)).toBe(NOW + ELEVATION_MS);
		expect(await counterOf(id)).toBe(9);
		expect(
			await count(
				`SELECT COUNT(*) AS n FROM cadmus_audit WHERE action = 'auth.elevate' AND target = ?1 AND data LIKE '%passkey%'`,
				u.sessionId,
			),
		).toBe(1);
	});

	it("lets only one of two concurrent assertions with a counter above 0 win, and elevates only for the winner", async () => {
		const u = await seed();
		const s2 = await store().createSession({
			userId: u.userId,
			accountId: u.accountId,
		});
		const id = cred();
		await register(u, id, { counter: 7 });
		const [r1, r2] = await Promise.all([
			elevate(u, id, 7, 8),
			elevate(u, id, 7, 8, { sessionId: s2.sessionId }),
		]);
		const oks = [r1, r2].filter((r) => r.ok);
		expect(oks).toHaveLength(1);
		const [e1, e2] = [
			await elevatedUntil(u.sessionId),
			await elevatedUntil(s2.sessionId),
		];
		expect([e1, e2].filter((e) => e !== null)).toHaveLength(1);
		expect(r1.ok ? e1 : e2).not.toBeNull();
		expect(await counterOf(id)).toBe(8);
	});

	it("documents that counterless (0 to 0) credentials can succeed twice on distinct challenges", async () => {
		const u = await seed();
		const id = cred();
		await register(u, id, { counter: 0 });
		const r1 = await elevate(u, id, 0, 0);
		const r2 = await elevate(u, id, 0, 0);
		expect(r1.ok && r2.ok).toBe(true);
	});

	it("another attempt's marker on the credential cannot elevate a different session", async () => {
		const u = await seed();
		const s2 = await store().createSession({
			userId: u.userId,
			accountId: u.accountId,
		});
		const id = cred();
		await register(u, id, { counter: 7 });
		expect((await elevate(u, id, 7, 8)).ok).toBe(true); // attempt A writes its marker
		// Attempt B verified against the old counter, so its CAS fails; A's marker stays.
		const r = await elevate(u, id, 7, 8, { sessionId: s2.sessionId });
		expect(r).toEqual({ ok: false, reason: "refused" });
		expect(await elevatedUntil(s2.sessionId)).toBeNull();
		expect(
			await count(
				`SELECT COUNT(*) AS n FROM cadmus_audit WHERE action = 'auth.elevate' AND target = ?1`,
				s2.sessionId,
			),
		).toBe(0);
	});

	it("refuses and changes nothing when the method, user or session is revoked after verification", async () => {
		const cases: [
			string,
			(u: Awaited<ReturnType<typeof seed>>, id: string) => Promise<void>,
		][] = [
			[
				"passkey method revoked",
				async (_u, id) => {
					await db()
						.prepare(
							`UPDATE cadmus_login_methods SET revoked_at = ?2 WHERE subject = ?1`,
						)
						.bind(id, NOW)
						.run();
				},
			],
			[
				"user disabled",
				async (u) => {
					await db()
						.prepare(`UPDATE cadmus_users SET disabled_at = ?2 WHERE id = ?1`)
						.bind(u.userId, NOW)
						.run();
				},
			],
			[
				"session revoked",
				async (u) => {
					await store().revokeSession(u.sessionId);
				},
			],
		];
		for (const [name, hook] of cases) {
			const u = await seed();
			const id = cred();
			await register(u, id, { counter: 7 });
			const b = await burn("elevate", u);
			await hook(u, id);
			const r = await finishElevation(db(), {
				attemptId: b.attemptId,
				challengeId: b.challengeId,
				credentialId: id,
				verifiedAgainstCounter: 7,
				newCounter: 8,
				sessionId: u.sessionId,
				elevationMs: ELEVATION_MS,
				now: NOW,
			});
			expect(r, name).toEqual({ ok: false, reason: "refused" });
			expect(await elevatedUntil(u.sessionId), name).toBeNull();
			expect(await counterOf(id), name).toBe(7);
			expect(
				await count(
					`SELECT COUNT(*) AS n FROM cadmus_audit WHERE action = 'auth.elevate' AND target = ?1`,
					u.sessionId,
				),
				name,
			).toBe(0);
		}
	});

	it("records the account admin mode was enabled in, on the session and in the audit row", async () => {
		const u = await seed();
		const id = cred();
		await register(u, id, { counter: 3 });
		const b = await burn("elevate", u);
		const r = await finishElevation(db(), {
			attemptId: b.attemptId,
			challengeId: b.challengeId,
			credentialId: id,
			verifiedAgainstCounter: 3,
			newCounter: 4,
			sessionId: u.sessionId,
			elevationMs: ELEVATION_MS,
			accountId: "acct_selected_other",
			now: NOW,
		});
		expect(r.ok).toBe(true);
		const row = await db()
			.prepare(
				`SELECT elevated_account_id AS a FROM cadmus_sessions WHERE id = ?1`,
			)
			.bind(u.sessionId)
			.first<{ a: string | null }>();
		expect(row?.a).toBe("acct_selected_other");
		expect(
			await count(
				`SELECT COUNT(*) AS n FROM cadmus_audit WHERE action = 'auth.elevate' AND target = ?1 AND account_id = 'acct_selected_other'`,
				u.sessionId,
			),
		).toBe(1);
	});

	it("refuses an unburned attempt id, another user's session, another session's challenge and a token session", async () => {
		const a = await seed();
		const b = await seed();
		const id = cred();
		await register(a, id, { counter: 7 });
		// attempt id that never burned a challenge
		expect(await elevate(a, id, 7, 8, { attemptId: newAttemptId() })).toEqual({
			ok: false,
			reason: "refused",
		});
		// credential of A with B's session
		expect(
			await elevate({ userId: b.userId, sessionId: b.sessionId }, id, 7, 8),
		).toEqual({ ok: false, reason: "refused" });
		// challenge burned for session s2, effect asked for session a
		const s2 = await store().createSession({
			userId: a.userId,
			accountId: a.accountId,
		});
		const burned = await burn("elevate", {
			userId: a.userId,
			sessionId: s2.sessionId,
		});
		const r = await finishElevation(db(), {
			attemptId: burned.attemptId,
			challengeId: burned.challengeId,
			credentialId: id,
			verifiedAgainstCounter: 7,
			newCounter: 8,
			sessionId: a.sessionId,
			elevationMs: ELEVATION_MS,
			now: NOW,
		});
		expect(r).toEqual({ ok: false, reason: "refused" });
		expect(await elevatedUntil(a.sessionId)).toBeNull();
		expect(await counterOf(id)).toBe(7);
	});

	it("policy: legacy startElevation works again once the user's last passkey is revoked", async () => {
		const v = await seed();
		const id = cred();
		await register(v, id);
		expect(await store().startElevation(v.sessionId)).toBeUndefined();
		await db()
			.prepare(
				`UPDATE cadmus_login_methods SET revoked_at = ?1 WHERE provider = 'passkey' AND subject = ?2`,
			)
			.bind(NOW, id)
			.run();
		expect(await store().startElevation(v.sessionId)).toBeTypeOf("number");
		expect(await elevatedUntil(v.sessionId)).not.toBeNull();
	});

	it("blocks the password-free startElevation path once the user has an active passkey", async () => {
		const u = await seed();
		expect(await store().startElevation(u.sessionId)).toBeTypeOf("number");
		const v = await seed();
		await register(v, cred());
		expect(await store().startElevation(v.sessionId)).toBeUndefined();
		expect(await elevatedUntil(v.sessionId)).toBeNull();
	});
});

describe("single-use effects", () => {
	const countRows = async (sql: string, ...b: unknown[]) =>
		(
			await db()
				.prepare(sql)
				.bind(...b)
				.first<{ n: number }>()
		)?.n ?? -1;
	const auditCount = (action: string) =>
		countRows(
			`SELECT count(*) AS n FROM cadmus_audit WHERE action = ?1`,
			action,
		);

	it("a repeated finishElevation with the same attempt changes nothing, even for a counterless credential", async () => {
		const u = await seed();
		const id = cred();
		await register(u, id, { counter: 0 });
		const b = await burn("elevate", u);
		const call = (now: number) =>
			finishElevation(db(), {
				attemptId: b.attemptId,
				challengeId: b.challengeId,
				credentialId: id,
				verifiedAgainstCounter: 0,
				newCounter: 0,
				sessionId: u.sessionId,
				elevationMs: ELEVATION_MS,
				now,
			});
		const first = await call(NOW);
		expect(first.ok).toBe(true);
		const until = await elevatedUntil(u.sessionId);
		const audits = await auditCount("auth.elevate");
		// Clear elevation, then replay at the same and a later timestamp.
		await db()
			.prepare(`UPDATE cadmus_sessions SET elevated_until = NULL WHERE id = ?1`)
			.bind(u.sessionId)
			.run();
		expect((await call(NOW)).ok).toBe(false);
		expect((await call(NOW + 1000)).ok).toBe(false);
		expect(await elevatedUntil(u.sessionId)).toBeNull();
		expect(await auditCount("auth.elevate")).toBe(audits);
		expect(until).toBe(NOW + ELEVATION_MS);
	});

	it("a repeated finishElevation with a stale counter does not re-elevate", async () => {
		const u = await seed();
		const id = cred();
		await register(u, id, { counter: 5 });
		const b = await burn("elevate", u);
		const base = {
			attemptId: b.attemptId,
			challengeId: b.challengeId,
			credentialId: id,
			sessionId: u.sessionId,
			elevationMs: ELEVATION_MS,
			now: NOW,
		};
		expect(
			(
				await finishElevation(db(), {
					...base,
					verifiedAgainstCounter: 5,
					newCounter: 6,
				})
			).ok,
		).toBe(true);
		await db()
			.prepare(`UPDATE cadmus_sessions SET elevated_until = NULL WHERE id = ?1`)
			.bind(u.sessionId)
			.run();
		const audits = await auditCount("auth.elevate");
		expect(
			(
				await finishElevation(db(), {
					...base,
					verifiedAgainstCounter: 5,
					newCounter: 6,
				})
			).ok,
		).toBe(false);
		expect(await elevatedUntil(u.sessionId)).toBeNull();
		expect(await auditCount("auth.elevate")).toBe(audits);
		expect(await counterOf(id)).toBe(6);
	});

	it("a second challenge burned with a reused attempt id and a stale counter elevates nothing", async () => {
		const u = await seed();
		const id = cred();
		await register(u, id, { counter: 5 });
		const b1 = await burn("elevate", u);
		const base = {
			credentialId: id,
			sessionId: u.sessionId,
			elevationMs: ELEVATION_MS,
			now: NOW,
		};
		expect(
			(
				await finishElevation(db(), {
					...base,
					attemptId: b1.attemptId,
					challengeId: b1.challengeId,
					verifiedAgainstCounter: 5,
					newCounter: 6,
				})
			).ok,
		).toBe(true);
		// Second challenge burned with the SAME attempt id.
		const issued = await issueChallenge(db(), {
			purpose: "elevate",
			userId: u.userId,
			sessionId: u.sessionId,
			rp: RP,
			now: NOW,
		});
		if (!issued) throw new Error("issue refused");
		await consumeChallenge(db(), {
			id: issued.id,
			purpose: "elevate",
			userId: u.userId,
			sessionId: u.sessionId,
			rp: RP,
			attemptId: b1.attemptId,
			now: NOW,
		});
		await db()
			.prepare(`UPDATE cadmus_sessions SET elevated_until = NULL WHERE id = ?1`)
			.bind(u.sessionId)
			.run();
		const audits = await auditCount("auth.elevate");
		const r = await finishElevation(db(), {
			...base,
			attemptId: b1.attemptId,
			challengeId: issued.id,
			verifiedAgainstCounter: 5,
			newCounter: 6,
		});
		expect(r.ok).toBe(false);
		expect(await elevatedUntil(u.sessionId)).toBeNull();
		expect(await auditCount("auth.elevate")).toBe(audits);
		expect(await counterOf(id)).toBe(6);
	});

	it("a same-attempt replay after the method is revoked elevates nothing", async () => {
		const u = await seed();
		const id = cred();
		await register(u, id, { counter: 0 });
		const b = await burn("elevate", u);
		const input = {
			attemptId: b.attemptId,
			challengeId: b.challengeId,
			credentialId: id,
			verifiedAgainstCounter: 0,
			newCounter: 0,
			sessionId: u.sessionId,
			elevationMs: ELEVATION_MS,
			now: NOW,
		};
		expect((await finishElevation(db(), input)).ok).toBe(true);
		await db()
			.prepare(
				`UPDATE cadmus_login_methods SET revoked_at = ?1 WHERE provider = 'passkey' AND subject = ?2`,
			)
			.bind(NOW, id)
			.run();
		await db()
			.prepare(`UPDATE cadmus_sessions SET elevated_until = NULL WHERE id = ?1`)
			.bind(u.sessionId)
			.run();
		expect((await finishElevation(db(), input)).ok).toBe(false);
		expect(await elevatedUntil(u.sessionId)).toBeNull();
	});

	it("a repeated finishRegistration with the same attempt and a different credential stores nothing", async () => {
		const u = await seed();
		const b = await burn("register", u);
		const input = (id: string) => ({
			attemptId: b.attemptId,
			challengeId: b.challengeId,
			userId: u.userId,
			sessionId: u.sessionId,
			accountId: u.accountId,
			credential: {
				id,
				publicKey: "cHVibGljLWtleQ",
				counter: 1,
				transports: ["internal"],
				deviceType: "singleDevice",
				backedUp: false,
			},
			display: "Replay",
			now: NOW,
		});
		const a = cred();
		const other = cred();
		expect((await finishRegistration(db(), input(a))).ok).toBe(true);
		const methods = await countRows(
			`SELECT count(*) AS n FROM cadmus_login_methods WHERE provider = 'passkey'`,
		);
		const keys = await countRows(`SELECT count(*) AS n FROM cadmus_passkeys`);
		const audits = await auditCount("auth.passkey.register");
		expect((await finishRegistration(db(), input(other))).ok).toBe(false);
		expect((await finishRegistration(db(), input(a))).ok).toBe(false);
		expect(
			await countRows(
				`SELECT count(*) AS n FROM cadmus_login_methods WHERE provider = 'passkey'`,
			),
		).toBe(methods);
		expect(await countRows(`SELECT count(*) AS n FROM cadmus_passkeys`)).toBe(
			keys,
		);
		expect(await auditCount("auth.passkey.register")).toBe(audits);
	});

	it("concurrent first handle assignment agrees on one handle", async () => {
		const u = await seed();
		const handles = await Promise.all(
			Array.from({ length: 6 }, () => userHandleFor(db(), u.userId)),
		);
		expect(new Set(handles).size).toBe(1);
		expect(handles[0]).toBeTruthy();
		expect(await userHandleFor(db(), u.userId)).toBe(handles[0]);
	});

	it("the first passkey ends legacy elevations; a later passkey keeps passkey-proved ones", async () => {
		const u = await seed();
		const second = await store().createSession({
			userId: u.userId,
			accountId: u.accountId,
		});
		expect(await store().startElevation(u.sessionId)).toBeTypeOf("number");
		expect(await store().startElevation(second.sessionId)).toBeTypeOf("number");
		const id = cred();
		expect((await register(u, id, { counter: 0 })).ok).toBe(true);
		expect(await elevatedUntil(u.sessionId)).toBeNull();
		expect(await elevatedUntil(second.sessionId)).toBeNull();
		// Elevate with the passkey, then add another: that elevation survives.
		expect((await elevate(u, id, 0, 0)).ok).toBe(true);
		const kept = await elevatedUntil(u.sessionId);
		expect(kept).not.toBeNull();
		expect((await register(u, cred())).ok).toBe(true);
		expect(await elevatedUntil(u.sessionId)).toBe(kept);
	});

	it("registers two passkeys for one user with the same stored handle", async () => {
		const u = await seed();
		await register(u, cred());
		await register(u, cred());
		expect(
			await countRows(
				`SELECT count(DISTINCT user_handle) AS n FROM cadmus_passkeys WHERE user_id = ?1`,
				u.userId,
			),
		).toBe(1);
	});
});

describe("populated v8 upgrade", () => {
	it("adds the passkey tables and handle column, keeps existing rows, and the new storage works", async () => {
		const u = await seed();
		const methodsBefore = await count(
			`SELECT count(*) AS n FROM cadmus_login_methods WHERE user_id = ?1`,
			u.userId,
		);
		try {
			// Rebuild the v8 shape: no passkey tables, no handle column, version 8.
			await db().prepare(`DROP TABLE cadmus_passkeys`).run();
			await db().prepare(`DROP TABLE cadmus_passkey_challenges`).run();
			await db()
				.prepare(`ALTER TABLE cadmus_users DROP COLUMN passkey_handle`)
				.run();
			await db()
				.prepare(
					`UPDATE cadmus_schema_meta SET value = '8' WHERE key = 'version'`,
				)
				.run();
			resetD1InitializationCache(db());
			expect(await readSchemaVersion(db())).toBe(8);
			await ensureD1Schema(db());
			expect(await readSchemaVersion(db())).toBe(CADMUS_SCHEMA_VERSION);
			expect(
				await count(
					`SELECT count(*) AS n FROM cadmus_login_methods WHERE user_id = ?1`,
					u.userId,
				),
			).toBe(methodsBefore);
			expect(
				await count(
					`SELECT count(*) AS n FROM cadmus_sessions WHERE id = ?1 AND revoked_at IS NULL`,
					u.sessionId,
				),
			).toBe(1);
			const id = cred();
			expect((await register(u, id)).ok).toBe(true);
			expect((await elevate(u, id, 7, 8)).ok).toBe(true);
		} finally {
			resetD1InitializationCache(db());
			await ensureD1Schema(db(), { force: true });
		}
	});
});

describe("populated v9 upgrade", () => {
	it("adds fresh_google_at, keeps existing sessions (unqualified for first enrollment) and the new flow works", async () => {
		const u = await seed();
		try {
			await db()
				.prepare(`ALTER TABLE cadmus_sessions DROP COLUMN fresh_google_at`)
				.run();
			await db()
				.prepare(
					`ALTER TABLE cadmus_passkey_challenges DROP COLUMN target_method_id`,
				)
				.run();
			await db()
				.prepare(
					`UPDATE cadmus_schema_meta SET value = '9' WHERE key = 'version'`,
				)
				.run();
			resetD1InitializationCache(db());
			expect(await readSchemaVersion(db())).toBe(9);
			await ensureD1Schema(db());
			expect(await readSchemaVersion(db())).toBe(CADMUS_SCHEMA_VERSION);
			const row = await db()
				.prepare(
					`SELECT fresh_google_at AS f, revoked_at AS r FROM cadmus_sessions WHERE id = ?1`,
				)
				.bind(u.sessionId)
				.first<{ f: number | null; r: number | null }>();
			expect(row).toEqual({ f: null, r: null });
			// The removal-target column came back too.
			await db()
				.prepare(
					`SELECT target_method_id FROM cadmus_passkey_challenges LIMIT 1`,
				)
				.all();
			// A pre-upgrade session has no verified auth_time, so it cannot enroll.
			expect(await canEnrollPasskey(db(), u)).toBe(false);
			const fresh = await store().createSession({
				userId: u.userId,
				accountId: u.accountId,
				loginMethodId: (
					await db()
						.prepare(`SELECT id FROM cadmus_login_methods WHERE user_id = ?1`)
						.bind(u.userId)
						.first<{ id: string }>()
				)?.id,
				freshGoogleAt: Date.now(),
			});
			expect(
				await canEnrollPasskey(db(), {
					userId: u.userId,
					sessionId: fresh.sessionId,
				}),
			).toBe(true);
		} finally {
			resetD1InitializationCache(db());
			await ensureD1Schema(db(), { force: true });
		}
	});
});

describe("populated v10 upgrade", () => {
	it("adds the removal columns, keeps passkeys, and removal works afterwards", async () => {
		const u = await seed();
		const a = cred();
		const b = cred();
		const ra = await register(u, a, { counter: 0 });
		const rb = await register(u, b, { counter: 0 });
		if (!ra.ok || !rb.ok) throw new Error("setup");
		try {
			for (const col of ["target_method_id", "removed_exec"]) {
				await db()
					.prepare(`ALTER TABLE cadmus_passkey_challenges DROP COLUMN ${col}`)
					.run();
			}
			await db()
				.prepare(
					`UPDATE cadmus_schema_meta SET value = '10' WHERE key = 'version'`,
				)
				.run();
			resetD1InitializationCache(db());
			expect(await readSchemaVersion(db())).toBe(10);
			await ensureD1Schema(db());
			expect(await readSchemaVersion(db())).toBe(CADMUS_SCHEMA_VERSION);
			expect(
				await count(
					`SELECT count(*) AS n FROM cadmus_passkeys WHERE user_id = ?1`,
					u.userId,
				),
			).toBe(2);
			const burned = await burn("remove", u, NOW, ra.loginMethodId);
			const done = await finishRemoval(db(), {
				attemptId: burned.attemptId,
				challengeId: burned.challengeId,
				credentialId: b,
				verifiedAgainstCounter: 0,
				newCounter: 1,
				sessionId: u.sessionId,
				now: NOW,
			});
			expect(done).toEqual({ ok: true, methodId: ra.loginMethodId });
		} finally {
			resetD1InitializationCache(db());
			await ensureD1Schema(db(), { force: true });
		}
	});
});

describe("enrollment authority is enforced in the effect", () => {
	const setSession = (sessionId: string, set: string, ...b: unknown[]) =>
		db()
			.prepare(`UPDATE cadmus_sessions SET ${set} WHERE id = ?1`)
			.bind(sessionId, ...b)
			.run();
	const nPasskeys = (userId: string) =>
		count(
			`SELECT count(*) AS n FROM cadmus_passkeys WHERE user_id = ?1`,
			userId,
		);
	// Raw enrollment with no elevation stand-in.
	async function enroll(
		u: Awaited<ReturnType<typeof seed>>,
		burned?: Awaited<ReturnType<typeof burn>>,
	) {
		const b = burned ?? (await burn("register", u));
		return finishRegistration(db(), {
			attemptId: b.attemptId,
			challengeId: b.challengeId,
			userId: u.userId,
			sessionId: u.sessionId,
			accountId: u.accountId,
			credential: {
				id: cred(),
				publicKey: "cHVibGljLWtleQ",
				counter: 0,
				transports: ["internal"],
				deviceType: "multiDevice",
				backedUp: true,
			},
			display: "t",
			now: NOW,
		});
	}

	it("refuses a first passkey when fresh_google_at is absent, stale or in the future", async () => {
		for (const v of [null, Date.now() - 6 * 60_000, Date.now() + 10 * 60_000]) {
			const u = await seed();
			await setSession(u.sessionId, "fresh_google_at = ?2", v);
			expect((await enroll(u)).ok).toBe(false);
			expect(await nPasskeys(u.userId)).toBe(0);
		}
	});

	it("refuses a first passkey for a session whose login method is not Google or is revoked", async () => {
		const u = await seed();
		await db()
			.prepare(
				`UPDATE cadmus_login_methods SET provider = 'github' WHERE user_id = ?1`,
			)
			.bind(u.userId)
			.run();
		expect((await enroll(u)).ok).toBe(false);
		await db()
			.prepare(
				`UPDATE cadmus_login_methods SET provider = 'google', revoked_at = ?2 WHERE user_id = ?1`,
			)
			.bind(u.userId, Date.now())
			.run();
		expect((await enroll(u)).ok).toBe(false);
	});

	it("two first enrollments verified before either effect: exactly one lands", async () => {
		const u = await seed();
		const a = await burn("register", u);
		const b = await burn("register", u);
		const first = await enroll(u, a);
		const second = await enroll(u, b);
		expect(first.ok).toBe(true);
		expect(second.ok).toBe(false);
		expect(await nPasskeys(u.userId)).toBe(1);
	});

	it("an additional passkey needs a live elevation at effect time, even with fresh Google", async () => {
		const u = await seed();
		expect((await enroll(u)).ok).toBe(true);
		// Fresh Google no longer suffices once a passkey exists.
		expect((await enroll(u)).ok).toBe(false);
		await setSession(u.sessionId, "elevated_until = ?2", Date.now() + 60_000);
		const b = await burn("register", u);
		// Elevation expires between verification and effect.
		await setSession(u.sessionId, "elevated_until = ?2", NOW - 1);
		expect((await enroll(u, b)).ok).toBe(false);
		expect(await nPasskeys(u.userId)).toBe(1);
		await setSession(u.sessionId, "elevated_until = ?2", Date.now() + 60_000);
		expect((await enroll(u)).ok).toBe(true);
		expect(await nPasskeys(u.userId)).toBe(2);
	});

	it("canEnrollPasskey mirrors the effect gate", async () => {
		const u = await seed();
		expect(await canEnrollPasskey(db(), u)).toBe(true);
		await setSession(u.sessionId, "fresh_google_at = NULL");
		expect(await canEnrollPasskey(db(), u)).toBe(false);
	});

	it("ending legacy elevations on the first passkey writes one audit row per session", async () => {
		const u = await seed();
		const second = await store().createSession({
			userId: u.userId,
			accountId: u.accountId,
		});
		await store().startElevation(u.sessionId);
		await store().startElevation(second.sessionId);
		expect((await enroll(u)).ok).toBe(true);
		expect(
			await count(
				`SELECT count(*) AS n FROM cadmus_audit WHERE action = 'auth.elevation.end' AND actor_user_id = ?1`,
				u.userId,
			),
		).toBe(2);
		expect(await elevatedUntil(second.sessionId)).toBeNull();
	});
});

describe("removal effect", () => {
	const nActive = async (userId: string) =>
		count(
			`SELECT count(*) AS n FROM cadmus_passkeys p JOIN cadmus_login_methods m ON m.id = p.login_method_id
       WHERE p.user_id = ?1 AND m.revoked_at IS NULL`,
			userId,
		);
	async function twoPasskeys() {
		const u = await seed();
		const a = cred();
		const b = cred();
		const ra = await register(u, a, { counter: 0 });
		const rb = await register(u, b, { counter: 0 });
		if (!ra.ok || !rb.ok) throw new Error("setup");
		return { u, a, b, ma: ra.loginMethodId, mb: rb.loginMethodId };
	}
	const remove = async (
		u: { userId: string; sessionId: string },
		proof: string,
		target: string,
		burned?: Awaited<ReturnType<typeof burn>>,
	) => {
		const b = burned ?? (await burn("remove", u, NOW, target));
		return finishRemoval(db(), {
			attemptId: b.attemptId,
			challengeId: b.challengeId,
			credentialId: proof,
			verifiedAgainstCounter: 0,
			newCounter: 1,
			sessionId: u.sessionId,
			now: NOW,
		});
	};

	it("a stale counter (lost CAS) removes nothing and writes no audit or revocation", async () => {
		const { u, b, ma } = await twoPasskeys();
		const burned = await burn("remove", u, NOW, ma);
		const r = await finishRemoval(db(), {
			attemptId: burned.attemptId,
			challengeId: burned.challengeId,
			credentialId: b,
			verifiedAgainstCounter: 99,
			newCounter: 100,
			sessionId: u.sessionId,
			now: NOW,
		});
		expect(r.ok).toBe(false);
		expect(await nActive(u.userId)).toBe(2);
		expect(
			await count(
				`SELECT count(*) AS n FROM cadmus_audit WHERE action = 'auth.passkey.remove' AND actor_user_id = ?1`,
				u.userId,
			),
		).toBe(0);
	});

	it("issue refuses a target that is not the user's active passkey method", async () => {
		const { u, ma } = await twoPasskeys();
		const other = await seed();
		expect(
			await issueChallenge(db(), { purpose: "remove", ...u, rp: RP }),
		).toBeNull();
		expect(
			await issueChallenge(db(), {
				purpose: "remove",
				...other,
				rp: RP,
				targetMethodId: ma,
			}),
		).toBeNull();
		expect(
			await issueChallenge(db(), {
				purpose: "remove",
				...u,
				rp: RP,
				targetMethodId: "lm_none",
			}),
		).toBeNull();
		// A target on any other purpose is refused too.
		expect(
			await issueChallenge(db(), {
				purpose: "elevate",
				...u,
				rp: RP,
				targetMethodId: ma,
			}),
		).toBeNull();
	});

	it("removes only the method fixed at issue, proven by another passkey; replays change nothing", async () => {
		const { u, a, b, ma, mb } = await twoPasskeys();
		const burned = await burn("remove", u, NOW, ma);
		const first = await remove(u, b, ma, burned);
		expect(first).toEqual({ ok: true, methodId: ma });
		expect(await nActive(u.userId)).toBe(1);
		const left = await db()
			.prepare(
				`SELECT credential_id AS c FROM cadmus_passkeys p JOIN cadmus_login_methods m ON m.id = p.login_method_id WHERE p.user_id = ?1 AND m.revoked_at IS NULL`,
			)
			.bind(u.userId)
			.first<{ c: string }>();
		expect(left?.c).toBe(b);
		expect(mb).not.toBe(ma);
		expect(a).not.toBe(b);
		// Same burned challenge and attempt again: refused, nothing more removed.
		const replay = await remove(u, b, ma, burned);
		expect(replay.ok).toBe(false);
		expect(await nActive(u.userId)).toBe(1);
	});

	it("removes at most one of two passkeys when the user has no other login method", async () => {
		const { u, a, b, ma, mb } = await twoPasskeys();
		await db()
			.prepare(
				`UPDATE cadmus_login_methods SET revoked_at = ?2 WHERE user_id = ?1 AND provider = 'google'`,
			)
			.bind(u.userId, Date.now())
			.run();
		const c1 = await burn("remove", u, NOW, ma);
		const c2 = await burn("remove", u, NOW, mb);
		expect((await remove(u, a, ma, c1)).ok).toBe(true);
		// A live session signed in with the surviving passkey method.
		const surviving = await u.s.createSession({
			userId: u.userId,
			accountId: u.accountId,
			loginMethodId: mb,
		});
		expect((await remove(u, b, mb, c2)).ok).toBe(false);
		expect(await nActive(u.userId)).toBe(1);
		// The refused removal must not sign out the method it failed to remove.
		const live = await db()
			.prepare(`SELECT revoked_at AS r FROM cadmus_sessions WHERE id = ?1`)
			.bind(surviving.sessionId)
			.first<{ r: number | null }>();
		expect(live?.r).toBeNull();
	});

	it("a session revoked after verification stops the removal", async () => {
		const { u, a, ma } = await twoPasskeys();
		const burned = await burn("remove", u, NOW, ma);
		await db()
			.prepare(`UPDATE cadmus_sessions SET revoked_at = ?2 WHERE id = ?1`)
			.bind(u.sessionId, Date.now())
			.run();
		expect((await remove(u, a, ma, burned)).ok).toBe(false);
		expect(await nActive(u.userId)).toBe(2);
	});
});
