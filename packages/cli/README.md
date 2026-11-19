# cadmus

`cadmus` is the agent-facing command line for the Cadmus protocol. It enumerates every RPC from the contract at runtime. `send` and `events` are the only special verbs. Output is JSON. `--pretty` indents it.

This package is not a system service. Nothing here installs it, and there is no CI job that builds the binaries.

## Build

From the repository root, with Bun 1.4.3:

```bash
# Build all targets (Linux and macOS)
bun run cli:build

# macOS targets
bun run cli:build:darwin          # Both Apple Silicon & Intel
bun run cli:build:darwin-arm64    # Apple Silicon (M1/M2/M3/M4)
bun run cli:build:darwin-x64      # Intel Mac

# Linux targets
bun run cli:build:linux           # Both arm64 & x64
bun run cli:build:linux-arm64
bun run cli:build:linux-x64

# Host native target (compiles for your current OS/arch)
bun run cli:build:local
```

Each script runs `bun build --compile` on `packages/cli/src/cli.ts`:

| Script | Target | Output |
| :--- | :--- | :--- |
| `cli:build:darwin-arm64` | `bun-darwin-arm64` | `packages/cli/dist/cadmus-darwin-arm64` |
| `cli:build:darwin-x64` | `bun-darwin-x64` | `packages/cli/dist/cadmus-darwin-x64` |
| `cli:build:linux-arm64` | `bun-linux-arm64` | `packages/cli/dist/cadmus-linux-arm64` |
| `cli:build:linux-x64` | `bun-linux-x64` | `packages/cli/dist/cadmus-linux-x64` |
| `cli:build:local` | host default | `packages/cli/dist/cadmus` |

`packages/cli/dist/` is gitignored (`dist/` and `packages/*/dist/` in `.gitignore`). Do not commit the binaries.

## Run

### Run directly with Bun

```bash
bun run cli --help
bun run cli --version
bun run cli --skill
bun run cli commands
bun packages/cli/src/cli.ts bot.list --token "$CADMUS_TOKEN"
```

### Run compiled binary

```bash
./packages/cli/dist/cadmus-darwin-arm64 --help
./packages/cli/dist/cadmus-darwin-x64 --help
./packages/cli/dist/cadmus-linux-arm64 --help
./packages/cli/dist/cadmus-linux-x64 --help
./packages/cli/dist/cadmus --help
```

`--help` and `--version` print and exit 0. They do not open a socket. `--version` prints the `version` field from `cli/package.json` and nothing else. When both flags are present, `--help` wins.

```text
cadmus --help
cadmus --version
cadmus --skill
cadmus commands
cadmus <command> [json] [--payload @file|-] [--key value]
cadmus send <chatKey> <text|-> [--timeout 600] [--stream]
cadmus events [--chat K] [--types a,b]
```

| Command / Flag | Meaning |
| :--- | :--- |
| `<command>` | Any protocol RPC. `--help` prints its method, read-only flag, description, and payload fields. |
| `commands` | JSON catalog: name, method, readOnly, description. |
| `send` | Submit a turn on `/ws` and wait for the result. `--stream` prints NDJSON events. |
| `events` | NDJSON `/ws` events until SIGINT. |
| `--skill` | Print a SKILL.md generated from the contract. |
| `--url` / `CADMUS_URL` | Worker origin. Default `http://localhost:8787` from source, `https://cadmus.purelogicstudios.com` in the compiled binary. |
| `--token` / `CADMUS_TOKEN` | Explicit `cad_at_` override. Not stored. |
| `auth login` | Device login. Stores `cad_rt_` in the OS keychain, or `~/.config/cadmus/credentials.json` when there is no keychain. `--device` prints the URL. `--dev-password` uses the worker's dev-password provider. |
| `auth logout` | Revokes the stored refresh secret and deletes it locally. |
| `auth status` | Prints the signed-in principal (`auth.whoami`). `loggedIn: false` when no session is stored. |
| `--account` / `CADMUS_ACCOUNT_ID` | Account id header and `/ws` query. |
| `--family` / `CADMUS_FAMILY_ID` | Family id header and `/ws` query. |
| `--pretty` | Indent JSON. |
| `--help` | Print help and exit. Does not connect. |
| `--version` | Print the package version and exit. Does not connect. |

Exit codes: 0 ok, 1 protocol or HTTP error, 2 usage, 3 transport or auth, 4 turn failed or timed out.
