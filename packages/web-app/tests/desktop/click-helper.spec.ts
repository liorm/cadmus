import { clickByRole } from "../support/actions.ts";
import { expect, test } from "../support/fixtures.ts";

// Auth-independent subject: no sign-in, no master dev config seeded. The tests use a fake page or a route-fulfilled fixture.
test.use({ signIn: "none" });

const FIXTURE = "/__click-helper-fixture";

/**
 * The post-dispatch rule is tested with a fake page and locator, so it does
 * not depend on how an engine schedules navigations. The error texts below
 * are real Playwright 1.64.1 messages captured on the Obscura engine
 * (call logs of a click that dispatched and one that was covered).
 *
 * `clickByRole` may fall back to a DOM click only when the real click provably
 * never dispatched. A click whose call log reached "click action done", or
 * that is still inside "performing click action" and was not intercepted,
 * resolves and is not repeated. A parent that intercepts the pointer falls
 * back even if the log also says "performing click action".
 *
 * These fakes have no geometry, so they exercise that classification. A real
 * page hit-tests first: a control that is not the element under its own
 * center gets one DOM click and no pointer event.
 */
const POST_DISPATCH = `locator.click: Timeout 800ms exceeded.
Call log:
  - waiting for getByRole('button', { name: 'Go' })
    - locator resolved to <button>Go</button>
  - attempting click action
    - waiting for element to be visible, enabled and stable
    - element is visible, enabled and stable
    - scrolling into view if needed
    - done scrolling
    - performing click action
    - click action done
    - waiting for scheduled navigations to finish
`;
const COVERED = `locator.click: Timeout 800ms exceeded.
Call log:
  - waiting for getByRole('button', { name: 'Go' })
    - locator resolved to <button>Go</button>
  - attempting click action
    2 \u00d7 waiting for element to be visible, enabled and stable
      - element is visible, enabled and stable
      - scrolling into view if needed
      - done scrolling
      - <div></div> intercepts pointer events
    - retrying click action
`;
// Obscura 1.64.1 logs the attempt line before reporting the parent that
// intercepted it. "performing click action" here does not mean the click landed.
const COVERED_ATTEMPT = `locator.click: Timeout 800ms exceeded.
Call log:
  - waiting for getByRole('button', { name: 'Go' })
    - locator resolved to <button>Go</button>
  - attempting click action
    - waiting for element to be visible, enabled and stable
    - element is visible, enabled and stable
    - scrolling into view if needed
    - done scrolling
    - performing click action
    - <div></div> intercepts pointer events
  - retrying click action
`;
const MISSING = `locator.click: Timeout 800ms exceeded.
Call log:
  - waiting for getByRole('button', { name: 'Go' })
`;
const STRICT = `locator.click: Error: strict mode violation: getByRole('button', { name: 'Go' }) resolved to 2 elements:
    1) <button>Go</button> aka getByRole('button', { name: 'Go' }).first()
    2) <button>Go</button> aka getByRole('button', { name: 'Go' }).nth(1)`;

function fakePage(clickError: Error | undefined, matched = 1) {
	const counts = { clicks: 0, fallbacks: 0, scopedFallbacks: 0 };
	const locator = (scoped: boolean) => ({
		click: async () => {
			counts.clicks += 1;
			if (clickError) throw clickError;
		},
		evaluate: async () => {
			if (scoped) counts.scopedFallbacks += 1;
			else counts.fallbacks += 1;
			return matched;
		},
	});
	const scope = {
		getByRole: () => locator(true),
		evaluate: locator(true).evaluate,
	};
	const page = {
		getByRole: () => locator(false),
		locator: () => locator(false),
	};
	return {
		page: page as unknown as import("@playwright/test").Page,
		scope: scope as unknown as import("@playwright/test").Locator,
		counts,
	};
}

test("a click that finished dispatching resolves and is not repeated", async () => {
	const { page, counts } = fakePage(new Error(POST_DISPATCH));
	await clickByRole(page, "button", "Go");
	expect(counts).toEqual({ clicks: 1, fallbacks: 0, scopedFallbacks: 0 });
});

const MID_DISPATCH = `locator.click: Timeout 800ms exceeded.
Call log:
  - waiting for getByRole('button', { name: 'Go' })
    - locator resolved to <button>Go</button>
  - attempting click action
    - waiting for element to be visible, enabled and stable
    - element is visible, enabled and stable
    - scrolling into view if needed
    - done scrolling
    - performing click action
`;

