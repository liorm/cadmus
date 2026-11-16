import type { Page } from "@playwright/test";
import { clickByRole } from "./actions.ts";
import {
	allowSlowTest,
	chooseAccount,
	elevate,
	enableAdminMode,
	expectAdminModeOn,
	loginDevPassword,
	loginDevPasswordIsolated,
	sessionCommand,
	uniqueEmail,
	uniqueLabel,
} from "./dev-session.ts";
import { expect } from "./fixtures.ts";

interface AccountRef {
	id: string;
	name: string;
}

interface TwoAccounts {
	home: AccountRef;
	other: AccountRef;
	bossToken: string;
}

/** One person, two accounts. The browser cookie is theirs; boss stays elevated. */
async function signInTwoAccounts(
	page: Page,
	origin: string,
): Promise<TwoAccounts> {
	const request = page.context().request;
	const boss = await loginDevPassword(request, origin);
	await elevate(request, origin, boss.accessToken);
	const email = uniqueEmail("switch");
	const accounts: AccountRef[] = [];
	for (const n of [1, 2]) {
		const name = uniqueLabel(`Acct${n}`);
		const created = await sessionCommand<{ account: { id: string } }>(
			request,
			origin,
			boss.accessToken,
			"system.accounts.create",
			{ name },
		);
		await sessionCommand(
			request,
			origin,
			boss.accessToken,
			"system.members.invite",
			{ accountId: created.account.id, email, role: "account-admin" },
		);
		accounts.push({ id: created.account.id, name });
	}
	const octet = crypto.getRandomValues(new Uint8Array(2));
	await loginDevPasswordIsolated(origin, email, `10.9.${octet[0]}.${octet[1]}`);
	const session = await loginDevPassword(request, origin, email);
	const who = await sessionCommand<{ principal: { accountId: string } }>(
		request,
		origin,
		session.accessToken,
		"auth.whoami",
	);
	const home = accounts.find((a) => a.id === who.principal.accountId);
	const other = accounts.find((a) => a.id !== who.principal.accountId);
	if (!home || !other) {
		throw new Error("sign-in did not land on one of the two invited accounts");
	}
	return { home, other, bossToken: boss.accessToken };
}

/**
 * Admin mode stays in the account where it was turned on. Stored keys follow
 * the account the tab is acting in.
 */
export async function accountSwitcherScenario(
	page: Page,
	_accountId: string,
	baseURL: string,
	shot: (name: string) => Promise<void>,
): Promise<void> {
	allowSlowTest();
	const storageKeys: string[] = [];
	await page.exposeFunction("__storageLog", (key: string) => {
		storageKeys.push(key);
	});
	await page.addInitScript(() => {
		const watched =
			/^cadmus\.(lastSeen|group\.collapsed|lastBotId|failedTurns)/;
		const log = (window as unknown as { __storageLog: (k: string) => void })
			.__storageLog;
		for (const name of ["getItem", "setItem"] as const) {
			const orig = Storage.prototype[name] as (...a: string[]) => unknown;
			Storage.prototype[name] = function (this: Storage, ...args: string[]) {
				if (this === window.localStorage && watched.test(args[0] ?? ""))
					void log(args[0] ?? "");
				return orig.apply(this, args);
			} as never;
		}
	});
	const { home, other } = await signInTwoAccounts(page, baseURL);
	const account = page.getByRole("combobox", { name: "Account", exact: true });
	// The switcher is on the account page. Admin mode is turned on from security.
	await page.goto("/settings/account");
	await expect(account).toHaveValue(home.id);
	await page.goto("/settings/security");
	await enableAdminMode(page);
	await shot("home");
	await page.goto("/settings/account");
	await expect(account).toHaveValue(home.id);
	await expectAdminModeOn(page);

	const keysAtSwitch = storageKeys.length;
	expect(storageKeys.every((key) => key.endsWith(`@${home.id}`))).toBe(true);

	await chooseAccount(page, other.id);
	await expect(page.getByText(/Admin mode on/)).toHaveCount(0);
	await page.reload();
	await expect(account).toHaveValue(other.id);
	await expect(page.getByText(/Admin mode on/)).toHaveCount(0);
	await page.goto("/settings/security");
	await expect(page.getByText(`${other.id}`)).toBeVisible();
	await expect(page.getByText(/^Off\./)).toBeVisible();
	await page.reload();
	await expect(page.getByText(/^Off\./)).toBeVisible();
	const otherKeys = storageKeys.slice(keysAtSwitch);
	expect(otherKeys.some((key) => key.endsWith(`@${other.id}`))).toBe(true);
	expect(
		otherKeys.every(
			(key) => key.endsWith(`@${other.id}`) || key.endsWith(`@${home.id}`),
		),
	).toBe(true);
	await shot("other");

	await page.goto("/settings/account");
	await chooseAccount(page, home.id);
	await expectAdminModeOn(page);
	await page.reload();
	await expect(account).toHaveValue(home.id);
	await expectAdminModeOn(page);
	await shot("back-home");
}

