import { expect, test } from "../support/fixtures.ts";
import {
	toolsTokenRefusalScenario,
	toolsUserBlockedScenario,
} from "../support/tools-real.ts";

test.use({ signIn: "none" });

test("tools changes are blocked for a plain user (desktop)", async ({
	page,
	accountId,
	baseURL,
}) => {
	await toolsUserBlockedScenario(
		page,
		accountId,
		baseURL ?? "http://127.0.0.1:8799",
	);
	await expect(
		page.getByRole("banner", { name: "Cadmus Cockpit" }),
	).toBeVisible();
});

test("a token session with an account-admin role keeps the controls and shows the worker refusal (desktop)", async ({
	page,
	accountId,
	baseURL,
}) => {
	await toolsTokenRefusalScenario(
		page,
		accountId,
		baseURL ?? "http://127.0.0.1:8799",
	);
	await expect(
		page.getByRole("banner", { name: "Cadmus Cockpit" }),
	).toBeVisible();
});
