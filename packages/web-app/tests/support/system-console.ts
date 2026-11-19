import type { Page } from "@playwright/test";
import { clickByRole, fillByLabel } from "./actions.ts";
import {
	allowSlowTest,
	BOOTSTRAP_EMAIL,
	elevate,
	enableAdminMode,
	expectAdminModeOn,
	loginDevPassword,
	loginDevPasswordIsolated,
	sessionCommand,
	signInInvitedMember,
	uniqueEmail,
	uniqueLabel,
} from "./dev-session.ts";
import { expect } from "./fixtures.ts";

/**
 * Signs the browser in with dev-password. API tokens are gone, so this is a
 * session cookie, not a personal access token. `accountId` is the fixture
 * account the caller already provisioned; the password login is the session.
 */
export async function signInWithToken(
	page: Page,
	origin: string,
	accountId: string,
): Promise<void> {
	void accountId;
	await loginDevPassword(page.context().request, origin);
}

async function findAccountRow(page: Page, name: string) {
	const row = page.getByLabel(`Account ${name}`, { exact: true });
	const showMore = page.getByRole("button", { name: "Show more accounts" });
	const loading = page.getByRole("status", { name: "Loading accounts" });
	for (let pageIndex = 0; pageIndex < 20; pageIndex++) {
		await expect(loading).toHaveCount(0);
		if (await row.isVisible()) return row;
		// After an account mutation, accounts.retry() reloads page 1 in the
		// background while "Show more accounts" may already be visible on the
		// stale list; give page 1 a moment to land before paginating.
		if (pageIndex === 0) {
			await row.waitFor({ state: "visible", timeout: 5_000 }).catch(() => {});
			if (await row.isVisible()) return row;
		}
		// Wait for either the row or the pagination button after loading finishes.
		await expect(row.or(showMore).first()).toBeVisible();
		if (await row.isVisible()) return row;
		if (!(await showMore.isVisible())) break;
		await clickByRole(page, "button", "Show more accounts");
	}
	await expect(row).toBeVisible();
	return row;
}

export async function expectNoHorizontalOverflow(page: Page): Promise<void> {
	const overflow = await page.evaluate(
		() =>
			document.documentElement.scrollWidth >
			document.documentElement.clientWidth + 1,
	);
	expect(overflow).toBe(false);
}

/** Super-admin creates, suspends and resumes an account. State survives reload. */
export async function superAdminScenario(
	page: Page,
	_accountId: string,
	baseURL: string,
	shot: (name: string) => Promise<void>,
): Promise<void> {
	allowSlowTest();
	await loginDevPassword(page.context().request, baseURL);
	const name = uniqueLabel("Acme");
	await page.goto("/settings");
	await clickByRole(page, "link", "System console");
	await expect(page.getByRole("heading", { name: "Accounts" })).toBeVisible();
	await expectNoHorizontalOverflow(page);
	await shot("console");

	await fillByLabel(page, "New account name", name);
	await expect(page.getByLabel("New account name")).toHaveValue(name);
	await clickByRole(page, "button", "Create account");
	await expect(
		page.getByText("'system.accounts.create' needs admin mode"),
	).toBeVisible({ timeout: 20_000 });

	await page.goto("/settings/security");
	await enableAdminMode(page);
	await page.goto("/system");
	await fillByLabel(page, "New account name", name);
	await clickByRole(page, "button", "Create account");
	await expect(page.getByLabel("New account name")).toHaveValue("");
	const row = await findAccountRow(page, name);
	await expect(row.getByText(/^Active/)).toBeVisible();

	await page.reload();
	await expectAdminModeOn(page);
	await findAccountRow(page, name);
	await expect(row.getByText(/^Active/)).toBeVisible();

	await clickByRole(page, "button", "Suspend", { within: row });
	await clickByRole(page, "button", "Cancel", { within: row });
	await expect(row.getByText(/^Active/)).toBeVisible();
	await clickByRole(page, "button", "Suspend", { within: row });
	await clickByRole(page, "button", "Confirm suspend", { within: row });
	await expect(row.getByText(/Suspended/)).toBeVisible();
	await page.reload();
	await findAccountRow(page, name);
	await expect(row.getByText(/Suspended/)).toBeVisible();
	await clickByRole(page, "button", "Resume", { within: row });
	await expect(row.getByText(/^Active/)).toBeVisible();
	await page.reload();
	await findAccountRow(page, name);
	await expect(row.getByText(/^Active/)).toBeVisible();
	await expectNoHorizontalOverflow(page);
	await shot("resumed");
}

