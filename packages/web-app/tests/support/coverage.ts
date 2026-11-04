/**
 * Istanbul coverage for Playwright flows. The Vite build instruments
 * `src/` only when `CADMUS_COVERAGE=1` (see vite.config.ts). Obscura does
 * not expose V8 `page.coverage`, so each test reads `window.__coverage__`.
 * Reports match the worker e2e run: text, json-summary, and html under
 * `coverage/web-app`. There is no coverage threshold.
 */
import {
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";
import type { CoverageMap, CoverageMapData } from "istanbul-lib-coverage";

const require = createRequire(import.meta.url);
const { createCoverageMap } = require("istanbul-lib-coverage") as {
	createCoverageMap: (data: CoverageMapData) => CoverageMap;
};
const { createContext } = require("istanbul-lib-report") as {
	createContext: (opts: { dir: string; coverageMap: CoverageMap }) => object;
};
const reports = require("istanbul-reports") as {
	create: (
		name: string,
		opts: object,
	) => { execute: (context: object) => void };
};

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, "../..");
const repoRoot = resolve(packageRoot, "../..");

export const COVERAGE_RAW = resolve(packageRoot, ".coverage-raw");
export const COVERAGE_OUT = resolve(repoRoot, "coverage/web-app");

export function coverageEnabled(): boolean {
	return process.env.CADMUS_COVERAGE === "1";
}

export function resetCoverageRaw(): void {
	if (!coverageEnabled()) return;
	rmSync(COVERAGE_RAW, { recursive: true, force: true });
	mkdirSync(COVERAGE_RAW, { recursive: true });
}

export async function captureCoverage(page: Page, id: string): Promise<void> {
	if (!coverageEnabled()) return;
	const data = await page.evaluate(() => {
		const bag = globalThis as { __coverage__?: CoverageMapData };
		return bag.__coverage__ ?? null;
	});
	if (!data) return;
	mkdirSync(COVERAGE_RAW, { recursive: true });
	const safe = id.replace(/[^a-zA-Z0-9._-]/g, "_");
	writeFileSync(resolve(COVERAGE_RAW, `${safe}.json`), JSON.stringify(data));
}

function isWebAppSource(file: string): boolean {
	const norm = file.replaceAll("\\", "/");
	return (
		norm.includes("/packages/web-app/src/") &&
		!norm.includes(".test.") &&
		!norm.includes("/node_modules/")
	);
}

export function writeCoverageReport(): void {
	if (!coverageEnabled()) return;
	const map = createCoverageMap({});
	let files: string[] = [];
	try {
		files = readdirSync(COVERAGE_RAW).filter((name) => name.endsWith(".json"));
	} catch {
		files = [];
	}
	if (files.length === 0) {
		throw new Error(
			"CADMUS_COVERAGE=1 but no window.__coverage__ was collected. The Vite build was not instrumented.",
		);
	}
	for (const name of files) {
		const raw = JSON.parse(
			readFileSync(resolve(COVERAGE_RAW, name), "utf8"),
		) as CoverageMapData;
		const filtered: CoverageMapData = {};
		for (const [file, entry] of Object.entries(raw)) {
			if (isWebAppSource(file)) filtered[file] = entry;
		}
		map.merge(filtered);
	}
	if (map.files().length === 0) {
		throw new Error("Coverage data had no packages/web-app/src files.");
	}
	rmSync(COVERAGE_OUT, { recursive: true, force: true });
	mkdirSync(COVERAGE_OUT, { recursive: true });
	const context = createContext({ dir: COVERAGE_OUT, coverageMap: map });
	for (const name of ["text", "json-summary", "html"] as const) {
		reports.create(name, {}).execute(context);
	}
	process.stdout.write(`web-app coverage written to ${COVERAGE_OUT}\n`);
}
