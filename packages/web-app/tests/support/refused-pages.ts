import type { Page, TestInfo } from "@playwright/test";
import { expect } from "./fixtures.ts";
import { signInWithToken } from "./system-console.ts";

/**
 * A token sign-in only holds the grants it was created with, so some settings
 * pages are refused by the server. The page says so plainly and does not offer
 * a Retry that cannot help. Real server refusals, no mocks.
 */
export const REFUSED_PAGES: [string, string][] = [
	["/settings/providers", "providers"],
	["/settings/tools", "tools"],
	["/settings/security", "security"],
];

export async function refusedPageScenario(
	page: Page,
	accountId: string,
	origin: string,
	path: string,
	name: string,
	testInfo: TestInfo,
	onReady?: () => Promise<void>,
): Promise<void> {
	await signInWithToken(page, origin, accountId);
	await page.goto(path);
	if (onReady) await onReady();
	const alert = page.getByRole("alert").filter({
		hasText: "Not available for this sign-in",
	});
	await expect(alert).toBeVisible();
	await expect(alert).toContainText("Server said:");
	await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
	if (name === "providers") {
		// Nothing to manage while refused: the key forms are not shown.
		await expect(page.getByRole("button", { name: "Save key" })).toHaveCount(0);
		await expect(page.getByLabel("API key").first()).toBeHidden();
	}
	if (name === "tools") {
		// Nothing on the page may mutate while refused: every control inside
		// the form area is disabled, none is merely dimmed.
		for (const control of [
			page.getByRole("button", { name: "Create just-bash env" }),
			page.getByRole("button", { name: "Create and pair daemon" }),
			page.getByLabel("just-bash label"),
		]) {
			await expect(control).toBeDisabled();
		}
		const controls = page.locator("form button, form input, form select");
		const total = await controls.count();
		expect(total).toBeGreaterThan(5);
		for (let i = 0; i < total; i++) {
			await expect(controls.nth(i)).toBeDisabled();
		}
	}
	await page.screenshot({
		path: testInfo.outputPath(`refused-${name}.png`),
	});
}
