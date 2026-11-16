import { accountNonAdminScenario } from "../support/account-admin.ts";
import { test } from "../support/fixtures.ts";

test.use({ signIn: "none" });

test("a plain user cannot rename the account (desktop)", async ({
	page,
	accountId,
	baseURL,
}) => {
	await accountNonAdminScenario(
		page,
		accountId,
		baseURL ?? "http://127.0.0.1:8799",
		{ role: "user" },
	);
});

test("a token session cannot save an account rename (desktop)", async ({
	page,
	accountId,
	baseURL,
}) => {
	await accountNonAdminScenario(
		page,
		accountId,
		baseURL ?? "http://127.0.0.1:8799",
		{ role: "account-admin", viaToken: true },
	);
});
