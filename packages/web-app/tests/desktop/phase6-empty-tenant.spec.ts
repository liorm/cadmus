import { allowSlowTest, signInInvitedMember } from "../support/dev-session.ts";
import { expect, test } from "../support/fixtures.ts";

test.use({ signIn: "none" });

test("an invited account admin sees an empty tenant, still empty after reload (desktop)", async ({
	page,
	baseURL,
}) => {
	allowSlowTest();
	const tenant = await signInInvitedMember(
		page.context().request,
		baseURL ?? "http://127.0.0.1:8799",
		"account-admin",
	);
	await page.goto("/");
	await expect(
		page.getByRole("banner", { name: "Cadmus Cockpit" }),
	).toBeVisible();
	await expect(page.getByText(/No bots/)).toBeVisible();
	await page.reload();
	await expect(page.getByText(/No bots/)).toBeVisible();
	await expect(
		page.getByRole("banner", { name: "Cadmus Cockpit" }),
	).toBeVisible();
	await page.goto("/settings/account");
	await expect(page.getByLabel("Account name")).toHaveValue(tenant.accountName);
	await page.reload();
	await expect(page.getByLabel("Account name")).toHaveValue(tenant.accountName);
});
