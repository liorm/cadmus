import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import type { ThemeName } from "../../src/theme/theme.ts";
import { expect } from "./fixtures.ts";

export const SCREENS_OUT_DIR = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../../.screens",
);

export const WORKER_BASE = "http://127.0.0.1:8799";

export function ensureScreensDir(): void {
	mkdirSync(SCREENS_OUT_DIR, { recursive: true });
}

const themedPages = new WeakSet<Page>();

/**
 * Opens `path` with `theme` set in storage before first paint.
 * Sets storage prior to a single navigation so boot `/auth/refresh` rotation
 * is never aborted mid-flight by an immediate reload.
 */
export async function openThemed(
	page: Page,
	path: string,
	theme: ThemeName,
): Promise<void> {
	if (!themedPages.has(page)) {
		themedPages.add(page);
		await page.addInitScript((initialTheme) => {
			if (!sessionStorage.getItem("cadmus.screenshot.theme")) {
				sessionStorage.setItem("cadmus.screenshot.theme", initialTheme);
			}
			const active = sessionStorage.getItem("cadmus.screenshot.theme");
			if (active) localStorage.setItem("cadmus.theme", active);
		}, theme);
	}
	if (page.url() !== "about:blank") {
		await page.evaluate((themeName) => {
			sessionStorage.setItem("cadmus.screenshot.theme", themeName);
			localStorage.setItem("cadmus.theme", themeName);
		}, theme);
	}
	await page.goto(path);
	await expect
		.poll(async () =>
			page.evaluate(() => document.documentElement.getAttribute("data-theme")),
		)
		.toBe(theme);
}
