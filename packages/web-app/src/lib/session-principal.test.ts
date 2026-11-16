import { afterEach, describe, expect, it } from "bun:test";
import { readPrincipal } from "./session.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

function answer(status: number, body: unknown = {}) {
	globalThis.fetch = (async () =>
		new Response(JSON.stringify(body), { status })) as typeof fetch;
}

describe("readPrincipal", () => {
	it("calls only 401 and 403 a refusal", async () => {
		answer(401);
		expect(await readPrincipal("t", "a")).toEqual({
			kind: "refused",
			status: 401,
		});
		answer(403);
		expect(await readPrincipal("t", "a")).toEqual({
			kind: "refused",
			status: 403,
		});
	});

	it("never takes a 5xx, a network error or an unreadable body for a refusal", async () => {
		answer(503);
		expect(await readPrincipal("t", "a")).toEqual({ kind: "unavailable" });
		answer(500);
		expect(await readPrincipal("t", "a")).toEqual({ kind: "unavailable" });
		globalThis.fetch = (async () => {
			throw new TypeError("network");
		}) as typeof fetch;
		expect(await readPrincipal("t", "a")).toEqual({ kind: "unavailable" });
		answer(200, {});
		expect(await readPrincipal("t", "a")).toEqual({ kind: "unavailable" });
	});

	it("returns the principal and sends the chosen account", async () => {
		let header: string | null = null;
		globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
			header = new Headers(init?.headers).get("x-account-id");
			return new Response(
				JSON.stringify({ principal: { accountId: "a", role: "user" } }),
			);
		}) as typeof fetch;
		const read = await readPrincipal("t", "a");
		expect(read).toEqual({
			kind: "ok",
			principal: { accountId: "a", role: "user" },
		});
		expect(header).toBe("a");
	});
});
