import type { Dialog, Page } from "@playwright/test";
import { seedBot, sendAccountRpc } from "../support/account.ts";
import { clickByRole } from "../support/actions.ts";
import { expect, test } from "../support/fixtures.ts";

// Ordinary user-level journey: signs in through token login with the user-role grants, no master token.
test.use({ signIn: "user" });

/**
 * The real browser prompt, not a synthetic event. Chrome only shows the
 * beforeunload prompt after the user has interacted with the page, so these
 * use real clicks and key presses. They need a real Chromium: Obscura does not
 * run page.close({ runBeforeUnload: true }) dialogs. Run with --engine=chrome.
 */
test.skip(
	process.env.CADMUS_TEST_ENGINE !== "chrome",
	"native beforeunload needs real Chrome (--engine=chrome)",
);

const WORKER_BASE = "http://127.0.0.1:8799";

async function openSoulEditor(
	page: Page,
	origin: string,
	accountId: string,
): Promise<void> {
	await seedBot(origin, accountId, "Echo Bot", "echo-bot");
	await sendAccountRpc(origin, accountId, "file.write", {
		botId: "echo-bot",
		path: "SOUL.md",
		content: "# Soul\n\nCalm.",
	});
	await page.goto("/bot/echo-bot/soul");
	await clickByRole(page, "button", "Edit");
	await page.getByLabel("SOUL.md source").click();
}

/** Close the page and report which beforeunload dialogs the browser raised. */
async function closeAndCollect(page: Page, answer: "accept" | "dismiss") {
	const dialogs: string[] = [];
	page.on("dialog", (dialog: Dialog) => {
		dialogs.push(dialog.type());
		void (answer === "accept" ? dialog.accept() : dialog.dismiss());
	});
	await page.close({ runBeforeUnload: true });
	await expect.poll(() => page.isClosed() || dialogs.length > 0).toBe(true);
	return dialogs;
}

test("native: closing with unsaved soul edits raises the prompt and Stay keeps the draft", async ({
	page,
	accountId,
	baseURL,
}) => {
	await openSoulEditor(page, baseURL ?? WORKER_BASE, accountId);
	await page.keyboard.press("End");
	await page.keyboard.type(" Restless.");
	await expect(page.getByText("Unsaved changes")).toBeVisible();
	const dialogs: string[] = [];
	page.on("dialog", (dialog) => {
		dialogs.push(dialog.type());
		void dialog.dismiss();
	});
	await page.close({ runBeforeUnload: true });
	await expect.poll(() => dialogs).toEqual(["beforeunload"]);
	// Stay: the page is still open and the draft is intact.
	expect(page.isClosed()).toBe(false);
	await expect(page.getByLabel("SOUL.md source")).toHaveValue(/Restless\./);
	await expect(page.getByText("Unsaved changes")).toBeVisible();
});

test("native: closing with no edits, or after saving, raises no prompt", async ({
	page,
	accountId,
	baseURL,
}) => {
	await openSoulEditor(page, baseURL ?? WORKER_BASE, accountId);
	await page.keyboard.press("End");
	await page.keyboard.type("x");
	await expect(page.getByText("Unsaved changes")).toBeVisible();
	await clickByRole(page, "button", "Save");
	await expect(page.getByText("Unsaved changes")).toHaveCount(0);
	expect(await closeAndCollect(page, "dismiss")).toEqual([]);
	await expect.poll(() => page.isClosed()).toBe(true);
});

test("native: reverting the edit by hand clears the prompt", async ({
	page,
	accountId,
	baseURL,
}) => {
	await openSoulEditor(page, baseURL ?? WORKER_BASE, accountId);
	await page.keyboard.press("End");
	await page.keyboard.type("zz");
	await expect(page.getByText("Unsaved changes")).toBeVisible();
	await page.keyboard.press("Backspace");
	await page.keyboard.press("Backspace");
	await expect(page.getByText("Unsaved changes")).toHaveCount(0);
	expect(await closeAndCollect(page, "dismiss")).toEqual([]);
	await expect.poll(() => page.isClosed()).toBe(true);
});

test("native: discarding through in-app navigation leaves no stale prompt", async ({
	page,
	accountId,
	baseURL,
}) => {
	await openSoulEditor(page, baseURL ?? WORKER_BASE, accountId);
	await page.keyboard.press("End");
	await page.keyboard.type("q");
	await expect(page.getByText("Unsaved changes")).toBeVisible();
	page.once("dialog", (dialog) => void dialog.accept());
	await clickByRole(page, "radio", "Memory");
	await expect(page.getByText("Unsaved changes")).toHaveCount(0);
	expect(await closeAndCollect(page, "dismiss")).toEqual([]);
	await expect.poll(() => page.isClosed()).toBe(true);
});
