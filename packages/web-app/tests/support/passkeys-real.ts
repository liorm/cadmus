import type {
	BrowserContext,
	CDPSession,
	Page,
	TestInfo,
} from "@playwright/test";
import { clickByRole } from "./actions.ts";
import { expect } from "./fixtures.ts";
import { type AuditAction, openFixture } from "./fresh-session.ts";

// Real worker and D1 on a cold start are slower than the stubbed specs.
const slow = expect.configure({ timeout: 30_000 });

const ORIGIN = "http://localhost:8799";

async function addAuthenticator(
	cdp: CDPSession,
	transport: "internal" | "usb" = "internal",
) {
	return (await cdp.send("WebAuthn.addVirtualAuthenticator", {
		options: {
			protocol: "ctap2",
			transport,
			hasResidentKey: true,
			hasUserVerification: true,
			isUserVerified: true,
			automaticPresenceSimulation: true,
		},
	})) as { authenticatorId: string };
}

async function signInAndAuthenticator(
	context: BrowserContext,
	page: Page,
	refreshToken: string,
) {
	await context.addCookies([
		{
			name: "__Secure-cadmus_refresh",
			value: refreshToken,
			domain: "localhost",
			path: "/auth/refresh",
			secure: true,
			httpOnly: true,
			sameSite: "Strict",
		},
	]);
	const cdp = await context.newCDPSession(page);
	await cdp.send("WebAuthn.enable");
	const { authenticatorId } = await addAuthenticator(cdp);
	return { cdp, authenticatorId };
}

async function openSecuritySettings(page: Page): Promise<void> {
	await page.goto(`${ORIGIN}/settings/security`);
	await slow(page.getByText("Signed in as")).toBeVisible({
		timeout: 30_000,
	});
	await slow(page.getByText("Login methods")).toBeVisible({
		timeout: 30_000,
	});
	await page.waitForLoadState("networkidle");
}

export async function passkeyLifecycleScenario(
	page: Page,
	context: BrowserContext,
	testInfo: TestInfo,
	onReady?: () => Promise<void>,
): Promise<void> {
	const fx = await openFixture();
	try {
		const s = await fx.session(0);
		const { cdp, authenticatorId } = await signInAndAuthenticator(
			context,
			page,
			s.refreshToken,
		);

		await openSecuritySettings(page);
		if (onReady) await onReady();
		await clickByRole(page, "button", "Add a passkey");
		await slow(page.getByText("Passkey", { exact: true })).toBeVisible();
		expect(await fx.activePasskeys(s.userId)).toBe(1);
		await page.screenshot({
			path: testInfo.outputPath(`passkey-row-${testInfo.project.name}.png`),
			fullPage: true,
		});

		// Admin mode: the plain call is refused for a passkey user, so the page proves it.
		await clickByRole(page, "button", "Turn on admin mode");
		await slow(page.getByText(/On, ends in 1[45]:\d\d/)).toBeVisible();

		// The same device cannot enrol twice: the browser refuses, and the page
		// says so instead of blaming admin mode (which is on).
		await clickByRole(page, "button", "Add a passkey");
		await slow(page.getByText(/already holds a passkey/)).toBeVisible();
		await slow(page.getByText(/needs admin mode/)).toHaveCount(0);
		expect(await fx.activePasskeys(s.userId)).toBe(1);

		// A second device: silence the first so only the new one answers.
		await cdp.send("WebAuthn.setAutomaticPresenceSimulation", {
			authenticatorId,
			enabled: false,
		});
		await addAuthenticator(cdp, "usb");
		await clickByRole(page, "button", "Add a passkey");
		await slow(page.getByText("Passkey", { exact: true })).toHaveCount(2);
		expect(await fx.activePasskeys(s.userId)).toBe(2);

		// Remove one with passkey proof (the second device answers).
		await page
			.getByRole("button", { name: /^Remove passkey/ })
			.first()
			.click();
		await slow(page.getByText("Passkey", { exact: true })).toHaveCount(1);
		expect(await fx.activePasskeys(s.userId)).toBe(1);
		expect(await fx.auditCount(s.userId, "auth.passkey.remove")).toBe(1);
		await page.reload();
		await slow(page.getByText("Passkey", { exact: true })).toHaveCount(1);
	} finally {
		await fx.close();
	}
}

export async function staleGoogleCannotEnrollScenario(
	page: Page,
	context: BrowserContext,
	onReady?: () => Promise<void>,
): Promise<void> {
	const fx = await openFixture();
	try {
		const s = await fx.session(6 * 60 * 1000);
		await signInAndAuthenticator(context, page, s.refreshToken);
		await openSecuritySettings(page);
		if (onReady) await onReady();
		await clickByRole(page, "button", "Add a passkey");
		await slow(
			page.getByRole("link", { name: /Sign in with Google again/ }),
		).toBeVisible();
		expect(await fx.passkeyRows(s.userId)).toBe(0);
	} finally {
		await fx.close();
	}
}

