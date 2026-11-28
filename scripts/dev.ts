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

const rootDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const wrangler = join(rootDir, "node_modules", ".bin", "wrangler");
const bunBin = process.execPath;

const children = [
	spawn(wrangler, ["dev", "--var", "CADMUS_DEPLOY_ENV:development"], {
		cwd: rootDir,
		stdio: "inherit",
	}),
	spawn(bunBin, ["run", "--cwd", "packages/web-app", "dev"], {
		cwd: rootDir,
		stdio: "inherit",
	}),
	spawn(bunBin, ["run", "--cwd", "packages/login-app", "dev"], {
		cwd: rootDir,
		stdio: "inherit",
	}),
];

let exiting = false;
function shutdown(code = 0) {
	if (exiting) return;
	exiting = true;
	for (const child of children) {
		if (!child.killed) {
			child.kill("SIGTERM");
		}
	}
	process.exit(code);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => shutdown(0));
}

for (const child of children) {
	child.on("exit", (code, signal) => {
		if (exiting) return;
		if (signal) {
			shutdown(1);
			return;
		}
		shutdown(code ?? 1);
	});
}
