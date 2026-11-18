import { createExecutionContext, env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { type Logger, setupLogger } from "../src/log.js";
import {
	HARNESS_PREFIX,
	type HarnessEnv,
	handleHarness,
} from "./harness/real-session-harness.js";
import harnessWorker, * as harnessEntry from "./harness/real-session-worker.js";
import { uniqueAccountId } from "./helpers.js";

const TOKEN = `harness-${crypto.randomUUID()}`;
const harnessEnv = (): HarnessEnv => ({ ...env, CADMUS_HARNESS_TOKEN: TOKEN });

function call(
	op: string,
	body: unknown,
	init: { token?: string | null; host?: string; method?: string } = {},
) {
	const headers = new Headers({ "content-type": "application/json" });
	const token = init.token === undefined ? TOKEN : init.token;
	if (token !== null) headers.set("x-harness-token", token);
	return handleHarness(
		new Request(
			`http://${init.host ?? "localhost:8799"}${HARNESS_PREFIX}${op}`,
			{
				method: init.method ?? "POST",
				headers,
				body: init.method === "GET" ? undefined : JSON.stringify(body),
			},
		),
		harnessEnv(),
	);
}

describe("real-session harness operations", () => {
	it("falls through when no token is configured", async () => {
		const res = await handleHarness(
			new Request(`http://localhost:8799${HARNESS_PREFIX}ping`, {
				method: "POST",
				body: "{}",
			}),
			{ ...env },
		);
		expect(res).toBeUndefined();
	});

	it("ignores requests outside the harness prefix", async () => {
		const res = await handleHarness(
			new Request("http://localhost:8799/api/other", { method: "POST" }),
			harnessEnv(),
		);
		expect(res).toBeUndefined();
	});

	it("answers 404 without the token, with a wrong token, off localhost, or by GET", async () => {
		const cases = [
			await call("ping", {}, { token: null }),
			await call("ping", {}, { token: "wrong" }),
			await call("ping", {}, { host: "example.com" }),
			await call("ping", {}, { method: "GET" }),
		];
		for (const res of cases) {
			expect(res?.status).toBe(404);
			expect(await res?.text()).toBe("Not Found");
		}
	});

	it("answers 404 for an unknown operation, including inherited names", async () => {
		for (const op of ["nope", "toString", "__proto__", "sql", "d1", ""]) {
			expect((await call(op, {}))?.status).toBe(404);
		}
	});

	it("answers 400 without detail for malformed input", async () => {
		const bad: [string, unknown][] = [
			["session", { accountId: "pk-x" }],
			["session", { accountId: "pk-x", freshAgeMs: -1 }],
			["session", { accountId: "pk-x", freshAgeMs: 1.5 }],
			["session", { accountId: "pk-x", freshAgeMs: 86_400_001 }],
			["session", { accountId: "pk x;--", freshAgeMs: 0 }],
			["session", { accountId: "pk-x", freshAgeMs: 0, sql: "select 1" }],
			["activePasskeys", { userId: "u'; DROP TABLE cadmus_audit;--" }],
			["activePasskeys", { userId: "u", table: "cadmus_audit" }],
			["activePasskeys", []],
			["activePasskeys", null],
			["auditCount", { userId: "u", action: "auth.login" }],
			["elevatedUntil", { sessionId: 5 }],
			["ping", { extra: true }],
		];
		for (const [op, body] of bad) {
			const res = await call(op, body);
			expect(res?.status, `${op} ${JSON.stringify(body)}`).toBe(400);
			expect(await res?.text()).toBe("Bad Request");
		}
		const notJson = await handleHarness(
			new Request(`http://localhost:8799${HARNESS_PREFIX}ping`, {
				method: "POST",
				headers: { "x-harness-token": TOKEN },
				body: "not json",
			}),
			harnessEnv(),
		);
		expect(notJson?.status).toBe(400);
	});

	it("creates a session with the chosen Google freshness and reads the rows it seeds", async () => {
		const ping = await call("ping", {});
		expect(await ping?.json()).toEqual({ harness: true });

		const before = Date.now();
		const res = await call("session", {
			accountId: uniqueAccountId("pk"),
			freshAgeMs: 6 * 60 * 1000,
		});
		expect(res?.status).toBe(200);
		const s = (await res?.json()) as {
			userId: string;
			sessionId: string;
			refreshToken: string;
			accessToken: string;
		};
		expect(s.refreshToken).toBeTruthy();
		const stored = await env.CADMUS_ADMIN_DB.prepare(
			`SELECT fresh_google_at AS f FROM cadmus_sessions WHERE id = ?1`,
		)
			.bind(s.sessionId)
			.first<{ f: number }>();
		expect(stored?.f).toBeLessThanOrEqual(before - 6 * 60 * 1000 + 5000);
		expect(stored?.f).toBeGreaterThan(before - 6 * 60 * 1000 - 5000);

		const read = async (op: string, body: unknown) =>
			(await (await call(op, body))?.json()) as Record<string, unknown>;
		expect(await read("elevatedUntil", { sessionId: s.sessionId })).toEqual({
			e: null,
		});
		expect(
			await read("auditCount", { userId: s.userId, action: "auth.elevate" }),
		).toEqual({ n: 0 });
	});
});

describe("real-session harness is not part of the deployed worker", () => {
	it("the production worker has no harness route, even with the header", async () => {
		const res = await SELF.fetch(`http://localhost:8799${HARNESS_PREFIX}ping`, {
			method: "POST",
			headers: { "x-harness-token": TOKEN },
			body: "{}",
		});
		expect(await res.text()).not.toContain("harness");
		expect(res.status).not.toBe(200);
	});

	it("nothing under src/ names the harness", () => {
		const sources = import.meta.glob("../src/**/*.ts", {
			query: "?raw",
			import: "default",
			eager: true,
		});
		expect(Object.keys(sources).length).toBeGreaterThan(10);
		for (const [file, text] of Object.entries(sources)) {
			expect(text, file).not.toMatch(/__test-harness|real-session|harness\//);
		}
	});

	it("wrangler.jsonc main is the production entry", () => {
		const config = import.meta.glob("../../../wrangler.jsonc", {
			query: "?raw",
			import: "default",
			eager: true,
		});
		const text = Object.values(config)[0] as string;
		expect(text).toContain('"main": "packages/worker/src/index.ts"');
		expect(text).not.toMatch(/tests\/|harness|CADMUS_HARNESS_TOKEN/);
	});
});

describe("real-session harness failure reporting", () => {
	it("answers an unexpected failure with an empty 500 and logs its name and message, not the token", async () => {
		const failing = {
			...env,
			CADMUS_HARNESS_TOKEN: TOKEN,
			CADMUS_ADMIN_DB: {
				prepare() {
					throw new Error("D1_ERROR: database is locked: SQLITE_BUSY");
				},
			} as unknown as D1Database,
		} as HarnessEnv;
		const lines: string[] = [];
		const capture: Logger = {
			debug() {},
			info() {},
			warn() {},
			error(message, fields) {
				lines.push(`${message} ${JSON.stringify(fields ?? {})}`);
			},
			child() {
				return capture;
			},
		};
		setupLogger({ type: "custom", logger: capture });
		try {
			const res = await handleHarness(
				new Request(`http://127.0.0.1:8799${HARNESS_PREFIX}activePasskeys`, {
					method: "POST",
					headers: { "x-harness-token": TOKEN },
					body: JSON.stringify({ userId: "usr_x" }),
				}),
				failing,
			);
			expect(res?.status).toBe(500);
			expect(await res?.text()).toBe("");
			const logged = lines.join("\n");
			expect(logged).toContain("activePasskeys");
			expect(logged).toContain("SQLITE_BUSY");
			expect(logged).not.toContain(TOKEN);
			expect(logged).not.toContain("usr_x");
		} finally {
			setupLogger({ type: "silent" });
		}
	});
});

describe("real-session-worker entry", () => {
	const request = (path: string, init: RequestInit = {}) =>
		new Request(`http://127.0.0.1:8799${path}`, init);

	it("re-exports the Durable Object classes the migrations name", () => {
		for (const name of [
			"CadmusBotFamilyDO",
			"CadmusEnvDO",
			"CadmusAuthLimiterDO",
		] as const) {
			expect(typeof harnessEntry[name]).toBe("function");
		}
	});

	it("falls through to the production worker with no token", async () => {
		const path = `${HARNESS_PREFIX}ping`;
		const init = { method: "POST", body: "{}" };
		const viaEntry = await harnessWorker.fetch(
			request(path, init),
			{ ...env } as HarnessEnv,
			createExecutionContext(),
		);
		const direct = await worker.fetch(
			request(path, init),
			{ ...env },
			createExecutionContext(),
		);
		expect(viaEntry.status).toBe(direct.status);
		expect(await viaEntry.text()).toBe(await direct.text());
		expect(viaEntry.status).not.toBe(200);
	});

	it("answers ping with a token and delegates /health", async () => {
		const withToken = harnessEnv();
		const ping = await harnessWorker.fetch(
			request(`${HARNESS_PREFIX}ping`, {
				method: "POST",
				headers: { "x-harness-token": TOKEN },
				body: "{}",
			}),
			withToken,
			createExecutionContext(),
		);
		expect(await ping.json()).toEqual({ harness: true });
		const health = await harnessWorker.fetch(
			request("/health"),
			withToken,
			createExecutionContext(),
		);
		const direct = await worker.fetch(
			request("/health"),
			{ ...env },
			createExecutionContext(),
		);
		expect(health.status).toBe(200);
		expect(health.status).toBe(direct.status);
		expect(await health.text()).toBe(await direct.text());
	});
});
