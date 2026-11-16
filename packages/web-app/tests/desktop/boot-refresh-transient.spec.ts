import {
	bootRefreshRateLimitedScenario,
	bootRefreshUnauthorizedScenario,
} from "../support/boot-refresh-transient.ts";
import { allowSlowTest } from "../support/dev-session.ts";
import { expect, test } from "../support/fixtures.ts";

test.use({ signIn: "none" });

test("a boot refresh that stays rate limited says it could not check sign-in (desktop)", async ({
	page,
	baseURL,
}) => {
	allowSlowTest(120_000);
	await bootRefreshRateLimitedScenario(
		page,
		baseURL ?? "http://127.0.0.1:8799",
		async () => {
			await expect(
				page.getByRole("banner", { name: "Cadmus Cockpit" }),
			).toBeVisible();
		},
	);
});

test("a boot refresh answered 401 is signed out at once (desktop)", async ({
	page,
	baseURL,
}) => {
	await bootRefreshUnauthorizedScenario(
		page,
		baseURL ?? "http://127.0.0.1:8799",
		async () => {
			await expect(
				page.getByRole("banner", { name: "Cadmus Cockpit" }),
			).toBeVisible();
		},
	);
});
