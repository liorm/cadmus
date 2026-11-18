import { DEV_PASSWORD } from "../support/dev-session.ts";
import { expect, test } from "../support/fixtures.ts";

test.use({ signIn: "none" });

test("signed-out boot shows Google and the dev password, then signs in", async ({
	page,
}) => {
	await page.goto("/");
	const dialog = page.getByRole("dialog", { name: "Sign in to Cadmus" });
	await expect(dialog).toBeVisible();
	await expect(dialog.getByText("Sign-in is not enabled")).toHaveCount(0);
	await expect(
		dialog.getByRole("link", { name: "Sign in with Google" }),
	).toHaveAttribute("href", "/api/auth/login/google/start");

	await dialog.getByLabel("Password").fill("not-the-password");
	await dialog.getByRole("button", { name: "Sign in" }).click();
	await expect(dialog.getByRole("alert")).toContainText(/refused/i);

	await dialog.getByLabel("Password").fill(DEV_PASSWORD);
	await dialog.getByRole("button", { name: "Sign in" }).click();
	await expect(dialog).toHaveCount(0);
	await expect(page.getByText("Sign-in is not enabled")).toHaveCount(0);
});
