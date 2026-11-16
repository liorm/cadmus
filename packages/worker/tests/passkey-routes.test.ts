import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getEdgeCache } from "../src/edge-cache.js";
import { D1AdminStore } from "../src/store/d1-admin.js";
import { issueChallenge } from "../src/store/d1-passkeys.js";
import { rpc, uniqueAccountId } from "./helpers.js";
import { newAuthenticator } from "./webauthn-authenticator.js";

const ORIGIN = "https://example.com";
const RP_ID = "example.com";
const db = () => env.CADMUS_ADMIN_DB;

function store(): D1AdminStore {
	return new D1AdminStore({
		db: db(),
		encryptionKey: env.CADMUS_ENCRYPTION_KEY,
		edgeCache: getEdgeCache(env),
	});
}

/** A user whose session was created through a login method of the given provider. */
async function seed(
	provider = "google",
	role: "user" | "account-admin" = "account-admin",
) {
	const s = store();
	const accountId = uniqueAccountId("pkr");
	const userId = `usr_${accountId}`;
	await s.ensureAccountAndUser({ accountId, userId, role });
	const loginMethodId = `lm_${crypto.randomUUID()}`;
	const now = Date.now();
	await db()
		.prepare(
			`INSERT INTO cadmus_login_methods (id, user_id, provider, subject, display, created_at, last_used_at)
       VALUES (?1, ?2, ?3, ?4, 'test', ?5, ?5)`,
		)
		.bind(loginMethodId, userId, provider, `${provider}-${userId}`, now)
		.run();
	const session = await s.createSession({
		userId,
		accountId,
		loginMethodId,
		freshGoogleAt: now,
	});
	return { s, accountId, userId, ...session };
}

const elevatedUntil = async (sessionId: string) =>
	(
		await db()
			.prepare(`SELECT elevated_until AS e FROM cadmus_sessions WHERE id = ?1`)
			.bind(sessionId)
			.first<{ e: number | null }>()
	)?.e ?? null;

type PasskeyBeginResult = {
	challengeId: string;
	options: {
		challenge: string;
		rp: { id: string };
		user: { id: string };
		authenticatorSelection: { userVerification: string };
		allowCredentials?: Array<{ id: string }>;
		excludeCredentials?: Array<{ id: string }>;
	};
};

const beginPasskey = (
	token: string,
	payload: { purpose: "register" | "elevate" | "remove"; methodId?: string },
	accountId?: string,
) => rpc<PasskeyBeginResult>(token, "auth.passkeys.begin", payload, accountId);

async function enroll(u: Awaited<ReturnType<typeof seed>>) {
	const auth = await newAuthenticator(
		crypto.getRandomValues(new Uint8Array(16)),
	);
	const begin = await beginPasskey(u.accessToken, {
		purpose: "register",
	});
	expect(begin.ok).toBe(true);
	if (!begin.result) throw new Error("missing begin result");
	const options = begin.result.options;
	const finish = await rpc(u.accessToken, "auth.passkeys.finish", {
		purpose: "register",
		challengeId: begin.result.challengeId,
		response: await auth.register({
			challenge: options.challenge,
			origin: ORIGIN,
			rpId: RP_ID,
		}),
	});
	return {
		auth,
		begin,
		options,
		finish,
	};
}

