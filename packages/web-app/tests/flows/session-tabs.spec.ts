import { test } from "../support/fixtures.ts";
import {
	crossTabAccountIsolationScenario,
	crossTabSignoutIsolationScenario,
} from "../support/session-tabs.ts";

// Signs in on its own (or not at all); no master dev config is seeded.
test.use({ signIn: "none" });

test.describe.configure({ mode: "parallel" });

test("a tab never takes the credential of a different account's session (flows)", async ({
	page,
	playwright,
	accountId,
	baseURL,
}) => {
	await crossTabAccountIsolationScenario(
		page,
		playwright,
		accountId,
		baseURL ?? "http://127.0.0.1:8799",
	);
});

test("signing out one session leaves another sign-in in the same browser alone (flows)", async ({
	page,
	accountId,
	baseURL,
}) => {
	await crossTabSignoutIsolationScenario(
		page,
		accountId,
		baseURL ?? "http://127.0.0.1:8799",
	);
});
