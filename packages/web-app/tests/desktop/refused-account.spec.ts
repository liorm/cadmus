import { expect, test } from "../support/fixtures.ts";
import { refusedAccountScenario } from "../support/refused-account.ts";

test("the account page explains a refused token sign-in and sends no change (desktop)", async ({
	page,
	accountId,
	baseURL,
}, testInfo) => {
	await refusedAccountScenario(
		page,
		accountId,
		baseURL ?? "http://127.0.0.1:8799",
		testInfo,
		async () => {
			await expect(
				page.getByRole("banner", { name: "Cadmus Cockpit" }),
			).toBeVisible();
		},
	);
});
