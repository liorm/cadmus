import { env, runInDurableObject, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { EdgeCache, getEdgeCache, sha256Hex } from "../src/edge-cache.js";
import { D1AdminStore } from "../src/store/d1-admin.js";
import { actingAdmin, rpc, uniqueAccountId } from "./helpers.js";

// Issue #3 data model L102: a legacy token is a `user` grant-set credential.
// A member-token row never carries more than the user set, whatever the
// member's live role, on /rpc, /ws and /events. A shared secret is not a
// credential. Account-admin checks use a real session.

const ORIGIN = "https://example.com";
const ADMIN_COMMANDS: [string, object][] = [
	["account.members.invite", { email: "x@example.com" }],
	["bot.delete", { botId: "no-such-bot" }],
];

function store(): D1AdminStore {
	return new D1AdminStore({
		db: env.CADMUS_ADMIN_DB,
		encryptionKey: env.CADMUS_ENCRYPTION_KEY,
		edgeCache: getEdgeCache(env),
	});
}

async function seed(role: "user" | "account-admin" = "account-admin") {
	const s = store();
	const accountId = uniqueAccountId("clamp");
	const userId = `usr_${accountId}`;
	const raw = `legacy-clamp-${accountId}`;
	await s.ensureAccountAndUser({ accountId, userId, role });
	await s.addMember({ accountId, userId, roles: [role], rawToken: raw });
	return { s, accountId, userId, raw };
}

async function openWs(token: string) {
	const t = await rpc(token, "auth.ticket", { target: "ws" });
	const res = await SELF.fetch(`${ORIGIN}/ws?ticket=${t.result?.ticket}`, {
		headers: { upgrade: "websocket" },
	});
	const ws = res.webSocket;
	if (!ws) throw new Error(`expected 101, got ${res.status}`);
	ws.accept();
	const seen = {
		frames: [] as { ok?: boolean; error?: { code?: string } }[],
		closeCode: undefined as number | undefined,
	};
	ws.addEventListener("message", (e) => {
		seen.frames.push(JSON.parse(e.data as string));
	});
	ws.addEventListener("close", (e) => {
		seen.closeCode = e.code;
	});
	const ask = async (type: string, payload: object = {}) => {
		seen.frames.length = 0;
		ws.send(JSON.stringify({ id: crypto.randomUUID(), type, payload }));
		for (
			let i = 0;
			i < 150 && seen.frames.length === 0 && seen.closeCode === undefined;
			i++
		) {
			await new Promise((r) => setTimeout(r, 20));
		}
		return seen.frames[0];
	};
	const waitClosed = async () => {
		for (let i = 0; i < 150 && seen.closeCode === undefined; i++) {
			await new Promise((r) => setTimeout(r, 20));
		}
	};
	return { seen, ask, waitClosed };
}

const sweep = (accountId: string) =>
	runInDurableObject(
		env.CADMUS_BOT_FAMILY.get(
			env.CADMUS_BOT_FAMILY.idFromName(`cadmus:${accountId}:default`),
		),
		async (instance) => {
			await (
				instance as unknown as {
					sweepAuthority: (force: boolean) => Promise<unknown>;
				}
			).sweepAuthority(true);
		},
	);

describe("legacy member tokens are clamped to the user grant set (issue #3 L102, L186)", () => {
	it("an account-admin member's legacy token is forbidden on admin grants over /rpc, on a warm cache too, while chat.use works with the same token", async () => {
		const { raw, accountId, userId } = await seed();
		const admin = await actingAdmin({ accountId, userId, elevated: true });
		const ok = await rpc(admin, "account.members.invite", {
			email: "control@example.com",
		});
		expect(ok.ok).toBe(true);
		for (let round = 0; round < 2; round++) {
			// round 1 is served from the warm edge cache
			expect((await rpc(raw, "auth.ticket", { target: "ws" })).ok).toBe(true);
			for (const [type, payload] of ADMIN_COMMANDS) {
				const r = await rpc(raw, type, payload);
				expect(r.ok, `${type} round ${round}`).toBe(false);
			}
		}
		// State unchanged on denial: still exactly the one control invite.
		const row = await env.CADMUS_ADMIN_DB.prepare(
			"SELECT COUNT(*) AS n FROM cadmus_invites WHERE account_id = ?1",
		)
			.bind(accountId)
			.first<{ n: number }>();
		expect(row?.n).toBe(1);
	});

	it("the ticket path carries the clamp: over /ws the same token is forbidden on admin grants and allowed on chat.use", async () => {
		const { raw } = await seed();
		const sock = await openWs(raw);
		expect((await sock.ask("auth.whoami"))?.ok).toBe(true);
		expect((await sock.ask("auth.ticket", { target: "ws" }))?.ok).toBe(true);
		for (const [type, payload] of ADMIN_COMMANDS) {
			expect((await sock.ask(type, payload))?.ok, type).toBe(false);
		}
	});

	it("a demoted user's token is no wider", async () => {
		const { raw, s, accountId, userId } = await seed();
		await env.CADMUS_ADMIN_DB.batch([
			env.CADMUS_ADMIN_DB.prepare(
				`INSERT OR IGNORE INTO cadmus_member_roles (account_id, user_id, role, created_at)
         SELECT account_id, user_id, 'user', created_at FROM cadmus_account_members
          WHERE account_id = ?1 AND user_id = ?2`,
			).bind(accountId, userId),
			env.CADMUS_ADMIN_DB.prepare(
				`DELETE FROM cadmus_member_roles WHERE account_id = ?1 AND user_id = ?2 AND role = 'account-admin'`,
			).bind(accountId, userId),
		]);
		void s;
		expect((await rpc(raw, "auth.ticket", { target: "ws" })).ok).toBe(true);
		for (const [type, payload] of ADMIN_COMMANDS) {
			expect((await rpc(raw, type, payload)).ok, type).toBe(false);
		}
	});

	it("revoking the token (revoked_at set, or row deleted) closes its socket on the next message and, idle, on the sweep", async () => {
		for (const mode of ["message", "sweep", "deleted", "expired"] as const) {
			const { raw, s, accountId } = await seed();
			const sock = await openWs(raw);
			expect((await sock.ask("bot.list"))?.ok).toBe(true);
			// Positive control: a sweep with the row live leaves it open.
			await sweep(accountId);
			await new Promise((r) => setTimeout(r, 100));
			expect(sock.seen.closeCode).toBeUndefined();
			if (mode === "deleted") {
				expect(await s.revokeToken(raw)).toBe(true);
			} else if (mode === "expired") {
				await env.CADMUS_ADMIN_DB.prepare(
					"UPDATE cadmus_auth_tokens SET expires_at = ?2 WHERE account_id = ?1",
				)
					.bind(accountId, Date.now() - 1000)
					.run();
			} else {
				// revoked_at set, row kept (what revokeTokenById does)
				await env.CADMUS_ADMIN_DB.prepare(
					"UPDATE cadmus_auth_tokens SET revoked_at = ?2 WHERE account_id = ?1",
				)
					.bind(accountId, Date.now())
					.run();
			}
			if (mode === "message") {
				// The command itself is refused, not merely followed by a close.
				expect((await sock.ask("bot.list"))?.ok).not.toBe(true);
			} else await sweep(accountId);
			await sock.waitClosed();
			expect(sock.seen.closeCode, mode).toBe(4401);
		}
	});

	it("a disabled user or suspended account closes both a legacy and a master socket on the sweep (4403, as for sessions)", async () => {
		for (const [what, sql, code] of [
			[
				"disabled user",
				"UPDATE cadmus_users SET disabled_at = 1 WHERE id = ?1",
				4403,
			],
			[
				"suspended account",
				"UPDATE cadmus_accounts SET status = 'suspended', suspended_at = 1 WHERE id = ?2",
				4403,
			],
		] as const) {
			const { raw, accountId, userId } = await seed();
			const legacy = await openWs(raw);
			const mst = await openWs(
				await actingAdmin({ accountId, userId: `${userId}-admin` }),
			);
			expect((await legacy.ask("auth.whoami"))?.ok).toBe(true);
			expect((await mst.ask("auth.whoami"))?.ok).toBe(true);
			await sweep(accountId);
			await new Promise((r) => setTimeout(r, 100));
			expect(legacy.seen.closeCode).toBeUndefined();
			expect(mst.seen.closeCode).toBeUndefined();
			const q = env.CADMUS_ADMIN_DB.prepare(sql);
			await (sql.includes("?2")
				? q.bind(userId, accountId)
				: q.bind(userId)
			).run();
			await sweep(accountId);
			await legacy.waitClosed();
			await mst.waitClosed();
			expect(legacy.seen.closeCode, `legacy ${what}`).toBe(code);
			expect(mst.seen.closeCode, `master ${what}`).toBe(code);
		}
	});

	it("an idle legacy /events stream ends on the sweep once its token row is revoked", async () => {
		const { raw, s, accountId } = await seed();
		const t = await rpc(raw, "auth.ticket", { target: "events" });
		const res = await SELF.fetch(`${ORIGIN}/events?ticket=${t.result?.ticket}`);
		expect(res.status).toBe(200);
		const reader = (res.body as ReadableStream<Uint8Array>).getReader();
		let done = false;
		void (async () => {
			try {
				for (;;) if ((await reader.read()).done) break;
			} catch {
				// closed with an error
			}
			done = true;
		})();
		await sweep(accountId);
		await new Promise((r) => setTimeout(r, 150));
		expect(done).toBe(false);
		expect(await s.revokeToken(raw)).toBe(true);
		await sweep(accountId);
		for (let i = 0; i < 100 && !done; i++) {
			await new Promise((r) => setTimeout(r, 20));
		}
		expect(done).toBe(true);
	});

	it("revoking by id drops this isolate's cache entry at once", async () => {
		const { raw, s, accountId, userId } = await seed();
		expect((await rpc(raw, "auth.ticket", { target: "ws" })).ok).toBe(true); // warms the cache
		const hash = await sha256Hex(raw);
		await env.CADMUS_ADMIN_DB.prepare(
			"UPDATE cadmus_auth_tokens SET id = 'tok_clamp' WHERE token_hash = ?1",
		)
			.bind(hash)
			.run();
		expect(
			await s.revokeTokenById({
				accountId,
				userId,
				tokenId: "tok_clamp",
				all: true,
			}),
		).toBe(true);
		const res = await SELF.fetch(`${ORIGIN}/rpc`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${raw}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				id: "x",
				type: "auth.ticket",
				payload: { target: "ws" },
			}),
		});
		expect(res.status).toBe(401);
	});
});

