import { afterEach, describe, expect, it, vi } from "vitest";
import {
	currentAccessToken,
	refreshSession,
	signOut,
} from "../../packages/web-app/src/lib/session";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("session refresh in one page", () => {
	it("coalesces concurrent refreshes in one page into one request", async () => {
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						accessToken: "cad_at_one",
						expiresAt: Date.now() + 15 * 60_000,
					}),
				),
		);
		vi.stubGlobal("fetch", fetchMock);
		const [a, b] = await Promise.all([refreshSession(), refreshSession()]);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(a?.accessToken).toBe("cad_at_one");
		expect(b?.accessToken).toBe("cad_at_one");
		expect(currentAccessToken()?.accessToken).toBe("cad_at_one");
		vi.unstubAllGlobals();
	});

	it("never installs another sign-in's credential after a refresh", async () => {
		const answers = [
			{ accessToken: "cad_at_A", sessionId: "ses_A" },
			{ accessToken: "cad_at_B", sessionId: "ses_B" },
		];
		const fetchMock = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						...answers.shift(),
						expiresAt: Date.now() + 60 * 60_000,
					}),
				),
		);
		vi.stubGlobal("fetch", fetchMock);
		const first = await refreshSession(true);
		expect(first?.sessionId).toBe("ses_A");
		// The shared cookie now belongs to sign-in B: A must keep its own identity.
		const second = await refreshSession(true);
		expect(second).toBeNull();
		expect(currentAccessToken()?.sessionId).toBe("ses_A");
		expect(currentAccessToken()?.accessToken).toBe("cad_at_A");
		vi.unstubAllGlobals();
	});

	const answer = (script: Array<Response | "network">) =>
		vi.fn(async (_url: string) => {
			const next = script.shift();
			if (next === "network") throw new TypeError("offline");
			return next ?? new Response("", { status: 500 });
		});
	const session = (accessToken: string, sessionId?: string) =>
		new Response(
			JSON.stringify({
				accessToken,
				sessionId,
				expiresAt: Date.now() + 60 * 60_000,
			}),
		);
	const refused = () => new Response("", { status: 401 });

	it("keeps its identity through a refused refresh and never adopts a later sign-in", async () => {
		// Bound to ses_A by the previous test.
		vi.stubGlobal("fetch", answer([refused(), session("cad_at_B", "ses_B")]));
		expect(await refreshSession(true)).toBeNull();
		expect(currentAccessToken()).toBeNull();
		// B signs in and the timer retries: still refused.
		expect(await refreshSession(true)).toBeNull();
		expect(currentAccessToken()).toBeNull();
		vi.unstubAllGlobals();
	});

	it("refuses responses without a session id while bound, and re-adopts its own session", async () => {
		vi.stubGlobal(
			"fetch",
			answer([session("cad_at_anon"), session("cad_at_A2", "ses_A")]),
		);
		expect(await refreshSession(true)).toBeNull();
		expect(currentAccessToken()).toBeNull();
		const own = await refreshSession(true);
		expect(own?.accessToken).toBe("cad_at_A2");
		expect(currentAccessToken()?.sessionId).toBe("ses_A");
		vi.unstubAllGlobals();
	});

	it("does not claim sign-out when revoke cannot be confirmed", async () => {
		const cases: Array<Array<Response | "network">> = [
			// stale bearer, then a missing shared cookie
			[new Response(JSON.stringify({ revoked: false })), refused()],
			// stale bearer, then another sign-in's cookie
			[
				new Response(JSON.stringify({ revoked: false })),
				session("cad_at_B", "ses_B"),
			],
			// network failure
			["network", "network"],
		];
		for (const script of cases) {
			vi.stubGlobal("fetch", answer(script));
			expect(await signOut()).toBe(false);
			vi.unstubAllGlobals();
		}
		// The tab is still bound to its own session: B is still refused.
		vi.stubGlobal("fetch", answer([session("cad_at_B", "ses_B")]));
		expect(await refreshSession(true)).toBeNull();
		vi.unstubAllGlobals();
	});

	it("signs out only on a confirmed revoke, then forgets the session", async () => {
		vi.stubGlobal(
			"fetch",
			answer([
				session("cad_at_A3", "ses_A"),
				new Response(JSON.stringify({ revoked: true })),
				refused(),
			]),
		);
		await refreshSession(true);
		expect(await signOut()).toBe(true);
		expect(currentAccessToken()).toBeNull();
		vi.unstubAllGlobals();
		vi.stubGlobal("fetch", answer([session("cad_at_C", "ses_C")]));
		expect((await refreshSession(true))?.sessionId).toBe("ses_C");
		vi.unstubAllGlobals();
	});
});
