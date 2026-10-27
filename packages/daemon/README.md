# cadmus-daemon

`cadmus-daemon` is the outbound process for a Cadmus `local-daemon` tools env. It runs `bash`, `read`, `write`, and `edit` on the machine that owns the workspace, inside pi-durable's `NodeExecutionEnv`. The cloud does not open a port on that machine. The daemon dials Cadmus and stays connected.

This package is not a system service. Nothing here installs it, and there is no CI job that builds the binaries.

## Build

From the repository root, with Bun 1.4.3:

```bash
bun run daemon:build
bun run daemon:build:linux-arm64
bun run daemon:build:linux-x64
```

`daemon:build` compiles both targets. Each script runs `bun build --compile` on `daemon/src/cli.ts`:

| Script | Target | Output |
| :--- | :--- | :--- |
| `daemon:build:linux-arm64` | `bun-linux-arm64` | `daemon/dist/cadmus-daemon-linux-arm64` |
| `daemon:build:linux-x64` | `bun-linux-x64` | `daemon/dist/cadmus-daemon-linux-x64` |

`daemon/dist/` is gitignored (`dist/` and `daemon/dist/` in `.gitignore`). Do not commit the binaries.

## Run

`bun run <name>` reads `package.json` `"scripts"`, not `"bin"`. Start the TypeScript entry by path, from the repository root:

```bash
bun daemon/src/cli.ts --help
bun daemon/src/cli.ts --version
bun daemon/src/cli.ts --url <ws-url> --token <cadmus_dt_...> --env-id <id> --workspace <path>
```

The compiled binaries are the other way to run it:

```bash
./daemon/dist/cadmus-daemon-linux-arm64 --help
./daemon/dist/cadmus-daemon-linux-x64 --version
```

`--help` and `--version` print and exit 0. They do not open a socket. `--version` prints the `version` field from `daemon/package.json` and nothing else. When both flags are present, `--help` wins. A token that is the value of `--url`, `--token`, `--env-id`, `--workspace`, `--persist`, or `--confine` is not `--help` or `--version`.

```text
cadmus-daemon --help
cadmus-daemon --version
cadmus-daemon --url <ws-url> --token <cadmus_dt_...> --env-id <id> --workspace <path> [--persist true|false] [--confine true|false]
```

| Flag | Required | Meaning |
| :--- | :--- | :--- |
| `--url <ws-url>` | yes, to run | WebSocket URL. If the query has no `envId`, the process sets it from `--env-id`. |
| `--token <cadmus_dt_...>` | yes, to run | Bearer minted by `account.toolsEnvSecrets.set`. |
| `--env-id <id>` | yes, to run | Account tools env id (`local-daemon` row). |
| `--workspace <path>` | yes, to run | Workspace directory for this env. |
| `--persist true\|false` | no | Default `true`. The next token disables persistence only when it is exactly `false`. |
| `--confine true\|false` | no | Default `false`. Confinement is required only when the next token is exactly `true`. |
| `--help` | no | Print help and exit. Does not connect. |
| `--version` | no | Print the package version and exit. Does not connect. |

A value is the next argv token. The CLI does not accept `--flag=value`. Missing any required run flag exits 1 and prints the usage line on stderr. No other flags are read.

## Pairing

1. `account.toolsEnvSecrets.set` mints a `cadmus_dt_` token and returns it once. Later list and get calls do not return the raw token.
2. Create a `local-daemon` env that points at that secret (`secretId`), with the workspace path and `confineToWorkspace` for this machine.
3. The daemon dials `GET /tools-env/ws?envId=<envId>` with `Authorization: Bearer <token>`.

## Confinement

Linux confinement is bubblewrap (`bwrap` on `PATH`). macOS confinement is `sandbox-exec` on `PATH`. The startup check looks for those two binaries.

When `--confine true` and neither binary is on `PATH`, the process refuses to start and does not dial. The error is: `No confinement mechanism (bwrap or sandbox-exec). Refusing to start.`

When a mechanism exists and confine is on, file operations go through a realpath jail: a symlink whose target leaves the workspace is `permission_denied`. A missing file is allowed only when every existing ancestor stays inside the workspace. `bash` is wrapped with `bwrap` (Linux, preferred when both exist) or `sandbox-exec` (macOS). The upgrade request sends `X-Cadmus-Env-Capabilities: confinement`. The env DO answers `409` before accept when the env requires confinement and that capability is absent.

When confine is off, the process still starts. It prints this trust warning and runs as the current OS user. `workspacePath` is the working directory, not a sandbox:

```text
cadmus-daemon: confinement is off. This process runs as the current OS user and workspacePath is the working directory, not a sandbox.
```

## Reconnect

A refused dial, a connect timeout, and any completed response other than `101`, `401`, or `409` waits and tries again. The wait starts at 1s, doubles, and caps at 60s, with ±20% jitter. A `101` accept resets that delay to 1s.

`401` stops the loop. `409` stops it until the config stamp changes. The stamp is `envId`, `workspacePath`, `persist`, and `confineToWorkspace`. This CLI reads flags once, so a `409` ends the process; start it again after changing one of those four. A `401` is not cleared by a config change inside the same process.

The TCP connect budget is 10s (`DAEMON_CONNECT_TIMEOUT_MS`). A timeout uses the same backoff as a refused connection.

Heartbeats are not sent by the daemon on a timer. The env DO sends `{ method: "heartbeat" }` only while tool calls to that socket are in flight. The daemon replies `{ ok: true }`. An idle socket has no heartbeat.