describe("passkey admin mode in a selected account (issue #3)", () => {
	async function twoAccounts() {
		const u = await seed();
		const other = uniqueAccountId("pkr2");
		await u.s.ensureAccountAndUser({
			accountId: other,
			userId: u.userId,
			role: "account-admin",
		});
		return { u, other };
	}
	const whoami = async (token: string, account?: string) => {
		const res = await SELF.fetch(`${ORIGIN}/api/auth/whoami`, {
			headers: {
				authorization: `Bearer ${token}`,
				...(account ? { "x-account-id": account } : {}),
			},
		});
		return ((await res.json()) as { principal?: Record<string, unknown> })
			.principal;
	};

	it("the plain toggle works in the session's own account and is refused in another with a passkey-proof message, not a 401", async () => {
		const { u, other } = await twoAccounts();
		const refused = await rpc(u.accessToken, "auth.elevate", {}, other);
		expect(refused.ok).toBe(false);
		expect(refused.error?.code).toBe("forbidden");
		expect(refused.error?.message).toMatch(/passkey proof/);
		expect(await elevatedUntil(u.sessionId)).toBeNull();
		// Positive control: the same session toggles in its own account.
		const own = await rpc(u.accessToken, "auth.elevate", {}, u.accountId);
		expect(own.ok).toBe(true);
		expect((await whoami(u.accessToken, u.accountId))?.elevatedUntil).toBe(
			own.result?.elevatedUntil,
		);
		expect((await whoami(u.accessToken, other))?.elevatedUntil).toBeUndefined();
	});

	it("with a passkey enrolled, the plain toggle is refused in the home account and in another, and an explicit home header audits the home account", async () => {
		const { u, other } = await twoAccounts();
		const own = await rpc(u.accessToken, "auth.elevate", {}, u.accountId);
		expect(own.ok).toBe(true);
		const audit = await db()
			.prepare(
				"SELECT account_id AS a FROM cadmus_audit WHERE action = 'auth.elevate' AND target = ?1 ORDER BY at DESC LIMIT 1",
			)
			.bind(u.sessionId)
			.first<{ a: string }>();
		expect(audit?.a).toBe(u.accountId);
		await rpc(u.accessToken, "auth.elevation.end", {}, u.accountId);
		const e = await enroll(u);
		expect(e.finish.ok).toBe(true);
		for (const account of [u.accountId, other]) {
			const refused = await rpc(u.accessToken, "auth.elevate", {}, account);
			expect(refused.ok).toBe(false);
			expect(refused.error?.code).toBe("forbidden");
			expect(refused.error?.message).toMatch(/passkey proof/);
		}
		expect(await elevatedUntil(u.sessionId)).toBeNull();
	});

	it("enrolls the first passkey while another account is selected, with no admin mode", async () => {
		const { u, other } = await twoAccounts();
		const auth = await newAuthenticator(
			crypto.getRandomValues(new Uint8Array(16)),
		);
		const begin = await beginPasskey(
			u.accessToken,
			{ purpose: "register" },
			other,
		);
		expect(begin.ok).toBe(true);
		const finish = await rpc(
			u.accessToken,
			"auth.passkeys.finish",
			{
				purpose: "register",
				challengeId: begin.result?.challengeId ?? "",
				response: await auth.register({
					challenge: begin.result?.options.challenge ?? "",
					origin: ORIGIN,
					rpId: RP_ID,
				}),
			},
			other,
		);
		expect(finish.ok).toBe(true);
		expect(await elevatedUntil(u.sessionId)).toBeNull();
	});

	it("a passkey assertion with another account selected enables admin mode there only, tagged and audited to that account", async () => {
		const { u, other } = await twoAccounts();
		const e = await enroll(u);
		expect(e.finish.ok).toBe(true);
		const begin = await beginPasskey(
			u.accessToken,
			{ purpose: "elevate" },
			other,
		);
		expect(begin.ok).toBe(true);
		const done = await rpc(
			u.accessToken,
			"auth.passkeys.finish",
			{
				purpose: "elevate",
				challengeId: begin.result?.challengeId ?? "",
				response: await e.auth.assert({
					challenge: begin.result?.options.challenge ?? "",
					origin: ORIGIN,
					rpId: RP_ID,
					counter: 1,
					userHandle: e.options.user.id,
				}),
			},
			other,
		);
		expect(done.ok).toBe(true);
		expect((await whoami(u.accessToken, other))?.elevatedUntil).toBe(
			done.result?.elevatedUntil,
		);
		expect(
			(await whoami(u.accessToken, u.accountId))?.elevatedUntil,
		).toBeUndefined();
		const audit = await db()
			.prepare(
				"SELECT account_id AS a, target_account_id AS t FROM cadmus_audit WHERE action = 'auth.elevate' AND target = ?1 ORDER BY at DESC LIMIT 1",
			)
			.bind(u.sessionId)
			.first<{ a: string; t: string }>();
		expect(audit?.a).toBe(other);
		expect(audit?.t).toBe(other);
	});
});

