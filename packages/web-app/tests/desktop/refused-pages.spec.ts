import { expect, test } from "../support/fixtures.ts";
import {
	REFUSED_PAGES,
	refusedPageScenario,
} from "../support/refused-pages.ts";

for (const [path, name] of REFUSED_PAGES) {
	test(`the ${name} page explains a refused token sign-in (desktop)`, async ({
		page,
		accountId,
		baseURL,
	}, testInfo) => {
		await refusedPageScenario(
			page,
			accountId,
			baseURL ?? "http://127.0.0.1:8799",
			path,
			name,
			testInfo,
			async () => {
				await expect(
					page.getByRole("banner", { name: "Cadmus Cockpit" }),
				).toBeVisible();
			},
		);
	});
}
