import {
	accountMembersScenario,
	accountNonAdminScenario,
} from "../support/account-admin.ts";
import { expect, test } from "../support/fixtures.ts";

// Signs in through the dev-password helper. No master dev config is seeded.
test.use({ signIn: "none" });

test("an account admin manages members behind admin mode (desktop)", async ({
	page,
	accountId,
	baseURL,
}, testInfo) => {
	await accountMembersScenario(
		page,
		accountId,
		baseURL ?? "http://127.0.0.1:8799",
		async (name) => {
			await page.screenshot({
				path: testInfo.outputPath(`account-admin-desktop-${name}.png`),
			});
		},
	);
	await expect(
		page.getByRole("banner", { name: "Cadmus Cockpit" }),
	).toBeVisible();
});

test("a plain user keeps only what the server allows on members (desktop)", async ({
	page,
	accountId,
	baseURL,
}) => {
	await accountNonAdminScenario(
		page,
		accountId,
		baseURL ?? "http://127.0.0.1:8799",
	);
});
