import { afterEach, describe, expect, it } from "bun:test";
import { BOOT_REFRESH_RETRIES, BOOT_RETRY_MAX_MS } from "./session.ts";

type SessionModule = typeof import("./session.ts");

/**
 * A fresh copy of the module per call, so each test starts with no shared
 * token. Every specifier is a literal (the boundaries check rejects computed
 * ones); the query string makes the runtime load a separate copy.
 */
const copies: Array<() => Promise<SessionModule>> = [
	() => import("./session.ts?fresh=1"),
	() => import("./session.ts?fresh=2"),
	() => import("./session.ts?fresh=3"),
	() => import("./session.ts?fresh=4"),
	() => import("./session.ts?fresh=5"),
	() => import("./session.ts?fresh=6"),
	() => import("./session.ts?fresh=7"),
	() => import("./session.ts?fresh=8"),
	() => import("./session.ts?fresh=9"),
	() => import("./session.ts?fresh=10"),
	() => import("./session.ts?fresh=11"),
	() => import("./session.ts?fresh=12"),
	() => import("./session.ts?fresh=13"),
	() => import("./session.ts?fresh=14"),
	() => import("./session.ts?fresh=15"),
	() => import("./session.ts?fresh=16"),
	() => import("./session.ts?fresh=17"),
	() => import("./session.ts?fresh=18"),
	() => import("./session.ts?fresh=19"),
	() => import("./session.ts?fresh=20"),
	() => import("./session.ts?fresh=21"),
	() => import("./session.ts?fresh=22"),
	() => import("./session.ts?fresh=23"),
	() => import("./session.ts?fresh=24"),
];
let nextCopy = 0;
async function fresh(): Promise<SessionModule> {
	const load = copies[nextCopy++];
	if (!load) throw new Error("add another literal import to copies");
	return load();
}

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

/** Plays the given answers to /auth/refresh in order, then repeats the last. */
function script(answers: Array<() => Response | Promise<Response>>) {
	const calls: string[] = [];
	globalThis.fetch = (async (url: unknown) => {
		calls.push(String(url));
		const next = answers[Math.min(calls.length - 1, answers.length - 1)];
		return next();
	}) as typeof fetch;
	return calls;
}

const limited = (retryAfter?: string) => () =>
	new Response("{}", {
		status: 429,
		headers: retryAfter ? { "retry-after": retryAfter } : {},
	});
const ok = () =>
	new Response(
		JSON.stringify({
			accessToken: "at",
			expiresAt: Date.now() + 15 * 60_000,
			sessionId: "s1",
		}),
		{ status: 200 },
	);

function sleeper() {
	const waits: number[] = [];
	return {
		waits,
		sleep: async (ms: number) => {
			waits.push(ms);
			// A runaway retry loop must fail the test, not hang it.
			if (waits.length > 20) throw new Error("unbounded boot retries");
		},
	};
}

