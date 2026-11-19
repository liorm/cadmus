import { accountNonAdminScenario } from "../support/account-admin.ts";
import { test } from "../support/fixtures.ts";

test.use({ signIn: "none" });

test("a plain user cannot rename the account (flows)", async ({
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
