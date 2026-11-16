import { execFileSync } from "node:child_process";
import { expect, test } from "../support/fixtures.ts";

// Auth-independent subject: no sign-in, no master dev config seeded. The tests use a page with setContent and a bundled hook harness.
test.use({ signIn: "none" });

/**
 * The real useScopedResource hook under real React in a browser page, with
 * every read held by hand. A read started by an older request must never count
 * as the answer to a newer retry(), even when it completes before React has
 * committed the retry. Runs once (the hook has no viewport behavior).
 */
let bundle = "";
test.beforeAll(() => {
	const out = test.info().outputPath("harness.js");
	execFileSync(
		"bun",
		[
			"build",
			"tests/support/scoped-resource-harness.tsx",
			"--target=browser",
			`--outfile=${out}`,
		],
		{ cwd: process.cwd() },
	);
	bundle = out;
});

const state = (page: import("@playwright/test").Page) =>
	page.evaluate(() => window.__h.state());

const count = (page: import("@playwright/test").Page) =>
	page.evaluate(() => window.__h.deferreds.length);

for (const outcome of ["resolves", "rejects"] as const) {
	test(`an older read that ${outcome} cannot answer a newer retry request`, async ({
		page,
	}) => {
		await page.setContent('<div id="root"></div>');
		await page.addScriptTag({ path: bundle });
		await expect.poll(() => count(page)).toBe(1);
		await page.evaluate(() => window.__h.deferreds[0]?.resolve("first"));
		await expect
			.poll(() => state(page))
			.toMatchObject({ phase: "ready", data: "first", completed: 0 });

		// retry() #1 starts read #1, which stays held.
		const id1 = await page.evaluate(() => window.__h.retry());
		await expect.poll(() => count(page)).toBe(2);
		expect(id1).toBe(1);

		// retry() #2 is requested and, in the same task, the still-held OLD read
		// #1 settles before React has committed the retry.
		const id2 = await page.evaluate(async (mode) => {
			const id = window.__h.retry();
			const older = window.__h.deferreds[1];
			if (mode === "resolves") older?.resolve("older");
			else older?.reject(new Error("older failed"));
			for (let i = 0; i < 5; i++) await Promise.resolve();
			return id;
		}, outcome);
		expect(id2).toBe(2);
		await expect.poll(() => count(page)).toBe(3);
		await page.waitForTimeout(100);
		// Whatever the old read published, it is not request 2's answer.
		expect((await state(page)).completed).toBeLessThan(id2);

		// The requested read answers: now it is complete.
		await page.evaluate(() => window.__h.deferreds[2]?.resolve("requested"));
		await expect
			.poll(() => state(page))
			.toMatchObject({ data: "requested", completed: 2 });
	});
}

for (const outcome of ["resolves", "rejects"] as const) {
	test(`an old scope's in-flight read that ${outcome} is ignored after a scope change`, async ({
		page,
	}) => {
		await page.setContent('<div id="root"></div>');
		await page.addScriptTag({ path: bundle });
		await expect.poll(() => count(page)).toBe(1);
		await page.evaluate(() => window.__h.deferreds[0]?.resolve("a-data"));
		await expect.poll(() => state(page)).toMatchObject({ data: "a-data" });

		// A retry in scope A is held, then the scope changes to B (also held).
		await page.evaluate(() => window.__h.retry());
		await expect.poll(() => count(page)).toBe(2);
		await page.evaluate(() => window.__h.setScope("b"));
		await expect.poll(() => count(page)).toBe(3);
		expect(await state(page)).toEqual({
			phase: "loading",
			data: undefined,
			error: undefined,
			completed: -1,
		});

		// The A read settles while B is still held: nothing changes.
		await page.evaluate((mode) => {
			const old = window.__h.deferreds[1];
			if (mode === "resolves") old?.resolve("a-late");
			else old?.reject(new Error("a-late failed"));
		}, outcome);
		await page.waitForTimeout(100);
		expect(await state(page)).toEqual({
			phase: "loading",
			data: undefined,
			error: undefined,
			completed: -1,
		});

		await page.evaluate(() => window.__h.deferreds[2]?.resolve("b-data"));
		await expect
			.poll(() => state(page))
			.toMatchObject({ phase: "ready", data: "b-data", error: undefined });
	});
}