describe("refreshForBoot: a transient refresh failure is not signed out", () => {
	it("429 forever: bounded retries, then unavailable (never none), capped waits", async () => {
		const { refreshForBoot } = await fresh();
		const calls = script([limited("3600")]);
		const s = sleeper();
		const out = await refreshForBoot(
			new AbortController().signal,
			undefined,
			s.sleep,
		);
		expect(out).toEqual({ kind: "unavailable" });
		expect(calls.length).toBe(1 + BOOT_REFRESH_RETRIES);
		expect(s.waits.length).toBe(BOOT_REFRESH_RETRIES);
		for (const w of s.waits) expect(w).toBe(BOOT_RETRY_MAX_MS);
	});

	it("honours a small Retry-After and falls back to a default without one", async () => {
		const { refreshForBoot } = await fresh();
		script([limited("2"), limited(), ok]);
		const s = sleeper();
		const out = await refreshForBoot(
			new AbortController().signal,
			undefined,
			s.sleep,
		);
		expect(out.kind).toBe("tokens");
		expect(s.waits).toEqual([2000, 3000]);
	});

	it("a 5xx and a network error are retried too", async () => {
		const { refreshForBoot } = await fresh();
		script([
			() => new Response("{}", { status: 503 }),
			() => {
				throw new TypeError("network");
			},
			ok,
		]);
		const s = sleeper();
		const out = await refreshForBoot(
			new AbortController().signal,
			undefined,
			s.sleep,
		);
		expect(out.kind).toBe("tokens");
		expect(s.waits.length).toBe(2);
	});

	it("reports each wait through onRetry", async () => {
		const { refreshForBoot } = await fresh();
		script([limited("1"), ok]);
		let n = 0;
		await refreshForBoot(
			new AbortController().signal,
			() => n++,
			sleeper().sleep,
		);
		expect(n).toBe(1);
	});

	it("a 401 is signed out at once: no retry, no wait", async () => {
		const { refreshForBoot } = await fresh();
		const calls = script([() => new Response("{}", { status: 401 })]);
		const s = sleeper();
		const out = await refreshForBoot(
			new AbortController().signal,
			undefined,
			s.sleep,
		);
		expect(out).toEqual({ kind: "none" });
		expect(calls.length).toBe(1);
		expect(s.waits).toEqual([]);
	});

	it("any other refusal (403, 400) is not retried either", async () => {
		const { refreshForBoot } = await fresh();
		for (const status of [400, 403]) {
			const calls = script([() => new Response("{}", { status })]);
			const out = await refreshForBoot(
				new AbortController().signal,
				undefined,
				sleeper().sleep,
			);
			expect(out).toEqual({ kind: "none" });
			expect(calls.length).toBe(1);
		}
	});

	it("aborting during the wait stops the retries and sends no further request", async () => {
		const { refreshForBoot } = await fresh();
		const calls = script([limited("1")]);
		const abort = new AbortController();
		const out = await refreshForBoot(abort.signal, undefined, async () => {
			abort.abort();
		});
		expect(out).toEqual({ kind: "cancelled" });
		expect(calls.length).toBe(1);
	});

	it("aborting while a request is in flight is cancelled even if it succeeds", async () => {
		const { refreshForBoot } = await fresh();
		const abort = new AbortController();
		script([
			() => {
				abort.abort();
				return ok();
			},
		]);
		const out = await refreshForBoot(abort.signal, undefined, sleeper().sleep);
		expect(out).toEqual({ kind: "cancelled" });
	});

	it("a Retry-After under a second waits the 1 s floor; 0 or garbage uses the default", async () => {
		const { refreshForBoot } = await fresh();
		script([limited("0.2"), limited("0"), limited("soon"), ok]);
		const s = sleeper();
		const out = await refreshForBoot(
			new AbortController().signal,
			undefined,
			s.sleep,
		);
		expect(out.kind).toBe("tokens");
		expect(s.waits).toEqual([1000, 3000, 3000]);
	});

	it("a plain 429 alone (no other status) is transient", async () => {
		const { refreshForBoot } = await fresh();
		script([limited("1"), ok]);
		const s = sleeper();
		const out = await refreshForBoot(
			new AbortController().signal,
			undefined,
			s.sleep,
		);
		expect(out.kind).toBe("tokens");
		expect(s.waits).toEqual([1000]);
	});

	it("a concurrent refreshSession caller shares the attempt and cannot hide its transient result from boot", async () => {
		const { refreshForBoot, refreshSession } = await fresh();
		const calls = script([
			async () => {
				await new Promise((r) => setTimeout(r, 5));
				return limited("1")();
			},
			ok,
		]);
		const s = sleeper();
		const boot = refreshForBoot(
			new AbortController().signal,
			undefined,
			s.sleep,
		);
		const other = refreshSession();
		expect(await other).toBeNull();
		const out = await boot;
		expect(out.kind).toBe("tokens");
		expect(s.waits).toEqual([1000]);
		expect(calls.length).toBe(2);
	});

	it("boot joining a refresh another caller started still sees that attempt's transient result", async () => {
		const { refreshForBoot, refreshSession } = await fresh();
		const calls = script([
			async () => {
				await new Promise((r) => setTimeout(r, 5));
				return limited("1")();
			},
			ok,
		]);
		const s = sleeper();
		const other = refreshSession();
		const boot = refreshForBoot(
			new AbortController().signal,
			undefined,
			s.sleep,
		);
		expect(await other).toBeNull();
		const out = await boot;
		expect(out.kind).toBe("tokens");
		expect(s.waits).toEqual([1000]);
		expect(calls.length).toBe(2);
	});

	it("uses optional retry config override when provided for transient failures", async () => {
		const { refreshForBoot } = await fresh();
		const calls = script([limited("60")]);
		const s = sleeper();
		const out = await refreshForBoot(
			new AbortController().signal,
			undefined,
			s.sleep,
			async () => ({ waitMs: 200, retries: 2 }),
		);
		expect(out).toEqual({ kind: "unavailable" });
		expect(calls.length).toBe(3);
		expect(s.waits).toEqual([200, 200]);
	});
});
