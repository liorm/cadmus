export const DAEMON_USAGE =
	"usage:\n  cadmus-daemon [pair] <token> [--name <name>] [--workspace <path>] [--config <path>]\n  cadmus-daemon [start] [--workspace <path>] [--config <path>]\n  cadmus-daemon deregister [--config <path>]\n  cadmus-daemon --help | --version";

export type ParsedDaemonArgs =
	| { kind: "help" }
	| { kind: "version" }
	| {
			kind: "pair";
			token: string;
			name?: string;
			workspace?: string;
			configPath?: string;
	  }
	| { kind: "start"; workspace?: string; configPath?: string }
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

function flagValue(argv: readonly string[], name: string): string | undefined {
	const index = argv.indexOf(name);
	if (index < 0) return undefined;
	return argv[index + 1];
}

const VALUE_FLAGS = new Set(["--name", "--config", "--workspace"]);

function hasStandaloneFlag(argv: readonly string[], name: string): boolean {
	return argv.some(
		(token, index) =>
			token === name &&
			(index === 0 || !VALUE_FLAGS.has(argv[index - 1] ?? "")),
	);
}

export function parseDaemonArgs(argv: readonly string[]): ParsedDaemonArgs {
	if (hasStandaloneFlag(argv, "--help")) return { kind: "help" };
	if (hasStandaloneFlag(argv, "--version")) return { kind: "version" };

	const name = flagValue(argv, "--name");
	const configPath = flagValue(argv, "--config");
	const workspace = flagValue(argv, "--workspace");

	// Extract positionals (tokens not starting with - and not values of flags)
	const positionals: string[] = [];
	for (let i = 0; i < argv.length; i++) {
		const token = argv[i] ?? "";
		if (token.startsWith("-")) {
			if (VALUE_FLAGS.has(token)) {
				i++; // skip flag value
			}
			continue;
		}
		positionals.push(token);
	}

	if (positionals.length === 0) {
		return { kind: "start", workspace, configPath };
	}

	const first = positionals[0] ?? "";
	if (first === "start") {
		return { kind: "start", workspace, configPath };
	}

	if (first === "deregister") {
		return { kind: "deregister", configPath };
	}

	if (first === "pair") {
		const token = positionals[1];
		if (!token) {
			return {
				kind: "error",
				message: `Missing pairing token.\n${DAEMON_USAGE}`,
			};
		}
		return { kind: "pair", token, name, workspace, configPath };
	}

	// Direct token pass without "pair" subcommand
	if (first.startsWith("cadmus_pt_")) {
		return { kind: "pair", token: first, name, workspace, configPath };
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
		"  start                          Run using saved local credentials (default when no command given).",
		"  deregister                     Remove local registration and credentials.",
		"",
		"Options:",
		"  --name <name>                  Friendly daemon name (e.g. 'My MacBook').",
		"  --workspace <path>             Directory for this run. Defaults to the current directory.",
		"  --config <path>                Custom path to configuration file (default: ~/.cadmus/daemon.json).",
		"  --help                         Print this help and exit.",
		"  --version                      Print the daemon package version and exit.",
		"",
		"--help wins when both --help and --version are present.",
	].join("\n");
}
