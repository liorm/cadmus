import {
	accountAuditDeniedScenario,
	accountAuditScenario,
} from "../support/account-admin.ts";
import { test } from "../support/fixtures.ts";

test.use({ signIn: "none" });

test("an account admin sees the invite in the audit log after a reload (flows)", async ({
	page,
	accountId,
	baseURL,
}) => {
	await accountAuditScenario(
		page,
		accountId,
		baseURL ?? "http://127.0.0.1:8799",
	);
});

test("a plain user does not get the audit log (flows)", async ({
	page,
	accountId,
	baseURL,
}) => {
	await accountAuditDeniedScenario(
		page,
		accountId,
		baseURL ?? "http://127.0.0.1:8799",
	);
});