describe("token cache bound (issue #3 R20: at most the 60 s L2 TTL from the write)", () => {
	it("an L2 hit gives L1 only the rest of the entry's life, not a fresh 60 s", async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(1_000_000);
			const kv = new Map<string, { v: string; exp: number }>();
			const fakeKv = {
				get: async (k: string) => {
					const e = kv.get(k);
					return e && e.exp > Date.now() ? JSON.parse(e.v) : null;
				},
				put: async (k: string, v: string, o: { expirationTtl: number }) => {
					kv.set(k, { v, exp: Date.now() + o.expirationTtl * 1000 });
				},
				delete: async (k: string) => {
					kv.delete(k);
				},
			};
			const cache = new EdgeCache({
				CADMUS_CACHE_KV: fakeKv,
			} as unknown as ConstructorParameters<typeof EdgeCache>[0]);
			const scope = {
				userId: "u",
				accountId: "a",
				role: "user" as const,
			};
			await cache.setToken("h1", scope);
			cache.clearMemory(); // another isolate: no L1 copy
			vi.setSystemTime(1_000_000 + 45_000);
			expect(await cache.getToken("h1")).toMatchObject(scope); // L2 hit
			vi.setSystemTime(1_000_000 + 61_000);
			// Past 60 s from the write: gone from L1 and L2.
			expect(await cache.getToken("h1")).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("shared-secret bearer is not an admin credential", () => {
	it("an account:user:secret bearer cannot open a socket; the legacy token for the same member is not account-admin", async () => {
		const { raw, accountId, userId } = await seed("user");
		const shaped = `${accountId}:${userId}:not-a-credential`;
		const denied = await SELF.fetch(`${ORIGIN}/rpc`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${shaped}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({ id: "no", type: "auth.whoami", payload: {} }),
		});
		expect(denied.status).toBe(401);
		const l = await openWs(raw);
		const [type, payload] = ADMIN_COMMANDS[1] as [string, object];
		const asLegacy = await l.ask(type, payload);
		expect(asLegacy?.ok).toBe(false);
		expect(asLegacy?.error?.code).toBe("forbidden");
	});
});

describe("credentialless sessionless callers fail closed", () => {
	it("a sessionless attachment with no credential is ended on the next message and by the sweep", async () => {
		const { accountId, userId } = await seed();
		const stub = env.CADMUS_BOT_FAMILY.get(
			env.CADMUS_BOT_FAMILY.idFromName(`cadmus:${accountId}:default`),
		);
		const live = await runInDurableObject(stub, async (instance) => {
			const i = instance as unknown as {
				liveCaller: (m: object) => Promise<unknown>;
			};
			return {
				none: await i.liveCaller({
					userId,
					accountId,
					role: "account-admin",
				}),
				master: await i.liveCaller({
					userId,
					accountId,
					role: "account-admin",
					credential: "master",
				}),
			};
		});
		expect(live.none).toBeUndefined();
		expect(live.master).toMatchObject({ credential: "master" });
	});
});

describe("authority changes drop the cached legacy token scope in this isolate (issue #3 R20)", () => {
	it("member removal, role change, user disable and account suspension each drop the cache entry at once", async () => {
		const cache = getEdgeCache(env);
		for (const op of ["remove", "role", "disable", "suspend"] as const) {
			const { raw, s, accountId, userId } = await seed("user");
			const hash = await sha256Hex(raw);
			expect((await rpc(raw, "auth.ticket", { target: "ws" })).ok).toBe(true);
			expect(await cache.getToken(hash), `${op}: warm`).toBeDefined();
			if (op === "remove") {
				await s.removeMember({ accountId, userId, actor: userId });
			} else if (op === "role") {
				await s.updateMemberRole({
					accountId,
					userId,
					op: "grant",
					role: "account-admin",
					actor: userId,
				});
			} else if (op === "disable") {
				await s.setUserDisabled({ userId, disabled: true, actor: "sa" });
			} else {
				await s.setSystemAccountStatus({
					accountId,
					status: "suspended",
					actor: "sa",
				});
			}
			expect(await cache.getToken(hash), `${op}: dropped`).toBeUndefined();
		}
	});

	it("the KV read trusts an entry only for the L2 TTL from its own write time, whatever KV still holds", async () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(2_000_000);
			const kv = new Map<string, string>();
			// A KV whose expiry and delete have not propagated: it never forgets.
			const fakeKv = {
				get: async (k: string) =>
					kv.has(k) ? JSON.parse(kv.get(k) ?? "") : null,
				put: async (k: string, v: string) => {
					kv.set(k, v);
				},
				delete: async () => {},
			};
			const cache = new EdgeCache({
				CADMUS_CACHE_KV: fakeKv,
			} as unknown as ConstructorParameters<typeof EdgeCache>[0]);
			const scope = { userId: "u", accountId: "a", role: "account-admin" };
			await cache.setToken("fresh", scope as never);
			cache.clearMemory();
			expect(await cache.getToken("fresh")).toMatchObject(scope);
			cache.clearMemory();
			vi.setSystemTime(2_000_000 + 60_000);
			expect(await cache.getToken("fresh")).toBeUndefined();
			// An entry written before the write time existed is a miss.
			const key = [...kv.keys()][0] as string;
			kv.set(key.replace("fresh", "old"), JSON.stringify(scope));
			const oldKey = key.replace("fresh", "old");
			expect(kv.has(oldKey)).toBe(true);
			expect(await cache.getToken("old")).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("resolver and sweep edge cases", () => {
	it("an unknown or missing credential never resolves", async () => {
		const { s, accountId, userId } = await seed("user");
		expect(
			await s.resolveLegacyCredential("master", userId, accountId),
		).toBeUndefined();
		expect(
			await s.resolveLegacyCredential("bogus", userId, accountId),
		).toBeUndefined();
		expect(
			await s.resolveLegacyCredential(undefined, userId, accountId),
		).toBeUndefined();
	});

	it("removing the membership row ends legacy and master sockets and stops resolution", async () => {
		const { raw, s, accountId, userId } = await seed("user");
		const legacy = await openWs(raw);
		const mst = await openWs(await actingAdmin({ accountId, userId }));
		expect((await legacy.ask("bot.list"))?.ok).toBe(true);
		expect((await mst.ask("bot.list"))?.ok).toBe(true);
		await env.CADMUS_ADMIN_DB.prepare(
			"DELETE FROM cadmus_account_members WHERE account_id = ?1 AND user_id = ?2",
		)
			.bind(accountId, userId)
			.run();
		expect(
			await s.resolveLegacyCredential("master", userId, accountId),
		).toBeUndefined();
		await sweep(accountId);
		await legacy.waitClosed();
		await mst.waitClosed();
		expect(legacy.seen.closeCode).toBe(4401);
		expect(mst.seen.closeCode).toBe(4401);
	});

	it("the sweep ends a sessionless socket whose attachment names no credential", async () => {
		const { raw, accountId, userId } = await seed();
		const sock = await openWs(raw);
		expect((await sock.ask("bot.list"))?.ok).toBe(true);
		await sweep(accountId);
		await new Promise((r) => setTimeout(r, 100));
		expect(sock.seen.closeCode).toBeUndefined(); // control: credentialed, live
		await runInDurableObject(
			env.CADMUS_BOT_FAMILY.get(
				env.CADMUS_BOT_FAMILY.idFromName(`cadmus:${accountId}:default`),
			),
			async (_i, state) => {
				for (const ws of state.getWebSockets()) {
					ws.serializeAttachment({ userId, accountId, role: "account-admin" });
				}
			},
		);
		await sweep(accountId);
		await sock.waitClosed();
		expect(sock.seen.closeCode).toBe(4401);
	});
});

describe("authority change invalidates every token of the member, not a capped subset", () => {
	it("520 cached tokens of one member are all dropped on removal", async () => {
		const cache = getEdgeCache(env);
		const { s, accountId, userId } = await seed("user");
		const hashes = Array.from(
			{ length: 520 },
			(_, i) => `bulk-${accountId}-${i}`,
		);
		for (let i = 0; i < hashes.length; i += 50) {
			await env.CADMUS_ADMIN_DB.batch(
				hashes
					.slice(i, i + 50)
					.map((h) =>
						env.CADMUS_ADMIN_DB.prepare(
							"INSERT INTO cadmus_auth_tokens (token_hash, user_id, account_id, label, created_at) VALUES (?1, ?2, ?3, 'member-token', ?4)",
						).bind(h, userId, accountId, Date.now()),
					),
			);
		}
		const scope = { userId, accountId, role: "user" as const };
		for (const h of hashes) await cache.setToken(h, scope as never);
		await s.removeMember({ accountId, userId, actor: userId });
		let left = 0;
		for (const h of hashes) if (await cache.getToken(h)) left++;
		expect(left).toBe(0);
	});
});

describe("raw-token revoke drops this isolate's cache entry at once", () => {
	it("a warm legacy token is refused on the very next /rpc after revokeToken", async () => {
		const { raw, s } = await seed();
		expect((await rpc(raw, "auth.ticket", { target: "ws" })).ok).toBe(true);
		expect(
			await getEdgeCache(env).getToken(await sha256Hex(raw)),
		).toBeDefined();
		expect(await s.revokeToken(raw)).toBe(true);
		const res = await SELF.fetch(`${ORIGIN}/rpc`, {
			method: "POST",
			headers: {
				authorization: `Bearer ${raw}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				id: "r",
				type: "auth.ticket",
				payload: { target: "ws" },
			}),
		});
		expect(res.status).toBe(401);
	});
});

describe("cache invalidation failure after a committed authority change", () => {
	it("the authority write still succeeds when invalidation throws", async () => {
		const cache = getEdgeCache(env);
		const { accountId, userId, raw } = await seed("user");
		const hash = await sha256Hex(raw);
		expect((await rpc(raw, "auth.ticket", { target: "ws" })).ok).toBe(true);
		expect(await cache.getToken(hash)).toBeDefined();
		const spy = vi
			.spyOn(cache, "invalidateToken")
			.mockRejectedValue(new Error("invalidate boom"));
		try {
			const s = store();
			await expect(
				s.removeMember({ accountId, userId, actor: userId }),
			).resolves.not.toThrow();
			expect(spy).toHaveBeenCalled();
		} finally {
			spy.mockRestore();
		}
		expect(await cache.getToken(hash)).toBeUndefined();
		expect((await rpc(raw, "auth.ticket", { target: "ws" })).ok).not.toBe(true);
	});
});

describe("local token floor", () => {
	it("refuses a KV entry written in the same millisecond and skips an older in-flight write", async () => {
		const cache = getEdgeCache(env);
		const { raw } = await seed("user");
		const hash = await sha256Hex(raw);
		const scope = { userId: "u", accountId: "a", role: "user" as const };
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			await cache.setToken(hash, scope as never);
			const gen = cache.tokenGeneration;
			cache.floorTokens();
			expect(await cache.getToken(hash)).toBeUndefined();
			await cache.setToken(hash, scope as never, undefined, gen);
			expect(await cache.getToken(hash)).toBeUndefined();
			vi.setSystemTime(Date.now() + 5);
			await cache.setToken(
				hash,
				scope as never,
				undefined,
				cache.tokenGeneration,
			);
			expect(await cache.getToken(hash)).toBeDefined();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("resolve in flight across an authority change", () => {
	it("a resolve that began before removeMember is not cached and the next /rpc is refused", async () => {
		const cache = getEdgeCache(env);
		const { s, accountId, userId, raw } = await seed("user");
		const hash = await sha256Hex(raw);
		await cache.getToken(hash); // no entry yet
		const gen = cache.tokenGeneration; // resolve starts here
		const stale = { userId, accountId, role: "user" as const };
		await s.removeMember({ accountId, userId, actor: userId }); // commits + invalidates
		await cache.setToken(hash, stale as never, undefined, gen); // resolve finishes late
		expect(await cache.getToken(hash)).toBeUndefined();
		expect((await rpc(raw, "auth.ticket", { target: "ws" })).ok).not.toBe(true);
	});

	it("a resolve that began before a narrowing role change is not cached", async () => {
		const cache = getEdgeCache(env);
		const { s, accountId, userId, raw } = await seed("account-admin");
		const hash = await sha256Hex(raw);
		const gen = cache.tokenGeneration; // resolve starts, sees account-admin
		const stale = { userId, accountId, role: "account-admin" as const };
		await s.updateMemberRole({
			accountId,
			userId,
			op: "grant",
			role: "user",
			actor: userId,
		});
		await cache.setToken(hash, stale as never, undefined, gen); // finishes late
		expect(await cache.getToken(hash)).toBeUndefined();
	});
});
