import { expect, test } from "../support/fixtures.ts";
import {
	securitySettingsDevPasswordReloadScenario,
	securitySettingsGoogleSignInScenario,
} from "../support/security-settings.ts";

test.use({ signIn: "none" });

test("security settings shows Google sign-in inside the cockpit when enabled", async ({
	page,
}) => {
	await securitySettingsGoogleSignInScenario(page);
});

test("a dev-password session stays signed in inside the cockpit after a reload", async ({
	page,
	baseURL,
}) => {
	await securitySettingsDevPasswordReloadScenario(
		page,
		baseURL ?? "http://127.0.0.1:8799",
		async () => {
			await expect(
				page.getByRole("banner", { name: "Cadmus Cockpit" }),
			).toBeVisible();
		},
	);
});
