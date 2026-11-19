import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getEdgeCache } from "../src/edge-cache.js";
import { D1AdminStore } from "../src/store/d1-admin.js";
import { rpc, uniqueAccountId } from "./helpers.js";

/**
 * Issue #3 L77/L148: provider OAuth is credentials.manage. The progress event of
 * a provider login carries the device user code and verification URL, so only
 * connections that hold credentials.manage receive it (WebSocket and SSE), and
 * account.credentials.oauth.status needs the same grant.
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

describe("account.credentials.oauth.event delivery is limited to credentials.manage", () => {
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
		const started = await rpc(
			admin.accessToken,
			"account.credentials.oauth.start",
			{
				providerId: "xai",
				redirectUri: "http://localhost/cb",
			},
		);
		expect(started.ok).toBe(true);
		const flowId = (started.result as { flow: { flowId: string } }).flow.flowId;

		const isEvent = (f: Frame) => f.type === "account.credentials.oauth.event";
		const deadline = Date.now() + 3000;
		while (
			Date.now() < deadline &&
			!(
				adminWs.seen.some(isEvent) &&
				adminSse.chunks.join("").includes("account.credentials.oauth.event")
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
		expect(userSse.chunks.join("")).not.toContain(
			"account.credentials.oauth.event",
		);
		expect(userSse.chunks.join("")).not.toContain("GATE-4242");

		// The status read needs the same grant: the user is refused, the admin is not.
		expect(
			(
				await rpc(user.accessToken, "account.credentials.oauth.status", {
					flowId,
				})
			).error?.code,
		).toBe("forbidden");
		expect(
			(
				await rpc(admin.accessToken, "account.credentials.oauth.status", {
					flowId,
				})
			).ok,
		).toBe(true);

		await rpc(admin.accessToken, "account.credentials.oauth.cancel", {
			flowId,
		});
		adminWs.ws.close();
		userWs.ws.close();
		await adminSse.reader.cancel().catch(() => undefined);
		await userSse.reader.cancel().catch(() => undefined);
	});

	it("refuses cad_pat_, cad_svc_, and a prefix-less secret on /ws and /events", async () => {
		for (const token of [
			"cad_pat_x",
			"cad_svc_x",
			`plain-${crypto.randomUUID()}`,
		]) {
			const ws = await SELF.fetch(`${ORIGIN}/ws`, {
				headers: {
					upgrade: "websocket",
					authorization: `Bearer ${token}`,
				},
			});
			expect(ws.status, token).toBe(401);
			const events = await SELF.fetch(`${ORIGIN}/events`, {
				headers: { authorization: `Bearer ${token}` },
			});
			expect(events.status, token).toBe(401);
		}
	});
});
