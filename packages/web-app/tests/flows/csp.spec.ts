import { seedBot, sendAccountRpc } from "../support/account.ts";
import { expect, test } from "../support/fixtures.ts";

/**
 * Only real Chrome is known to enforce the policy and report violations. On the
 * default Obscura engine a deliberately wrong script hash produced no violation
 * (checked), so there the violation check would pass for the wrong reason and is
 * left to the real Chrome CI job. The header assertions run on every engine.
 */
const reportsViolations =
	(process.env.CADMUS_TEST_ENGINE ?? "obscura").toLowerCase() === "chrome";

/**
 * The static-assets headers in public/_headers (a CSP, nosniff, framing and
 * referrer rules) must reach the SPA shell, including a deep link served by the
 * single-page-application fallback, and the app must run under that policy
 * without a single violation on boot, a bot page and the security settings.
 * These headers do not apply to Worker-generated responses (API, auth).
 */
test("the app shell carries the CSP headers and runs without violations", async ({
	page,
	accountId,
}) => {
	await page.addInitScript(() => {
		const bag = window as unknown as { __csp: string[] };
		bag.__csp = [];
		document.addEventListener("securitypolicyviolation", (event) => {
			bag.__csp.push(`${event.violatedDirective} ${event.blockedURI}`);
		});
	});
	const violations = async () =>
		page.evaluate(() => (window as unknown as { __csp: string[] }).__csp);

	for (const path of ["/", "/settings/security", `/bot/none/config`]) {
		const response = await page.goto(path);
		expect(response?.status(), path).toBe(200);
		const headers = response?.headers() ?? {};
		expect(headers["content-security-policy"], path).toContain(
			"default-src 'none'",
		);
		expect(headers["content-security-policy"], path).toContain(
			"frame-ancestors 'none'",
		);
		expect(headers["x-content-type-options"], path).toBe("nosniff");
		expect(headers["x-frame-options"], path).toBe("DENY");
		expect(headers["referrer-policy"], path).toBe("no-referrer");
		// The app mounted under the policy (the page keeps connections open, so
		// network idle is never reached).
		await expect(page.locator("#root > *").first(), path).toBeAttached();
		await page.waitForLoadState("load");
		if (reportsViolations) expect(await violations(), path).toEqual([]);
	}
	// The theme script ran under the hash: the attribute is set before React.
	await page.goto("/");
	await expect(page.locator("html")).toHaveAttribute("data-theme", /.+/);
	expect(accountId).toBeTruthy();
});

// 1x1 transparent PNG, served for the intercepted remote image requests.
const PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
	"base64",
);

/**
 * Policy under test: remote https images in chat, soul and memory markdown keep
 * loading, so img-src is 'self' data: https:. (The decision's source is
 * recorded in the PR scope matrix, not here.) The served policy still blocks an
 * http: image and an inline script, and the page's own WebSocket and fetches
 * (connect-src 'self') still work. The remote hosts are intercepted by the
 * test (no real network); a blocked URL never reaches the interception.
 *
 * The skip is on the suite, not inside the test. An in-body skip still sets up
 * the default user sign-in, and teardown then fails the proof because these
 * tests never load a page on Obscura.
 */
