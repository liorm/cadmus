import { test } from "../support/fixtures.ts";
import {
	elevationFailureScenario,
	notSuperAdminScenario,
	selfResetScenario,
	superAdminScenario,
} from "../support/system-console.ts";

// Signs in through the dev-password helper. No master dev config is seeded.
test.use({ signIn: "none" });

test.describe.configure({ mode: "parallel" });

test("a super-admin runs the system console (flows)", async ({
	page,
	accountId,
	baseURL,
}, testInfo) => {
	await superAdminScenario(
		page,
		accountId,
		baseURL ?? "http://127.0.0.1:8799",
		async (name) => {
			await page.screenshot({
				path: testInfo.outputPath(`system-console-flows-${name}.png`),
			});
		},
	);
});

test("an account admin does not get the system console (flows)", async ({
	page,
	accountId,
	baseURL,
}) => {
	await notSuperAdminScenario(
		page,
		accountId,
		baseURL ?? "http://127.0.0.1:8799",
	);
});

test("a failed admin mode enable stays visible and recoverable (flows)", async ({
	page,
	accountId,
	baseURL,
}, testInfo) => {
	await elevationFailureScenario(
		page,
		accountId,
		baseURL ?? "http://127.0.0.1:8799",
		async (name) => {
			await page.screenshot({
				path: testInfo.outputPath(`system-console-flows-${name}.png`),
			});
		},
	);
});

test("the console does not offer a passkey reset for the signed-in user (flows)", async ({
	page,
	accountId,
	baseURL,
}) => {
	await selfResetScenario(page, accountId, baseURL ?? "http://127.0.0.1:8799");
});
