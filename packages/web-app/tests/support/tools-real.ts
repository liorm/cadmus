import type { Locator, Page } from "@playwright/test";
import { clickByRole, fillByLabel } from "./actions.ts";
import {
	allowSlowTest,
	enableAdminMode,
	expectAdminModeOn,
	signInInvitedMember,
	uniqueLabel,
} from "./dev-session.ts";
import { expect, USER_ROLE_GRANTS } from "./fixtures.ts";
import { signInWithToken } from "./system-console.ts";

const BLOCKED =
	"Changing tools environments needs an account admin. Signed-in people also need admin mode; API tokens need matching grants.";

async function labeled(page: Page, label: string): Promise<boolean> {
	const rows = page.locator("li");
	const count = await rows.count();
	for (let i = 0; i < count; i++) {
		const input = rows.nth(i).locator('input[aria-label^="Label "]');
		if ((await input.count()) === 0) continue;
		if ((await input.inputValue()) === label) return true;
	}
	return false;
}

async function rowForLabel(page: Page, label: string): Promise<Locator> {
	const rows = page.locator("li");
	await expect.poll(() => labeled(page, label)).toBe(true);
	const count = await rows.count();
	for (let i = 0; i < count; i++) {
		const row = rows.nth(i);
		const input = row.locator('input[aria-label^="Label "]');
		if ((await input.count()) === 0) continue;
		if ((await input.inputValue()) === label) return row;
	}
	throw new Error(`no tools env row for ${label}`);
}

/** A user-role member sees the seeded env and cannot change it. */
export async function toolsUserBlockedScenario(
	page: Page,
	_accountId: string,
	baseURL: string,
): Promise<void> {
	allowSlowTest();
	await signInInvitedMember(page.context().request, baseURL, "user");
	await page.goto("/settings/tools");
	await expect(page.getByText("jb_default")).toBeVisible();
	await expect(page.getByText(BLOCKED)).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Create just-bash env" }),
	).toBeDisabled();
	await page.reload();
	await expect(page.getByText("jb_default")).toBeVisible();
	await expect(page.getByText(BLOCKED)).toBeVisible();
}

/**
 * The fixture account's token session keeps the role of an account admin, so
 * the controls stay. The worker refuses the missing grant. Admin mode is not
 * offered to a token.
 */
export async function toolsTokenRefusalScenario(
	page: Page,
	accountId: string,
	baseURL: string,
): Promise<void> {
	allowSlowTest();
	await signInWithToken(page, baseURL, accountId, [...USER_ROLE_GRANTS]);
	const label = uniqueLabel("denied");
	await page.goto("/settings/tools");
	await expect(
		page.getByRole("button", { name: "Create just-bash env" }),
	).toBeEnabled();
	await expect(
		page.getByRole("button", { name: "Turn on admin mode" }),
	).toHaveCount(0);
	await fillByLabel(page, "just-bash label", label);
	await clickByRole(page, "button", "Create just-bash env");
	await expect(page.getByText(/does not hold grant/)).toBeVisible();
	await page.reload();
	await expect(page.getByText(label)).toHaveCount(0);
}

/** Create, rename, and delete a just-bash env. Each step survives a reload. */
export async function toolsJustBashScenario(
	page: Page,
	_accountId: string,
	baseURL: string,
): Promise<void> {
	allowSlowTest();
	await signInInvitedMember(page.context().request, baseURL, "account-admin");
	const label = uniqueLabel("bash");
	await page.goto("/settings/tools");
	await fillByLabel(page, "just-bash label", label);
	await clickByRole(page, "button", "Create just-bash env");
	await expect(
		page.getByText("'account.toolsEnvs.create' needs admin mode"),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Turn on admin mode" }),
	).toBeVisible();
	await clickByRole(page, "button", "Create just-bash env");
	await expect(
		page.getByRole("button", { name: "Turn on admin mode" }),
	).toBeVisible();

	await enableAdminMode(page);
	await page.goto("/settings/tools");
	await fillByLabel(page, "just-bash label", label);
	await clickByRole(page, "button", "Create just-bash env");
	await rowForLabel(page, label);
	await page.reload();
	await expectAdminModeOn(page);
	const kept = await rowForLabel(page, label);

	const renamed = uniqueLabel("renamed");
	const envId = (await kept.locator("div").first().innerText()).trim();
	await fillByLabel(page, `Label ${envId}`, renamed);
	await clickByRole(page, "button", "Save", { within: kept, exact: true });
	await rowForLabel(page, renamed);
	await page.reload();
	const renamedRow = await rowForLabel(page, renamed);

	await clickByRole(page, "button", "Delete", {
		within: renamedRow,
		exact: true,
	});
	await expect.poll(() => labeled(page, renamed)).toBe(false);
	await page.reload();
	await expect.poll(() => labeled(page, renamed)).toBe(false);
}

/** A daemon env returns a real pairing command, and the env is still listed. */
export async function toolsDaemonScenario(
	page: Page,
	_accountId: string,
	baseURL: string,
): Promise<void> {
	allowSlowTest();
	await signInInvitedMember(page.context().request, baseURL, "account-admin");
	await page.goto("/settings/security");
	await enableAdminMode(page);
	const label = uniqueLabel("daemon");
	await page.goto("/settings/tools");
	await fillByLabel(page, "Daemon label", label);
	await clickByRole(page, "button", "Create and pair daemon");
	await expect(page.getByLabel("Pairing command")).toContainText(
		"cadmus-daemon pair",
	);
	await rowForLabel(page, label);
	await page.reload();
	await rowForLabel(page, label);
	await expect(page.getByLabel("Pairing command")).toHaveCount(0);
}
