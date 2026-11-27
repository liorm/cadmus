import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { getEdgeCache } from "../src/edge-cache.js";
import { D1AdminStore } from "../src/store/d1-admin.js";
import { uniqueAccountId } from "./helpers.js";

/**
 * Issue #3 L237, transport side. The registry matrix (unit/authz-registry-
 * matrix.test.ts) covers every command at the authorize() layer. This file
 * drives representative cases through the real entry points /rpc, /api and /ws
 * with a real session, to show each one builds the caller from the session and
 * reaches authorize(): a tenant-data read (allowed for user and account-admin,
 * forbidden for super-admin) and an elevation-grant command (forbidden for a
 * user, elevation_required for an account-admin until admin mode is on).
 * Not an every-command-by-every-transport cross product.
 */
const ORIGIN = "https://example.com";
type Role = "user" | "account-admin" | "super-admin";
type Outcome = "ok" | string;

function store(): D1AdminStore {
	return new D1AdminStore({
		db: env.CADMUS_ADMIN_DB,
		encryptionKey: env.CADMUS_ENCRYPTION_KEY,
		edgeCache: getEdgeCache(env),
	});
}

async function session(role: Role) {
	const s = store();
	const accountId = uniqueAccountId(`atr${role.length}`);
	const userId = `usr_${accountId}`;
	await s.ensureAccountAndUser({ accountId, userId, role });
	return s.createSession({ userId, accountId });
}

type Frame = {
	ok: boolean;
	result?: { ticket?: string };
	error?: { code?: string };
};
const outcome = (f: Frame): Outcome =>
	f.ok ? "ok" : (f.error?.code ?? "error");

async function viaRpc(
	token: string,
	type: string,
	payload: Record<string, unknown> = {},
): Promise<Outcome> {
	const res = await SELF.fetch(`${ORIGIN}/rpc`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({ id: crypto.randomUUID(), type, payload }),
	});
	return outcome((await res.json()) as Frame);
}

async function viaApi(
	token: string,
	path: string,
	method: "GET" | "POST",
	body?: Record<string, unknown>,
): Promise<Outcome> {
	const res = await SELF.fetch(`${ORIGIN}/api/${path}`, {
		method,
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
		},
		body: body ? JSON.stringify(body) : undefined,
	});
	const text = await res.text();
	let frame: Frame | undefined;
	try {
		frame = JSON.parse(text) as Frame;
	} catch {
		/* non-JSON body: reported below through the status */
	}
	if (res.ok && (frame?.ok ?? true)) return "ok";
	return frame?.error?.code ?? `http_${res.status}`;
}

async function viaWs(
	token: string,
	calls: [string, Record<string, unknown>][],
) {
	const t = await SELF.fetch(`${ORIGIN}/rpc`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			id: crypto.randomUUID(),
			type: "auth.ticket",
			payload: { target: "ws" },
		}),
	});
	const ticket = ((await t.json()) as Frame).result?.ticket;
	const res = await SELF.fetch(`${ORIGIN}/ws?ticket=${ticket}`, {
		headers: { upgrade: "websocket" },
	});
	const ws = res.webSocket;
	if (!ws) throw new Error(`expected 101, got ${res.status}`);
	ws.accept();
	const pending = new Map<string, (f: Frame) => void>();
	ws.addEventListener("message", (ev) => {
		const f = JSON.parse(ev.data as string);
		pending.get(f.id)?.(f);
	});
	const out: Outcome[] = [];
	for (const [type, payload] of calls) {
		out.push(
			outcome(
				await new Promise<Frame>((resolve) => {
					const id = crypto.randomUUID();
					pending.set(id, resolve);
					ws.send(JSON.stringify({ id, type, payload }));
				}),
			),
		);
	}
	ws.close();
	return out;
}

const INVITE = (tag: string) => ({ email: `${tag}@example.com` });