/**
 * The signed-in super-admin is a member of the tenant, next to someone else.
 * The page offers a passkey reset only for the other person.
 */
export async function selfResetScenario(
	page: Page,
	_accountId: string,
	baseURL: string,
): Promise<void> {
	allowSlowTest();
	const request = page.context().request;
	const boss = await loginDevPassword(request, baseURL);
	await elevate(request, baseURL, boss.accessToken);
	const name = uniqueLabel("Roster");
	const created = await sessionCommand<{ account: { id: string } }>(
		request,
		baseURL,
		boss.accessToken,
		"system.accounts.create",
		{ name },
	);
	const other = uniqueEmail("member");
	await sessionCommand(
		request,
		baseURL,
		boss.accessToken,
		"system.members.invite",
		{
			accountId: created.account.id,
			email: BOOTSTRAP_EMAIL,
			role: "account-admin",
		},
	);
	await sessionCommand(
		request,
		baseURL,
		boss.accessToken,
		"system.members.invite",
		{ accountId: created.account.id, email: other, role: "user" },
	);
	const octet = crypto.getRandomValues(new Uint8Array(2));
	await loginDevPasswordIsolated(
		baseURL,
		BOOTSTRAP_EMAIL,
		`10.7.${octet[0]}.${octet[1]}`,
	);
	await loginDevPasswordIsolated(
		baseURL,
		other,
		`10.6.${octet[0]}.${octet[1]}`,
	);
	await loginDevPassword(request, baseURL);

	await page.goto("/settings/security");
	await enableAdminMode(page);
	await page.goto("/system");
	const row = await findAccountRow(page, name);
	await clickByRole(page, "button", "Members", { within: row });
	await expect(row.getByText(BOOTSTRAP_EMAIL)).toBeVisible();
	await expect(row.getByText(other)).toBeVisible();
	await expect(
		row.getByRole("button", { name: "Reset passkeys in all accounts" }),
	).toHaveCount(1);
	await page.reload();
	await expectAdminModeOn(page);
	await findAccountRow(page, name);
	await clickByRole(page, "button", "Members", { within: row });
	await expect(row.getByText(other)).toBeVisible();
	await expect(
		row.getByRole("button", { name: "Reset passkeys in all accounts" }),
	).toHaveCount(1);
}

/** An account-admin session has no system console. */
export async function notSuperAdminScenario(
	page: Page,
	_accountId: string,
	baseURL: string,
): Promise<void> {
	await signInInvitedMember(page.context().request, baseURL, "account-admin");
	await page.goto("/settings");
	await expect(page.getByRole("link", { name: "System console" })).toHaveCount(
		0,
	);
	await page.goto("/system");
	await expect(page.getByRole("alert")).toContainText("only for super-admins");
	await expect(page.getByRole("heading", { name: "Accounts" })).toHaveCount(0);
}

/** Admin mode turned on through the page is still on after a reload, then off. */
export async function elevationFailureScenario(
	page: Page,
	_accountId: string,
	baseURL: string,
	shot: (name: string) => Promise<void>,
): Promise<void> {
	allowSlowTest();
	await loginDevPassword(page.context().request, baseURL);
	await page.goto("/settings/security");
	await expect(page.getByText(/^Off\./)).toBeVisible({ timeout: 15_000 });
	await enableAdminMode(page);
	await shot("admin-on");
	await page.reload();
	await expectAdminModeOn(page);
	await clickByRole(page, "button", "Leave admin mode");
	await expect(page.getByText(/^Off\./)).toBeVisible({ timeout: 15_000 });
	await page.reload();
	await expect(page.getByText(/^Off\./)).toBeVisible({ timeout: 15_000 });
	await expect(
		page.getByRole("button", { name: "Turn on admin mode" }),
	).toBeVisible();
}
