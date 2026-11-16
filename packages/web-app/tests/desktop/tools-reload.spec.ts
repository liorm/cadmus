import { expect, test } from "../support/fixtures.ts";
import { toolsJustBashScenario } from "../support/tools-real.ts";

test.use({ signIn: "none" });

test("a just-bash env survives reload, and so do its rename and delete (desktop)", async ({
	page,
	accountId,
	baseURL,
}) => {
	await toolsJustBashScenario(
		page,
		accountId,
		baseURL ?? "http://127.0.0.1:8799",
	);
	await expect(
		page.getByRole("banner", { name: "Cadmus Cockpit" }),
	).toBeVisible();
});
