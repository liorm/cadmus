import type { Page } from "@playwright/test";
import { clickByRole, fillByLabel } from "./actions.ts";
import {
	allowSlowTest,
	enableAdminMode,
	expectAdminModeOn,
	signInInvitedMember,
	uniqueEmail,
	uniqueLabel,
} from "./dev-session.ts";
import { expect } from "./fixtures.ts";

async function turnOnAdminMode(page: Page): Promise<void> {
	await page.goto("/settings/security");
	await enableAdminMode(page);
}

/** Account-admin invites someone. The invite is still there after a reload. */
export async function accountMembersScenario(
	page: Page,
	_accountId: string,
	baseURL: string,
	shot: (name: string) => Promise<void>,
): Promise<void> {
	const tenant = await signInInvitedMember(
		page.context().request,
		baseURL,
		"account-admin",
	);
	await turnOnAdminMode(page);
	await page.goto("/settings/account");
	await expect(page.getByLabel("Account name")).toHaveValue(tenant.accountName);
	const email = uniqueEmail("invite");
	await expect(
		page.getByRole("textbox", { name: "Invite email" }),
	).toBeEnabled();
	await fillByLabel(page, "Invite email", email);
	await clickByRole(page, "button", "Send invite");
	const invite = page.getByRole("region", { name: "Invites" });
	await expect(
		invite.getByRole("button", { name: `Revoke invite ${email}` }),
	).toBeVisible();
	await shot("invited");
	await page.reload();
	await expectAdminModeOn(page);
	await expect(page.getByLabel("Account name")).toHaveValue(tenant.accountName);
	await expect(
		invite.getByRole("button", { name: `Revoke invite ${email}` }),
	).toBeVisible();
	await clickByRole(page, "button", `Revoke invite ${email}`);
	await expect(page.getByText("No pending invites.")).toBeVisible();
	await page.reload();
	await expect(page.getByText("No pending invites.")).toBeVisible();
	await expect(invite.getByText(email)).toHaveCount(0);
}

/** A plain user sees no member controls and cannot rename the account. */
export async function accountNonAdminScenario(
	page: Page,
	_accountId: string,
	baseURL: string,
): Promise<void> {
	await signInInvitedMember(page.context().request, baseURL, "user");
	await page.goto("/settings/account");
	await expect(
		page.getByText("Only account admins in admin mode can change members."),
	).toBeVisible();
	await expect(page.getByLabel("Account name")).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Save account" }),
	).toBeDisabled();
	await expect(page.getByText("Admin mode", { exact: true })).toHaveCount(0);
	await page.reload();
	await expect(page.getByLabel("Account name")).toBeDisabled();
	await expect(
		page.getByText("Only account admins in admin mode can change members."),
	).toBeVisible();
}

/** A rename without admin mode does not stick. With admin mode, it survives reload. */
export async function accountSaveScenario(
	page: Page,
	_accountId: string,
	baseURL: string,
): Promise<void> {
	allowSlowTest();
	const tenant = await signInInvitedMember(
		page.context().request,
		baseURL,
		"account-admin",
	);
	const renamed = uniqueLabel("Renamed");
	await page.goto("/settings/account");
	await expect(page.getByLabel("Account name")).toHaveValue(tenant.accountName);
	await fillByLabel(page, "Account name", renamed);
	await clickByRole(page, "button", "Save account");
	await expect(
		page.getByText("'account.update' needs admin mode"),
	).toBeVisible();
	await expect(
		page.getByRole("button", { name: "Turn on admin mode" }),
	).toBeVisible();
	await page.reload();
	await expect(page.getByLabel("Account name")).toHaveValue(tenant.accountName);

	await turnOnAdminMode(page);
	await page.goto("/settings/account");
	await fillByLabel(page, "Account name", renamed);
	await clickByRole(page, "button", "Save account");
	await expect(page.getByLabel("Account name")).toHaveValue(renamed);
	await page.reload();
	await expectAdminModeOn(page);
	await expect(page.getByLabel("Account name")).toHaveValue(renamed);
}

/**
 * A refused save keeps the admin-mode action on screen through another refused
 * member action. Turning it on, then saving, survives a reload.
 */
export async function accountHelpStickyScenario(
	page: Page,
	_accountId: string,
	baseURL: string,
): Promise<void> {
	allowSlowTest();
	const tenant = await signInInvitedMember(
		page.context().request,
		baseURL,
		"account-admin",
	);
	await page.goto("/settings/account");
	const renamed = uniqueLabel("Sticky");
	await fillByLabel(page, "Account name", renamed);
	await clickByRole(page, "button", "Save account");
	await expect(
		page.getByRole("button", { name: "Turn on admin mode" }),
	).toBeVisible();
	const invites = page.getByRole("region", { name: "Invites" });
	await expect(
		invites.getByRole("textbox", { name: "Invite email" }),
	).toBeDisabled();
	await expect(
		invites.getByRole("button", { name: "Send invite" }),
	).toBeDisabled();
	await expect(invites.getByRole("alert")).toContainText("admin mode");
	await expect(
		page.getByRole("button", { name: "Turn on admin mode" }),
	).toBeVisible();

	await turnOnAdminMode(page);
	await page.goto("/settings/account");
	await fillByLabel(page, "Account name", renamed);
	await clickByRole(page, "button", "Save account");
	await page.reload();
	await expect(page.getByLabel("Account name")).toHaveValue(renamed);
	await expect(page.getByLabel("Account name")).not.toHaveValue(
		tenant.accountName,
	);
}

/** The invite that created the admin is in the audit log, still there after reload. */
export async function accountAuditScenario(
	page: Page,
	_accountId: string,
	baseURL: string,
): Promise<void> {
	allowSlowTest();
	await signInInvitedMember(page.context().request, baseURL, "account-admin");
	await turnOnAdminMode(page);
	await page.goto("/settings/account");
	const log = page.getByRole("region", { name: "Audit log" });
	const invites = log.getByText("member.invite", { exact: true });
	await expect(invites.first()).toBeVisible();
	const email = uniqueEmail("audit");
	await fillByLabel(page, "Invite email", email);
	await clickByRole(page, "button", "Send invite");
	await expect(
		page.getByRole("button", { name: `Revoke invite ${email}` }),
	).toBeVisible();
	// The audit list loads with the page, so the new row is there after reload.
	await page.reload();
	await expectAdminModeOn(page);
	await expect(invites.first()).toBeVisible();
	await expect(log.getByText(email).first()).toBeVisible();
	await expect(
		page.getByRole("button", { name: `Revoke invite ${email}` }),
	).toBeVisible();
}

/** A user sees no audit log. */
export async function accountAuditDeniedScenario(
	page: Page,
	_accountId: string,
	baseURL: string,
): Promise<void> {
	allowSlowTest();
	await signInInvitedMember(page.context().request, baseURL, "user");
	await page.goto("/settings/account");
	await expect(
		page.getByText("Only account admins in admin mode can change members."),
	).toBeVisible();
	await expect(page.getByRole("region", { name: "Audit log" })).toHaveCount(0);
	await page.reload();
	await expect(
		page.getByText("Only account admins in admin mode can change members."),
	).toBeVisible();
	await expect(page.getByRole("region", { name: "Audit log" })).toHaveCount(0);
}
