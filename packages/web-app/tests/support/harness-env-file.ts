/**
 * The real-session harness run hands its per-run token to the dev server
 * through a private env file (`wrangler dev --env-file`), the one supported
 * route that binds only the file's keys. This module creates that file once per
 * run, in the process that owns the run, and removes it again.
 *
 * Playwright loads the config in the runner and again in every worker. Workers
 * are children of the runner, so a process that sees the owner marker equal to
 * its own pid or its parent's pid reuses the run's values; anything else
 * (including a value left over in the environment) starts a new run with a new
 * token and file. Only the process that created the file removes it. A SIGKILL
 * cannot be caught, so it can leave the 0600 file behind.
 */
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const OWNER = "CADMUS_HARNESS_OWNER";
const FILE = "CADMUS_HARNESS_ENV_FILE";
const TOKEN = "CADMUS_HARNESS_TOKEN";

export function prepareHarnessRun(): void {
	const owner = process.env[OWNER];
	if (owner === String(process.pid) || owner === String(process.ppid)) return;
	const token = randomUUID();
	const file = join(
		tmpdir(),
		`cadmus-harness-${process.pid}-${randomUUID()}.env`,
	);
	// "wx": never write through an existing file or link.
	writeFileSync(file, `${TOKEN}=${token}\n`, { mode: 0o600, flag: "wx" });
	process.env[TOKEN] = token;
	process.env[FILE] = file;
	process.env[OWNER] = String(process.pid);
	process.once("exit", removeHarnessEnvFile);
}

/** Removes this process's env file. Does nothing for a file it did not create. */
export function removeHarnessEnvFile(): void {
	const file = process.env[FILE];
	if (!file || process.env[OWNER] !== String(process.pid)) return;
	if (!basename(file).startsWith(`cadmus-harness-${process.pid}-`)) return;
	rmSync(file, { force: true });
}
