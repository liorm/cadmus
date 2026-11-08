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
			workspace: undefined,
			configPath: undefined,
		});
		expect(parseDaemonArgs(["start"])).toEqual({
			kind: "start",
			workspace: undefined,
			configPath: undefined,
		});
		expect(parseDaemonArgs(["start", "--config", "/tmp/cadmus.json"])).toEqual({
			kind: "start",
			workspace: undefined,
			configPath: "/tmp/cadmus.json",
		});
		expect(
			parseDaemonArgs([
				"start",
				"--workspace",
				"proj",
				"--config",
				"/tmp/c.json",
			]),
		).toEqual({
			kind: "start",
			workspace: "proj",
			configPath: "/tmp/c.json",
		});
		expect(parseDaemonArgs(["--config", "/tmp/cadmus.json"])).toEqual({
			kind: "start",
			workspace: undefined,
			configPath: "/tmp/cadmus.json",
		});
	});

	it("parses pair command with token and optional name", () => {
		expect(parseDaemonArgs(["pair", "cadmus_pt_test123"])).toEqual({
			kind: "pair",
			token: "cadmus_pt_test123",
			name: undefined,
			workspace: undefined,
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
			workspace: undefined,
			configPath: "/tmp/custom.json",
		});

		// Direct token pass without "pair" prefix
		expect(
			parseDaemonArgs(["cadmus_pt_direct_token", "--name", "Office Mac"]),
		).toEqual({
			kind: "pair",
			token: "cadmus_pt_direct_token",
			name: "Office Mac",
			workspace: undefined,
			configPath: undefined,
		});
	});

	it("parses start command with configuration flags", () => {
		expect(
			parseDaemonArgs([
				"start",
				"--url",
				"wss://cadmus.example/ws",
				"--token",
				"cadmus_dt_test_token",
				"--env-id",
				"ld_test_env",
				"--name",
				"CLI Machine",
				"--persist",
				"false",
				"--confine",
				"true",
				"--save",
			]),
		).toEqual({
			kind: "start",
			workspace: undefined,
			configPath: undefined,
			url: "wss://cadmus.example/ws",
			token: "cadmus_dt_test_token",
			envId: "ld_test_env",
			name: "CLI Machine",
			persist: false,
			confineToWorkspace: true,
			save: true,
		});

		// Without explicit "start" subcommand
		expect(
			parseDaemonArgs([
				"--url",
				"wss://cadmus.example/ws",
				"--token",
				"cadmus_dt_test_token",
				"--env-id",
				"ld_test_env",
			]),
		).toEqual({
			kind: "start",
			workspace: undefined,
			configPath: undefined,
			url: "wss://cadmus.example/ws",
			token: "cadmus_dt_test_token",
			envId: "ld_test_env",
		});
	});

	it("parses boolean flags in multiple forms", () => {
		// Standalone --persist and --confine
		expect(parseDaemonArgs(["--persist", "--confine"])).toEqual({
			kind: "start",
			workspace: undefined,
			configPath: undefined,
			persist: true,
			confineToWorkspace: true,
		});

		// Negative forms --no-persist and --no-confine
		expect(parseDaemonArgs(["--no-persist", "--no-confine"])).toEqual({
			kind: "start",
			workspace: undefined,
			configPath: undefined,
			persist: false,
			confineToWorkspace: false,
		});

		// Explicit true/false
		expect(
			parseDaemonArgs(["--persist", "true", "--confine-to-workspace", "false"]),
		).toEqual({
			kind: "start",
			workspace: undefined,
			configPath: undefined,
			persist: true,
			confineToWorkspace: false,
		});
	});

	it("parses --flag=value format", () => {
		expect(
			parseDaemonArgs([
				"--url=wss://cadmus.example/ws",
				"--token=cadmus_dt_123",
				"--envId=ld_test",
				"--name=Custom",
				"--persist=false",
				"--confine=true",
			]),
		).toEqual({
			kind: "start",
			workspace: undefined,
			configPath: undefined,
			url: "wss://cadmus.example/ws",
			token: "cadmus_dt_123",
			envId: "ld_test",
			name: "Custom",
			persist: false,
			confineToWorkspace: true,
		});
	});

	it("parses config get and config set commands", () => {
		expect(parseDaemonArgs(["config", "get"])).toEqual({
			kind: "config",
			action: "get",
			key: undefined,
			configPath: undefined,
		});

		expect(parseDaemonArgs(["config", "get", "url"])).toEqual({
			kind: "config",
			action: "get",
			key: "url",
			configPath: undefined,
		});

		expect(
			parseDaemonArgs([
				"config",
				"set",
				"persist",
				"false",
				"--config",
				"/tmp/custom.json",
			]),
		).toEqual({
			kind: "config",
			action: "set",
			key: "persist",
			value: "false",
			configPath: "/tmp/custom.json",
		});

		// Missing key or value
		expect(parseDaemonArgs(["config", "set"])).toEqual({
			kind: "error",
			message: expect.stringContaining("Missing key or value"),
		});

		expect(parseDaemonArgs(["config", "set", "name"])).toEqual({
			kind: "error",
			message: expect.stringContaining("Missing key or value"),
		});

		// Unknown action
		expect(parseDaemonArgs(["config", "unknown"])).toEqual({
			kind: "error",
			message: expect.stringContaining("Unknown config action"),
		});
	});

	it("parses pair command with config overrides", () => {
		expect(
			parseDaemonArgs([
				"pair",
				"cadmus_pt_test123",
				"--persist",
				"false",
				"--confine",
				"true",
				"--url",
				"wss://custom.example/ws",
			]),
		).toEqual({
			kind: "pair",
			token: "cadmus_pt_test123",
			name: undefined,
			workspace: undefined,
			configPath: undefined,
			persist: false,
			confineToWorkspace: true,
			url: "wss://custom.example/ws",
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
