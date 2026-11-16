import { accountSaveScenario } from "../support/account-admin.ts";
import { expect, test } from "../support/fixtures.ts";

test.use({ signIn: "none" });

test("a rename applies once admin mode is on and stays after reload (desktop)", async ({
	page,
	accountId,
	baseURL,
}) => {
	await accountSaveScenario(
		page,
		accountId,
		baseURL ?? "http://127.0.0.1:8799",
	);
	await expect(
		page.getByRole("banner", { name: "Cadmus Cockpit" }),
	).toBeVisible();
});
