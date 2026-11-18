import type { Page } from "@playwright/test";
import { loginDevPassword } from "./dev-session.ts";
import { expect } from "./fixtures.ts";

export async function securitySettingsGoogleSignInScenario(
	page: Page,
	options?: { onReady?: () => Promise<void> },
): Promise<void> {
	await page.goto("/");
	if (options?.onReady) await options.onReady();
	const dialog = page.getByRole("dialog", { name: "Sign in to Cadmus" });
	await expect(dialog).toBeVisible();
	await expect(dialog.getByText("Sign-in is not enabled")).toHaveCount(0);
	await expect(
		dialog.getByRole("link", { name: "Sign in with Google" }),
	).toHaveAttribute("href", "/api/auth/login/google/start");
	await expect(dialog.getByLabel("Password")).toBeVisible();
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
