import type { Page } from "@playwright/test";
import { clickByRole } from "./actions.ts";
import { enableAdminMode, loginDevPassword } from "./dev-session.ts";
import { expect } from "./fixtures.ts";
import { signInWithToken } from "./system-console.ts";

export async function tokenSessionNoAdminModeScenario(
	page: Page,
	accountId: string,
	origin: string,
	onReady?: () => Promise<void>,
): Promise<void> {
	await signInWithToken(page, origin, accountId);
	await page.goto("/settings/security");
	if (onReady) await onReady();
	await expect(page.getByText("Signed in as")).toBeVisible();
	await expect(page.getByText("Admin mode", { exact: true })).toHaveCount(0);
	await page.reload();
	await expect(page.getByText("Admin mode", { exact: true })).toHaveCount(0);
}

export async function adminModeCountdownAndLeaveScenario(
	page: Page,
	origin: string,
	onReady?: () => Promise<void>,
): Promise<void> {
	await loginDevPassword(page.context().request, origin);
	await page.goto("/settings/security");
	if (onReady) await onReady();
	await expect(page.getByText("Admin mode", { exact: true })).toBeVisible();
	await expect(page.getByText(/^Off\./)).toBeVisible({ timeout: 15_000 });
	await enableAdminMode(page);
	await expect(page.getByText(/On, ends in 1[45]:\d\d/)).toBeVisible();
	await page.reload();
	await expect(page.getByText(/On, ends in 1[45]:\d\d/)).toBeVisible();
	await clickByRole(page, "button", "Leave admin mode");
	await expect(page.getByText(/^Off\./)).toBeVisible({ timeout: 15_000 });
	await page.reload();
	await expect(page.getByText(/^Off\./)).toBeVisible({ timeout: 15_000 });
	await expect(
		page.getByRole("button", { name: "Turn on admin mode" }),
	).toBeVisible();
}

export async function adminModeBannerAcrossScreensScenario(
	page: Page,
	origin: string,
	onReady?: () => Promise<void>,
): Promise<void> {
	await loginDevPassword(page.context().request, origin);
	await page.goto("/settings/security");
	const banner = page.getByRole("status", { name: "Admin mode" });
	await expect(banner).toHaveCount(0);
	await enableAdminMode(page);
	await expect(banner).toContainText(/Admin mode on.*ends in/);
	await page.goto("/");
	if (onReady) await onReady();
	await expect(banner).toContainText(/Admin mode on.*ends in/);
	await page.reload();
	await expect(banner).toContainText(/Admin mode on.*ends in/);
	await clickByRole(page, "button", "Leave", { within: banner });
	await expect(banner).toHaveCount(0);
	await page.goto("/settings/security");
	await expect(page.getByText(/^Off\./)).toBeVisible({ timeout: 15_000 });
	await page.reload();
	await expect(page.getByText(/^Off\./)).toBeVisible({ timeout: 15_000 });
}