test("a click still performing its action resolves and is not repeated", async () => {
	const { page, counts } = fakePage(new Error(MID_DISPATCH));
	await clickByRole(page, "button", "Go");
	expect(counts).toEqual({ clicks: 1, fallbacks: 0, scopedFallbacks: 0 });
});

test("an unknown error from the click is rethrown without a fallback", async () => {
	const { page, counts } = fakePage(new Error("Target page has been closed"));
	await expect(clickByRole(page, "button", "Go")).rejects.toThrow(
		/Target page has been closed/,
	);
	expect(counts).toEqual({ clicks: 1, fallbacks: 0, scopedFallbacks: 0 });
});

for (const [label, text] of [
	["covered element", COVERED],
	["covered element after a click attempt", COVERED_ATTEMPT],
	["missing element", MISSING],
] as const) {
	test(`a click that never dispatched (${label}) falls back to exactly one DOM click`, async () => {
		const { page, counts } = fakePage(new Error(text));
		await clickByRole(page, "button", "Go");
		expect(counts).toEqual({ clicks: 1, fallbacks: 1, scopedFallbacks: 0 });
	});
}

test("an ambiguous locator rethrows instead of clicking the first match", async () => {
	const { page, counts } = fakePage(new Error(STRICT));
	await expect(clickByRole(page, "button", "Go")).rejects.toThrow(
		/strict mode violation/,
	);
	expect(counts).toEqual({ clicks: 1, fallbacks: 0, scopedFallbacks: 0 });
});

test("a scoped click and its fallback stay inside the scope", async () => {
	const { page, scope, counts } = fakePage(new Error(MISSING));
	await clickByRole(page, "button", "Go", { within: scope });
	expect(counts).toEqual({ clicks: 1, fallbacks: 0, scopedFallbacks: 1 });
});

test("a pre-dispatch failure with several fallback matches clicks nothing and reports the count", async () => {
	const { page, counts } = fakePage(new Error(MISSING), 2);
	await expect(clickByRole(page, "button", "Go")).rejects.toThrow(
		/2 buttons match "Go"; nothing was clicked/,
	);
	expect(counts).toEqual({ clicks: 1, fallbacks: 1, scopedFallbacks: 0 });
});

test("a pre-dispatch failure whose fallback finds nothing still fails", async () => {
	const { page, counts } = fakePage(new Error(MISSING), 0);
	await expect(clickByRole(page, "button", "Go")).rejects.toThrow(
		/no button named "Go"/,
	);
	expect(counts).toEqual({ clicks: 1, fallbacks: 1, scopedFallbacks: 0 });
});

async function serveFixture(
	page: import("@playwright/test").Page,
	body: string,
): Promise<void> {
	await page.route(`**${FIXTURE}`, (route) =>
		route.fulfill({
			status: 200,
			contentType: "text/html",
			body: `<!doctype html><html><body>${body}</body></html>`,
		}),
	);
	await page.route("**/__slow", async (route) => {
		await new Promise((resolve) => setTimeout(resolve, 3_000));
		await route.fulfill({
			status: 200,
			contentType: "text/html",
			body: "<p>slow</p>",
		});
	});
	await page.goto(FIXTURE);
}

test("a button that is the hit target receives one click", async ({ page }) => {
	await serveFixture(
		page,
		`<button id="go" onclick="window.__n = (window.__n || 0) + 1">Go</button>`,
	);
	await clickByRole(page, "button", "Go");
	expect(await page.evaluate(() => (window as { __n?: number }).__n ?? 0)).toBe(
		1,
	);
});

test("a covered button is activated without waiting out the click budget", async ({
	page,
}) => {
	await serveFixture(
		page,
		`<button id="go" onclick="window.__n = (window.__n || 0) + 1">Go</button>
		<div style="position:fixed;inset:0;z-index:10"></div>`,
	);
	const started = Date.now();
	await clickByRole(page, "button", "Go", { timeout: 8_000 });
	expect(Date.now() - started).toBeLessThan(3_000);
	expect(await page.evaluate(() => (window as { __n?: number }).__n ?? 0)).toBe(
		1,
	);
});

test("a click that cannot dispatch falls back to exactly one DOM click", async ({
	page,
}) => {
	await serveFixture(
		page,
		`<button id="go" onclick="window.__n = (window.__n || 0) + 1">Go</button>
		<div style="position:fixed;inset:0;z-index:10"></div>`,
	);
	await clickByRole(page, "button", "Go", { timeout: 500 });
	expect(await page.evaluate(() => (window as { __n?: number }).__n ?? 0)).toBe(
		1,
	);
});

