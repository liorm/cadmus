import type { Page, TestInfo } from "@playwright/test";
import { expect } from "./fixtures.ts";
import { signInWithToken } from "./system-console.ts";

/**
 * A token sign-in without the grants the account page reads is refused by the
 * real server. The page says so, offers no Retry, keeps every control
 * disabled, and a programmatic submit sends no account.update call.
 */
export async function refusedAccountScenario(
	page: Page,
	accountId: string,
	origin: string,
	testInfo: TestInfo,
	onReady?: () => Promise<void>,
): Promise<void> {
	await signInWithToken(page, origin, accountId);
	const writes: string[] = [];
	page.on("request", (req) => {
		if (
			req.method() === "POST" &&
			/\/api\/account\/(update|members\/)/.test(req.url())
		)
			writes.push(req.url());
	});
	await page.goto("/settings/account");
	if (onReady) await onReady();
	const alert = page.getByRole("alert").filter({
		hasText: "Not available for this sign-in",
	});
	await expect(alert).toBeVisible();
	await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);
	await expect(page.getByLabel("Account name")).toBeDisabled();
	await expect(
		page.getByRole("button", { name: "Save account" }),
	).toBeDisabled();
	const controls = page.locator(
		"main form button, main form input, main form select",
	);
	const total = await controls.count();
	expect(total).toBeGreaterThan(0);
	for (let i = 0; i < total; i++) await expect(controls.nth(i)).toBeDisabled();
	await page.evaluate(() => {
		for (const f of document.querySelectorAll("main form"))
			(f as HTMLFormElement).requestSubmit();
	});
	await page.waitForTimeout(300);
	expect(writes).toEqual([]);
	await page.screenshot({ path: testInfo.outputPath("refused-account.png") });
}