test.describe("CSP checks that need a browser which reports violations", () => {
	test.skip(
		!reportsViolations,
		"needs real Chrome: Obscura reports no CSP violations",
	);

	test("a remote https markdown image loads, an http image and an injected inline script do not", async ({
		page,
		accountId,
		baseURL,
	}) => {
		const origin = baseURL ?? "http://127.0.0.1:8799";
		await seedBot(origin, accountId, "Csp Bot", "csp-bot");
		await sendAccountRpc(origin, accountId, "file.write", {
			botId: "csp-bot",
			path: "SOUL.md",
			content:
				"# Soul\n\n![remote https](https://csp-https.test/ok.png)\n\n![remote http](http://csp-http.test/bad.png)\n",
		});
		const fetched: string[] = [];
		await page.route(/csp-(https|http)\.test/, (route) => {
			fetched.push(route.request().url());
			return route.fulfill({
				status: 200,
				contentType: "image/png",
				body: PNG,
			});
		});
		const sockets: string[] = [];
		page.on("websocket", (ws) => sockets.push(ws.url()));
		await page.addInitScript(() => {
			const bag = window as unknown as { __csp: string[]; __inline?: number };
			bag.__csp = [];
			document.addEventListener("securitypolicyviolation", (event) => {
				bag.__csp.push(`${event.violatedDirective} ${event.blockedURI}`);
			});
		});

		await page.goto("/bot/csp-bot/soul");
		await expect(page.getByRole("heading", { name: "Soul" })).toBeVisible();

		// Positive control first: the https image really loaded (decoded, 1x1).
		const https = page.locator("img[src='https://csp-https.test/ok.png']");
		await expect(https).toHaveCount(1);
		await expect
			.poll(() => https.evaluate((img: HTMLImageElement) => img.naturalWidth))
			.toBe(1);
		expect(fetched).toContain("https://csp-https.test/ok.png");

		// The http: image is in the DOM but blocked by img-src, and never fetched.
		const http = page.locator("img[src='http://csp-http.test/bad.png']");
		await expect(http).toHaveCount(1);
		await expect
			.poll(() =>
				page.evaluate(() => (window as unknown as { __csp: string[] }).__csp),
			)
			.toContain("img-src http://csp-http.test/bad.png");
		expect(
			await http.evaluate((img: HTMLImageElement) => img.naturalWidth),
		).toBe(0);
		expect(fetched).not.toContain("http://csp-http.test/bad.png");

		// An inline script added at runtime is refused by script-src.
		await page.evaluate(() => {
			const el = document.createElement("script");
			el.textContent = "window.__inline = 1";
			document.head.appendChild(el);
		});
		expect(
			await page.evaluate(
				() => (window as unknown as { __inline?: number }).__inline,
			),
		).toBeUndefined();
		const violations = await page.evaluate(
			() => (window as unknown as { __csp: string[] }).__csp,
		);
		expect(violations.some((v) => v.startsWith("script-src"))).toBe(true);

		// Nothing else was reported: the https image, the page's fetches and its
		// WebSocket ran without a violation (connect-src 'self').
		expect(
			violations.filter(
				(v) =>
					v !== "img-src http://csp-http.test/bad.png" &&
					!v.startsWith("script-src"),
			),
		).toEqual([]);
		await expect.poll(() => sockets.length).toBeGreaterThan(0);
		for (const url of sockets) expect(url).toContain("127.0.0.1:8799");
	});

	/**
	 * The routes a user reaches, each loaded under the served policy in real
	 * Chrome: none may report a violation (a script, style, font, image,
	 * connection or form the policy would block). Forms in the app are all handled
	 * in script (onSubmit with preventDefault, no action attribute), and sign-in
	 * starts from anchors, so form-action is not exercised by a submit here.
	 */
	test("the main routes run under the served policy without a violation", async ({
		page,
		accountId,
		baseURL,
	}) => {
		const origin = baseURL ?? "http://127.0.0.1:8799";
		await seedBot(origin, accountId, "Route Bot", "route-bot");
		const created = await sendAccountRpc<{ chat: { key: string } }>(
			origin,
			accountId,
			"chat.create",
			{ botId: "route-bot", title: "Routes" },
		);
		await page.addInitScript(() => {
			const bag = window as unknown as { __csp: string[] };
			bag.__csp = [];
			document.addEventListener("securitypolicyviolation", (event) => {
				bag.__csp.push(`${event.violatedDirective} ${event.blockedURI}`);
			});
		});
		const paths = [
			"/",
			`/chat/${created.chat.key}`,
			"/new",
			"/bot/route-bot",
			"/bot/route-bot/soul",
			"/bot/route-bot/memory",
			"/bot/route-bot/tools",
			"/bot/route-bot/harvest",
			"/settings",
			"/settings/account",
			"/settings/security",
			"/settings/family",
			"/settings/providers",
			"/settings/tools",
			"/settings/schedules",
			"/settings/archive",
			"/search",
		];
		for (const path of paths) {
			await page.goto(path);
			await expect(page.locator("#root > *").first(), path).toBeAttached();
			await page.waitForLoadState("load");
			// Let the route's first fetches and any lazy chunk settle.
			await page.waitForTimeout(500);
			expect(
				await page.evaluate(
					() => (window as unknown as { __csp: string[] }).__csp,
				),
				path,
			).toEqual([]);
		}
	});
});
