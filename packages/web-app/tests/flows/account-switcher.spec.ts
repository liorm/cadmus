import {
	accountSwitcherScenario,
	noPasskeyBetaScenario,
	rememberedAccountScenario,
	twoTabsScenario,
} from "../support/account-switcher.ts";
import { test } from "../support/fixtures.ts";

// Signs in through the dev-password helper. No master dev config is seeded.
test.use({ signIn: "none" });

test("a user in two accounts switches between them and admin mode stays in its account (flows)", async ({
	page,
	accountId,
	baseURL,
}, testInfo) => {
	await accountSwitcherScenario(
		page,
		accountId,
		baseURL ?? "http://127.0.0.1:8799",
		async (name) => {
			await page.screenshot({
				path: testInfo.outputPath(`account-switcher-flows-${name}.png`),
			});
		},
	);
});

for (const mode of ["suspended", "kept"] as const) {
	test(`a remembered account the server ${mode === "suspended" ? "refuses sends the tab home with a notice" : "still allows stays selected and says nothing"} (flows)`, async ({
		page,
		accountId,
		baseURL,
	}, testInfo) => {
		await rememberedAccountScenario(
			page,
			mode,
			accountId,
			baseURL ?? "http://127.0.0.1:8799",
			async (name) => {
				await page.screenshot({
					path: testInfo.outputPath(
						`account-switcher-flows-${name}-${mode}.png`,
					),
				});
			},
		);
	});
}

test("two tabs in two accounts each show only their own account's admin mode (flows)", async ({
	page,
	accountId,
	baseURL,
}) => {
	await twoTabsScenario(page, accountId, baseURL ?? "http://127.0.0.1:8799");
});

test("a no-passkey user in the second account sees the server's refusal when turning on admin mode (flows)", async ({
	page,
	accountId,
	baseURL,
}, testInfo) => {
	await noPasskeyBetaScenario(
		page,
		accountId,
		baseURL ?? "http://127.0.0.1:8799",
		async (name) => {
			await page.screenshot({
				path: testInfo.outputPath(`account-switcher-flows-${name}.png`),
			});
		},
	);
});
