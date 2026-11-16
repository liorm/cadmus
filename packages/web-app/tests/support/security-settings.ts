import type { Page } from "@playwright/test";
import { clickByRole } from "./actions.ts";
import { loginDevPassword } from "./dev-session.ts";
import { expect } from "./fixtures.ts";

export async function securitySettingsGoogleSignInScenario(
	page: Page,
	options?: { viaSettingsLink?: boolean; onReady?: () => Promise<void> },
): Promise<void> {
	if (options?.viaSettingsLink) {
		await page.goto("/settings");
		await clickByRole(page, "link", "Sign-in and sessions");
	} else {
		await page.goto("/settings/security");
	}
	if (options?.onReady) await options.onReady();
	await expect(
		page.getByText("You are using the shared access key"),
	).toBeVisible();
	await expect(
		page.getByRole("link", { name: "Sign in with Google" }),
	).toHaveAttribute("href", "/auth/login/google");
}

export async function securitySettingsDevPasswordReloadScenario(
	page: Page,
	origin: string,
	onReady?: () => Promise<void>,
): Promise<void> {
	await loginDevPassword(page.context().request, origin);
	await page.goto("/settings/security");
	if (onReady) await onReady();
	await expect(page.getByText("Signed in as")).toBeVisible();
	await expect(
		page.getByRole("link", { name: "Sign in with Google" }),
	).toHaveCount(0);
	await page.reload();
	await expect(page.getByText("Signed in as")).toBeVisible();
	if (onReady) await onReady();
}
