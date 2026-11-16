import type { Page } from "@playwright/test";
import {
	exhaustRefreshBudget,
	loginDevPassword,
	pinSourceAddress,
} from "./dev-session.ts";
import { expect, sourceAddressFor, test } from "./fixtures.ts";

export async function bootRefreshRateLimitedScenario(
	page: Page,
	origin: string,
	onReady?: () => Promise<void>,
): Promise<void> {
	const ip = sourceAddressFor(test.info().testId, test.info().retry);
	await loginDevPassword(page.context().request, origin);
	await pinSourceAddress(page, ip);
	await exhaustRefreshBudget(origin, ip);
	const refreshes: string[] = [];
	page.on("request", (req) => {
		if (new URL(req.url()).pathname !== "/auth/refresh") return;
		const headers = req.headers();
		refreshes.push(`ip=${headers["cf-connecting-ip"] ?? "missing"}`);
	});
	page.on("response", (res) => {
		if (new URL(res.url()).pathname === "/auth/refresh") {
			refreshes.push(String(res.status()));
		}
	});
	await page.goto("/settings/security");
	if (onReady) await onReady();
	await expect(
		page
			.getByRole("alert")
			.filter({ hasText: "We could not check your sign-in" }),
		`page refresh: ${refreshes.join(" ") || "none"}`,
	).toBeVisible({ timeout: 45_000 });
	await expect(page.getByText("Signed in as")).toHaveCount(0);
	await expect(
		page.getByText("You are using the shared access key"),
	).toHaveCount(0);
}

export async function bootRefreshUnauthorizedScenario(
	page: Page,
	origin: string,
	onReady?: () => Promise<void>,
): Promise<void> {
	const url = new URL(origin);
	const session = await loginDevPassword(page.context().request, origin);
	const logout = await page.context().request.post(`${origin}/auth/logout`, {
		headers: {
			Origin: url.origin,
			"X-Cadmus-Refresh": "1",
			Authorization: `Bearer ${session.accessToken}`,
		},
	});
	expect(logout.ok(), await logout.text()).toBe(true);
	await page.goto("/settings/security");
	if (onReady) await onReady();
	await expect(
		page.getByRole("link", { name: "Sign in with Google" }),
	).toBeVisible();
	await expect(page.getByText("Signed in as")).toHaveCount(0);
	await expect(page.getByText("We could not check your sign-in")).toHaveCount(
		0,
	);
	await expect(page.getByText("Reconnecting...")).toHaveCount(0);
}
