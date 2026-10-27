import { describe, expect, it } from "bun:test";
import daemonPackage from "../package.json" with { type: "json" };
import {
	DAEMON_USAGE,
	daemonCliArgs,
	formatDaemonHelp,
	parseDaemonArgs,
} from "../src/args.js";
import { DAEMON_VERSION } from "../src/version.js";

describe("daemon cli args", () => {
	it("prints help and version without requiring a connection", () => {
		expect(parseDaemonArgs(["--help"])).toEqual({ kind: "help" });
		expect(parseDaemonArgs(["--help", "--version"])).toEqual({ kind: "help" });
		expect(parseDaemonArgs(["--version"])).toEqual({ kind: "version" });
		expect(
			parseDaemonArgs(["--version", "--url", "ws://example.test/tools-env/ws"]),
		).toEqual({ kind: "version" });
		expect(DAEMON_VERSION).toBe(daemonPackage.version);
		expect(DAEMON_VERSION).toBe("0.1.0");
		const help = formatDaemonHelp();
		for (const flag of [
			"--url",
			"--token",
			"--env-id",
			"--workspace",
			"--persist",
			"--confine",
			"--help",
			"--version",
		]) {
			expect(help).toContain(flag);
		}
		expect(help).toContain(DAEMON_USAGE);
	});

	it("parses run flags and rejects a partial command", () => {
		expect(parseDaemonArgs([])).toEqual({
			kind: "error",
			message: DAEMON_USAGE,
		});
		expect(
			parseDaemonArgs([
				"--url",
				"wss://cadmus.example/tools-env/ws",
				"--token",
				"cadmus_dt_abc",
				"--env-id",
				"ld_laptop",
				"--workspace",
				"/tmp/workspace",
			]),
		).toEqual({
			kind: "run",
			flags: {
				url: "wss://cadmus.example/tools-env/ws",
				token: "cadmus_dt_abc",
				envId: "ld_laptop",
				workspacePath: "/tmp/workspace",
				persist: true,
				confineToWorkspace: false,
			},
		});
		const confined = parseDaemonArgs([
			"--url",
			"ws://127.0.0.1/tools-env/ws",
			"--token",
			"cadmus_dt_abc",
			"--env-id",
			"ld_laptop",
			"--workspace",
			"/tmp/workspace",
			"--persist",
			"false",
			"--confine",
			"true",
		]);
		expect(confined).toMatchObject({
			kind: "run",
			flags: { persist: false, confineToWorkspace: true },
		});
	});

	it("ignores --help and --version when they are values of other flags", () => {
		expect(
			parseDaemonArgs([
				"--url",
				"ws://127.0.0.1/tools-env/ws",
				"--token",
				"cadmus_dt_abc",
				"--env-id",
				"ld_laptop",
				"--workspace",
				"--help",
			]),
		).toEqual({
			kind: "run",
			flags: {
				url: "ws://127.0.0.1/tools-env/ws",
				token: "cadmus_dt_abc",
				envId: "ld_laptop",
				workspacePath: "--help",
				persist: true,
				confineToWorkspace: false,
			},
		});
		expect(
			parseDaemonArgs([
				"--url",
				"ws://127.0.0.1/tools-env/ws",
				"--token",
				"--version",
				"--env-id",
				"ld_laptop",
				"--workspace",
				"/tmp/workspace",
			]),
		).toMatchObject({
			kind: "run",
			flags: { token: "--version", workspacePath: "/tmp/workspace" },
		});
		expect(
			parseDaemonArgs(["--workspace", "/tmp/workspace", "--help"]),
		).toEqual({ kind: "help" });
		expect(parseDaemonArgs(["--token", "cadmus_dt_abc", "--version"])).toEqual({
			kind: "version",
		});
	});

	it("drops the bun script path and keeps compiled-binary flags", () => {
		expect(daemonCliArgs(["bun", "daemon/src/cli.ts", "--help"])).toEqual([
			"--help",
		]);
		expect(
			daemonCliArgs(["bun", "packages/daemon/src/cli.ts", "--help"]),
		).toEqual(["--help"]);
		expect(daemonCliArgs(["./packages/daemon/src/cli.ts", "--help"])).toEqual([
			"--help",
		]);
		expect(
			daemonCliArgs(["/opt/cadmus/cadmus-daemon-linux-arm64", "--version"]),
		).toEqual(["--version"]);
		expect(
			daemonCliArgs(["/opt/cadmus/cadmus-daemon-darwin-arm64", "--version"]),
		).toEqual(["--version"]);
		expect(
			daemonCliArgs(["/opt/cadmus/cadmus-daemon-darwin-x64", "--version"]),
		).toEqual(["--version"]);
		expect(
			daemonCliArgs(["packages/daemon/dist/cadmus-daemon", "--help"]),
		).toEqual(["--help"]);
	});
});
