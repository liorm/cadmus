import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { resetCoverageRaw } from "./coverage.ts";
import {
	CDP_URL_FILE,
	isPerWorkerEngine,
	parseEngine,
	startEngine,
} from "./engine.ts";

export default async function globalSetup() {
	resetCoverageRaw();
	const engine = parseEngine();
	if (engine === "chrome") return;
	if (isPerWorkerEngine(engine)) return;
	const handle = await startEngine(engine);
	if (handle.cdpUrl) {
		process.env.CADMUS_TEST_CDP_URL = handle.cdpUrl;
		mkdirSync(dirname(CDP_URL_FILE), { recursive: true });
		writeFileSync(CDP_URL_FILE, handle.cdpUrl, "utf8");
	}
}
