import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { withSecurityHeaders } from "../src/index.js";
import { streamAuthParams, uniqueAccountId } from "./helpers.js";

/**
 * Issue #3 phase 8: the SPA `_headers` file covers static assets only, so
 * Worker-generated responses get nosniff, no-referrer and X-Frame-Options here.
 */
const ORIGIN = "https://example.com";
const EXPECTED = {
	"x-content-type-options": "nosniff",
	"referrer-policy": "no-referrer",
	"x-frame-options": "DENY",
};

function expectHeaders(res: Response, label: string) {
	for (const [name, value] of Object.entries(EXPECTED)) {
		expect(res.headers.get(name), `${label} ${name}`).toBe(value);
	}
}

describe("Worker responses carry the security headers", () => {
	const cases: Array<[string, string, RequestInit]> = [
		["GET /health", "/health", {}],
		["GET /protocol/schema", "/protocol/schema", {}],
		["GET / redirect to /app", "/", { redirect: "manual" }],
		["GET /sign-in redirect to /login", "/sign-in", { redirect: "manual" }],
		["GET /app unauthenticated redirect", "/app", { redirect: "manual" }],
		["GET /login", "/login", { redirect: "manual" }],
		["GET unknown path (401 or 404)", "/nope", {}],
		["GET /api/auth/login/providers", "/api/auth/login/providers", {}],
		[
			"GET /api/auth/login/google/start (sets a cookie)",
			"/api/auth/login/google/start",
			{},
		],
		[
			"POST /api/auth/session/refresh without CSRF header",
			"/api/auth/session/refresh",
			{ method: "POST" },
		],
		["GET /rpc unauthenticated", "/rpc", {}],
		["GET /events unauthenticated", "/events", {}],
		["GET /api/v1/bots unauthenticated", "/api/v1/bots", {}],
		[
			"cross-origin POST refusal (403)",
			"/rpc",
			{ method: "POST", headers: { origin: "https://evil.example" } },
		],
	];
	for (const [label, path, init] of cases) {
		it(label, async () => {
			const res = await SELF.fetch(`${ORIGIN}${path}`, init);
			expectHeaders(res, label);
			await res.arrayBuffer();
		});
	}

	it("keeps the real Set-Cookie on the Google login redirect", async () => {
		const res = await SELF.fetch(`${ORIGIN}/api/auth/login/google/start`, {
			redirect: "manual",
		});
		const cookies = res.headers.getSetCookie();
		expect(cookies.length).toBeGreaterThanOrEqual(1);
		expect(cookies.join("\n")).toMatch(/HttpOnly/);
		expectHeaders(res, "google login");
	});

	it("keeps the body, status and handler headers", async () => {
		const res = await SELF.fetch(`${ORIGIN}/health`);
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ ok: true });
		expect(res.headers.get("content-type")).toContain("application/json");
	});
});

// The only codes the Worker returns for a refused /ws upgrade (index.ts).
const KNOWN_CODES: ReadonlySet<string> = new Set([
	"unauthorized",
	"forbidden",
	"family_not_found",
]);

describe("the WebSocket upgrade passes through the wrapper", () => {
	it("completes a real 101 handshake and answers a frame", async () => {
		// A fresh account: the default master account is shared by every file on
		// one workerd (vitest.config.ts), so its state is not this test's own.
		const options = {
			accountId: uniqueAccountId("sec-headers"),
			familyId: "default",
		};
		const url = new URL("http://example.com/ws");
		url.searchParams.set(
			"ticket",
			(await streamAuthParams("ws", options)).ticket ?? "",
		);
		url.searchParams.set("accountId", options.accountId);
		url.searchParams.set("familyId", options.familyId);
		const res = await SELF.fetch(url.toString(), {
			headers: { Upgrade: "websocket" },
		});
		if (!res.webSocket) {
			// Status and a known error code only. Worker auth failures are JSON
			// {type:"protocol.error", payload:{code}} (index.ts 401) or
			// {error:{code}} (cross-origin 403); the message, URL and headers are
			// never printed, and any other body shows as unrecognized.
			let code = "unrecognized body";
			try {
				const body = (await res.json()) as {
					payload?: { code?: unknown };
					error?: { code?: unknown };
				};
				const found = body.payload?.code ?? body.error?.code;
				if (typeof found === "string" && KNOWN_CODES.has(found)) {
					code = found;
				}
			} catch {
				// not JSON: keep the generic marker
			}
			throw new Error(`expected 101, got ${res.status} (${code})`);
		}
		expect(res.status).toBe(101);
		const ws = res.webSocket;
		ws.accept();
		try {
			const reply = await new Promise<{ type: string; ok?: boolean }>(
				(resolve, reject) => {
					const timer = setTimeout(
						() => reject(new Error("no frame in 3s")),
						3000,
					);
					ws.addEventListener("message", (event) => {
						const frame = JSON.parse(event.data as string);
						if (frame.id !== "sec-1") return;
						clearTimeout(timer);
						resolve(frame);
					});
					ws.send(
						JSON.stringify({ id: "sec-1", type: "bot.list", payload: {} }),
					);
				},
			);
			expect(reply.ok).toBe(true);
		} finally {
			ws.close();
		}
	});
});

describe("withSecurityHeaders", () => {
	it("adds the headers and keeps status, body and existing headers", async () => {
		const out = withSecurityHeaders(
			new Response("hi", {
				status: 418,
				statusText: "teapot",
				headers: { "cache-control": "no-store", "x-custom": "1" },
			}),
		);
		expectHeaders(out, "unit");
		expect(out.status).toBe(418);
		expect(out.statusText).toBe("teapot");
		expect(out.headers.get("cache-control")).toBe("no-store");
		expect(out.headers.get("x-custom")).toBe("1");
		expect(await out.text()).toBe("hi");
	});

	it("keeps every repeated Set-Cookie header", () => {
		const headers = new Headers();
		headers.append("set-cookie", "a=1; Path=/; HttpOnly");
		headers.append("set-cookie", "b=2; Path=/x; Secure");
		const out = withSecurityHeaders(new Response(null, { headers }));
		expect(out.headers.getSetCookie()).toEqual([
			"a=1; Path=/; HttpOnly",
			"b=2; Path=/x; Secure",
		]);
		expectHeaders(out, "cookies");
	});

	it("streams the body: the first chunk is readable before the source closes", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const enc = new TextEncoder();
		const source = new ReadableStream<Uint8Array>({
			async start(controller) {
				controller.enqueue(enc.encode("first"));
				await gate;
				controller.enqueue(enc.encode("second"));
				controller.close();
			},
		});
		const out = withSecurityHeaders(new Response(source));
		const reader = out.body?.getReader();
		if (!reader) throw new Error("missing response body");
		const first = await reader.read();
		expect(new TextDecoder().decode(first.value)).toBe("first");
		release();
		const second = await reader.read();
		expect(new TextDecoder().decode(second.value)).toBe("second");
		expect((await reader.read()).done).toBe(true);
	});

	it("does not override a header the handler already set", () => {
		const out = withSecurityHeaders(
			new Response(null, { headers: { "x-frame-options": "SAMEORIGIN" } }),
		);
		expect(out.headers.get("x-frame-options")).toBe("SAMEORIGIN");
		expect(out.headers.get("x-content-type-options")).toBe("nosniff");
	});
});
