# Cadmus (`cadmus`) — Cloud-Native Multi-Bot Agent Runtime

Cadmus is the cloud-native V2 architecture of `pi-bot`, built on **Cloudflare Workers**, **Cloudflare D1**, and **SQLite-backed Cloudflare Durable Objects (`CadmusBotFamilyDO`)** over [`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable) and [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai).

## Key Highlights

- **Two-Tier Storage Architecture (Self-Initializing in Code)**:
  - **Global Admin Database (`CADMUS_ADMIN_DB` on Cloudflare D1)**: Stores cross-family account data — users, auth tokens, accounts, user-to-account memberships, AES-GCM 256-bit encrypted BYOK credentials, and the Bot Families catalog (`account_id <-> family_id <-> do_name`). Schema is self-initializing and self-migrating in application code ([`packages/worker/src/store/d1-admin.ts`](packages/worker/src/store/d1-admin.ts)); no external SQL migration files or `wrangler d1 migrations` steps exist.
  - **Per-Family Durable Object (`CadmusBotFamilyDO` on DO SQLite)**: Co-locates all bots, chats, virtual files (`SOUL.md`, `MEMORY.md`, `knowledge/<slug>.md` with CAS optimistic concurrency), schedules, harvest watermarks/notes (`cadmus_*` tables), and `pi-durable` conversations/tasks (`cadmus_pi_*` tables) for one Bot Family inside a single SQLite-backed Durable Object (`cadmus:<accountId>:<familyId>`). Schema is self-initializing in code ([`packages/worker/src/store/sqlite-family.ts`](packages/worker/src/store/sqlite-family.ts)).
- **Schema-Validated Protocol (`@cadmus/contract`)**:
  - UI-agnostic JSON protocol (`POST /rpc`, REST `/api/*`, `GET /ws` WebSocket, `GET /events` SSE) validated with TypeBox and exported as JSON Schema at `GET /protocol/schema`.
  - Readonly commands set `readOnly: true` on their schema and are served as `GET /api/<dotted.path>`; mutating commands are `POST`. `/api/*`, `/rpc`, `/ws`, and `/events` authenticate via `Authorization: Bearer` (query `?token=` and cookie-only requests are rejected with `401`). `/ws` and `/events` open with a single-use ticket from `auth.ticket`.
  - Generated route tables, OpenAPI, and AsyncAPI documents are committed and validated via `bun run contract:gen` / `bun run contract:check`.
- **Unified Schedule & Idle Harvest Engine (`ScheduleTask`)**:
  - Single durable `cadmus.schedule` task (`wait` -> `run`) driving 5-field cron schedules, one-shot `when` timers, and idle knowledge/memory harvest forks (`harvest:<chatKey>`) via a single Durable Object alarm (`ctx.storage.setAlarm`).
- **Out-of-Band Runtime Status (`chat.status`)**:
  - Inspects live conversation, bot, usage, harvest watermark, and alarm state out-of-band via the `chat.status` RPC without polluting conversation transcripts or invoking the LLM.
- **Agent CLI, Local Daemon & Web UI**:
  - **Agent CLI (`packages/cli/`)**: `cadmus` enumerates every protocol RPC from the contract. See [`packages/cli/README.md`](packages/cli/README.md).
  - **Local Daemon (`packages/daemon/`)**: `cadmus-daemon` connects outbound from a local workspace to run `local-daemon` tools environments. See [`packages/daemon/README.md`](packages/daemon/README.md).
  - **Web UI (`packages/web-app/` & `packages/login-app/`)**: React + Vite apps assembled into `dist/web` and served by the Worker at `/app` and `/login`. `CadmusClient` calls `GET`/`POST /api/*` with `Authorization: Bearer` and receives live events over `GET /ws` via `@cadmus/contract/client`.

---

## Packages

| Package | Name | Description |
| :--- | :--- | :--- |
| [`packages/contract`](packages/contract) | `@cadmus/contract` | TypeBox protocol schemas, generated routes, OpenAPI/AsyncAPI specs, and shared client |
| [`packages/worker`](packages/worker) | `@cadmus/worker` | Cloudflare Worker entrypoint, auth, D1 admin store, and Durable Objects (`CadmusBotFamilyDO`, `CadmusEnvDO`, `CadmusAuthLimiterDO`) |
| [`packages/web-app`](packages/web-app) | `@cadmus/web-app` | React + Vite Web UI served at `/app` |
| [`packages/login-app`](packages/login-app) | `@cadmus/login-app` | React + Vite sign-in app served at `/login` |
| [`packages/cli`](packages/cli) | `@cadmus/cli` | Agent-facing CLI (`cadmus`) |
| [`packages/daemon`](packages/daemon) | `@cadmus/daemon` | Outbound `local-daemon` tools environment runner (`cadmus-daemon`) |

---

## Quickstart

### 1. Install Dependencies

```bash
bun install
```

### 2. Run Tests & Checks

All E2E tests execute inside the real Cloudflare Workers `workerd` runtime via `@cloudflare/vitest-plugin`:

```bash
# Run E2E test suite in workerd
bun run test

# Typecheck all packages
bun run typecheck

# Run full verification (boundaries, contract check, typecheck, lint, conformance, E2E)
bun run check:all
```

### 3. Local Development

Set up `.dev.vars` with a dev-password login (this file stays out of git) and start the local Cloudflare Worker:

```bash
bun run dev:setup
bun run dev
```

#### Option A: Web UI (Vite)

Start the Web UI and Login app dev servers in separate terminals:

```bash
bun run web-app:dev      # http://localhost:5174 (/app)
bun run login-app:dev    # http://localhost:5175 (/login)
```

Open [http://localhost:5174/app/](http://localhost:5174/app/) in your browser. The Vite dev server proxies `/health`, `/protocol/schema`, `/ws`, `/events`, `/rpc`, `/api/*`, and `/tools-env/*` to the local Worker at `http://localhost:8787` (and `/login` / `/sign-in` to `http://localhost:5175`).

#### Option B: Agent CLI

Drive the local Worker with `cadmus`. Flags override `CADMUS_URL`, `CADMUS_TOKEN`, `CADMUS_ACCOUNT_ID`, and `CADMUS_FAMILY_ID`:

```bash
bun run cli --help
bun run cli --version
bun run cli commands --token "$CADMUS_TOKEN"
bun run cli bot.list --token "$CADMUS_TOKEN" --account "$CADMUS_ACCOUNT_ID"
```

`cadmus --skill` prints a contract-generated `SKILL.md`. `cadmus send <chatKey> <text>` waits for the turn. See [`packages/cli/README.md`](packages/cli/README.md) for compiled build targets.

### 4. Deployment (Cloudflare Workers)

```bash
bun run build
bun run deploy
```

> [!IMPORTANT]
> **No External SQL Migrations**: Database tables in both D1 (`CADMUS_ADMIN_DB`) and DO SQLite (`CadmusBotFamilyDO`) are self-initializing and self-migrating via code on first access. Never create `migrations/*.sql` files or run `wrangler d1 migrations` commands.

### 5. Edge Caching & Optional Workers KV (`CADMUS_CACHE_KV`)

Cadmus includes an edge caching layer ([`packages/worker/src/edge-cache.ts`](packages/worker/src/edge-cache.ts)) for token resolution and Bot Family DO routing info:
- **L1 (In-Memory)**: Always enabled, zero latency, 60s TTL, bounded LRU cache per isolate.
- **L2 (Workers KV)**: Optional distributed cache via `CADMUS_CACHE_KV` binding.
- Requests authenticate with a Cadmus session access token (`cad_at_`). Anything else is `401`.

To enable L2 distributed KV caching across isolates, create production and preview KV namespaces and bind them in `wrangler.jsonc`:

```bash
wrangler kv namespace create cadmus-cache
wrangler kv namespace create cadmus-cache-preview
```

```jsonc
  "kv_namespaces": [
    {
      "binding": "CADMUS_CACHE_KV",
      "id": "<PRODUCTION_KV_ID>"
    }
  ],
  "previews": {
    "kv_namespaces": [
      {
        "binding": "CADMUS_CACHE_KV",
        "id": "<PREVIEW_KV_ID>"
      }
    ]
  }
```

---

## All-In-One Self-Hosted Deployment (Docker + `celld`)

Cadmus can run self-contained on your own hardware or VM using **[`celld`](https://celld.dev)** — an open-source daemon that runs Cloudflare Workers and Durable Objects locally using embedded SQLite "cells" without requiring an external Cloudflare account or cloud database.

The included [`docker/Dockerfile`](docker/Dockerfile) bundles the stack into a single container:
- **Durable Objects (`CadmusBotFamilyDO`)**: Backed by isolated SQLite files managed by `celld`.
- **Global Admin Database (`CADMUS_ADMIN_DB`)**: Cloudflare D1 compatibility layer mapped to local SQLite.
- **Durable Object Alarms**: In-memory alarm scheduler driving cron jobs, `when` timers, and idle harvest forks.
- **WebSocket Hibernation API**: Full real-time streaming and duplex messaging support.
- **Zero External Dependencies**: Persistent storage defaults to a local volume (`/data`).

### 1. Build the Docker Image

```bash
docker build -f docker/Dockerfile -t cadmus-aio .
```

### 2. Run the Container

```bash
docker run -d \
  --name cadmus \
  -p 8787:8787 \
  -v cadmus-data:/data \
  -e CADMUS_ENCRYPTION_KEY="your-32-byte-encryption-key-here!" \
  -e ANTHROPIC_API_KEY="sk-ant-..." \
  -e OPENAI_API_KEY="sk-..." \
  -e XAI_API_KEY="..." \
  cadmus-aio
```

### 3. Verify Health

```bash
curl http://localhost:8787/health
# {"ok":true,"service":"cadmus","version":2}
```

### 4. Connect with the Agent CLI

From your host machine or inside the container:

```bash
bun run cli bot.list --url http://localhost:8787 --token "$CADMUS_TOKEN"
# or:
docker exec -it cadmus bun run cli bot.list --url http://localhost:8787 --token "$CADMUS_TOKEN"
```

### Configuration Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `8787` | HTTP/WebSocket listener port |
| `HOST` | `0.0.0.0` | Network interface to bind |
| `CADMUS_ENCRYPTION_KEY` | `dev-cadmus-encryption-key-32bytes!` | Master key for AES-GCM 256-bit BYOK credential encryption |
| `CADMUS_DEFAULT_TIMEZONE` | `UTC` | Default timezone for scheduled cron expressions |
| `CADMUS_HARVEST_DELAY_MS` | `60000` | Inactivity threshold (ms) before idle conversation harvest runs |
| `CADMUS_HEARTBEAT_MS` | `30000` | Daemon heartbeat interval (ms) while a tool call is in flight (clamped to 50–120000 when numeric) |
| `CADMUS_LOG_LEVEL` | `debug` | Logging verbosity (`debug`, `info`, `warn`, `error`) |
| `ANTHROPIC_API_KEY` | *(optional)* | Anthropic API key |
| `OPENAI_API_KEY` | *(optional)* | OpenAI API key |
| `OPENROUTER_API_KEY` | *(optional)* | OpenRouter API key |
| `XAI_API_KEY` | *(optional)* | xAI API key |

---

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — High-level architecture index and subsystem docs.
- [`AGENTS.md`](AGENTS.md) — Handbook for coding agents working on this repository.
