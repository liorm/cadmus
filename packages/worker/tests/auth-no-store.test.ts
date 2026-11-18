import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * Issue #3 phase 8: `no-store` on every auth response. The Google redirect and
 * callback outcomes are asserted in google-login.test.ts; this matrix covers
 * every /auth/* route with each method and with and without the CSRF headers,
 * so refusals (405, 403, 401, 404) are covered along with the happy paths.
 */
const ORIGIN = "https://example.com";
// Dev-password login exists only on loopback hosts, so that route is probed there.
const LOCAL = "http://localhost";
const PATHS = [
	"/api/auth/session/refresh",
	"/api/auth/session/logout",
	"/api/auth/login/token",
	"/api/auth/login/devPassword",
	"/api/auth/login/providers",
	"/api/auth/login/google/start",
	"/api/auth/login/google/callback",
];
const METHODS = ["GET", "HEAD", "POST", "PUT", "DELETE"];

describe("auth responses are no-store (issue #3 phase 8)", () => {
	for (const path of PATHS) {
		it(`${path}: every method and header shape`, async () => {
			const host = path === "/api/auth/login/devPassword" ? LOCAL : ORIGIN;
			const seen = new Set<number>();
			for (const method of METHODS) {
				for (const headers of [
					{},
					{ origin: host, "x-cadmus-refresh": "1" },
					{ origin: "https://evil.example", "x-cadmus-refresh": "1" },
					{
						origin: host,
						"x-cadmus-refresh": "1",
						authorization: "Bearer cad_svc_bogus",
						cookie: "__Secure-cadmus_refresh=cad_rt_bogus",
					},
				] as Record<string, string>[]) {
					const res = await SELF.fetch(`${host}${path}`, {
						method,
						headers,
						redirect: "manual",
					});
					seen.add(res.status);
					expect(
						res.headers.get("cache-control"),
						`${method} ${path} ${res.status} ${JSON.stringify(Object.keys(headers))}`,
					).toBe("no-store");
				}
			}
			// The matrix must hit more than one outcome per route, or it proves nothing.
			expect(seen.size).toBeGreaterThan(1);
		});
	}
});

describe("shared authentication refusals are no-store (issue #3 phase 8)", () => {
	const cases: Array<[string, string, Record<string, string>]> = [
		["POST", "/rpc", {}],
		["GET", "/events", {}],
		["GET", "/ws", { upgrade: "websocket" }],
		["POST", "/rpc", { authorization: "Bearer cad_svc_bogus" }],
		["GET", "/events", { authorization: "Bearer cad_svc_bogus" }],
	];
	for (const [method, path, headers] of cases) {
		it(`${method} ${path} ${JSON.stringify(Object.keys(headers))}: 401 carries no-store`, async () => {
			const res = await SELF.fetch(`${ORIGIN}${path}`, {
				method,
				headers,
				body: method === "POST" ? "{}" : undefined,
			});
			expect(res.status).toBe(401);
			expect(res.headers.get("cache-control")).toBe("no-store");
		});
	}

	it("/api refusals keep the stricter private,no-store", async () => {
		const res = await SELF.fetch(`${ORIGIN}/api/auth/whoami`);
		expect(res.status).toBe(401);
		expect(res.headers.get("cache-control")).toBe("private, no-store");
	});
});
