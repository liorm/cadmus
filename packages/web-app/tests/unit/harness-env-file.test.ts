import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MODULE = new URL("../support/harness-env-file.ts", import.meta.url)
	.pathname;

/** Runs a script in a fresh process that loads the module. */
function run(body: string, env: Record<string, string> = {}) {
	const res = spawnSync(
		process.execPath,
		[
			"-e",
			`import { prepareHarnessRun, removeHarnessEnvFile } from ${JSON.stringify(MODULE)};\n${body}`,
		],
		{ env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8" },
	);
	return { code: res.status, out: res.stdout.trim(), err: res.stderr };
}

describe("real-session harness env file", () => {
	it("creates a private file with only the token, and removes it on normal exit", () => {
		const res = run(
			`prepareHarnessRun();
const f = process.env.CADMUS_HARNESS_ENV_FILE;
const fs = await import("node:fs");
console.log(JSON.stringify({ f, mode: (fs.statSync(f).mode & 0o777).toString(8), body: fs.readFileSync(f, "utf8"), tok: process.env.CADMUS_HARNESS_TOKEN }));`,
		);
		expect(res.code).toBe(0);
		const seen = JSON.parse(res.out);
		expect(seen.mode).toBe("600");
		expect(seen.body).toBe(`CADMUS_HARNESS_TOKEN=${seen.tok}\n`);
		expect(seen.f).not.toContain(seen.tok);
		expect(existsSync(seen.f)).toBe(false);
	});

	it("removes the file when the process exits early with an error", () => {
		const res = run(
			`prepareHarnessRun(); console.log(process.env.CADMUS_HARNESS_ENV_FILE); process.exit(3);`,
		);
		expect(res.code).toBe(3);
		expect(existsSync(res.out)).toBe(false);
	});

	it("removes the file on an uncaught error", () => {
		const res = run(
			`prepareHarnessRun(); console.log(process.env.CADMUS_HARNESS_ENV_FILE); throw new Error("boom");`,
		);
		expect(res.code).not.toBe(0);
		expect(existsSync(res.out.split("\n")[0] ?? "")).toBe(false);
	});

	it("starts a new run, not a reuse, when the environment carries a stale or foreign run", () => {
		const stale = "/tmp/cadmus-harness-1-stale.env";
		const res = run(
			`prepareHarnessRun(); console.log(JSON.stringify([process.env.CADMUS_HARNESS_ENV_FILE, process.env.CADMUS_HARNESS_TOKEN]));`,
			{
				CADMUS_HARNESS_OWNER: "999999",
				CADMUS_HARNESS_ENV_FILE: stale,
				CADMUS_HARNESS_TOKEN: "stale-token",
			},
		);
		const [file, token] = JSON.parse(res.out) as [string, string];
		expect(file).not.toBe(stale);
		expect(token).not.toBe("stale-token");
	});

	it("does not remove a file it did not create", () => {
		const foreign = join(tmpdir(), `foreign-${process.pid}-${Date.now()}.env`);
		const res = run(
			`const fs = await import("node:fs");
fs.writeFileSync(${JSON.stringify(foreign)}, "keep");
process.env.CADMUS_HARNESS_ENV_FILE = ${JSON.stringify(foreign)};
process.env.CADMUS_HARNESS_OWNER = String(process.pid);
removeHarnessEnvFile();
console.log(String(fs.existsSync(${JSON.stringify(foreign)})));
fs.rmSync(${JSON.stringify(foreign)}, { force: true });`,
		);
		expect(res.out).toBe("true");
	});

	it("a worker (child of the owner) reuses the run and creates nothing", () => {
		const res = run(
			`prepareHarnessRun();
const first = [process.env.CADMUS_HARNESS_ENV_FILE, process.env.CADMUS_HARNESS_TOKEN];
const { spawnSync } = await import("node:child_process");
const child = spawnSync(process.execPath, ["-e", \`import { prepareHarnessRun } from ${JSON.stringify(MODULE)}; prepareHarnessRun(); console.log(JSON.stringify([process.env.CADMUS_HARNESS_ENV_FILE, process.env.CADMUS_HARNESS_TOKEN]));\`], { env: process.env, encoding: "utf8" });
console.log(JSON.stringify({ first, child: JSON.parse(child.stdout) }));`,
		);
		const seen = JSON.parse(res.out) as { first: string[]; child: string[] };
		expect(seen.child).toEqual(seen.first);
		expect(existsSync(seen.first[0] ?? "")).toBe(false);
	});
});
