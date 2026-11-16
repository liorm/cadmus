import { expect, test } from "../support/fixtures.ts";
import { toolsDaemonScenario } from "../support/tools-real.ts";

test.use({ signIn: "none" });

test("creating a daemon env shows a real pairing command and the env stays after reload (desktop)", async ({
	page,
	accountId,
	baseURL,
}) => {
	await toolsDaemonScenario(
		page,
		accountId,
		baseURL ?? "http://127.0.0.1:8799",
	);
	await expect(
		page.getByRole("banner", { name: "Cadmus Cockpit" }),
	).toBeVisible();
});
