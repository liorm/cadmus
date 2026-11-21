import { describe, expect, it } from "vitest";
import {
	cookiePair,
	DEV_PASSWORD,
	elevateAccessToken,
	loginDevPassword,
	provisionInvitedMember,
	sendRpc,
	setCookieLines,
	useWorkerFixture,
	workerFetch,
} from "./helpers.js";

const ORIGIN = "https://example.com";
const LOCAL = "http://127.0.0.1";
const HINT_COOKIE = "__Secure-cadmus_signed_in";
const REFRESH_COOKIE = "__Secure-cadmus_refresh";

function findSetCookie(lines: string[], name: string): string | undefined {
	return lines.find((line) => line.startsWith(`${name}=`));
}

describe("web routing and login/app split redirects", () => {
	useWorkerFixture();

	it("redirects / to /app", async () => {
		const res = await workerFetch(`${ORIGIN}/`, { redirect: "manual" });
		expect(res.status).toBe(302);
		expect(res.headers.get("location")).toBe("/app");
		expect(res.headers.get("cache-control")).toBe("no-store");
	});

	it("redirects /sign-in and subpaths to /login while preserving query strings", async () => {
		const root = await workerFetch(`${ORIGIN}/sign-in`, { redirect: "manual" });
		expect(root.status).toBe(302);
		expect(root.headers.get("location")).toBe("/login");

		const withQuery = await workerFetch(
			`${ORIGIN}/sign-in?next=%2Fapp%2Fsettings`,
			{ redirect: "manual" },
		);
		expect(withQuery.status).toBe(302);
		expect(withQuery.headers.get("location")).toBe(
			"/login?next=%2Fapp%2Fsettings",
		);

		const device = await workerFetch(
			`${ORIGIN}/sign-in/device?code=ABCD-EFGH`,
			{ redirect: "manual" },
		);
		expect(device.status).toBe(302);
		expect(device.headers.get("location")).toBe("/login/device?code=ABCD-EFGH");
	});

	it("redirects unauthenticated /app and /app/* requests to /login before serving the app", async () => {
		const appRoot = await workerFetch(`${ORIGIN}/app`, { redirect: "manual" });
		expect(appRoot.status).toBe(302);
		expect(appRoot.headers.get("location")).toBe("/login");
		expect(appRoot.headers.get("cache-control")).toBe("no-store");

		const deep = await workerFetch(`${ORIGIN}/app/chat/foo?view=raw`, {
			redirect: "manual",
		});
		expect(deep.status).toBe(302);
		expect(deep.headers.get("location")).toBe(
			"/login?next=%2Fapp%2Fchat%2Ffoo%3Fview%3Draw",
		);
	});

	it("manages the non-credential session hint cookie across full, provisional, assumeRole, refresh, and logout flows", async () => {
		const member = await provisionInvitedMember({ role: "account-admin" });
		const boss = await loginDevPassword();
		await elevateAccessToken(boss.accessToken);
		const granted = await sendRpc(
			"system.members.update",
			{
				accountId: member.accountId,
				userId: member.userId,
				op: "grant",
				role: "user",
			},
			{ token: boss.accessToken },
		);
		expect(granted.frame.ok).toBe(true);

		// 1. Provisional login (chooseRole=true with two hats) clears the hint cookie.
		const provRes = await workerFetch(`${LOCAL}/api/auth/login/devPassword`, {
			method: "POST",
			headers: { Origin: LOCAL, "Content-Type": "application/json" },
			body: JSON.stringify({
				id: "prov",
				type: "auth.login.devPassword",
				payload: {
					email: member.email,
					password: DEV_PASSWORD,
					chooseRole: true,
				},
			}),
		});
		expect(provRes.status).toBe(200);
		const provCookies = setCookieLines(provRes);
		const provBody = (await provRes.json()) as {
			accessToken: string;
			provisional?: boolean;
		};
		expect(provBody.provisional).toBe(true);
		const provHint = findSetCookie(provCookies, HINT_COOKIE);
		expect(provHint).toContain(`${HINT_COOKIE}=; Path=/app;`);
		expect(provHint).toContain("Max-Age=0");

		// Refresh while provisional keeps provisional=true and clears hint cookie.
		const provRefresh = await workerFetch(`${LOCAL}/api/auth/session/refresh`, {
			method: "POST",
			headers: {
				Origin: LOCAL,
				"X-Cadmus-Refresh": "1",
				Cookie: cookiePair(provCookies, REFRESH_COOKIE),
			},
		});
		expect(provRefresh.status).toBe(200);
		const provRefreshBody = (await provRefresh.json()) as {
			accessToken: string;
			provisional?: boolean;
		};
		expect(provRefreshBody.provisional).toBe(true);
		expect(findSetCookie(setCookieLines(provRefresh), HINT_COOKIE)).toContain(
			"Max-Age=0",
		);

		// 2. Assume role promotes the provisional session and sets the /app hint cookie.
		const assumeRes = await workerFetch(`${LOCAL}/api/auth/assumeRole`, {
			method: "POST",
			headers: {
				Origin: LOCAL,
				"Content-Type": "application/json",
				Authorization: `Bearer ${provRefreshBody.accessToken}`,
			},
			body: JSON.stringify({
				id: "assume",
				type: "auth.assumeRole",
				payload: { role: "account-admin", accountId: member.accountId },
			}),
		});
		expect(assumeRes.status).toBe(200);
		const assumeCookies = setCookieLines(assumeRes);
		const assumeHint = findSetCookie(assumeCookies, HINT_COOKIE);
		expect(assumeHint).toContain(`${HINT_COOKIE}=1; Path=/app;`);
		expect(assumeHint).toContain("HttpOnly");
		expect(assumeHint).toContain("Secure");
		expect(assumeHint).toContain("SameSite=Lax");
		const assumeBody = (await assumeRes.json()) as { accessToken: string };

		// 3. Refresh on a full session preserves the hint cookie and omits provisional.
		const fullRefresh = await workerFetch(`${LOCAL}/api/auth/session/refresh`, {
			method: "POST",
			headers: {
				Origin: LOCAL,
				"X-Cadmus-Refresh": "1",
				Cookie: cookiePair(assumeCookies, REFRESH_COOKIE),
			},
		});
		expect(fullRefresh.status).toBe(200);
		const fullRefreshBody = (await fullRefresh.json()) as {
			accessToken: string;
			provisional?: boolean;
		};
		expect(fullRefreshBody.provisional).toBeUndefined();
		expect(findSetCookie(setCookieLines(fullRefresh), HINT_COOKIE)).toContain(
			`${HINT_COOKIE}=1; Path=/app;`,
		);

		// 4. Logout clears both refresh and hint cookies.
		const logoutRes = await workerFetch(`${LOCAL}/api/auth/session/logout`, {
			method: "POST",
			headers: {
				Origin: LOCAL,
				"X-Cadmus-Refresh": "1",
				Authorization: `Bearer ${fullRefreshBody.accessToken}`,
				Cookie: cookiePair(setCookieLines(fullRefresh), REFRESH_COOKIE),
			},
		});
		expect(logoutRes.status).toBe(200);
		const logoutCookies = setCookieLines(logoutRes);
		expect(findSetCookie(logoutCookies, REFRESH_COOKIE)).toContain("Max-Age=0");
		expect(findSetCookie(logoutCookies, HINT_COOKIE)).toContain("Max-Age=0");

		// 5. Invalid/revoked refresh returns 401 and clears the hint cookie too.
		const staleRefresh = await workerFetch(
			`${LOCAL}/api/auth/session/refresh`,
			{
				method: "POST",
				headers: {
					Origin: LOCAL,
					"X-Cadmus-Refresh": "1",
					Cookie: `${REFRESH_COOKIE}=cad_rt_invalid`,
				},
			},
		);
		expect(staleRefresh.status).toBe(401);
		expect(findSetCookie(setCookieLines(staleRefresh), HINT_COOKIE)).toContain(
			"Max-Age=0",
		);

		// 6. Cookie-less refresh returns 401 and clears both refresh and hint cookies.
		const missingRefresh = await workerFetch(
			`${LOCAL}/api/auth/session/refresh`,
			{
				method: "POST",
				headers: {
					Origin: LOCAL,
					"X-Cadmus-Refresh": "1",
				},
			},
		);
		expect(missingRefresh.status).toBe(401);
		const missingRefreshCookies = setCookieLines(missingRefresh);
		expect(findSetCookie(missingRefreshCookies, REFRESH_COOKIE)).toContain(
			"Max-Age=0",
		);
		expect(findSetCookie(missingRefreshCookies, HINT_COOKIE)).toContain(
			"Max-Age=0",
		);

		// Sanity: old access token is revoked.
		const dead = await sendRpc(
			"auth.whoami",
			{},
			{ token: assumeBody.accessToken },
		);
		expect(dead.status).toBe(401);
	});
});
