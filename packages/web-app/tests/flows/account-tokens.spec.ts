import {
	tokensAdminScenario,
	tokensNonAdminScenario,
} from "../support/account-tokens.ts";
import { test } from "../support/fixtures.ts";

// Signs in through the dev-password helper. No master dev config is seeded.
test.use({ signIn: "none" });

test("an account admin manages service tokens (flows)", async ({
	page,
	accountId,
	baseURL,
}, testInfo) => {
	await tokensAdminScenario(
		page,
		accountId,
		baseURL ?? "http://127.0.0.1:8799",
		async (name) => {
			await page.screenshot({
				path: testInfo.outputPath(`account-tokens-flows-${name}.png`),
			});
		},
	);
});

for (const who of [
	{ name: "a plain user", role: "user" },
	{ name: "a token session", role: "account-admin", viaToken: true },
]) {
	test(`${who.name} keeps only what the server allows (flows)`, async ({
		page,
		accountId,
		baseURL,
	}, testInfo) => {
		await tokensNonAdminScenario(
			page,
			accountId,
			baseURL ?? "http://127.0.0.1:8799",
			{ role: who.role, viaToken: who.viaToken },
			async (name) => {
				await page.screenshot({
					path: testInfo.outputPath(
						`account-tokens-flows-${who.role}-${name}.png`,
					),
				});
			},
		);
	});
}
