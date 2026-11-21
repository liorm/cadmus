import { describe, expect, it } from "bun:test";
import type { Env } from "../../src/types.js";
import {
	clearSessionHintCookieHeader,
	handleWebRoute,
	SESSION_HINT_COOKIE,
	sanitizeAppNextPath,
	sanitizeGoogleReturnTo,
	sessionHintCookieHeader,
	WEB_HTML_CSP,
} from "../../src/web-routes.js";

function mockAssetsEnv(): {
	env: Env;
	fetched: Array<{ method: string; url: string }>;
} {
	const fetched: Array<{ method: string; url: string }> = [];
	const env = {
		ASSETS: {
			async fetch(input: RequestInfo | URL) {
				const req =
					input instanceof Request ? input : new Request(String(input));
				fetched.push({ method: req.method, url: req.url });
				return new Response(`<html>${new URL(req.url).pathname}</html>`, {
					status: 200,
					headers: { "content-type": "text/html; charset=utf-8" },
				});
			},
		},
	} as unknown as Env;
	return { env, fetched };
}

describe("web-routes helpers", () => {
	it("sanitizes /app next paths and rejects external or non-app paths", () => {
		expect(sanitizeAppNextPath("/app")).toBe("/app");
		expect(sanitizeAppNextPath("/app/")).toBe("/app/");
		expect(sanitizeAppNextPath("/app/chat/abc?view=raw")).toBe(
			"/app/chat/abc?view=raw",
		);
		expect(sanitizeAppNextPath("/app-evil")).toBeUndefined();
		expect(sanitizeAppNextPath("/login")).toBeUndefined();
		expect(sanitizeAppNextPath("//evil.example/app")).toBeUndefined();
		expect(sanitizeAppNextPath("https://evil.example/app")).toBeUndefined();
		expect(sanitizeAppNextPath("/app\\evil")).toBeUndefined();
		expect(sanitizeAppNextPath("/app/\nfoo")).toBeUndefined();
		expect(sanitizeAppNextPath("")).toBeUndefined();
		expect(sanitizeAppNextPath(null)).toBeUndefined();
	});

	it("sanitizes Google returnTo to /app/* or /login/device only", () => {
		expect(sanitizeGoogleReturnTo("/login/device")).toBe("/login/device");
		expect(sanitizeGoogleReturnTo("/app/settings")).toBe("/app/settings");
		expect(sanitizeGoogleReturnTo("/login/device?code=1")).toBeUndefined();
		expect(sanitizeGoogleReturnTo("/login")).toBeUndefined();
		expect(sanitizeGoogleReturnTo("https://evil.example")).toBeUndefined();
	});

	it("formats session hint set and clear cookie headers", () => {
		const header = sessionHintCookieHeader({
			sessionId: "s1",
			accessToken: "cad_at_1",
			refreshToken: "cad_rt_1",
			accessExpiresAt: Date.now() + 60_000,
			refreshExpiresAt: Date.now() + 3600_000,
		});
		expect(header).toContain(`${SESSION_HINT_COOKIE}=1; Path=/app;`);
		expect(header).toContain("HttpOnly; Secure; SameSite=Lax;");
		expect(clearSessionHintCookieHeader()).toBe(
			`${SESSION_HINT_COOKIE}=; Path=/app; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
		);
	});
});

describe("handleWebRoute", () => {
	it("serves /login/index.html with CSP and no-store for /login and /login/device", async () => {
		const { env, fetched } = mockAssetsEnv();
		for (const path of ["/login", "/login/device?code=ABCD-EFGH"]) {
			const url = new URL(`https://example.com${path}`);
			const res = await handleWebRoute(new Request(url), url, env);
			expect(res?.status).toBe(200);
			expect(res?.headers.get("content-security-policy")).toBe(WEB_HTML_CSP);
			expect(res?.headers.get("cache-control")).toBe("no-store");
			expect(await res?.text()).toBe("<html>/login/index.html</html>");
		}
		expect(fetched).toEqual([
			{ method: "GET", url: "https://example.com/login/index.html" },
			{ method: "GET", url: "https://example.com/login/index.html" },
		]);
	});

	it("serves /app/index.html with CSP when SESSION_HINT_COOKIE=1 is present", async () => {
		const { env, fetched } = mockAssetsEnv();
		const url = new URL("https://example.com/app/chat/123");
		const res = await handleWebRoute(
			new Request(url, {
				headers: { cookie: `${SESSION_HINT_COOKIE}=1` },
			}),
			url,
			env,
		);
		expect(res?.status).toBe(200);
		expect(res?.headers.get("content-security-policy")).toBe(WEB_HTML_CSP);
		expect(res?.headers.get("cache-control")).toBe("no-store");
		expect(await res?.text()).toBe("<html>/app/index.html</html>");
		expect(fetched).toEqual([
			{ method: "GET", url: "https://example.com/app/index.html" },
		]);
	});

	it("passes /login/assets/* and /app/assets/* through to env.ASSETS", async () => {
		const { env, fetched } = mockAssetsEnv();
		const url = new URL("https://example.com/login/assets/login-abc.js");
		const res = await handleWebRoute(new Request(url), url, env);
		expect(res?.status).toBe(200);
		expect(fetched).toEqual([
			{ method: "GET", url: "https://example.com/login/assets/login-abc.js" },
		]);
	});

	it("ignores non-GET/HEAD requests and unknown paths", async () => {
		const { env } = mockAssetsEnv();
		const postLogin = new URL("https://example.com/login");
		expect(
			await handleWebRoute(
				new Request(postLogin, { method: "POST" }),
				postLogin,
				env,
			),
		).toBeNull();
		const apiUrl = new URL("https://example.com/api/auth/whoami");
		expect(await handleWebRoute(new Request(apiUrl), apiUrl, env)).toBeNull();
	});
});
