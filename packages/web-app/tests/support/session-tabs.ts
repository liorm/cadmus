import type { Page, PlaywrightWorkerArgs } from "@playwright/test";
import {
	provisionAccount,
	sendAccountRpc,
	uniqueAccountId,
} from "./account.ts";
import { clickByRole } from "./actions.ts";
import { expect, test } from "./fixtures.ts";
import { crossTabMessagingWorks, webLocksSerialize } from "./tabs.ts";

async function patFor(origin: string, accountId: string): Promise<string> {
	const created = await sendAccountRpc<{ token: string }>(
		origin,
		accountId,
		"auth.tokens.create",
		{
			kind: "pat",
			label: "tab",
			grants: ["chat.use", "bot.read", "tokens.self"],
			ttlDays: 1,
		},
	);
	return created.token;
}

/** A tab never adopts the credential broadcast by a different account's session. */
export async function crossTabAccountIsolationScenario(
	page: Page,
	playwright: PlaywrightWorkerArgs["playwright"],
	accountId: string,
	origin: string,
	onReady?: () => Promise<void>,
): Promise<void> {
	test.skip(
		!(await crossTabMessagingWorks(page)),
		"this engine does not deliver BroadcastChannel across pages",
	);
	const otherAccount = uniqueAccountId("ui-b");
	await provisionAccount(origin, otherAccount);
	await sendAccountRpc(origin, accountId, "family.create", {
		familyId: "alt-family",
		name: "Alt family",
	});
	const patA = await patFor(origin, accountId);
	const patB = await patFor(origin, otherAccount);

	const loginAs = async (pat: string) => {
		const res = await page
			.context()
			.request.post(`${origin}/auth/token-login`, {
				headers: { Authorization: `Bearer ${pat}` },
			});
		expect(res.ok()).toBe(true);
	};

	// Tab A signs in as account A and holds its token in memory.
	await loginAs(patA);
	await page.goto("/settings/family");
	await expect(page.getByText("Alt family")).toBeVisible();
	if (onReady) await onReady();

	// Tab B signs in as account B in the same browser. Its boot rotates and
	// announces B's token to every tab.
	await loginAs(patB);
	const tabB = await page.context().newPage();
	await tabB.goto("/settings/security");
	await expect(
		tabB
			.getByText(`member in ${otherAccount}`)
			.or(tabB.getByText(otherAccount)),
	).toBeVisible();

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
	expect(body.principal?.accountId).toBe(accountId);
	await independent.dispose();
	await tabB.close();
}

/** Signing out one session leaves another account's sign-in in the same browser alone. */
export async function crossTabSignoutIsolationScenario(
	page: Page,
	accountId: string,
	origin: string,
	onReady?: () => Promise<void>,
): Promise<void> {
	test.skip(
		!(await webLocksSerialize(page)),
		"this engine's navigator.locks does not serialize, so two tabs refreshing one cookie can revoke each other",
	);
	const otherAccount = uniqueAccountId("ui-b");
	await provisionAccount(origin, otherAccount);
	const patA = await patFor(origin, accountId);
	const patB = await patFor(origin, otherAccount);
	const loginAs = async (pat: string) => {
		const res = await page
			.context()
			.request.post(`${origin}/auth/token-login`, {
				headers: { Authorization: `Bearer ${pat}` },
			});
		expect(res.ok()).toBe(true);
	};

	await loginAs(patA);
	await page.goto("/settings/security");
	await expect(page.getByText("Signed in as")).toBeVisible();
	if (onReady) await onReady();

	// Another sign-in (account B) takes over the browser's refresh cookie.
	await loginAs(patB);
	const tabB = await page.context().newPage();
	await tabB.goto("/settings/security");
	await expect(tabB.getByText(otherAccount)).toBeVisible();

	// Tab A signs out its own session. Account B must stay signed in.
	await clickByRole(page, "button", "Sign out");
	await page.waitForURL("**/");
	await tabB.reload();
	await expect(tabB.getByText(otherAccount)).toBeVisible();
	await tabB.close();
}