describe("passkey register and elevate commands", () => {
	it("enrolls the first passkey after a fresh Google sign-in, then elevates with it", async () => {
		const u = await seed();
		const e = await enroll(u);
		expect(e.options.rp.id).toBe(RP_ID);
		expect(e.options.authenticatorSelection.userVerification).toBe("required");
		expect(e.finish.ok).toBe(true);
		expect(e.finish.result?.methodId).toMatch(/^lm_/);

		// With a passkey, the password-free elevation is closed.
		expect((await rpc(u.accessToken, "auth.elevate", {})).ok).toBe(false);

		const begin = await beginPasskey(u.accessToken, {
			purpose: "elevate",
		});
		expect(begin.ok).toBe(true);
		expect(begin.result?.options.allowCredentials?.map((c) => c.id)).toEqual([
			e.auth.id,
		]);
		const done = await rpc(u.accessToken, "auth.passkeys.finish", {
			purpose: "elevate",
			challengeId: begin.result?.challengeId ?? "",
			response: await e.auth.assert({
				challenge: begin.result?.options.challenge ?? "",
				origin: ORIGIN,
				rpId: RP_ID,
				counter: 1,
				userHandle: e.options.user.id,
			}),
		});
		expect(done.ok).toBe(true);
		expect(await elevatedUntil(u.sessionId)).toBe(done.result?.elevatedUntil);
		const audits = await db()
			.prepare(
				`SELECT action, count(*) AS n FROM cadmus_audit WHERE actor_user_id = ?1 AND action IN ('auth.passkey.register','auth.elevate') GROUP BY action ORDER BY action`,
			)
			.bind(u.userId)
			.all<{ action: string; n: number }>();
		expect(audits.results).toEqual([
			{ action: "auth.elevate", n: 1 },
			{ action: "auth.passkey.register", n: 1 },
		]);
	});

	it("refuses first enrollment without a Google sign-in or when it is older than 5 minutes", async () => {
		const pw = await seed("dev-password");
		const begin = await rpc(pw.accessToken, "auth.passkeys.begin", {
			purpose: "register",
		});
		expect(begin).toMatchObject({ ok: false, error: { code: "forbidden" } });

		const stale = await seed();
		await db()
			.prepare(`UPDATE cadmus_sessions SET created_at = ?2 WHERE id = ?1`)
			.bind(stale.sessionId, Date.now() - 6 * 60_000)
			.run();
		expect(
			(
				await rpc(stale.accessToken, "auth.passkeys.begin", {
					purpose: "register",
				})
			).ok,
		).toBe(false);
	});

	it("a new session without a verified fresh Google auth_time cannot enroll (a silent OAuth round trip is not enough)", async () => {
		for (const v of [null, Date.now() - 6 * 60_000]) {
			const u = await seed();
			await db()
				.prepare(
					`UPDATE cadmus_sessions SET fresh_google_at = ?2 WHERE id = ?1`,
				)
				.bind(u.sessionId, v)
				.run();
			expect(
				await rpc(u.accessToken, "auth.passkeys.begin", {
					purpose: "register",
				}),
			).toMatchObject({ ok: false, error: { code: "forbidden" } });
		}
	});

	it("rechecks freshness at finish: a challenge issued while fresh does not finish after the sign-in ages out", async () => {
		const u = await seed();
		const auth = await newAuthenticator(
			crypto.getRandomValues(new Uint8Array(16)),
		);
		const begin = await beginPasskey(u.accessToken, {
			purpose: "register",
		});
		await db()
			.prepare(`UPDATE cadmus_sessions SET created_at = ?2 WHERE id = ?1`)
			.bind(u.sessionId, Date.now() - 6 * 60_000)
			.run();
		const finish = await rpc(u.accessToken, "auth.passkeys.finish", {
			purpose: "register",
			challengeId: begin.result?.challengeId ?? "",
			response: await auth.register({
				challenge: begin.result?.options.challenge ?? "",
				origin: ORIGIN,
				rpId: RP_ID,
			}),
		});
		expect(finish.ok).toBe(false);
		expect(
			(
				await db()
					.prepare(
						`SELECT count(*) AS n FROM cadmus_passkeys WHERE user_id = ?1`,
					)
					.bind(u.userId)
					.first<{ n: number }>()
			)?.n,
		).toBe(0);
	});

	it("refuses elevation to a role without the admin.elevate grant, even with a passkey", async () => {
		const u = await seed("google", "user");
		const e = await enroll(u);
		expect(e.finish.ok).toBe(true);
		const begin = await beginPasskey(u.accessToken, {
			purpose: "elevate",
		});
		expect(begin).toMatchObject({ ok: false, error: { code: "forbidden" } });
		// A real elevate challenge issued straight to storage, as if begin had let it through.
		const issued = await issueChallenge(db(), {
			purpose: "elevate",
			userId: u.userId,
			sessionId: u.sessionId,
			rp: { id: RP_ID, origin: ORIGIN },
		});
		if (!issued) throw new Error("issue refused");
		const forced = await rpc(u.accessToken, "auth.passkeys.finish", {
			purpose: "elevate",
			challengeId: issued.id,
			response: await e.auth.assert({
				challenge: issued.challenge,
				origin: ORIGIN,
				rpId: RP_ID,
				counter: 1,
				userHandle: e.options.user.id,
			}),
		});
		expect(forced.ok).toBe(false);
		expect(await elevatedUntil(u.sessionId)).toBeNull();
	});

	it("requires admin mode to add a second passkey", async () => {
		const u = await seed();
		const e = await enroll(u);
		expect(e.finish.ok).toBe(true);
		const denied = await rpc(u.accessToken, "auth.passkeys.begin", {
			purpose: "register",
		});
		expect(denied).toMatchObject({ ok: false, error: { code: "forbidden" } });
		const begin = await beginPasskey(u.accessToken, {
			purpose: "elevate",
		});
		await rpc(u.accessToken, "auth.passkeys.finish", {
			purpose: "elevate",
			challengeId: begin.result?.challengeId ?? "",
			response: await e.auth.assert({
				challenge: begin.result?.options.challenge ?? "",
				origin: ORIGIN,
				rpId: RP_ID,
				counter: 1,
				userHandle: e.options.user.id,
			}),
		});
		const second = await beginPasskey(u.accessToken, {
			purpose: "register",
		});
		expect(second.ok).toBe(true);
		expect(second.result?.options.excludeCredentials).toHaveLength(1);
	});

	it("a legacy elevation made before the first passkey cannot add a second one", async () => {
		const u = await seed();
		expect(await store().startElevation(u.sessionId)).toBeTypeOf("number");
		const e = await enroll(u);
		expect(e.finish.ok).toBe(true);
		expect(await elevatedUntil(u.sessionId)).toBeNull();
		const begin = await beginPasskey(u.accessToken, {
			purpose: "register",
		});
		expect(begin).toMatchObject({ ok: false, error: { code: "forbidden" } });
	});

	it("accepts a recent Google sign-in even when the login method row is old, and refuses an old session on a new method", async () => {
		const u = await seed();
		await db()
			.prepare(
				`UPDATE cadmus_login_methods SET created_at = ?2 WHERE user_id = ?1`,
			)
			.bind(u.userId, Date.now() - 30 * 86_400_000)
			.run();
		const ok = await rpc(u.accessToken, "auth.passkeys.begin", {
			purpose: "register",
		});
		expect(ok.ok).toBe(true);
		const v = await seed();
		await db()
			.prepare(`UPDATE cadmus_sessions SET created_at = ?2 WHERE id = ?1`)
			.bind(v.sessionId, Date.now() - 6 * 60_000)
			.run();
		expect(
			(await rpc(v.accessToken, "auth.passkeys.begin", { purpose: "register" }))
				.ok,
		).toBe(false);
	});

	it("fails every bad elevation the same way and changes nothing", async () => {
		const u = await seed();
		const e = await enroll(u);
		const begin = async () =>
			beginPasskey(u.accessToken, { purpose: "elevate" });
		const attempt = async (
			mutate: (b: Awaited<ReturnType<typeof begin>>) => {
				challengeId?: string;
				resp: Record<string, unknown>;
			},
			over: Partial<{ userHandle: string; counter: number }> = {},
		) => {
			const b = await begin();
			const good = await e.auth.assert({
				challenge: b.result?.options.challenge ?? "",
				origin: ORIGIN,
				rpId: RP_ID,
				counter: over.counter ?? 1,
				userHandle: over.userHandle ?? e.options.user.id,
			});
			const m = mutate(b);
			return rpc(u.accessToken, "auth.passkeys.finish", {
				purpose: "elevate",
				challengeId: m.challengeId ?? b.result?.challengeId ?? "",
				response: { ...good, ...m.resp },
			});
		};
		const failures = [
			await attempt(() => ({ resp: {} }), { userHandle: "wrong-handle" }),
			await attempt(() => ({ resp: { id: "unknown", rawId: "unknown" } })),
			await attempt(() => ({ resp: {}, challengeId: "pkc_missing" })),
			await attempt(() => ({ resp: { response: { signature: "AAAA" } } })),
		];
		for (const f of failures) {
			expect(f).toMatchObject({ ok: false, error: { code: "forbidden" } });
		}
		expect(new Set(failures.map((f) => f.error?.message)).size).toBe(1);
		expect(await elevatedUntil(u.sessionId)).toBeNull();
		const counter = await db()
			.prepare(`SELECT counter AS c FROM cadmus_passkeys WHERE user_id = ?1`)
			.bind(u.userId)
			.first<{ c: number }>();
		expect(counter?.c).toBe(0);
	});

	it("does not let another user's passkey or a replayed finish elevate", async () => {
		const a = await seed();
		const b = await seed();
		const ea = await enroll(a);
		await enroll(b);
		const begin = await beginPasskey(b.accessToken, {
			purpose: "elevate",
		});
		// A's credential presented on B's session.
		const foreign = await rpc(b.accessToken, "auth.passkeys.finish", {
			purpose: "elevate",
			challengeId: begin.result?.challengeId ?? "",
			response: await ea.auth.assert({
				challenge: begin.result?.options.challenge ?? "",
				origin: ORIGIN,
				rpId: RP_ID,
				counter: 1,
				userHandle: ea.options.user.id,
			}),
		});
		expect(foreign.ok).toBe(false);
		expect(await elevatedUntil(b.sessionId)).toBeNull();

		const begin2 = await beginPasskey(a.accessToken, {
			purpose: "elevate",
		});
		const resp = await ea.auth.assert({
			challenge: begin2.result?.options.challenge ?? "",
			origin: ORIGIN,
			rpId: RP_ID,
			counter: 1,
			userHandle: ea.options.user.id,
		});
		const first = await rpc(a.accessToken, "auth.passkeys.finish", {
			purpose: "elevate",
			challengeId: begin2.result?.challengeId ?? "",
			response: resp,
		});
		expect(first.ok).toBe(true);
		await db()
			.prepare(`UPDATE cadmus_sessions SET elevated_until = NULL WHERE id = ?1`)
			.bind(a.sessionId)
			.run();
		const replay = await rpc(a.accessToken, "auth.passkeys.finish", {
			purpose: "elevate",
			challengeId: begin2.result?.challengeId ?? "",
			response: resp,
		});
		expect(replay.ok).toBe(false);
		expect(await elevatedUntil(a.sessionId)).toBeNull();
	});

	it.each([
		["unset", ""],
		["http on a real host", "http://example.com"],
		["an IP literal", "https://203.0.113.7"],
		["unparseable", "not a url"],
	])(
		"fails closed at the route when the public URL is %s",
		async (_name, value) => {
			const u = await seed();
			const mutable = env as unknown as { CADMUS_PUBLIC_URL?: string };
			const before = mutable.CADMUS_PUBLIC_URL;
			mutable.CADMUS_PUBLIC_URL = value;
			try {
				const begin = await rpc(u.accessToken, "auth.passkeys.begin", {
					purpose: "register",
				});
				expect(begin).toMatchObject({
					ok: false,
					error: { code: "forbidden" },
				});
				const finish = await rpc(u.accessToken, "auth.passkeys.finish", {
					purpose: "register",
					challengeId: "pkc_none",
					response: { id: "x" },
				});
				expect(finish).toMatchObject({
					ok: false,
					error: { code: "forbidden" },
				});
				// A challenge row may not exist: nothing was issued.
				expect(
					(
						await db()
							.prepare(
								`SELECT count(*) AS n FROM cadmus_passkey_challenges WHERE user_id = ?1`,
							)
							.bind(u.userId)
							.first<{ n: number }>()
					)?.n,
				).toBe(0);
			} finally {
				mutable.CADMUS_PUBLIC_URL = before;
			}
		},
	);
});

