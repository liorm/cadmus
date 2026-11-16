import { accountHelpStickyScenario } from "../support/account-admin.ts";
import { test } from "../support/fixtures.ts";

test.use({ signIn: "none" });

test("a refused save keeps admin mode recovery through a refused invite (desktop)", async ({
	page,
	accountId,
	baseURL,
}) => {
	await accountHelpStickyScenario(
		page,
		accountId,
		baseURL ?? "http://127.0.0.1:8799",
	);
});
