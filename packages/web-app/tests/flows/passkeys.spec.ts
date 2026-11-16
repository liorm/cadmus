import { allowSlowTest } from "../support/dev-session.ts";
import { test } from "../support/fixtures.ts";
import { passkeysAdminModeScenario } from "../support/passkeys.ts";

test.use({ signIn: "none" });

test("a signed-in admin uses admin mode in the home account and the browser reports real passkey support (flows)", async ({
	page,
	baseURL,
}) => {
	allowSlowTest();
	await passkeysAdminModeScenario(page, baseURL ?? "http://127.0.0.1:8799");
});
