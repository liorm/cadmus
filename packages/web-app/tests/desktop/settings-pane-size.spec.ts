import { expect, test } from "../support/fixtures.ts";

/**
 * Settings pages open in the desktop stage pane. The pane must hand them its
 * full height, so the scrolling area fills the pane instead of collapsing to
 * the height of its first lines (a regression only visible in pixels).
 */
const PAGES: [string, string][] = [
	["/settings", "settings"],
	["/settings/account", "account"],
	["/settings/tokens", "tokens"],
	["/settings/family", "family"],
	["/settings/providers", "providers"],
	["/settings/tools", "tools"],
	["/settings/security", "security"],
];

for (const [path, name] of PAGES) {
	test(`the ${name} settings page fills the stage pane (desktop)`, async ({
		page,
	}, testInfo) => {
		await page.goto(path);
		await expect(page.locator("main h1, header h1").first()).toBeVisible();
		const stage = page.locator("main").last();
		await expect(stage).toBeVisible();
		await expect
			.poll(async () => (await stage.boundingBox())?.height ?? 0)
			.toBeGreaterThan(600);
		await page.screenshot({
			path: testInfo.outputPath(`settings-pane-${name}.png`),
		});
	});
}
