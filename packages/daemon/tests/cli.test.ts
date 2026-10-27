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
		expect(DAEMON_VERSION).toBe(daemonPackage.version);
		expect(DAEMON_VERSION).toBe("0.1.0");
		const help = formatDaemonHelp();
		expect(help).toContain("--help");
		expect(help).toContain("--version");
		expect(help).toContain("pair <token>");
		expect(help).toContain("start");
		expect(help).toContain("deregister");
		expect(help).toContain(DAEMON_USAGE);
	});

	it("parses start command with or without explicit subcommand", () => {
		expect(parseDaemonArgs([])).toEqual({
			kind: "start",
			configPath: undefined,
		});
		expect(parseDaemonArgs(["start"])).toEqual({
			kind: "start",
			configPath: undefined,
		});
		expect(parseDaemonArgs(["start", "--config", "/tmp/cadmus.json"])).toEqual({
			kind: "start",
			configPath: "/tmp/cadmus.json",
		});
		expect(parseDaemonArgs(["--config", "/tmp/cadmus.json"])).toEqual({
			kind: "start",
			configPath: "/tmp/cadmus.json",
		});
	});

	it("parses pair command with token and optional name", () => {
		expect(parseDaemonArgs(["pair", "cadmus_pt_test123"])).toEqual({
			kind: "pair",
			token: "cadmus_pt_test123",
			name: undefined,
			configPath: undefined,
		});

		expect(
			parseDaemonArgs([
				"pair",
				"cadmus_pt_test123",
				"--name",
				"MacBook Pro",
				"--config",
				"/tmp/custom.json",
			]),
		).toEqual({
			kind: "pair",
			token: "cadmus_pt_test123",
			name: "MacBook Pro",
			configPath: "/tmp/custom.json",
		});

		// Direct token pass without "pair" prefix
		expect(
			parseDaemonArgs(["cadmus_pt_direct_token", "--name", "Office Mac"]),
		).toEqual({
			kind: "pair",
			token: "cadmus_pt_direct_token",
			name: "Office Mac",
			configPath: undefined,
		});
	});

	it("parses deregister command", () => {
		expect(parseDaemonArgs(["deregister"])).toEqual({
			kind: "deregister",
			configPath: undefined,
		});
		expect(
			parseDaemonArgs(["deregister", "--config", "/tmp/custom.json"]),
		).toEqual({
			kind: "deregister",
			configPath: "/tmp/custom.json",
		});
	});

	it("rejects invalid commands or missing tokens", () => {
		expect(parseDaemonArgs(["pair"])).toEqual({
			kind: "error",
			message: expect.stringContaining("Missing pairing token"),
		});
		expect(parseDaemonArgs(["invalid_cmd"])).toEqual({
			kind: "error",
			message: expect.stringContaining("Unknown command"),
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