describe("authorization at each transport entry point (issue #3 L237)", () => {
	const reads: Record<Role, Outcome> = {
		user: "ok",
		"account-admin": "ok",
		"super-admin": "forbidden",
	};

	for (const role of ["user", "account-admin", "super-admin"] as const) {
		it(`${role}: tenant read over /rpc, /api and /ws`, async () => {
			const { accessToken } = await session(role);
			expect(await viaRpc(accessToken, "bot.list")).toBe(reads[role]);
			expect(await viaApi(accessToken, "bot/list", "GET")).toBe(reads[role]);
			// /ws needs a ticket, and auth.ticket needs chat.use, which the
			// super-admin does not hold: the refusal is the grant contract.
			if (role === "super-admin") {
				expect(await viaRpc(accessToken, "auth.ticket", { target: "ws" })).toBe(
					"forbidden",
				);
				const noTicket = await SELF.fetch(`${ORIGIN}/ws`, {
					headers: { upgrade: "websocket" },
				});
				expect(noTicket.status).toBe(401);
			} else {
				expect(await viaWs(accessToken, [["bot.list", {}]])).toEqual([
					reads[role],
				]);
			}
		});
	}

	it("user: a members.manage command is forbidden on every transport", async () => {
		const { accessToken } = await session("user");
		const p = INVITE("u1");
		expect(await viaRpc(accessToken, "account.members.invite", p)).toBe(
			"forbidden",
		);
		expect(await viaApi(accessToken, "account/members/invite", "POST", p)).toBe(
			"forbidden",
		);
		expect(await viaWs(accessToken, [["account.members.invite", p]])).toEqual([
			"forbidden",
		]);
	});

	it("account-admin: the same command needs admin mode, then runs, on every transport", async () => {
		const { accessToken } = await session("account-admin");
		const p = INVITE("a1");
		expect(await viaRpc(accessToken, "account.members.invite", p)).toBe(
			"elevation_required",
		);
		expect(await viaApi(accessToken, "account/members/invite", "POST", p)).toBe(
			"elevation_required",
		);
		expect(await viaWs(accessToken, [["account.members.invite", p]])).toEqual([
			"elevation_required",
		]);
		expect(await viaRpc(accessToken, "auth.elevate")).toBe("ok");
		expect(
			await viaRpc(accessToken, "account.members.invite", INVITE("a2")),
		).toBe("ok");
		expect(
			await viaApi(accessToken, "account/members/invite", "POST", INVITE("a3")),
		).toBe("ok");
		expect(
			await viaWs(accessToken, [["account.members.invite", INVITE("a4")]]),
		).toEqual(["ok"]);
	});

	async function systemSuperAdmin() {
		const s = store();
		await s.initialize();
		const userId = `usr_${uniqueAccountId("atsa")}`;
		const now = Date.now();
		await env.CADMUS_ADMIN_DB.batch([
			env.CADMUS_ADMIN_DB.prepare(
				`INSERT INTO cadmus_users (id, name, email, created_at) VALUES (?1, 'Root', NULL, ?2)`,
			).bind(userId, now),
			env.CADMUS_ADMIN_DB.prepare(
				`INSERT INTO cadmus_account_members (account_id, user_id, created_at) VALUES ('system', ?1, ?2)`,
			).bind(userId, now),
			env.CADMUS_ADMIN_DB.prepare(
				`INSERT INTO cadmus_member_roles (account_id, user_id, role, created_at) VALUES ('system', ?1, 'super-admin', ?2)`,
			).bind(userId, now),
		]);
		return { s, userId };
	}

	// Issue #3 L88: a super-admin has no account-scope grant anywhere, and gets
	// tenant access only through an ordinary membership.
	it("super-admin: no account-scope command in the system account or a tenant, and the same user succeeds through an ordinary tenant membership", async () => {
		const { s, userId } = await systemSuperAdmin();
		const tenant = uniqueAccountId("atten");
		await s.ensureAccountAndUser({
			accountId: tenant,
			userId: `usr_${tenant}`,
			role: "account-admin",
		});
		const inSystem = await s.createSession({ userId, accountId: "system" });
		const refused = async (token: string) => {
			expect(await viaRpc(token, "bot.list")).toBe("forbidden");
			expect(await viaRpc(token, "account.members.list")).toBe("forbidden");
			expect(await viaApi(token, "bot/list", "GET")).toBe("forbidden");
			expect(await viaApi(token, "account/members/list", "GET")).toBe(
				"forbidden",
			);
		};
		await refused(inSystem.accessToken);

		// Positive control: the same user with an ordinary membership in the
		// tenant succeeds on the command refused above.
		await s.addMember({ accountId: tenant, userId, roles: ["user"] });
		const inTenant = await s.createSession({ userId, accountId: tenant });
		expect(await viaRpc(inTenant.accessToken, "bot.list")).toBe("ok");
		expect(await viaApi(inTenant.accessToken, "bot/list", "GET")).toBe("ok");
		expect(await viaWs(inTenant.accessToken, [["bot.list", {}]])).toEqual([
			"ok",
		]);
		// ...and the system session of that user is still refused.
		await refused(inSystem.accessToken);
	});

	// Issue #3 L88 on a real resource: a bot exists in a tenant. A super-admin
	// session in that account (a membership with the super-admin role) is
	// refused it; the account-admin who owns it and a member with the "user"
	// role are allowed. Over /rpc and /api only.
	it("super-admin: a real tenant bot is refused to the super-admin role and readable to account-admin and user roles", async () => {
		const s = store();
		const tenant = uniqueAccountId("atrb");
		const adminId = `usr_${tenant}`;
		await s.ensureAccountAndUser({
			accountId: tenant,
			userId: adminId,
			role: "account-admin",
		});
		const admin = (
			await s.createSession({ userId: adminId, accountId: tenant })
		).accessToken;
		const slug = `rb-${crypto.randomUUID().slice(0, 8)}`;
		expect(
			await viaRpc(admin, "bot.create", {
				slug,
				name: "real",
				model: "faux/echo",
			}),
		).toBe("ok");
		const sa = `usr_sa_${tenant}`;
		await s.addMember({
			accountId: tenant,
			userId: sa,
			roles: ["super-admin"],
		});
		const saTok = (await s.createSession({ userId: sa, accountId: tenant }))
			.accessToken;
		const plain = `usr_u_${tenant}`;
		await s.addMember({ accountId: tenant, userId: plain, roles: ["user"] });
		const userTok = (
			await s.createSession({ userId: plain, accountId: tenant })
		).accessToken;
		const get = { botId: slug };
		const members = {};
		for (const [token, want] of [
			[admin, "ok"],
			[userTok, "ok"],
			[saTok, "forbidden"],
		] as const) {
			expect(await viaRpc(token, "bot.get", get)).toBe(want);
			expect(await viaApi(token, `bot/get?botId=${slug}`, "GET")).toBe(want);
			expect(await viaRpc(token, "account.members.list", members)).toBe(want);
		}
	});

	// Issue #3 L32: a role per account for the same user.
	it("one user, account-admin in one account and user in another: the same command differs per account on every transport", async () => {
		const s = store();
		const a1 = uniqueAccountId("atm1");
		const a2 = uniqueAccountId("atm2");
		const userId = `usr_${a1}`;
		await s.ensureAccountAndUser({
			accountId: a1,
			userId,
			role: "account-admin",
		});
		await s.ensureAccountAndUser({
			accountId: a2,
			userId: `usr_${a2}`,
			role: "account-admin",
		});
		await s.addMember({ accountId: a2, userId, roles: ["user"] });
		const t1 = (await s.createSession({ userId, accountId: a1 })).accessToken;
		const t2 = (await s.createSession({ userId, accountId: a2 })).accessToken;
		expect(await viaRpc(t1, "auth.elevate")).toBe("ok");
		const p = (n: string) => INVITE(`m${n}`);
		expect(await viaRpc(t1, "account.members.invite", p("r1"))).toBe("ok");
		expect(await viaApi(t1, "account/members/invite", "POST", p("a1"))).toBe(
			"ok",
		);
		expect(await viaWs(t1, [["account.members.invite", p("w1")]])).toEqual([
			"ok",
		]);
		expect(await viaRpc(t2, "account.members.invite", p("r2"))).toBe(
			"forbidden",
		);
		expect(await viaApi(t2, "account/members/invite", "POST", p("a2"))).toBe(
			"forbidden",
		);
		expect(await viaWs(t2, [["account.members.invite", p("w2")]])).toEqual([
			"forbidden",
		]);
		// The session hat does not follow a different stored role. Account 2
		// has only user, so this account-admin session cannot select it.
		const audit = (tok: string, hdr: Record<string, string>) =>
			SELF.fetch(`${ORIGIN}/rpc`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${tok}`,
					"content-type": "application/json",
					...hdr,
				},
				body: JSON.stringify({
					id: "au",
					type: "account.audit.list",
					payload: { limit: 5 },
				}),
			}).then(async (r) => outcome((await r.json()) as Frame));
		expect(await audit(t1, {})).toBe("ok");
		expect(await audit(t1, { "x-account-id": a2 })).not.toBe("ok");
		const invited = async (account: string) =>
			(
				await env.CADMUS_ADMIN_DB.prepare(
					"SELECT COUNT(*) AS n FROM cadmus_audit WHERE account_id = ?1 AND action = 'member.invite'",
				)
					.bind(account)
					.first<{ n: number }>()
			)?.n;
		expect(await invited(a1)).toBe(3);
		expect(await invited(a2)).toBe(0);
	});

	// Issue #3 L239: a write through a session bound to account A never lands
	// in account B.
	it("own-account create and list: bots created through each transport are listed in A and not in B (not a cross-account write)", async () => {
		const a = await session("account-admin");
		const b = await session("account-admin");
		const mk = (slug: string) => ({ slug, name: slug, model: "faux/echo" });
		const tag = crypto.randomUUID().slice(0, 8);
		expect(await viaRpc(a.accessToken, "bot.create", mk(`r-${tag}`))).toBe(
			"ok",
		);
		expect(
			await viaApi(a.accessToken, "bot/create", "POST", mk(`a-${tag}`)),
		).toBe("ok");
		expect(
			await viaWs(a.accessToken, [["bot.create", mk(`w-${tag}`)]]),
		).toEqual(["ok"]);
		const slugs = async (token: string) => {
			const res = await SELF.fetch(`${ORIGIN}/rpc`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ id: "l", type: "bot.list", payload: {} }),
			});
			const f = (await res.json()) as {
				result?: { bots?: { slug?: string; id?: string }[] };
			};
			return (f.result?.bots ?? []).map((x) => x.slug ?? x.id);
		};
		expect((await slugs(a.accessToken)).sort()).toEqual([
			`a-${tag}`,
			`r-${tag}`,
			`w-${tag}`,
		]);
		expect(await slugs(b.accessToken)).toEqual([]);
	});

	// Issue #3 L239 and L32. Account selection for a caller: `x-account-id`
	// selects among the user's own memberships for a user session, and no
	// other selector counts. The case writes through the real entry point and
	// reads the state of A, B and C from each account's own session.
	it("a session bound to account A: only a membership selector can move a write, and never to a non-member account", async () => {
		const s = store();
		const [a, b, c] = ["atxa", "atxb", "atxc"].map((n) => uniqueAccountId(n));
		const userId = `usr_${a}`;
		for (const id of [a, b, c]) {
			await s.ensureAccountAndUser({
				accountId: id,
				userId: `usr_${id}`,
				role: "account-admin",
			});
		}
		await s.addMember({ accountId: b, userId, roles: ["account-admin"] });
		const token = (await s.createSession({ userId, accountId: a })).accessToken;
		const own = async (id: string) =>
			(await s.createSession({ userId: `usr_${id}`, accountId: id }))
				.accessToken;
		const bOwn = (await s.createSession({ userId, accountId: b })).accessToken;
		const cOwn = await own(c);
		const tag = crypto.randomUUID().slice(0, 8);
		const mk = (slug: string) => ({ slug, name: slug, model: "faux/echo" });
		const send = async (
			via: "rpc" | "api",
			slug: string,
			opts: { query?: string; headers?: Record<string, string> },
		) => {
			const url =
				via === "rpc"
					? `${ORIGIN}/rpc${opts.query ?? ""}`
					: `${ORIGIN}/api/bot/create${opts.query ?? ""}`;
			const body =
				via === "rpc"
					? JSON.stringify({ id: "x", type: "bot.create", payload: mk(slug) })
					: JSON.stringify(mk(slug));
			const res = await SELF.fetch(url, {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
					...opts.headers,
				},
				body,
			});
			return res.status;
		};
		const slugs = async (tok: string) => {
			const r = await SELF.fetch(`${ORIGIN}/rpc`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${tok}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ id: "l", type: "bot.list", payload: {} }),
			});
			const f = (await r.json()) as { result?: { bots?: { id?: string }[] } };
			return (f.result?.bots ?? []).map((x) => x.id).sort();
		};
		// Selectors the transports do not read for these credentials: the write lands in A.
		for (const via of ["rpc", "api"] as const) {
			expect(
				await send(via, `q-${via}-${tag}`, { query: `?accountId=${b}` }),
			).toBe(200);
			expect(
				await send(via, `h-${via}-${tag}`, {
					headers: { "x-cadmus-account-id": b },
				}),
			).toBe(200);
		}
		// A non-member account is refused on both transports, with no state anywhere.
		for (const via of ["rpc", "api"] as const) {
			expect(
				await send(via, `n-${via}-${tag}`, {
					headers: { "x-account-id": c },
				}),
			).toBe(401);
		}
		expect(await slugs(cOwn)).toEqual([]);
		// A user session selects among the user's memberships: the write lands in B only.
		for (const via of ["rpc", "api"] as const) {
			expect(
				await send(via, `m-${via}-${tag}`, {
					headers: { "x-account-id": b },
				}),
			).toBe(200);
		}
		expect(await slugs(bOwn)).toEqual([`m-api-${tag}`, `m-rpc-${tag}`]);
		expect(await slugs(token)).toEqual([
			`h-api-${tag}`,
			`h-rpc-${tag}`,
			`q-api-${tag}`,
			`q-rpc-${tag}`,
		]);
	});

	// Issue #3 L239: account B's session names account A's bot in write and read
	// commands. Each is refused or finds nothing, and A's own session reads the
	// bot unchanged afterwards. A's session performs the same write as a
	// positive control.
	it("session B naming account A's bot: update and get never reach it over /rpc, /api and /ws", async () => {
		const a = await session("account-admin");
		const b = await session("account-admin");
		const tag = crypto.randomUUID().slice(0, 8);
		const bot = `x-${tag}`;
		expect(
			await viaRpc(a.accessToken, "bot.create", {
				slug: bot,
				name: "before",
				model: "faux/echo",
			}),
		).toBe("ok");
		const nameOf = async (token: string) => {
			const r = await SELF.fetch(`${ORIGIN}/rpc`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					id: "g",
					type: "bot.get",
					payload: { botId: bot },
				}),
			});
			const f = (await r.json()) as Frame & {
				result?: { bot?: { name?: string } };
			};
			return f.ok
				? (f.result?.bot?.name ?? "no-name")
				: (f.error?.code ?? "error");
		};
		expect(await nameOf(a.accessToken)).toBe("before");
		// Control for the request shapes: A gets the same get over each transport.
		expect(await viaRpc(a.accessToken, "bot.get", { botId: bot })).toBe("ok");
		expect(
			await viaApi(
				a.accessToken,
				`bot/get?${new URLSearchParams({ botId: bot })}`,
				"GET",
			),
		).toBe("ok");
		expect(await viaWs(a.accessToken, [["bot.get", { botId: bot }]])).toEqual([
			"ok",
		]);
		const attempts = [
			["bot.update", { botId: bot, name: "hijack" }],
			["bot.get", { botId: bot }],
		] as const;
		const refusals: Record<string, Outcome[]> = {};
		for (const [type, payload] of attempts) {
			const api =
				type === "bot.update"
					? await viaApi(b.accessToken, "bot/update", "POST", payload)
					: await viaApi(
							b.accessToken,
							`${type.replace(".", "/")}?${new URLSearchParams(payload as Record<string, string>)}`,
							"GET",
						);
			refusals[type] = [
				await viaRpc(b.accessToken, type, payload),
				api,
				...(await viaWs(b.accessToken, [[type, payload]])),
			];
		}
		// Each of /rpc, /api and /ws answers not_found for A's bot.
		expect(refusals).toEqual({
			"bot.update": ["not_found", "not_found", "not_found"],
			"bot.get": ["not_found", "not_found", "not_found"],
		});
		// Control for the setup: B's session updates a bot of its own.
		expect(
			await viaRpc(b.accessToken, "bot.create", {
				slug: bot,
				name: "b-own",
				model: "faux/echo",
			}),
		).toBe("ok");
		expect(
			await viaRpc(b.accessToken, "bot.update", { botId: bot, name: "b-own2" }),
		).toBe("ok");
		expect(await nameOf(b.accessToken)).toBe("b-own2");
		expect(await nameOf(a.accessToken)).toBe("before");
		// Positive control: A's session performs the same update.
		expect(
			await viaRpc(a.accessToken, "bot.update", { botId: bot, name: "after" }),
		).toBe("ok");
		expect(await nameOf(a.accessToken)).toBe("after");
		// A's update did not touch B's bot of the same slug.
		expect(await nameOf(b.accessToken)).toBe("b-own2");
	});

	// Issue #3 L34 and L239 on knowledge: a knowledge document written in
	// account A is found by A, refused to a super-admin role in A, and not
	// reachable from account B, over /rpc, /api and /ws where stated.
	it("knowledge: a real document is found by its account, refused to the super-admin role, and unreachable from another account", async () => {
		const s = store();
		const tenant = uniqueAccountId("atkn");
		const adminId = `usr_${tenant}`;
		await s.ensureAccountAndUser({
			accountId: tenant,
			userId: adminId,
			role: "account-admin",
		});
		const admin = (
			await s.createSession({ userId: adminId, accountId: tenant })
		).accessToken;
		const other = await session("account-admin");
		const bot = `kb-${crypto.randomUUID().slice(0, 8)}`;
		expect(
			await viaRpc(admin, "bot.create", {
				slug: bot,
				name: "kb",
				model: "faux/echo",
			}),
		).toBe("ok");
		const word = `zebra${crypto.randomUUID().slice(0, 6)}`;
		const skillPath = "/.cadmus/skills/bot/doc/SKILL.md";
		const write = {
			botId: bot,
			path: skillPath,
			description: "doc",
			content: `# Doc\n${word}`,
		};
		expect(await viaRpc(admin, "file.write", write)).toBe("ok");
		const frame = async (
			token: string,
			type: string,
			payload: Record<string, unknown>,
		) => {
			const r = await SELF.fetch(`${ORIGIN}/rpc`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({ id: "k", type, payload }),
			});
			return (await r.json()) as Frame & {
				result?: { files?: unknown[]; content?: string };
			};
		};
		const listReq = { botId: bot };
		const found = await frame(admin, "file.list", listReq);
		expect(found.ok).toBe(true);
		expect(found.result?.files?.length).toBeGreaterThanOrEqual(3);
		// The super-admin role in the same account is refused on every knowledge command.
		const sa = `usr_sa_${tenant}`;
		await s.addMember({
			accountId: tenant,
			userId: sa,
			roles: ["super-admin"],
		});
		const saTok = (await s.createSession({ userId: sa, accountId: tenant }))
			.accessToken;
		for (const [type, payload] of [
			["file.list", listReq],
			["file.read", { botId: bot, path: skillPath }],
			["file.write", { ...write, content: "overwrite" }],
		] as const) {
			expect(await viaRpc(saTok, type, payload), type).toBe("forbidden");
		}
		expect(
			await viaApi(saTok, `file/list?${new URLSearchParams(listReq)}`, "GET"),
		).toBe("forbidden");
		expect(await viaWs(admin, [["file.list", listReq]])).toEqual(["ok"]);
		// Another account naming the same bot id reaches nothing.
		const missList = await frame(other.accessToken, "file.list", listReq);
		const missRead = await frame(other.accessToken, "file.read", {
			botId: bot,
			path: skillPath,
		});
		const missWrite = await frame(other.accessToken, "file.write", {
			...write,
			content: "hijack",
		});
		expect([missList.ok, missList.error?.code]).toEqual([false, "not_found"]);
		expect([missRead.ok, missRead.error?.code]).toEqual([false, "not_found"]);
		expect([missWrite.ok, missWrite.error?.code]).toEqual([false, "not_found"]);
		// A's document is unchanged, read through A's own session.
		const back = await frame(admin, "file.read", {
			botId: bot,
			path: skillPath,
		});
		expect(back.result?.content).toContain(word);
		expect(back.result?.content).not.toContain("hijack");
		expect(back.result?.content).not.toContain("overwrite");
	});
});
