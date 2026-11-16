import type { Page } from "@playwright/test";
import { clickByRole, fillByLabel } from "./actions.ts";
import {
	allowSlowTest,
	enableAdminMode,
	expectAdminModeOn,
	signInInvitedMember,
	uniqueLabel,
} from "./dev-session.ts";
import { expect, USER_ROLE_GRANTS } from "./fixtures.ts";
import {
	expectNoHorizontalOverflow,
	signInWithToken,
} from "./system-console.ts";

async function scrollTop(page: Page) {
	await page.evaluate(() => {
		for (const el of document.querySelectorAll("*")) el.scrollTop = 0;
	});
}

/** An account admin mints a service token, and the row survives a reload. */
export async function tokensAdminScenario(
	page: Page,
	_accountId: string,
	baseURL: string,
	shot: (name: string) => Promise<void>,
): Promise<void> {
	allowSlowTest();
	await signInInvitedMember(page.context().request, baseURL, "account-admin");
	const label = uniqueLabel("ci");
	await page.goto("/settings/tokens");
	await expect(page.getByText("No tokens yet.")).toBeVisible();
	await expectNoHorizontalOverflow(page);
	await fillByLabel(page, "Token label", label);
	await clickByRole(page, "button", "Create token");
	await expect(page.getByRole("alert").first()).toContainText("admin mode");

	await enableAdminMode(page);
	await page.goto("/settings/tokens");
	await fillByLabel(page, "Token label", label);
	await clickByRole(page, "button", "Create token");
	const secret = page.getByLabel("New token secret");
	await expect(secret).toContainText("cad_svc_");
	await shot("secret");
	await clickByRole(page, "button", "I copied it");
	await expect(page.getByLabel("New token secret")).toHaveCount(0);
	const row = page.getByRole("listitem").filter({ hasText: label });
	await expect(row).toContainText("service");
	await page.reload();
	await expectAdminModeOn(page);
	await expect(row).toContainText("service");

	await clickByRole(page, "button", `Revoke token ${label}`);
	await expect(row).toContainText("revoked");
	await scrollTop(page);
	await shot("revoked");
	await page.reload();
	await expect(row).toContainText("revoked");
	await expectNoHorizontalOverflow(page);
}

/**
 * A plain user can mint a personal token. A token session cannot mint at all.
 * What was saved is still there after a reload.
 */
export async function tokensNonAdminScenario(
	page: Page,
	accountId: string,
	baseURL: string,
	who: { role: string; viaToken?: boolean },
	shot: (name: string) => Promise<void> = async () => {},
): Promise<void> {
	allowSlowTest();
	if (who.viaToken) {
		await signInWithToken(page, baseURL, accountId, [...USER_ROLE_GRANTS]);
		await page.goto("/settings/tokens");
		await expect(
			page.getByText("Token sessions cannot create tokens"),
		).toBeVisible();
		await expect(
			page.getByRole("button", { name: "Create token" }),
		).toHaveCount(0);
		await expect(page.getByText("Admin mode", { exact: true })).toHaveCount(0);
		await page.reload();
		await expect(
			page.getByRole("button", { name: "Create token" }),
		).toHaveCount(0);
		await shot("token-session");
		return;
	}
	await signInInvitedMember(page.context().request, baseURL, "user");
	const label = uniqueLabel("laptop");
	await page.goto("/settings/tokens");
	await expect(page.getByText("You can create personal tokens")).toBeVisible();
	await fillByLabel(page, "Token label", label);
	await clickByRole(page, "button", "Create token");
	await expect(page.getByLabel("New token secret")).toContainText("cad_pat_");
	await clickByRole(page, "button", "I copied it");
	const row = page.getByRole("listitem").filter({ hasText: label });
	await expect(row).toContainText("pat");
	await page.reload();
	await expect(row).toContainText("pat");
	await shot("pat");
	await clickByRole(page, "button", `Revoke token ${label}`);
	await expect(row).toContainText("revoked");
	await page.reload();
	await expect(row).toContainText("revoked");
}