export async function secondPasskeyRequiresAdminModeScenario(
	page: Page,
	context: BrowserContext,
	onReady?: () => Promise<void>,
): Promise<void> {
	const fx = await openFixture();
	try {
		const s = await fx.session(0);
		const { cdp, authenticatorId } = await signInAndAuthenticator(
			context,
			page,
			s.refreshToken,
		);
		const active = () => fx.activePasskeys(s.userId);
		await openSecuritySettings(page);
		if (onReady) await onReady();
		await clickByRole(page, "button", "Add a passkey");
		await slow(page.getByText("Passkey", { exact: true })).toBeVisible();
		expect(await active()).toBe(1);

		// Admin mode is off: a second passkey (second device) is refused by the worker.
		await cdp.send("WebAuthn.setAutomaticPresenceSimulation", {
			authenticatorId,
			enabled: false,
		});
		await addAuthenticator(cdp, "usb");
		await clickByRole(page, "button", "Add a passkey");
		await slow(page.getByText(/needs admin mode/)).toBeVisible();
		expect(await active()).toBe(1);

		// Turn admin mode on, remove the only passkey, reload: admin mode is off.
		await cdp.send("WebAuthn.setAutomaticPresenceSimulation", {
			authenticatorId,
			enabled: true,
		});
		await clickByRole(page, "button", "Turn on admin mode");
		await slow(page.getByText(/On, ends in 1[45]:\d\d/)).toBeVisible();
		const elevatedUntil = () => fx.elevatedUntil(s.sessionId);
		const audits = (action: AuditAction) => fx.auditCount(s.userId, action);
		// The real session row holds the grant before the removal.
		expect(await elevatedUntil()).toBeGreaterThan(Date.now());
		expect(await audits("auth.passkey.register")).toBe(1);
		expect(await audits("auth.elevate")).toBe(1);
		expect(await audits("auth.passkey.remove")).toBe(0);
		expect(await audits("auth.elevation.end")).toBe(0);
		await page.getByRole("button", { name: /^Remove passkey/ }).click();
		await slow(page.getByText("Passkey", { exact: true })).toHaveCount(0);
		expect(await active()).toBe(0);
		// Removing the last passkey ends admin mode in the stored session and
		// the audit trail records both the removal and the end.
		expect(await elevatedUntil()).toBeNull();
		expect(await audits("auth.passkey.remove")).toBe(1);
		expect(await audits("auth.elevation.end")).toBe(1);
		await page.reload();
		await slow(page.getByText("Signed in as")).toBeVisible({
			timeout: 30_000,
		});
		await slow(page.getByText("Login methods")).toBeVisible({
			timeout: 30_000,
		});
		await page.waitForLoadState("networkidle");
		await slow(
			page.getByRole("button", { name: "Leave admin mode" }),
		).toHaveCount(0);
	} finally {
		await fx.close();
	}
}

