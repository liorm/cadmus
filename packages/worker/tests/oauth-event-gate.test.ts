import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getEdgeCache } from "../src/edge-cache.js";
import { D1AdminStore } from "../src/store/d1-admin.js";
import {
	addLegacyMember,
	connectTestWs,
	rpc,
	sendRpc,
	TEST_TOKEN,
	uniqueAccountId,
} from "./helpers.js";

/**
 * Issue #3 L77/L148: provider OAuth is credentials.manage. The progress event of
 * a provider login carries the device user code and verification URL, so only
 * connections that hold credentials.manage receive it (WebSocket and SSE), and
 * account.oauth.status needs the same grant.
 */
const ORIGIN = "https://example.com";
type Frame = {
	ok?: boolean;
	type?: string;
	result?: Record<string, unknown>;
	error?: { code?: string };
	payload?: Record<string, unknown>;
};

function store(): D1AdminStore {
	return new D1AdminStore({
		db: env.CADMUS_ADMIN_DB,
		encryptionKey: env.CADMUS_ENCRYPTION_KEY,
		edgeCache: getEdgeCache(env),
	});
}

describe("account.oauth.event delivery is limited to credentials.manage", () => {
	const originalFetch = globalThis.fetch;
	beforeEach(() => {
		globalThis.fetch = async (input, init) => {
			const url =
				typeof input === "string"
					? input
					: input instanceof URL
						? input.toString()
						: input.url;
			if (url.includes("auth.x.ai/oauth2/device/code")) {
				return new Response(
					JSON.stringify({
						device_code: "dc-mock",
						user_code: "GATE-4242",
						verification_uri: "https://auth.x.ai/activate",
						expires_in: 600,
						interval: 5,
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (url.includes("auth.x.ai/oauth2/token")) {
				return new Response(
					JSON.stringify({ error: "authorization_pending" }),
					{
						status: 400,
						headers: { "Content-Type": "application/json" },
					},
				);
			}
			return originalFetch(input, init);
		};
	});
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("an admin socket and stream get the event; a user socket and stream do not", async () => {
		const s = store();
		const tag = uniqueAccountId("oevt");
		const accountId = `${tag}_acct`;
		const adminId = `usr_a_${tag}`;
		const userId = `usr_u_${tag}`;
		await s.ensureAccountAndUser({
			accountId,
			userId: adminId,
			role: "account-admin",
		});
		await s.ensureAccountAndUser({ accountId, userId, role: "user" });
		const admin = await s.createSession({ userId: adminId, accountId });
		const user = await s.createSession({ userId, accountId });

		const openWs = async (token: string) => {
			const t = await rpc(token, "auth.ticket", { target: "ws" });
			const res = await SELF.fetch(`${ORIGIN}/ws?ticket=${t.result?.ticket}`, {
				headers: { upgrade: "websocket" },
			});
			const ws = res.webSocket;
			if (!ws) throw new Error(`expected 101, got ${res.status}`);
			ws.accept();
			const seen: Frame[] = [];
			ws.addEventListener("message", (ev) => {
				seen.push(JSON.parse(ev.data as string) as Frame);
			});
			return { ws, seen };
		};
		const openSse = async (token: string) => {
			const t = await rpc(token, "auth.ticket", { target: "events" });
			const res = await SELF.fetch(
				`${ORIGIN}/events?ticket=${t.result?.ticket}`,
			);
			expect(res.status).toBe(200);
			const reader = res.body?.getReader();
			if (!reader) throw new Error("no sse body");
			const chunks: string[] = [];
			void (async () => {
				const dec = new TextDecoder();
				for (;;) {
					const { done, value } = await reader
						.read()
						.catch(() => ({ done: true, value: undefined }));
					if (done) return;
					chunks.push(dec.decode(value));
				}
			})();
			return { reader, chunks };
		};

		const adminWs = await openWs(admin.accessToken);
		const userWs = await openWs(user.accessToken);
		const adminSse = await openSse(admin.accessToken);
		const userSse = await openSse(user.accessToken);

		expect((await rpc(admin.accessToken, "auth.elevate")).ok).toBe(true);
		const started = await rpc(admin.accessToken, "account.oauth.start", {
			providerId: "xai",
			redirectUri: "http://localhost/cb",
		});
		expect(started.ok).toBe(true);
		const flowId = (started.result as { flow: { flowId: string } }).flow.flowId;

		const isEvent = (f: Frame) => f.type === "account.oauth.event";
		const deadline = Date.now() + 3000;
		while (
			Date.now() < deadline &&
			!(
				adminWs.seen.some(isEvent) &&
				adminSse.chunks.join("").includes("account.oauth.event")
			)
		) {
			await new Promise((r) => setTimeout(r, 50));
		}
		// Give a wrongly delivered event to the user connections time to arrive.
		await new Promise((r) => setTimeout(r, 300));

		const got = adminWs.seen.find(isEvent);
		expect(got?.payload?.userCode).toBe("GATE-4242");
		expect(adminSse.chunks.join("")).toContain("GATE-4242");
		expect(userWs.seen.filter(isEvent)).toEqual([]);
		expect(userSse.chunks.join("")).not.toContain("account.oauth.event");
		expect(userSse.chunks.join("")).not.toContain("GATE-4242");

		// The status read needs the same grant: the user is refused, the admin is not.
		expect(
			(await rpc(user.accessToken, "account.oauth.status", { flowId })).error
				?.code,
		).toBe("forbidden");
		expect(
			(await rpc(admin.accessToken, "account.oauth.status", { flowId })).ok,
		).toBe(true);

		await rpc(admin.accessToken, "account.oauth.cancel", { flowId });
		adminWs.ws.close();
		userWs.ws.close();
		await adminSse.reader.cancel().catch(() => undefined);
		await userSse.reader.cancel().catch(() => undefined);
	});

	it("sessionless connections: only the master secret receives it; legacy member tokens (user or admin role, clamped to non-elevated grants) and a scoped token do not", async () => {
		const s = store();
		const tag = uniqueAccountId("oevl");
		const accountId = `${tag}_acct`;
		const ownerId = `usr_o_${tag}`;
		await s.ensureAccountAndUser({
			accountId,
			userId: ownerId,
			role: "account-admin",
		});
		const legacyUser = `cad_legacy_user_${tag}`;
		const legacyAdmin = `cad_legacy_admin_${tag}`;
		await addLegacyMember({
			accountId,
			userId: `usr_lu_${tag}`,
			role: "user",
			token: legacyUser,
		});
		await addLegacyMember({
			accountId,
			userId: `usr_la_${tag}`,
			role: "account-admin",
			token: legacyAdmin,
		});

		// A token session clamped to chat.use only (created by an elevated admin).
		const owner = await s.createSession({ userId: ownerId, accountId });
		expect((await rpc(owner.accessToken, "auth.elevate")).ok).toBe(true);
		const made = await rpc(owner.accessToken, "auth.tokens.create", {
			kind: "service",
			label: "chat only",
			grants: ["chat.use"],
			ttlDays: 1,
		});
		expect(made.ok).toBe(true);
		const login = await SELF.fetch(`${ORIGIN}/auth/token-login`, {
			method: "POST",
			headers: { authorization: `Bearer ${made.result?.token}` },
		});
		expect(login.status).toBe(200);
		const tokenAccess = ((await login.json()) as { accessToken: string })
			.accessToken;

		const master = await connectTestWs({ token: TEST_TOKEN, accountId });
		const admin = await connectTestWs({ token: legacyAdmin, accountId });
		const user = await connectTestWs({ token: legacyUser, accountId });
		const sseOf = async (token: string) => {
			const t = await sendRpc<{ ticket: string }>(
				"auth.ticket",
				{ target: "events" },
				{ token, accountId },
			);
			const res = await SELF.fetch(
				`${ORIGIN}/events?ticket=${t.frame.result?.ticket}`,
			);
			expect(res.status).toBe(200);
			const reader = res.body?.getReader();
			if (!reader) throw new Error("no sse body");
			const chunks: string[] = [];
			void (async () => {
				const dec = new TextDecoder();
				for (;;) {
					const r = await reader
						.read()
						.catch(() => ({ done: true, value: undefined }));
					if (r.done) return;
					chunks.push(dec.decode(r.value));
				}
			})();
			return { reader, chunks };
		};
		const masterSse = await sseOf(TEST_TOKEN);
		const userSse = await sseOf(legacyUser);
		const adminTokenSse = await sseOf(legacyAdmin);
		const tokenWs = await (async () => {
			const t = await rpc(tokenAccess, "auth.ticket", { target: "ws" });
			const res = await SELF.fetch(`${ORIGIN}/ws?ticket=${t.result?.ticket}`, {
				headers: { upgrade: "websocket" },
			});
			const ws = res.webSocket;
			if (!ws) throw new Error(`expected 101, got ${res.status}`);
			ws.accept();
			const seen: Frame[] = [];
			ws.addEventListener("message", (ev) => {
				seen.push(JSON.parse(ev.data as string) as Frame);
			});
			return { ws, seen };
		})();

		const started = await sendRpc<{ flow: { flowId: string } }>(
			"account.oauth.start",
			{ providerId: "xai", redirectUri: "http://localhost/cb" },
			{ token: TEST_TOKEN, accountId },
		);
		expect(started.frame.ok).toBe(true);
		const has = (events: { type?: string }[]) =>
			events.some((e) => e.type === "account.oauth.event");
		const deadline = Date.now() + 3000;
		while (
			Date.now() < deadline &&
			!(has(master.events) && has(admin.events))
		) {
			await new Promise((r) => setTimeout(r, 50));
		}
		await new Promise((r) => setTimeout(r, 300));
		// Positive control: the master secret (account-admin, no token clamp).
		expect(has(master.events)).toBe(true);
		expect(masterSse.chunks.join("")).toContain("GATE-4242");
		// Legacy member tokens carry only non-elevated grants, whatever the role.
		expect(has(admin.events)).toBe(false);
		expect(has(user.events)).toBe(false);
		expect(adminTokenSse.chunks.join("")).not.toContain("account.oauth.event");
		expect(userSse.chunks.join("")).not.toContain("account.oauth.event");
		expect(userSse.chunks.join("")).not.toContain("GATE-4242");
		expect(tokenWs.seen.some((f) => f.type === "account.oauth.event")).toBe(
			false,
		);

		await sendRpc(
			"account.oauth.cancel",
			{ flowId: started.frame.result?.flow.flowId ?? "" },
			{ token: TEST_TOKEN, accountId },
		);
		for (const c of [master, admin, user]) c.close();
		tokenWs.ws.close();
	});
	it("token sessions: an elevated token that holds credentials.manage receives it on WS and SSE; a chat.use-only token does not", async () => {
		const s = store();
		const tag = uniqueAccountId("oevk");
		const accountId = `${tag}_acct`;
		const ownerId = `usr_o_${tag}`;
		await s.ensureAccountAndUser({
			accountId,
			userId: ownerId,
			role: "account-admin",
		});
		const owner = await s.createSession({ userId: ownerId, accountId });
		expect((await rpc(owner.accessToken, "auth.elevate")).ok).toBe(true);
		const login = async (grants: string[]) => {
			const made = await rpc(owner.accessToken, "auth.tokens.create", {
				kind: "pat",
				label: grants.join("+"),
				grants,
				ttlDays: 1,
			});
			expect(made.ok).toBe(true);
			const res = await SELF.fetch(`${ORIGIN}/auth/token-login`, {
				method: "POST",
				headers: { authorization: `Bearer ${made.result?.token}` },
			});
			expect(res.status).toBe(200);
			return ((await res.json()) as { accessToken: string }).accessToken;
		};
		const manageTok = await login([
			"chat.use",
			"credentials.manage",
			"tokens.self",
		]);
		const chatTok = await login(["chat.use", "tokens.self"]);
		const open = async (token: string) => {
			const w = await rpc(token, "auth.ticket", { target: "ws" });
			const res = await SELF.fetch(`${ORIGIN}/ws?ticket=${w.result?.ticket}`, {
				headers: { upgrade: "websocket" },
			});
			const ws = res.webSocket;
			if (!ws) throw new Error(`expected 101, got ${res.status}`);
			ws.accept();
			const seen: Frame[] = [];
			ws.addEventListener("message", (ev) => {
				seen.push(JSON.parse(ev.data as string) as Frame);
			});
			const e = await rpc(token, "auth.ticket", { target: "events" });
			const sres = await SELF.fetch(
				`${ORIGIN}/events?ticket=${e.result?.ticket}`,
			);
			expect(sres.status).toBe(200);
			const reader = sres.body?.getReader();
			if (!reader) throw new Error("no sse body");
			const chunks: string[] = [];
			void (async () => {
				const dec = new TextDecoder();
				for (;;) {
					const r = await reader
						.read()
						.catch(() => ({ done: true, value: undefined }));
					if (r.done) return;
					chunks.push(dec.decode(r.value));
				}
			})();
			return { ws, seen, chunks };
		};
		const manage = await open(manageTok);
		const chat = await open(chatTok);
		const started = await rpc(owner.accessToken, "account.oauth.start", {
			providerId: "xai",
			redirectUri: "http://localhost/cb",
		});
		expect(started.ok).toBe(true);
		const got = () =>
			manage.seen.some((f) => f.type === "account.oauth.event") &&
			manage.chunks.join("").includes("account.oauth.event");
		const deadline = Date.now() + 3000;
		while (Date.now() < deadline && !got()) {
			await new Promise((r) => setTimeout(r, 50));
		}
		await new Promise((r) => setTimeout(r, 300));
		expect(manage.seen.some((f) => f.type === "account.oauth.event")).toBe(
			true,
		);
		expect(manage.chunks.join("")).toContain("GATE-4242");
		expect(chat.seen.some((f) => f.type === "account.oauth.event")).toBe(false);
		expect(chat.chunks.join("")).not.toContain("account.oauth.event");
		manage.ws.close();
		chat.ws.close();
	});
});
