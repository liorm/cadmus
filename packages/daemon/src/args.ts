export const DAEMON_USAGE =
	"usage:\n  cadmus-daemon [pair] <token> [--name <name>] [--workspace <path>] [--config <path>]\n  cadmus-daemon [start] [options]\n  cadmus-daemon config set <key> <value> [--config <path>]\n  cadmus-daemon config get [key] [--config <path>]\n  cadmus-daemon deregister [--config <path>]\n  cadmus-daemon --help | --version";

export type ParsedDaemonArgs =
	| { kind: "help" }
	| { kind: "version" }
	| {
			kind: "pair";
			token: string;
			name?: string;
			workspace?: string;
			configPath?: string;
			url?: string;
			persist?: boolean;
			confineToWorkspace?: boolean;
	  }
	| {
			kind: "start";
			workspace?: string;
			configPath?: string;
			url?: string;
			token?: string;
			envId?: string;
			name?: string;
			persist?: boolean;
			confineToWorkspace?: boolean;
			save?: boolean;
	  }
	| {
			kind: "config";
			action: "get" | "set";
			key?: string;
			value?: string;
			configPath?: string;
	  }
	| { kind: "deregister"; configPath?: string }
	| { kind: "error"; message: string };

/**
 * Args after the executable. `bun path/cli.ts` inserts the script at argv[1];
 * a compiled binary does not. A compiled path stays in argv[0], which is dropped.
 */
export function daemonCliArgs(argv: readonly string[]): readonly string[] {
	const rest = argv.slice(1);
	const head = rest[0];
	if (
		head !== undefined &&
		!head.startsWith("-") &&
		(head.endsWith(".ts") || head.endsWith(".js") || head.includes("/"))
	) {
		return rest.slice(1);
	}
	return rest;
}

const VALUE_FLAGS = new Set([
	"--name",
	"--config",
	"--workspace",
	"--url",
	"--token",
	"--env-id",
	"--envId",
]);

function hasStandaloneFlag(argv: readonly string[], name: string): boolean {
	return argv.some(
		(token, index) =>
			token === name &&
			(index === 0 || !VALUE_FLAGS.has(argv[index - 1] ?? "")),
	);
}

function buildStartArgs(flags: {
	workspace?: string;
	configPath?: string;
	url?: string;
	token?: string;
	envId?: string;
	name?: string;
	persist?: boolean;
	confineToWorkspace?: boolean;
	save?: boolean;
}): ParsedDaemonArgs {
	const res: {
		kind: "start";
		workspace?: string;
		configPath?: string;
		url?: string;
		token?: string;
		envId?: string;
		name?: string;
		persist?: boolean;
		confineToWorkspace?: boolean;
		save?: boolean;
	} = {
		kind: "start",
		workspace: flags.workspace,
		configPath: flags.configPath,
	};
	if (flags.url !== undefined) res.url = flags.url;
	if (flags.token !== undefined) res.token = flags.token;
	if (flags.envId !== undefined) res.envId = flags.envId;
	if (flags.name !== undefined) res.name = flags.name;
	if (flags.persist !== undefined) res.persist = flags.persist;
	if (flags.confineToWorkspace !== undefined)
		res.confineToWorkspace = flags.confineToWorkspace;
	if (flags.save !== undefined) res.save = flags.save;
	return res;
}

function buildPairArgs(flags: {
	token: string;
	name?: string;
	workspace?: string;
	configPath?: string;
	url?: string;
	persist?: boolean;
	confineToWorkspace?: boolean;
}): ParsedDaemonArgs {
	const res: {
		kind: "pair";
		token: string;
		name?: string;
		workspace?: string;
		configPath?: string;
		url?: string;
		persist?: boolean;
		confineToWorkspace?: boolean;
	} = {
		kind: "pair",
		token: flags.token,
		name: flags.name,
		workspace: flags.workspace,
		configPath: flags.configPath,
	};
	if (flags.url !== undefined) res.url = flags.url;
	if (flags.persist !== undefined) res.persist = flags.persist;
	if (flags.confineToWorkspace !== undefined)
		res.confineToWorkspace = flags.confineToWorkspace;
	return res;
}

