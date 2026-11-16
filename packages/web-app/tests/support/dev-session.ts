import type { APIRequestContext, Page } from "@playwright/test";
import { executeRpcPost } from "./account.ts";
import { clickByRole } from "./actions.ts";
import { expect, test } from "./fixtures.ts";

/** Password for the Playwright worker's CADMUS_DEV_PASSWORD_HASH. */
export const DEV_PASSWORD = "cadmus-playwright-dev";
/** Bootstrap super-admin email on the Playwright worker. */
export const BOOTSTRAP_EMAIL = "boss@example.com";

export interface DevLogin {
	accessToken: string;
	email: string;
}

export function uniqueEmail(prefix: string): string {
	return `${prefix}-${crypto.randomUUID()}@example.com`;
}

export function uniqueLabel(prefix: string): string {
	return `${prefix} ${crypto.randomUUID().slice(0, 8)}`;
}

/** Real sign-in, elevation, and reloads need more than the default 30s. */
export function allowSlowTest(ms = 90_000): void {
	test.setTimeout(ms);
}

/** The app-wide banner. The security page has its own "On, ends in" status. */
export function adminModeBanner(page: Page) {
	return page.getByRole("status", { name: "Admin mode" });
}

/** Clicks the admin-mode button already on the page and waits until it is on. */
export async function enableAdminMode(page: Page): Promise<void> {
	await clickByRole(page, "button", "Turn on admin mode");
	await expectAdminModeOn(page, 15_000);
}

export async function expectAdminModeOn(
	page: Page,
	timeout = 15_000,
): Promise<void> {
	await expect(adminModeBanner(page)).toContainText(/Admin mode on/, {
		timeout,
	});
}

/**
 * Puts the test source address on the page's own requests. The fixture's
 * extra headers are not visible to every engine, and a refresh with no
 * cf-connecting-ip is not budgeted, so the boot rate-limit check would see a
 * successful sign-in.
 */
export async function pinSourceAddress(page: Page, ip: string): Promise<void> {
	await page.route("**/*", async (route) => {
		const headers = {
			...route.request().headers(),
			"cf-connecting-ip": ip,
		};
		await route.continue({ headers });
	});
}

/**
 * Spend the per-IP refresh budget without touching the browser cookie.
 * Posts with a small pool so a full parallel burst does not stall the dev server.
 */
export async function exhaustRefreshBudget(
	origin: string,
	ip: string,
): Promise<void> {
	const url = new URL(origin);
	const headers = {
		Origin: url.origin,
		"X-Cadmus-Refresh": "1",
		"cf-connecting-ip": ip,
	};
	const total = 140;
	let cursor = 0;
	let limited = 0;
	const worker = async () => {
		for (;;) {
			const n = cursor;
			cursor += 1;
			if (n >= total) return;
			const res = await fetch(`${origin}/auth/refresh`, {
				method: "POST",
				headers,
			});
			if (res.status === 429) limited += 1;
		}
	};
	await Promise.all(Array.from({ length: 8 }, () => worker()));
	if (limited === 0) {
		throw new Error("refresh budget was not exhausted");
	}
}

/**
 * Picks an account in the switcher. The control reloads the page. Obscura's
 * selectOption is unreliable, so this sets the value and dispatches change.
 */
/** The account combobox. A section labelled "Account" is not this control. */
function accountSelect(page: Page) {
	return page.getByRole("combobox", { name: "Account", exact: true });
}

export async function chooseAccount(
	page: Page,
	accountId: string,
): Promise<void> {
	const select = accountSelect(page);
	await expect(select).toBeVisible();
	try {
		await select.evaluate((el, value) => {
			const node = el as HTMLSelectElement;
			node.value = value;
			node.dispatchEvent(new Event("change", { bubbles: true }));
		}, accountId);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (!/destroyed|navigation|closed/i.test(message)) throw error;
	}
	await page.waitForLoadState("domcontentloaded");
	await expect(accountSelect(page)).toHaveValue(accountId);
}

interface DevPasswordPost {
	ok: boolean;
	status: number;
	text: string;
}

/**
 * POST /auth/login/dev-password, retrying a shared bootstrap claim that loses
 * the race (`not_invited`) until the winner's login method exists, and also
 * retrying 429 and 5xx. The two logins differ only in how the POST is sent.
 */
