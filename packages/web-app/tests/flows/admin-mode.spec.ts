import {
	adminModeBannerAcrossScreensScenario,
	adminModeCountdownAndLeaveScenario,
	tokenSessionNoAdminModeScenario,
} from "../support/admin-mode.ts";
import { allowSlowTest } from "../support/dev-session.ts";
import { test } from "../support/fixtures.ts";

test.use({ signIn: "none" });

test("a token session is not offered admin mode", async ({
	page,
	accountId,
	baseURL,
}) => {
	await tokenSessionNoAdminModeScenario(
		page,
		accountId,
		baseURL ?? "http://127.0.0.1:8799",
	);
});

test("an admin turns admin mode on, sees the countdown, and leaves it", async ({
	page,
	baseURL,
}) => {
	allowSlowTest();
	await adminModeCountdownAndLeaveScenario(
		page,
		baseURL ?? "http://127.0.0.1:8799",
	);
});

test("the banner shows on other screens while admin mode is on and leaves it", async ({
	page,
	baseURL,
}) => {
	allowSlowTest();
	await adminModeBannerAcrossScreensScenario(
		page,
		baseURL ?? "http://127.0.0.1:8799",
	);
});
