export const DAEMON_USAGE =
	"usage: cadmus-daemon --url <ws-url> --token <cadmus_dt_...> --env-id <id> --workspace <path> [--persist true|false] [--confine true|false]";

export interface DaemonRunFlags {
	url: string;
	token: string;
	envId: string;
	workspacePath: string;
	persist: boolean;
	confineToWorkspace: boolean;
}

export type ParsedDaemonArgs =
	| { kind: "help" }
	| { kind: "version" }
	| { kind: "run"; flags: DaemonRunFlags }
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
	"--url",
	"--token",
	"--env-id",
	"--workspace",
	"--persist",
	"--confine",
]);

function flagValue(argv: readonly string[], name: string): string | undefined {
	const index = argv.indexOf(name);
	if (index < 0) return undefined;
	return argv[index + 1];
}

/** `--help` / `--version` count only as their own argv tokens, not as a flag value. */
function hasStandaloneFlag(argv: readonly string[], name: string): boolean {
	return argv.some(
		(token, index) =>
			token === name &&
			(index === 0 || !VALUE_FLAGS.has(argv[index - 1] ?? "")),
	);
}

/** Pure flag parse. `--help` and `--version` do not require the run flags. */
export function parseDaemonArgs(argv: readonly string[]): ParsedDaemonArgs {
	if (hasStandaloneFlag(argv, "--help")) return { kind: "help" };
	if (hasStandaloneFlag(argv, "--version")) return { kind: "version" };
	const url = flagValue(argv, "--url");
	const token = flagValue(argv, "--token");
	const envId = flagValue(argv, "--env-id");
	const workspacePath = flagValue(argv, "--workspace");
	if (!url || !token || !envId || !workspacePath) {
		return { kind: "error", message: DAEMON_USAGE };
	}
	return {
		kind: "run",
		flags: {
			url,
			token,
			envId,
			workspacePath,
			persist: flagValue(argv, "--persist") !== "false",
			confineToWorkspace: flagValue(argv, "--confine") === "true",
		},
	};
}

export function formatDaemonHelp(): string {
	return [
		"cadmus-daemon runs a Cadmus local-daemon tools env on this machine.",
		"",
		DAEMON_USAGE,
		"",
		"  --url <ws-url>            WebSocket URL. If envId is absent, --env-id is added.",
		"  --token <cadmus_dt_...>   Pairing bearer from account.toolsEnvSecrets.set.",
		"  --env-id <id>             Account tools env id.",
		"  --workspace <path>        Workspace directory.",
		"  --persist true|false      Keep the workspace (default true). Only false disables it.",
		"  --confine true|false      Require OS confinement (default false). Only true enables it.",
		"  --help                    Print this help and exit. Does not connect.",
		"  --version                 Print the daemon package version and exit. Does not connect.",
		"",
		"Required to run: --url, --token, --env-id, --workspace.",
		"--help wins when both --help and --version are present.",
	].join("\n");
}
