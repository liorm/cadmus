import type {
	APIRequestContext,
	Page,
	PlaywrightWorkerArgs,
} from "@playwright/test";
import { clickByRole } from "./actions.ts";
import {
	createInvitedAccount,
	elevate,
	loginDevPassword,
	sessionCommand,
} from "./dev-session.ts";
import { expect, test } from "./fixtures.ts";
import { crossTabMessagingWorks, webLocksSerialize } from "./tabs.ts";

async function openSession(
	request: APIRequestContext,
	origin: string,
	email: string,
): Promise<void> {
	await loginDevPassword(request, origin, email);
}

/** A tab never adopts the credential broadcast by a different account's session. */
export async function crossTabAccountIsolationScenario(
	page: Page,
	playwright: PlaywrightWorkerArgs["playwright"],
	_accountId: string,
	origin: string,
	onReady?: () => Promise<void>,
): Promise<void> {
	test.skip(
		!(await crossTabMessagingWorks(page)),
		"this engine does not deliver BroadcastChannel across pages",
	);
	const request = page.context().request;
	const accountA = await createInvitedAccount(request, origin, "account-admin");
	const accountB = await createInvitedAccount(request, origin, "account-admin");
	const sessionA = await loginDevPassword(request, origin, accountA.email);
	await elevate(request, origin, sessionA.accessToken);
	await sessionCommand(request, origin, sessionA.accessToken, "family.create", {
		familyId: "alt-family",
		name: "Alt family",
	});

	// Tab A signs in as account A and holds its token in memory.
	await page.goto("/settings/family");
	await expect(page.getByText("Alt family")).toBeVisible();
	if (onReady) await onReady();

	// Tab B signs in as account B in the same browser. Its boot rotates and
	// announces B's token to every tab.
	await openSession(request, origin, accountB.email);
	const tabB = await page.context().newPage();
	await tabB.goto("/settings/security");
	await expect(tabB.getByText(accountB.accountId)).toBeVisible();

	// Tab A keeps acting as account A.
	const bearers: string[] = [];
	page.on("request", (req) => {
		const auth = req.headers().authorization;
		if (auth?.startsWith("Bearer cad_at_") && !req.url().includes("/auth/"))
			bearers.push(auth.replace("Bearer ", ""));
	});
	await clickByRole(page, "button", "Switch");
	await expect(page.getByText("alt-family · current")).toBeVisible();
	expect(bearers.length).toBeGreaterThan(0);
	const independent = await playwright.request.newContext();
	const who = await independent.get(`${origin}/api/auth/whoami`, {
		headers: { Authorization: `Bearer ${bearers.at(-1)}` },
	});
	expect(who.status()).toBe(200);
	const body = (await who.json()) as { principal?: { accountId?: string } };
	expect(body.principal?.accountId).toBe(accountA.accountId);
	await independent.dispose();
	await tabB.close();
}

/** Signing out one session leaves another account's sign-in in the same browser alone. */
export async function crossTabSignoutIsolationScenario(
	page: Page,
	_accountId: string,
	origin: string,
	onReady?: () => Promise<void>,
): Promise<void> {
	test.skip(
		!(await webLocksSerialize(page)),
		"this engine's navigator.locks does not serialize, so two tabs refreshing one cookie can revoke each other",
	);
	const request = page.context().request;
	const accountA = await createInvitedAccount(request, origin, "user");
	const accountB = await createInvitedAccount(request, origin, "user");

	await openSession(request, origin, accountA.email);
	await page.goto("/settings/security");
	await expect(page.getByText("Signed in as")).toBeVisible();
	await expect(page.getByText(accountA.accountId)).toBeVisible();
	if (onReady) await onReady();

	// Another sign-in (account B) takes over the browser's refresh cookie.
	await openSession(request, origin, accountB.email);
	const tabB = await page.context().newPage();
	await tabB.goto("/settings/security");
	await expect(tabB.getByText(accountB.accountId)).toBeVisible();

	// Tab A signs out its own session. Account B must stay signed in.
	await clickByRole(page, "button", "Sign out");
	await page.waitForURL("**/");
	await tabB.reload();
	await expect(tabB.getByText(accountB.accountId)).toBeVisible();
	await tabB.close();
}
