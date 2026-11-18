import { test } from "../support/fixtures.ts";
import {
	securitySettingsDevPasswordReloadScenario,
	securitySettingsGoogleSignInScenario,
} from "../support/security-settings.ts";

test.use({ signIn: "none" });

test("security settings offers Google sign-in when the server enables it", async ({
	page,
}) => {
	await securitySettingsGoogleSignInScenario(page);
});

test("a dev-password session stays signed in after a reload", async ({
	page,
	baseURL,
}) => {
	await securitySettingsDevPasswordReloadScenario(
		page,
		baseURL ?? "http://127.0.0.1:8799",
	);
});
