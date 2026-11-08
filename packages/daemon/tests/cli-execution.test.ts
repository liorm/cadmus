import { describe, expect, it } from "bun:test";
import { spawn } from "node:child_process";
import { join } from "node:path";
import {
	deleteDaemonConfig,
	loadDaemonConfig,
	saveDaemonConfig,
} from "../src/config.js";

function runCli(
	args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	return new Promise((resolve) => {
		const child = spawn(
			"bun",
			[join(import.meta.dir, "../src/cli.ts"), ...args],
			{
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (d) => {
			stdout += d.toString();
		});
		child.stderr.on("data", (d) => {
			stderr += d.toString();
		});
		child.on("close", (code) => {
			resolve({ stdout, stderr, exitCode: code ?? 0 });
		});
	});
}

describe("daemon cli execution", () => {
	it("executes config set and config get commands", async () => {
		const testConfigPath = `/tmp/test-exec-cfg-${crypto.randomUUID()}.json`;

		await saveDaemonConfig(
			{
				url: "wss://initial.example/ws",
				envId: "ld_exec_env",
				persist: true,
				confineToWorkspace: false,
				name: "Original Name",
				token: "cadmus_dt_original",
			},
			testConfigPath,
		);

		// Get name
		const getName = await runCli([
			"config",
			"get",
			"name",
			"--config",
			testConfigPath,
		]);
		expect(getName.exitCode).toBe(0);
		expect(getName.stdout.trim()).toBe("Original Name");

		// Set name
		const setName = await runCli([
			"config",
			"set",
			"name",
			"Renamed Box",
			"--config",
			testConfigPath,
		]);
		expect(setName.exitCode).toBe(0);

		// Get name again
		const getRenamed = await runCli([
			"config",
			"get",
			"name",
			"--config",
			testConfigPath,
		]);
		expect(getRenamed.exitCode).toBe(0);
		expect(getRenamed.stdout.trim()).toBe("Renamed Box");

		// Set persist to false
		const setPersist = await runCli([
			"config",
			"set",
			"persist",
			"false",
			"--config",
			testConfigPath,
		]);
		expect(setPersist.exitCode).toBe(0);

		const getPersist = await runCli([
			"config",
			"get",
			"persist",
			"--config",
			testConfigPath,
		]);
		expect(getPersist.exitCode).toBe(0);
		expect(getPersist.stdout.trim()).toBe("false");

		// Get full JSON
		const getFull = await runCli(["config", "get", "--config", testConfigPath]);
		expect(getFull.exitCode).toBe(0);
		const parsed = JSON.parse(getFull.stdout);
		expect(parsed.name).toBe("Renamed Box");
		expect(parsed.persist).toBe(false);
		expect(parsed.envId).toBe("ld_exec_env");

		await deleteDaemonConfig(testConfigPath);
	});

	it("saves config from command-line flags when --save is passed", async () => {
		const testConfigPath = `/tmp/test-exec-save-${crypto.randomUUID()}.json`;

		const child = spawn(
			"bun",
			[
				join(import.meta.dir, "../src/cli.ts"),
				"start",
				"--url",
				"http://127.0.0.1:9999/not-found",
				"--token",
				"cadmus_dt_cli_token",
				"--env-id",
				"ld_cli_env",
				"--name",
				"Saved From CLI",
				"--persist",
				"false",
				"--save",
				"--config",
				testConfigPath,
			],
			{
				stdio: ["ignore", "pipe", "pipe"],
			},
		);

		// Wait for config file to be written
		for (let i = 0; i < 50; i++) {
			const loaded = await loadDaemonConfig(testConfigPath);
			if (loaded) break;
			await new Promise((r) => setTimeout(r, 50));
		}

		child.kill();

		const loaded = await loadDaemonConfig(testConfigPath);
		expect(loaded).not.toBeNull();
		expect(loaded?.config.url).toBe("http://127.0.0.1:9999/not-found");
		expect(loaded?.config.envId).toBe("ld_cli_env");
		expect(loaded?.config.name).toBe("Saved From CLI");
		expect(loaded?.config.persist).toBe(false);
		expect(loaded?.token).toBe("cadmus_dt_cli_token");

		await deleteDaemonConfig(testConfigPath);
	});

	it("fails with exit code 1 when not paired and missing required options", async () => {
		const nonExistentPath = `/tmp/non-existent-${crypto.randomUUID()}.json`;
		const res = await runCli(["start", "--config", nonExistentPath]);
		expect(res.exitCode).toBe(1);
		expect(res.stdout + res.stderr).toContain("daemon.configNotFound");
	});
});