/**
 * A suspended remembered account sends the tab home with a notice. An active
 * remembered account stays selected and says nothing.
 */
export async function rememberedAccountScenario(
	page: Page,
	mode: "suspended" | "kept",
	_accountId: string,
	baseURL: string,
	shot: (name: string) => Promise<void> = async () => {},
): Promise<void> {
	allowSlowTest();
	const { home, other, bossToken } = await signInTwoAccounts(page, baseURL);
	const account = page.getByRole("combobox", { name: "Account", exact: true });
	await page.goto("/settings/account");
	await chooseAccount(page, other.id);
	await shot("selected");
	if (mode === "suspended") {
		await sessionCommand(
			page.context().request,
			baseURL,
			bossToken,
			"system.accounts.suspend",
			{ accountId: other.id },
		);
		await page.reload();
		await expect(page.getByLabel("Account changed")).toContainText(
			"no longer available",
		);
		// A suspended account drops out of the membership list, so the switcher
		// hides when only the home account remains.
		await expect(account).toHaveCount(0);
		await expect(page.getByLabel("Account name")).toHaveValue(home.name);
		await page.reload();
		await expect(page.getByLabel("Account name")).toHaveValue(home.name);
		await shot("home");
		return;
	}
	await page.reload();
	await expect(page.getByLabel("Account changed")).toHaveCount(0);
	await expect(account).toHaveValue(other.id);
	await shot("kept");
}

/** Two tabs of one session each show only their own account's admin mode. */
export async function twoTabsScenario(
	page: Page,
	_accountId: string,
	baseURL: string,
): Promise<void> {
	allowSlowTest();
	const { home, other } = await signInTwoAccounts(page, baseURL);
	await page.goto("/settings/security");
	await enableAdminMode(page);
	await expectAdminModeOn(page);

	const tab2 = await page.context().newPage();
	await tab2.addInitScript((id) => {
		sessionStorage.setItem("cadmus-selected-account", id);
	}, other.id);
	await tab2.goto("/settings/account");
	await expect(
		tab2.getByRole("combobox", { name: "Account", exact: true }),
	).toHaveValue(other.id);
	await expect(tab2.getByText(/Admin mode on/)).toHaveCount(0);
	await tab2.goto("/settings/security");
	await expect(tab2.getByText(/^Off\./)).toBeVisible();

	await page.evaluate(() => window.dispatchEvent(new Event("focus")));
	await expectAdminModeOn(page);
	await expect(tab2.getByText(/Admin mode on/)).toHaveCount(0);
	await tab2.close();
	expect(home.id).not.toBe(other.id);
}

/** Turning admin mode on in the other account needs a passkey, and stays off. */
export async function noPasskeyBetaScenario(
	page: Page,
	_accountId: string,
	baseURL: string,
	shot: (name: string) => Promise<void> = async () => {},
): Promise<void> {
	allowSlowTest();
	const { other } = await signInTwoAccounts(page, baseURL);
	await page.goto("/settings/account");
	await chooseAccount(page, other.id);
	await page.goto("/settings/security");
	await expect(page.getByText(/^Off\./)).toBeVisible();
	await clickByRole(page, "button", "Turn on admin mode");
	await expect(page.getByRole("alert").first()).toContainText("passkey proof");
	await expect(page.getByText(/^Off\./)).toBeVisible();
	await page.reload();
	await expect(page.getByText(other.id)).toBeVisible();
	await expect(page.getByText(/^Off\./)).toBeVisible();
	await shot("refused");
}