export async function passkeyReplayAndRefusalsScenario(
	page: Page,
	context: BrowserContext,
	testInfo: TestInfo,
	onReady?: () => Promise<void>,
): Promise<void> {
	const fx = await openFixture();
	try {
		const s = await fx.session(0);
		const other = await fx.session(0);
		// A real passkey row owned by another user: the foreign remove must aim
		// at a passkey method, not at a Google method.
		const otherPasskey = await fx.seedPasskey(other.userId);
		await signInAndAuthenticator(context, page, s.refreshToken);
		let finishBody = "";
		let finishStatus = 0;
		// The browser's refresh replaced the fixture's access token, so use the
		// bearer token the page itself sends. Same session, a live token.
		let bearer = "";
		page.on("request", (req) => {
			const auth = req.headers().authorization;
			if (req.url().includes("/api/") && auth?.startsWith("Bearer ")) {
				bearer = auth.slice("Bearer ".length);
			}
			if (req.url().endsWith("/api/auth/passkeys/finish")) {
				finishBody = req.postData() ?? "";
			}
		});
		page.on("response", (res) => {
			if (res.url().endsWith("/api/auth/passkeys/finish")) {
				finishStatus = res.status();
			}
		});
		await page.goto(`${ORIGIN}/settings/security`);
		await slow(page.getByText("Login methods")).toBeVisible();
		await page.waitForLoadState("networkidle");
		if (onReady) await onReady();
		await clickByRole(page, "button", "Add a passkey");
		await slow(page.getByText("Passkey", { exact: true })).toBeVisible();
		expect(finishBody).not.toBe("");

		// The challenge row records the localhost RP and the origin with the port.
		const row = await fx.registerChallenge(s.userId);
		expect(row?.rp_id).toBe("localhost");
		expect(row?.origin).toBe(ORIGIN);
		expect(row?.consumed_at).not.toBeNull();

		const call = async (path: string, body: unknown, method = "POST") => {
			const res = await fetch(`${ORIGIN}${path}`, {
				method,
				headers: {
					authorization: `Bearer ${bearer}`,
					"content-type": "application/json",
				},
				...(method === "POST"
					? { body: typeof body === "string" ? body : JSON.stringify(body) }
					: {}),
			});
			const text = await res.text();
			let json: { error?: { code?: string } } | undefined;
			try {
				json = JSON.parse(text);
			} catch {
				json = undefined;
			}
			return { status: res.status, text, json };
		};
		const passkeyMethodId = await fx.activePasskeyMethodId(s.userId);
		const count = (userId: string) => fx.activePasskeyMethods(userId);
		// The first finish really succeeded: HTTP 200, a stored passkey, and the
		// challenge consumed. Only then is a refusal of the replay meaningful.
		expect(finishStatus).toBe(200);
		expect(passkeyMethodId).toBeTruthy();
		expect(await count(s.userId)).toBe(1);
		expect(await count(other.userId)).toBe(1);

		// Positive control: the same bearer token is accepted by an authenticated
		// call, so the refusals below are not just an expired or bad token.
		expect(bearer).not.toBe("");
		const control = await call("/api/auth/whoami", undefined, "GET");
		expect(control.status).toBe(200);
		expect(control.text).toContain(s.userId);
		// A same-token positive control on the same route that is later refused:
		// beginning removal of the caller's own passkey is accepted.
		const ownBegin = await call("/api/auth/passkeys/begin", {
			purpose: "remove",
			methodId: passkeyMethodId,
		});
		expect(ownBegin.status).toBe(200);

		const replay = await call("/api/auth/passkeys/finish", finishBody);
		const garbage = await call("/api/auth/passkeys/finish", {
			purpose: "register",
			challengeId: "chl_does_not_exist",
			response: { id: "x", rawId: "x" },
		});
		expect(replay.status).toBe(403);
		expect(replay.json?.error?.code).toBe("forbidden");
		// The replay answer is the same generic refusal as any unknown challenge.
		expect(replay.text).toBe(garbage.text);
		expect(await count(s.userId)).toBe(1);

		const foreign = await call("/api/auth/passkeys/begin", {
			purpose: "remove",
			methodId: otherPasskey,
		});
		const unknown = await call("/api/auth/passkeys/begin", {
			purpose: "remove",
			methodId: "lm_does_not_exist",
		});
		expect(foreign.status).toBe(403);
		expect(foreign.json?.error?.code).toBe("forbidden");
		// A foreign passkey looks the same as one that does not exist.
		expect(foreign.text).toBe(unknown.text);
		expect(await count(other.userId)).toBe(1);

		const generic = await call("/api/auth/methods/revoke", {
			methodId: passkeyMethodId,
		});
		expect(generic.status).toBe(403);
		expect(generic.json?.error?.code).toBe("forbidden");
		expect(await count(s.userId)).toBe(1);
		// Keep the evidence: exact statuses and bodies, saved with the run.
		await testInfo.attach("refusals.json", {
			contentType: "application/json",
			body: JSON.stringify(
				{ control, ownBegin, replay, garbage, foreign, unknown, generic },
				null,
				2,
			),
		});
	} finally {
		await fx.close();
	}
}

export async function unsupportedBrowserPasskeyScenario(
	page: Page,
	context: BrowserContext,
	testInfo: TestInfo,
	onReady?: () => Promise<void>,
): Promise<void> {
	const fx = await openFixture();
	try {
		const s = await fx.session(0);
		await context.addCookies([
			{
				name: "__Secure-cadmus_refresh",
				value: s.refreshToken,
				domain: "localhost",
				path: "/auth/refresh",
				secure: true,
				httpOnly: true,
				sameSite: "Strict",
			},
		]);
		await page.addInitScript(() => {
			Object.defineProperty(window, "PublicKeyCredential", {
				configurable: true,
				value: undefined,
			});
		});
		await page.goto(`${ORIGIN}/settings/security`);
		await slow(
			page.getByText(/This browser cannot use passkeys\./),
		).toBeVisible();
		if (onReady) await onReady();
		await slow(
			page.getByRole("button", { name: "Add a passkey" }),
		).toBeDisabled();
		// A fresh Google sign-in cannot help a browser without passkeys.
		await slow(page.getByText(/recent Google sign-in/)).toHaveCount(0);
		await page.screenshot({
			path: testInfo.outputPath(`unsupported-${testInfo.project.name}.png`),
			fullPage: true,
		});
	} finally {
		await fx.close();
	}
}
