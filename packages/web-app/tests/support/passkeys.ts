import type { Page } from "@playwright/test";
import { clickByRole } from "./actions.ts";
import {
	enableAdminMode,
	expectAdminModeOn,
	loginDevPassword,
} from "./dev-session.ts";
import { expect } from "./fixtures.ts";

export async function passkeysAdminModeScenario(
	page: Page,
	origin: string,
	onReady?: () => Promise<void>,
): Promise<void> {
	await loginDevPassword(page.context().request, origin);
	await page.goto("/settings/security");
	if (onReady) await onReady();
	await expect(page.getByText("Signed in as")).toBeVisible();
	const add = page.getByRole("button", { name: "Add a passkey" });
	const unsupported = page.getByText("This browser cannot use passkeys.");
	await expect(add).toBeVisible();
	if (await add.isEnabled()) {
		await expect(unsupported).toHaveCount(0);
	} else {
		await expect(unsupported).toBeVisible();
	}
	await expect(page.getByText(/^Off\./)).toBeVisible({ timeout: 15_000 });
	await enableAdminMode(page);
	await page.reload();
	await expectAdminModeOn(page);
	if (onReady) await onReady();
	await clickByRole(page, "button", "Leave admin mode");
	await expect(page.getByText(/^Off\./)).toBeVisible({ timeout: 15_000 });
	await page.reload();
	await expect(page.getByText(/^Off\./)).toBeVisible({ timeout: 15_000 });
	await expect(
		page.getByRole("button", { name: "Turn on admin mode" }),
	).toBeVisible();
}
