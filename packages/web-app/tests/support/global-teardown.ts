import { readFileSync, rmSync } from "node:fs";
import { writeCoverageReport } from "./coverage.ts";
import { CDP_URL_FILE, ENGINE_PID_FILE } from "./engine.ts";

export default async function globalTeardown() {
	writeCoverageReport();
	try {
		const pid = Number(readFileSync(ENGINE_PID_FILE, "utf8"));
		if (pid) process.kill(pid, "SIGTERM");
	} catch {
		/* already gone */
	}
	rmSync(CDP_URL_FILE, { force: true });
	rmSync(ENGINE_PID_FILE, { force: true });
}