async function loginDevPasswordWith(
	email: string,
	post: () => Promise<DevPasswordPost>,
): Promise<DevLogin> {
	let last = "";
	for (let attempt = 0; attempt < 6; attempt++) {
		const res = await post();
		if (res.ok) {
			const body = JSON.parse(res.text) as { accessToken?: string };
			if (!body.accessToken) {
				throw new Error(`dev-password login missing access token: ${res.text}`);
			}
			return { accessToken: body.accessToken, email };
		}
		last = `${res.status} ${res.text}`;
		const retry =
			res.text.includes("not_invited") ||
			res.status === 429 ||
			res.status >= 500;
		if (retry && attempt < 5) {
			await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
			continue;
		}
		break;
	}
	throw new Error(`dev-password login failed for ${email}: ${last}`);
}

/** POST /auth/login/dev-password through the Playwright request context. */
export async function loginDevPassword(
	request: APIRequestContext,
	origin: string,
	email = BOOTSTRAP_EMAIL,
): Promise<DevLogin> {
	const url = new URL(origin);
	return loginDevPasswordWith(email, async () => {
		const res = await request.post(`${origin}/auth/login/dev-password`, {
			headers: {
				Origin: url.origin,
				"Content-Type": "application/json",
			},
			data: { email, password: DEV_PASSWORD },
		});
		return { ok: res.ok(), status: res.status(), text: await res.text() };
	});
}

/** Login that does not touch the browser cookie jar. */
export async function loginDevPasswordIsolated(
	origin: string,
	email: string,
	ip: string,
): Promise<DevLogin> {
	const url = new URL(origin);
	return loginDevPasswordWith(email, async () => {
		const res = await fetch(`${origin}/auth/login/dev-password`, {
			method: "POST",
			headers: {
				Origin: url.origin,
				"Content-Type": "application/json",
				"cf-connecting-ip": ip,
			},
			body: JSON.stringify({ email, password: DEV_PASSWORD }),
		});
		return { ok: res.ok, status: res.status, text: await res.text() };
	});
}

export async function sessionCommand<T>(
	request: APIRequestContext,
	origin: string,
	accessToken: string,
	type: string,
	payload: Record<string, unknown> = {},
	accountId?: string,
): Promise<T> {
	return executeRpcPost<T>(type, async () => {
		const res = await request.post(`${origin}/rpc`, {
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${accessToken}`,
				...(accountId ? { "x-account-id": accountId } : {}),
			},
			data: { id: `ui-${crypto.randomUUID()}`, type, payload },
		});
		return { ok: res.ok(), status: res.status(), text: await res.text() };
	});
}

export async function elevate(
	request: APIRequestContext,
	origin: string,
	accessToken: string,
	accountId?: string,
): Promise<void> {
	await sessionCommand(
		request,
		origin,
		accessToken,
		"auth.elevate",
		{},
		accountId,
	);
}

/**
 * Super-admin creates a tenant and invites `email` as an account-admin.
 * The invite is accepted by an isolated login so the browser cookie stays put.
 */
export async function createInvitedAccount(
	request: APIRequestContext,
	origin: string,
	role: "account-admin" | "user",
): Promise<{ accountId: string; accountName: string; email: string }> {
	const boss = await loginDevPassword(request, origin);
	await elevate(request, origin, boss.accessToken);
	const accountName = uniqueLabel("Tenant");
	const created = await sessionCommand<{
		account: { id: string; name: string };
	}>(request, origin, boss.accessToken, "system.accounts.create", {
		name: accountName,
	});
	const email = uniqueEmail(role === "user" ? "user" : "admin");
	await sessionCommand(
		request,
		origin,
		boss.accessToken,
		"system.members.invite",
		{ accountId: created.account.id, email, role },
	);
	const octet = crypto.getRandomValues(new Uint8Array(2));
	await loginDevPasswordIsolated(origin, email, `10.8.${octet[0]}.${octet[1]}`);
	return { accountId: created.account.id, accountName, email };
}

/** Browser session for an invited account-admin (or user) of a fresh tenant. */
export async function signInInvitedMember(
	request: APIRequestContext,
	origin: string,
	role: "account-admin" | "user",
): Promise<{
	accountId: string;
	accountName: string;
	email: string;
	accessToken: string;
}> {
	const tenant = await createInvitedAccount(request, origin, role);
	const session = await loginDevPassword(request, origin, tenant.email);
	return { ...tenant, accessToken: session.accessToken };
}
