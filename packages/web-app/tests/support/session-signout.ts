import type { Page, PlaywrightWorkerArgs } from "@playwright/test";
import { sendAccountRpc } from "./account.ts";
import { clickByRole } from "./actions.ts";
import { expect } from "./fixtures.ts";
import { crossTabMessagingWorks } from "./tabs.ts";

/**
 * A real signed-in session boots via cookie refresh without storing its access
 * token, survives family switching, and server-side revokes on sign-out.
 */
export async function sessionSignoutScenario(
	page: Page,
	playwright: PlaywrightWorkerArgs["playwright"],
	accountId: string,
	origin: string,
	onReady?: () => Promise<void>,
): Promise<void> {
	const created = await sendAccountRpc<{ token: string }>(
		origin,
		accountId,
		"auth.tokens.create",
		{
			kind: "pat",
			label: "ui session",
			grants: ["chat.use", "bot.read", "tokens.self"],
			ttlDays: 1,
		},
	);
	// Token login sets the refresh cookie in the browser context, as a real
	// sign-in would. The cookie is scoped to /auth/refresh.
	const login = await page
		.context()
		.request.post(`${origin}/auth/token-login`, {
			headers: { Authorization: `Bearer ${created.token}` },
		});
	expect(login.ok()).toBe(true);

	await page.goto("/settings/security");
	await expect(page.getByText("Signed in as")).toBeVisible();
	if (onReady) await onReady();

	// Reload keeps the session through the refresh cookie alone.
	await page.reload();
	await expect(page.getByText("Signed in as")).toBeVisible();

	// No access token is ever written to web storage.
	const stored = await page.evaluate(() =>
		JSON.stringify([
			Object.entries(localStorage),
			Object.entries(sessionStorage),
		]),
	);
	expect(stored).not.toContain("cad_at_");

	// Switching family writes a preference to storage; it must stay secret-free.
	await sendAccountRpc(origin, accountId, "family.create", {
		familyId: "alt-family",
		name: "Alt family",
	});
	await page.goto("/settings/family");
	await expect(page.getByText("Alt family")).toBeVisible();
	// A second tab boots and rotates the session's access token. The first tab
	// must pick up the new one (shared in memory), or its next call would 401.
	if (await crossTabMessagingWorks(page)) {
		const second = await page.context().newPage();
		await second.goto("/settings/security");
		await expect(second.getByText("Signed in as")).toBeVisible();
		await second.close();
	}
	await clickByRole(page, "button", "Switch");
	await expect(page.getByText("alt-family · current")).toBeVisible();
	const afterSwitch = await page.evaluate(() =>
		JSON.stringify([
			Object.entries(localStorage),
			Object.entries(sessionStorage),
		]),
	);
	expect(afterSwitch).toContain("alt-family");
	expect(afterSwitch).not.toContain("cad_at_");
	await page.goto("/settings/security");
	await expect(page.getByText("Signed in as")).toBeVisible();

	// Capture the live credentials before signing out, then replay them from an
	// independent client afterwards: that proves the server revoked the session,
	// not just that the browser forgot it.
	// Capture the bearer the page sends to /auth/logout. The page wrapper hands
	// it to this test process through a binding, so it stays in memory only: no
	// console output, trace or artifact carries it, and it survives the reload
	// that sign-out causes.
	let liveBearer = "";
	await page.exposeFunction("__captureLogoutBearer", (value: string) => {
		liveBearer = value;
	});
	await page.evaluate(() => {
		const report = (
			window as unknown as {
				__captureLogoutBearer: (value: string) => void;
			}
		).__captureLogoutBearer;
		const original = window.fetch.bind(window);
		window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
			const url = typeof input === "string" ? input : (input as Request).url;
			if (url.endsWith("/auth/logout")) {
				const headers = new Headers(init?.headers);
				report((headers.get("authorization") ?? "").replace("Bearer ", ""));
			}
			return original(input, init);
		}) as typeof window.fetch;
	});
	const cookie = (await page.context().cookies()).find((c) =>
		c.name.endsWith("cadmus_refresh"),
	);
	expect(cookie).toBeTruthy();
	await clickByRole(page, "button", "Sign out");
	await page.waitForURL("**/");
	expect(liveBearer.startsWith("cad_at_")).toBe(true);

	const independent = await playwright.request.newContext();
	const who = await independent.get(`${origin}/api/auth/whoami`, {
		headers: { Authorization: `Bearer ${liveBearer}` },
	});
	expect(who.status()).toBe(401);
	const refreshed = await independent.post(`${origin}/auth/refresh`, {
		headers: {
			origin,
			"X-Cadmus-Refresh": "1",
			cookie: `${cookie?.name}=${cookie?.value}`,
		},
	});
	expect(refreshed.status()).toBe(401);
	await independent.dispose();

	// Same browser, after sign-out. Logout never reads or clears the refresh
	// cookie (it is Path=/auth/refresh, so the browser does not send it there);
	// the page's next refresh is refused for the revoked session and clears the
	// stale cookie. Then a reload and a fresh navigation both stay signed out.
	const staleCookie = async () =>
		(await page.context().cookies()).some((c) =>
			c.name.endsWith("cadmus_refresh"),
		);
	await expect.poll(staleCookie).toBe(false);
	// The signed-out page is the positive marker: the Sign in section renders
	// only once the session check has finished and found no session.
	const signedOut = page.getByText(
		/Sign-in is not enabled|You are using the shared access key/,
	);
	await page.goto("/settings/security");
	await expect(signedOut).toBeVisible();
	await expect(page.getByText("Signed in as")).toHaveCount(0);
	await page.reload();
	await expect(signedOut).toBeVisible();
	await expect(page.getByText("Signed in as")).toHaveCount(0);
	expect(await staleCookie()).toBe(false);
}