test("a fallback that finds no matching element fails instead of passing silently", async ({
	page,
}) => {
	await serveFixture(page, `<p>nothing clickable here</p>`);
	await expect(
		clickByRole(page, "button", "Missing", { timeout: 300 }),
	).rejects.toThrow(/no button named "Missing"/);
});

const COVER = `<div style="position:fixed;inset:0;z-index:10"></div>`;

test("the DOM fallback honours exact matching and ignores whitespace between elements", async ({
	page,
}) => {
	await serveFixture(
		page,
		`<button onclick="window.__hit = 'tool'"><span>Tool environments</span><span>account.toolsEnvs</span></button>
		<button onclick="window.__hit = 'account'"><span>Account</span><span>account.get</span></button>${COVER}`,
	);
	await clickByRole(page, "button", "Account account.get", { timeout: 300 });
	expect(await page.evaluate(() => (window as { __hit?: string }).__hit)).toBe(
		"account",
	);
});

test("exact matching clicks only the exact label when a longer one also contains it", async ({
	page,
}) => {
	await serveFixture(
		page,
		`<button onclick="window.__hit = 'later'">Go later</button>
		<button onclick="window.__hit = 'go'">Go</button>${COVER}`,
	);
	await clickByRole(page, "button", "Go", { timeout: 300, exact: true });
	expect(await page.evaluate(() => (window as { __hit?: string }).__hit)).toBe(
		"go",
	);
});

test("a scoped fallback does not click a matching element outside the scope", async ({
	page,
}) => {
	await serveFixture(
		page,
		`<button onclick="window.__hit = 'outside'">Go</button>
		<section id="box"><button onclick="window.__hit = 'inside'">Go</button></section>${COVER}`,
	);
	await clickByRole(page, "button", "Go", {
		timeout: 300,
		within: page.locator("#box"),
	});
	expect(await page.evaluate(() => (window as { __hit?: string }).__hit)).toBe(
		"inside",
	);
});

test("two DOM matches in the fallback reject and click neither", async ({
	page,
}) => {
	// aria-hidden buttons are not in the role tree, so the locator finds
	// nothing (a pre-dispatch failure) while the DOM fallback sees both.
	await serveFixture(
		page,
		`<button aria-hidden="true" onclick="window.__hit = 'a'">Go</button>
		<button aria-hidden="true" onclick="window.__hit = 'b'">Go</button>`,
	);
	await expect(
		clickByRole(page, "button", "Go", { timeout: 300 }),
	).rejects.toThrow(/2 buttons match "Go"; nothing was clicked/);
	expect(
		await page.evaluate(() => (window as { __hit?: string }).__hit ?? "none"),
	).toBe("none");
});

// The fallback name is built the way a browser names a button from content:
// a descendant with its own aria-label contributes that label, not its text.
// aria-hidden on the button itself keeps the locator from finding it, so the
// DOM fallback is the only path that can click it.
test("the DOM fallback names a button from a labelled descendant, not its text", async ({
	page,
}) => {
	await serveFixture(
		page,
		`<button aria-hidden="true" onclick="window.__hit = 'row'">Title<span role="status" aria-label="Unread">dot</span><span>Bot</span></button>`,
	);
	await clickByRole(page, "button", "Title Unread Bot", { timeout: 300 });
	expect(await page.evaluate(() => (window as { __hit?: string }).__hit)).toBe(
		"row",
	);
});

test("the DOM fallback does not match the text a labelled descendant replaces", async ({
	page,
}) => {
	await serveFixture(
		page,
		`<button aria-hidden="true" onclick="window.__hit = 'row'">Title<span role="status" aria-label="Unread">dot</span></button>`,
	);
	await expect(
		clickByRole(page, "button", "Titledot", { timeout: 300 }),
	).rejects.toThrow(/no button named "Titledot" to click/);
});

test("the DOM fallback prefers the button's own aria-label over its content", async ({
	page,
}) => {
	await serveFixture(
		page,
		`<button aria-hidden="true" aria-label="Own name" onclick="window.__hit = 'own'">Other text</button>`,
	);
	await expect(
		clickByRole(page, "button", "Other text", { timeout: 300 }),
	).rejects.toThrow(/no button named "Other text" to click/);
	await clickByRole(page, "button", "Own name", { timeout: 300 });
	expect(await page.evaluate(() => (window as { __hit?: string }).__hit)).toBe(
		"own",
	);
});
