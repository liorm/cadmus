/**
 * Starts the local worker only when `.dev.vars` enables dev-password login.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DEV_VARS_FILE, devLoginHelp, devLoginProblems } from "./dev-login.ts";

function readVars(): string | null {
	try {
		return readFileSync(DEV_VARS_FILE, "utf8");
	} catch {
		return null;
	}
}

const problems = devLoginProblems(readVars());
if (problems.length > 0) {
	process.stderr.write(`${devLoginHelp()}\n\n${problems.join("\n")}\n`);
	process.exit(1);
}

const wrangler = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"node_modules",
	".bin",
	"wrangler",
);
const child = spawn(
	wrangler,
	["dev", "--var", "CADMUS_DEPLOY_ENV:development"],
	{
		stdio: "inherit",
	},
);
child.on("exit", (code, signal) => {
	if (signal) process.kill(process.pid, signal);
	process.exit(code ?? 1);
});