describe("passkey removal needs passkey proof", () => {
	async function begin(u: { accessToken: string }, methodId: string) {
		return beginPasskey(u.accessToken, {
			purpose: "remove",
			methodId,
		});
	}
	async function finish(
		u: { accessToken: string },
		e: Awaited<ReturnType<typeof enroll>>,
		b: Awaited<ReturnType<typeof begin>>,
		counter = 1,
	) {
		return rpc(u.accessToken, "auth.passkeys.finish", {
			purpose: "remove",
			challengeId: b.result?.challengeId ?? "",
			response: await e.auth.assert({
				challenge: b.result?.options.challenge ?? "",
				origin: ORIGIN,
				rpId: RP_ID,
				counter,
				userHandle: e.options.user.id,
			}),
		});
	}
	const active = async (userId: string) =>
		(
			await db()
				.prepare(
					`SELECT COUNT(*) AS n FROM cadmus_passkeys p JOIN cadmus_login_methods m ON m.id = p.login_method_id
           WHERE p.user_id = ?1 AND m.revoked_at IS NULL`,
				)
				.bind(userId)
				.first<{ n: number }>()
		)?.n;
	const auditN = async (action: string, userId: string) =>
		(
			await db()
				.prepare(
					`SELECT COUNT(*) AS n FROM cadmus_audit WHERE action = ?1 AND actor_user_id = ?2`,
				)
				.bind(action, userId)
				.first<{ n: number }>()
		)?.n;

	it("removes the passkey chosen at begin after a valid assertion, and audits it", async () => {
		const u = await seed();
		const e = await enroll(u);
		const methodId = e.finish.result?.methodId as string;
		const b = await begin(u, methodId);
		expect(b.ok).toBe(true);
		expect(b.result?.options.allowCredentials?.map((c) => c.id)).toEqual([
			e.auth.id,
		]);
		const done = await finish(u, e, b);
		expect(done).toMatchObject({
			ok: true,
			result: { removedMethodId: methodId },
		});
		expect(await active(u.userId)).toBe(0);
		expect(await auditN("auth.passkey.remove", u.userId)).toBe(1);
		// The Google session that did it is untouched.
		expect((await rpc(u.accessToken, "auth.whoami", {})).ok).toBe(true);
	});

	it("the generic method revoke cannot remove a passkey", async () => {
		const u = await seed();
		const e = await enroll(u);
		const r = await rpc(u.accessToken, "auth.methods.revoke", {
			methodId: e.finish.result?.methodId ?? "",
		});
		expect(r).toMatchObject({ ok: false, error: { code: "forbidden" } });
		expect(await active(u.userId)).toBe(1);
	});

	it("refuses begin for a non-passkey method, another user's passkey, no method id, or no passkey", async () => {
		const u = await seed();
		const noPasskey = await begin(u, "lm_missing");
		expect(noPasskey.ok).toBe(false);
		const e = await enroll(u);
		const googleMethod = (
			await db()
				.prepare(
					`SELECT id FROM cadmus_login_methods WHERE user_id = ?1 AND provider = 'google'`,
				)
				.bind(u.userId)
				.first<{ id: string }>()
		)?.id as string;
		expect((await begin(u, googleMethod)).ok).toBe(false);
		const other = await seed();
		expect((await begin(other, e.finish.result?.methodId ?? "")).ok).toBe(
			false,
		);
		expect(
			(await rpc(u.accessToken, "auth.passkeys.begin", { purpose: "remove" }))
				.ok,
		).toBe(false);
		expect(await active(u.userId)).toBe(1);
	});

	it("a bad signature, a replay and a foreign credential remove nothing", async () => {
		const u = await seed();
		const e = await enroll(u);
		const b = await begin(u, e.finish.result?.methodId ?? "");
		const resp = await e.auth.assert({
			challenge: b.result?.options.challenge ?? "",
			origin: ORIGIN,
			rpId: RP_ID,
			counter: 1,
			userHandle: e.options.user.id,
		});
		const bad = {
			...resp,
			response: { ...resp.response, signature: "AAAA" },
		};
		const r1 = await rpc(u.accessToken, "auth.passkeys.finish", {
			purpose: "remove",
			challengeId: b.result?.challengeId ?? "",
			response: bad,
		});
		expect(r1.ok).toBe(false);
		// The burned challenge cannot be used again, even with a good response.
		const r2 = await rpc(u.accessToken, "auth.passkeys.finish", {
			purpose: "remove",
			challengeId: b.result?.challengeId ?? "",
			response: resp,
		});
		expect(r2.ok).toBe(false);
		expect(await active(u.userId)).toBe(1);
		// A remove challenge does not finish as an elevation.
		const b2 = await begin(u, e.finish.result?.methodId ?? "");
		const asElevate = await rpc(u.accessToken, "auth.passkeys.finish", {
			purpose: "elevate",
			challengeId: b2.result?.challengeId ?? "",
			response: await e.auth.assert({
				challenge: b2.result?.options.challenge ?? "",
				origin: ORIGIN,
				rpId: RP_ID,
				counter: 1,
				userHandle: e.options.user.id,
			}),
		});
		expect(asElevate.ok).toBe(false);
		expect(await active(u.userId)).toBe(1);
	});

	it("never removes the last login method", async () => {
		const u = await seed();
		const e = await enroll(u);
		await db()
			.prepare(
				`UPDATE cadmus_login_methods SET revoked_at = ?2 WHERE user_id = ?1 AND provider = 'google'`,
			)
			.bind(u.userId, Date.now())
			.run();
		const b = await begin(u, e.finish.result?.methodId ?? "");
		expect(b.ok).toBe(true);
		expect((await finish(u, e, b)).ok).toBe(false);
		expect(await active(u.userId)).toBe(1);
		expect(await auditN("auth.passkey.remove", u.userId)).toBe(0);
	});

	it("removing the last passkey ends admin mode that the passkey backed, with an audit row", async () => {
		const u = await seed();
		const e = await enroll(u);
		const eb = await beginPasskey(u.accessToken, {
			purpose: "elevate",
		});
		await rpc(u.accessToken, "auth.passkeys.finish", {
			purpose: "elevate",
			challengeId: eb.result?.challengeId ?? "",
			response: await e.auth.assert({
				challenge: eb.result?.options.challenge ?? "",
				origin: ORIGIN,
				rpId: RP_ID,
				counter: 1,
				userHandle: e.options.user.id,
			}),
		});
		expect(await elevatedUntil(u.sessionId)).not.toBeNull();
		const b = await begin(u, e.finish.result?.methodId ?? "");
		expect((await finish(u, e, b, 2)).ok).toBe(true);
		expect(await elevatedUntil(u.sessionId)).toBeNull();
		expect(await auditN("auth.elevation.end", u.userId)).toBe(1);
	});
});
