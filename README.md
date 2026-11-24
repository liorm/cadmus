# Cadmus

Cadmus is a cloud-native multi-bot agent runtime built on **Cloudflare Workers**, **Cloudflare D1**, and **SQLite-backed Durable Objects** over [`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable) and [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai).

## Core Capabilities

- **Bot Families & Two-Tier Storage**:
  - **Global Admin Store (`CADMUS_ADMIN_DB` on Cloudflare D1)**: Stores users, auth sessions/tokens, accounts, memberships, AES-GCM 256-bit encrypted BYOK provider credentials, and the account-to-family Durable Object catalog.
  - **Per-Family Durable Object (`CadmusBotFamilyDO` on DO SQLite)**: Co-locates all bots, chats, virtual files, schedules, harvest notes, and `pi-durable` conversations/tasks for one Bot Family inside a single SQLite-backed Durable Object (`cadmus:<accountId>:<familyId>`).
  - **Self-Initializing Schemas**: Both D1 ([`packages/worker/src/store/d1-admin.ts`](packages/worker/src/store/d1-admin.ts)) and DO SQLite ([`packages/worker/src/store/sqlite-family.ts`](packages/worker/src/store/sqlite-family.ts)) initialize and migrate automatically in code on first access—there are no external SQL migration files or `wrangler d1 migrations` steps.
- **Contract-First Protocol (`@cadmus/contract`)**:
  - UI-agnostic JSON protocol over `POST /rpc`, REST `GET`/`POST /api/*`, WebSocket `GET /ws`, and SSE `GET /events`, validated with TypeBox and exported as JSON Schema at `GET /protocol/schema`.
  - Readonly commands declare `readOnly: true` and map to `GET /api/<path>`; mutating commands map to `POST /api/<path>`.
  - All API transports authenticate via `Authorization: Bearer <token>` (query `?token=` and cookie-only requests are rejected with `401`). `/ws` and `/events` open with a single-use ticket from `auth.ticket`.
- **Virtual Files & Forked Idle Harvest**:
  - Each bot owns `SOUL.md`, `MEMORY.md`, and `knowledge/<slug>.md` stored in DO SQLite with Compare-And-Swap (`expectedVersion`) optimistic concurrency.
  - When a chat goes idle, a background fork extracts durable facts and knowledge, records unified diffs as a `HarvestNote`, and advances the harvest watermark.
- **Unified Schedules & Alarms (`ScheduleTask`)**:
  - Timezone-aware 5-field cron jobs, one-shot `when` timers, and idle harvest timers (`harvest:<chatKey>`) all run through a single durable `cadmus.schedule` task backed by the Durable Object alarm (`ctx.storage.setAlarm`).
- **Inter-Bot Collaboration**:
  - Bots in the same family can search, inspect, spawn, and hold durable group chats with sibling bots.
- **Out-of-Band Runtime Status (`chat.status`)**:
  - Inspects live conversation, bot, usage, harvest watermark, and alarm state without polluting transcripts or invoking the LLM.
- **Local-Daemon Tool Environments**:
  - Bots can execute `bash`, `read`, `write`, and `edit` on a user's machine via an outbound-connected `cadmus-daemon`, with optional OS confinement (`bwrap` on Linux, `sandbox-exec` on macOS).

---

## Quickstart

### 1. Install Dependencies

Requires **Bun >= 1.4.3**:

```bash
bun install
```

### 2. Local Development

Configure `.dev.vars` for local dev-password login (gitignored) and start the Cloudflare Worker:

```bash
bun run dev:setup
bun run dev
```

In separate terminals, start the Web UI and Login app dev servers:

```bash
bun run web-app:dev      # http://localhost:5174 (/app)
bun run login-app:dev    # http://localhost:5175 (/login)
```

Open [http://localhost:5174/app/](http://localhost:5174/app/). Vite proxies `/health`, `/protocol/schema`, `/ws`, `/events`, `/rpc`, `/api/*`, `/auth/*`, and `/tools-env/*` to the local Worker at `http://localhost:8787`, and `/login` / `/sign-in` to `http://localhost:5175`.

### 3. Verify & Test

```bash
bun run typecheck         # Typecheck all packages
bun run lint              # Lint and format check (Biome)
bun run test              # Black-box E2E tests in workerd (Vitest)
bun run test:conformance  # Contract & daemon wire conformance
bun run check:all         # Full suite (boundaries, contract, typecheck, lint, unit, conformance, E2E)
```

---

## Packages

Cadmus is a Bun workspace monorepo under `packages/`:

| Package | Path | Role |
| :--- | :--- | :--- |
| `@cadmus/contract` | [`packages/contract`](packages/contract) | TypeBox protocol schemas, generated REST route table, OpenAPI/AsyncAPI specs, and shared client |
| `@cadmus/worker` | [`packages/worker`](packages/worker) | Cloudflare Worker entrypoint, auth, D1 admin store, and Durable Objects |
| `@cadmus/web-app` | [`packages/web-app`](packages/web-app) | React 19 + Vite + TanStack Router Web UI served at `/app` |
| `@cadmus/login-app` | [`packages/login-app`](packages/login-app) | React 19 + Vite sign-in and device-approval SPA served at `/login` |
| `@cadmus/cli` | [`packages/cli`](packages/cli) | Agent-facing CLI (`cadmus`) |
| `@cadmus/daemon` | [`packages/daemon`](packages/daemon) | Outbound `local-daemon` tools environment runner (`cadmus-daemon`) |

### `@cadmus/contract`

Defines the entire Cadmus API surface (command names, payload/result TypeBox schemas, `readOnly` flags, error codes, record types, and `/ws` / `/events` frame unions). Its only runtime dependency is `typebox`.

- **Subpath exports**:
  - `@cadmus/contract/types` — TypeScript types only.
  - `@cadmus/contract/routes` — Generated `API_ROUTES` table and `encodePayloadQuery` helper.
  - `@cadmus/contract/tools` — Agent tool-name constants.
  - `@cadmus/contract/client` — Shared REST + WebSocket client (`CadmusClient`).
  - `@cadmus/contract/schemas` — Runtime TypeBox schemas (used by `@cadmus/worker` and `@cadmus/cli`, not bundled into `@cadmus/web-app`).
  - `@cadmus/contract/grants` — Authorization grant definitions.
- **Code generation & boundaries**:
  - After editing schemas in `packages/contract/src`, run `bun run contract:gen` to regenerate `packages/contract/generated/{routes.ts,openapi.json,asyncapi.json}`.
  - `bun run contract:check` verifies generated files are up to date.
  - `bun run boundaries` enforces that clients never import Worker/Daemon internals and that `@cadmus/web-app` does not bundle runtime schemas.

### `@cadmus/worker`

Cloudflare Worker backend (`packages/worker/src/index.ts`) hosting HTTP/WS/SSE endpoints, authentication, rate limiting, and three SQLite-backed Durable Object classes:

- **`CadmusBotFamilyDO`** (`CADMUS_BOT_FAMILY`) — Per-family state, bots, virtual files, chats, schedules, alarms, and `pi-durable` turns.
- **`CadmusEnvDO`** (`CADMUS_ENV`) — Manages connected tool environments (`local-daemon` WebSocket sessions and tool call dispatch).
- **`CadmusAuthLimiterDO`** (`CADMUS_AUTH_LIMITER`) — Auth throttling and rate-limit state.

Includes an edge caching layer ([`packages/worker/src/edge-cache.ts`](packages/worker/src/edge-cache.ts)) with an always-on per-isolate L1 LRU cache (60s TTL) and optional L2 distributed caching via Workers KV (`CADMUS_CACHE_KV`).

```bash
bun run test:worker   # Worker unit tests + white-box workerd tests
bun run test:e2e      # Black-box E2E tests in workerd
```

### `@cadmus/web-app`

Primary Cadmus Web UI built with React 19, Vite, Tailwind CSS, and TanStack Router. Assembled together with `@cadmus/login-app` into `dist/web` via `bun run web:build` and served by the Worker at `/app` (with SPA fallback for deep links).

- Supports both **Mobile** (`390×844`) and the **Persistent Desktop Command Cockpit** (`1440×900`).
- Communicates with the Worker via `@cadmus/contract/client` (`GET`/`POST /api/*` with `Authorization: Bearer`, live events over `GET /ws`).

```bash
bun run web-app:dev                  # Vite dev server on :5174
bun run web-app:build                # Build into packages/web-app/dist
bun run --cwd packages/web-app test  # Unit tests
bun run web-app:screens              # On-demand themed PNGs in packages/web-app/.screens (Playwright Chromium; gitignored, not CI)
```

> [!NOTE]
> The Playwright UI-flow suites (`packages/web-app/tests/flows`, `packages/web-app/tests/desktop`, `bun run test:ui`) are currently parked and excluded from CI and `check:all`.

### `@cadmus/login-app`

Dedicated React 19 + Vite sign-in application served by the Worker at `/login` (and `/sign-in`), handling session boot/refresh, authentication providers (including local dev-password login), role selection, and CLI device-code approval (`/login/device`).

```bash
bun run login-app:dev    # Vite dev server on :5175
bun run login-app:build  # Build into packages/login-app/dist
bun run login-app:test   # Unit tests
```

### `@cadmus/cli`

`cadmus` is the agent-facing command-line client for the Cadmus protocol. It enumerates every protocol RPC from `@cadmus/contract` at runtime (`send` and `events` are the only special verbs). Output is JSON (`--pretty` indents it).

#### Running from Source

```bash
bun run cli --help
bun run cli --version
bun run cli --skill
bun run cli auth login --dev-password
bun run cli commands
bun run cli bot.list --pretty
bun run cli send <chatKey> "Hello" --stream
```

#### Commands & Flags

```text
cadmus --help
cadmus --version
cadmus --skill
cadmus auth <login|logout|status>
cadmus commands
cadmus <command> [json] [--payload @file|-] [--key value]
cadmus send <chatKey> <text|-> [--timeout 600] [--stream]
cadmus events [--chat K] [--types a,b]
```

| Command / Flag | Description |
| :--- | :--- |
| `<command>` | Invoke any protocol RPC. Pass `--help` to inspect its HTTP method, `readOnly` flag, description, and payload fields. |
| `commands` | Print the JSON command catalog (`name`, `method`, `readOnly`, `description`). |
| `send` | Submit a turn over `/ws` and wait for completion (`--stream` emits NDJSON events). |
| `events` | Stream NDJSON `/ws` events until `SIGINT`. |
| `auth login` | Device login; stores `cad_rt_` in the OS keychain (or `~/.config/cadmus/credentials.json` fallback). Supports `--device` and `--dev-password`. |
| `auth logout` / `auth status` | Revoke local session or print the active principal (`auth.whoami`). |
| `--skill` | Print a contract-generated `SKILL.md`. |
| `--url` / `CADMUS_URL` | Worker origin (default `http://localhost:8787` from source, `https://cadmus.purelogicstudios.com` in compiled binaries). |
| `--token` / `CADMUS_TOKEN` | Explicit `cad_at_` bearer token override (not persisted). |
| `--account` / `CADMUS_ACCOUNT_ID` | Account ID scope. |
| `--family` / `CADMUS_FAMILY_ID` | Family ID scope. |
| `--pretty` | Pretty-print JSON output. |
| `--help` / `--version` | Print help or version from `packages/cli/package.json` and exit `0` without connecting (`--help` takes precedence). |

**Exit codes**: `0` ok, `1` protocol/HTTP error, `2` usage error, `3` transport/auth error, `4` turn failed or timed out.

#### Building Standalone Binaries

Outputs land in gitignored `packages/cli/dist/`:

| Script | Target | Output |
| :--- | :--- | :--- |
| `bun run cli:build:local` | Host native | `packages/cli/dist/cadmus` |
| `bun run cli:build:darwin-arm64` | `bun-darwin-arm64` | `packages/cli/dist/cadmus-darwin-arm64` |
| `bun run cli:build:darwin-x64` | `bun-darwin-x64` | `packages/cli/dist/cadmus-darwin-x64` |
| `bun run cli:build:linux-arm64` | `bun-linux-arm64` | `packages/cli/dist/cadmus-linux-arm64` |
| `bun run cli:build:linux-x64` | `bun-linux-x64` | `packages/cli/dist/cadmus-linux-x64` |
| `bun run cli:build` | All macOS & Linux targets | All of the above |

```bash
bun run test:cli   # CLI unit tests
```

### `@cadmus/daemon`

`cadmus-daemon` is the outbound runner for a Cadmus `local-daemon` tools environment. It executes `bash`, `read`, `write`, and `edit` on the machine that owns the workspace inside `pi-durable`'s `NodeExecutionEnv`—no inbound ports are opened on the host.

#### Pairing & Running

1. Create a `local-daemon` environment in the Cadmus Web UI to receive a 15-minute pairing token (`cadmus_pt_...`).
2. Pair and start the daemon:

```bash
bun run daemon pair <token> --name "My Machine" [--workspace <path>]
bun run daemon start [--workspace <path>]
```

The daemon exchanges keys with the backend, stores its permanent token in the OS keystore (macOS Keychain or Linux Secret Service, with `0600` file fallback), and connects. Subsequent runs only need `cadmus-daemon` (or `bun run daemon`).

#### Commands & Flags

```text
cadmus-daemon --help
cadmus-daemon --version
cadmus-daemon pair <token> [--name <name>]
cadmus-daemon [start] [options]
cadmus-daemon config set <key> <value>
cadmus-daemon config get [key]
cadmus-daemon deregister
```

| Command / Flag | Description |
| :--- | :--- |
| `pair <token>` | Pair using a 15-minute UI token and store credentials in the OS keystore. |
| `start` *(default)* | Run the daemon using saved configuration or CLI flags. |
| `config set` / `config get` | Manage `url`, `token`, `env-id`, `name`, `persist`, and `confine` in `~/.cadmus/daemon.json`. |
| `deregister` | Remove local registration and delete the stored token. |
| `--url`, `--token`, `--env-id`, `--name` | Override connection and identity settings. |
| `--workspace <path>` | Workspace directory for this run (defaults to `cwd`; not saved to config; non-persistent envs report `<workspace>/.cadmus-ephemeral`). |
| `--persist [true\|false]` | Keep workspace between runs (default `true`). |
| `--confine [true\|false]` | Require OS confinement via `bwrap` or `sandbox-exec` (default `false`). |
| `--save` | Persist CLI flags to the config file. |
| `--config <path>` | Custom config file path (default `~/.cadmus/daemon.json`). |

#### Confinement & Connection Behavior

- **Confinement**: When `--confine true` is set, the daemon requires `bwrap` (Linux, preferred) or `sandbox-exec` (macOS) on `PATH` and refuses to start if neither is found. File operations enforce a realpath jail inside the workspace, and `bash` runs inside the sandbox. When confinement is off, the daemon prints a warning and runs as the current OS user with `workspacePath` as the working directory.
- **Reconnect & Heartbeats**: Transient disconnects and 10s connect timeouts retry with exponential backoff (1s -> 60s, ±20% jitter). `401` stops immediately; `409` (capability/config mismatch) stops until `envId`, `workspacePath`, `persist`, or `confineToWorkspace` changes. `CadmusEnvDO` sends `{ method: "heartbeat" }` only while tool calls are in flight (every 30s by default, or `CADMUS_HEARTBEAT_MS`).

#### Building Standalone Binaries

Outputs land in gitignored `packages/daemon/dist/`:

| Script | Target | Output |
| :--- | :--- | :--- |
| `bun run daemon:build:local` | Host native | `packages/daemon/dist/cadmus-daemon` |
| `bun run daemon:build:darwin-arm64` | `bun-darwin-arm64` | `packages/daemon/dist/cadmus-daemon-darwin-arm64` |
| `bun run daemon:build:darwin-x64` | `bun-darwin-x64` | `packages/daemon/dist/cadmus-daemon-darwin-x64` |
| `bun run daemon:build:linux-arm64` | `bun-linux-arm64` | `packages/daemon/dist/cadmus-daemon-linux-arm64` |
| `bun run daemon:build:linux-x64` | `bun-linux-x64` | `packages/daemon/dist/cadmus-daemon-linux-x64` |
| `bun run daemon:build` | All macOS & Linux targets | All of the above |

```bash
bun run test:daemon   # Daemon unit tests
```

---

## Deployment

### Cloudflare Workers

Build the combined Web + Login static assets (`dist/web`) and deploy via Wrangler:

```bash
bun run build
bun run deploy
```

Preview deployments use `bun run deploy:preview`. All bindings (`CADMUS_ADMIN_DB`, `CADMUS_CACHE_KV`, `CADMUS_BOT_FAMILY`, `CADMUS_ENV`, `CADMUS_AUTH_LIMITER`, and rate limiters) are configured in [`wrangler.jsonc`](wrangler.jsonc).

### Self-Hosted Docker (`celld`)

Cadmus can run as a single self-contained container using [`celld`](https://celld.dev) (local SQLite-backed Workers, D1, Durable Objects, Alarms, and WebSockets) with [`docker/Dockerfile`](docker/Dockerfile):

```bash
docker build -f docker/Dockerfile -t cadmus-aio .

docker run -d \
  --name cadmus \
  -p 8787:8787 \
  -v cadmus-data:/data \
  -e CADMUS_ENCRYPTION_KEY="your-32-byte-encryption-key-here!" \
  -e ANTHROPIC_API_KEY="sk-ant-..." \
  cadmus-aio

curl http://localhost:8787/health
```

### Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `8787` | HTTP/WebSocket port (Docker/`celld`) |
| `HOST` | `0.0.0.0` | Bind address (Docker/`celld`) |
| `CADMUS_ENCRYPTION_KEY` | `dev-cadmus-encryption-key-32bytes!` | Master key for AES-GCM 256-bit BYOK credential encryption |
| `CADMUS_PUBLIC_URL` | *(env-specific)* | Public base URL of the deployment |
| `CADMUS_DEFAULT_TIMEZONE` | `UTC` | Default timezone for cron schedules |
| `CADMUS_HARVEST_DELAY_MS` | `60000` | Idle delay (ms) before background conversation harvest runs |
| `CADMUS_HEARTBEAT_MS` | `30000` | Daemon heartbeat interval (ms) during active tool calls (clamped to 50–120000) |
| `CADMUS_LOG_LEVEL` | `debug` | Structured log level (`debug`, `info`, `warn`, `error`) |
| `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENROUTER_API_KEY`, `XAI_API_KEY` | *(optional)* | Server-level LLM provider API keys |

---

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — High-level architecture index and subsystem docs.
- [`docs/ui-architecture.md`](docs/ui-architecture.md) — Web UI personas, form factors, and information architecture.
- [`AGENTS.md`](AGENTS.md) — Coding agent handbook, invariants, and test guidelines.