export function parseDaemonArgs(argv: readonly string[]): ParsedDaemonArgs {
	if (hasStandaloneFlag(argv, "--help")) return { kind: "help" };
	if (hasStandaloneFlag(argv, "--version")) return { kind: "version" };

	const positionals: string[] = [];
	let name: string | undefined;
	let configPath: string | undefined;
	let workspace: string | undefined;
	let url: string | undefined;
	let token: string | undefined;
	let envId: string | undefined;
	let persist: boolean | undefined;
	let confineToWorkspace: boolean | undefined;
	let save: boolean | undefined;

	for (let i = 0; i < argv.length; i++) {
		const rawToken = argv[i] ?? "";
		if (!rawToken.startsWith("-")) {
			positionals.push(rawToken);
			continue;
		}

		// Split on '=' for --flag=value format
		const eqIndex = rawToken.indexOf("=");
		const flag = eqIndex === -1 ? rawToken : rawToken.slice(0, eqIndex);
		const inlineValue =
			eqIndex === -1 ? undefined : rawToken.slice(eqIndex + 1);

		if (flag === "--name") {
			name = inlineValue ?? argv[++i];
		} else if (flag === "--config") {
			configPath = inlineValue ?? argv[++i];
		} else if (flag === "--workspace") {
			workspace = inlineValue ?? argv[++i];
		} else if (flag === "--url") {
			url = inlineValue ?? argv[++i];
		} else if (flag === "--token") {
			token = inlineValue ?? argv[++i];
		} else if (flag === "--env-id" || flag === "--envId") {
			envId = inlineValue ?? argv[++i];
		} else if (flag === "--persist") {
			if (inlineValue !== undefined) {
				persist = inlineValue !== "false" && inlineValue !== "0";
			} else {
				const next = argv[i + 1];
				if (next === "true" || next === "1") {
					persist = true;
					i++;
				} else if (next === "false" || next === "0") {
					persist = false;
					i++;
				} else {
					persist = true;
				}
			}
		} else if (flag === "--no-persist") {
			persist = false;
		} else if (flag === "--confine" || flag === "--confine-to-workspace") {
			if (inlineValue !== undefined) {
				confineToWorkspace = inlineValue !== "false" && inlineValue !== "0";
			} else {
				const next = argv[i + 1];
				if (next === "true" || next === "1") {
					confineToWorkspace = true;
					i++;
				} else if (next === "false" || next === "0") {
					confineToWorkspace = false;
					i++;
				} else {
					confineToWorkspace = true;
				}
			}
		} else if (flag === "--no-confine") {
			confineToWorkspace = false;
		} else if (flag === "--save") {
			save = true;
		} else if (flag === "--help" || flag === "--version") {
			// handled standalone
		} else {
			return {
				kind: "error",
				message: `Unknown command or flag '${rawToken}'.\n${DAEMON_USAGE}`,
			};
		}
	}

	if (positionals.length === 0) {
		return buildStartArgs({
			workspace,
			configPath,
			url,
			token,
			envId,
			name,
			persist,
			confineToWorkspace,
			save,
		});
	}

	const first = positionals[0] ?? "";
	if (first === "start") {
		return buildStartArgs({
			workspace,
			configPath,
			url,
			token,
			envId,
			name,
			persist,
			confineToWorkspace,
			save,
		});
	}

	if (first === "deregister") {
		return { kind: "deregister", configPath };
	}

	if (first === "config") {
		const action = positionals[1];
		if (action === "set") {
			const key = positionals[2];
			const val = positionals[3];
			if (!key || val === undefined) {
				return {
					kind: "error",
					message: `Missing key or value for 'config set'.\nUsage: cadmus-daemon config set <key> <value>\n${DAEMON_USAGE}`,
				};
			}
			return {
				kind: "config",
				action: "set",
				key,
				value: val,
				configPath,
			};
		}
		if (action === "get" || action === undefined) {
			const key = positionals[2];
			return {
				kind: "config",
				action: "get",
				key,
				configPath,
			};
		}
		return {
			kind: "error",
			message: `Unknown config action '${action}'. Use 'get' or 'set'.\n${DAEMON_USAGE}`,
		};
	}

	if (first === "pair") {
		const pairToken = positionals[1];
		if (!pairToken) {
			return {
				kind: "error",
				message: `Missing pairing token.\n${DAEMON_USAGE}`,
			};
		}
		return buildPairArgs({
			token: pairToken,
			name,
			workspace,
			configPath,
			url,
			persist,
			confineToWorkspace,
		});
	}

	// Direct token pass without "pair" subcommand
	if (first.startsWith("cadmus_pt_")) {
		return buildPairArgs({
			token: first,
			name,
			workspace,
			configPath,
			url,
			persist,
			confineToWorkspace,
		});
	}

	return {
		kind: "error",
		message: `Unknown command or flag '${first}'.\n${DAEMON_USAGE}`,
	};
}

export function formatDaemonHelp(): string {
	return [
		"cadmus-daemon runs a Cadmus local-daemon tools env on this machine.",
		"",
		DAEMON_USAGE,
		"",
		"Commands:",
		"  pair <token> [--name <name>]   Pair and register with a 15-minute token from the UI.",
		"  start                          Run using saved local credentials or CLI options (default).",
		"  config set <key> <value>       Set a configuration value in the config file.",
		"  config get [key]               Display configuration value(s) from the config file.",
		"  deregister                     Remove local registration and credentials.",
		"",
		"Options:",
		"  --url <url>                    WebSocket URL to connect to.",
		"  --token <token>                Daemon authentication token.",
		"  --env-id <id>                  Account tools env ID.",
		"  --name <name>                  Friendly daemon name (e.g. 'My MacBook').",
		"  --workspace <path>             Directory for this run. Defaults to the current directory.",
		"  --persist [true|false]         Keep workspace between runs (default: true).",
		"  --confine [true|false]         Require OS confinement (bwrap/sandbox-exec, default: false).",
		"  --save                         Save command-line options to the configuration file.",
		"  --config <path>                Custom path to configuration file (default: ~/.cadmus/daemon.json).",
		"  --help                         Print this help and exit.",
		"  --version                      Print the daemon package version and exit.",
		"",
		"--help wins when both --help and --version are present.",
	].join("\n");
}
