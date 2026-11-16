# Cadmus (`cadmus`) — Cloud-Native Multi-Bot Agent Runtime

Cadmus is the cloud-native V2 architecture of `pi-bot`, built on **Cloudflare Workers**, **Cloudflare D1**, and **SQLite-backed Cloudflare Durable Objects (`CadmusBotFamilyDO`)** over [`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable) and [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai).

## Key Highlights

- **Two-Tier Storage Architecture (Self-Initializing in Code)**:
  - **Global Admin Database (`CADMUS_ADMIN_DB` on Cloudflare D1)**: Stores cross-family account data — users, auth tokens, accounts, user-to-account memberships, AES-GCM 256-bit encrypted BYOK credentials, and the Bot Families catalog (`account_id <-> family_id <-> do_name`). Schema is self-initializing and self-migrating in application code ([`packages/worker/src/store/d1-admin.ts`](packages/worker/src/store/d1-admin.ts)); no external SQL migration files or `wrangler d1 migrations` steps exist.
  - **Per-Family Durable Object (`CadmusBotFamilyDO` on DO SQLite)**: Co-locates all bots, chats, virtual files (`SOUL.md`, `MEMORY.md`, `knowledge/<slug>.md` with CAS optimistic concurrency), schedules, harvest watermarks/notes (`cadmus_*` tables), and `pi-durable` conversations/tasks (`cadmus_pi_*` tables) for one Bot Family inside a single SQLite-backed Durable Object (`cadmus:<accountId>:<familyId>`). Schema is self-initializing in code ([`packages/worker/src/store/sqlite-family.ts`](packages/worker/src/store/sqlite-family.ts)).
- **Schema-Validated Protocol + `ProtocolShim`**:
  - UI-agnostic JSON protocol (`POST /rpc`, REST `/api/*`, `GET /ws` WebSocket, `GET /events` SSE) validated with TypeBox and exported as standard JSON Schema at `GET /protocol/schema`. Readonly commands set `readOnly: true` on their schema and are served as `GET /api/<dotted.path>`; mutating commands are `POST`. `/api/*` uses the same dispatch path as `/rpc` and accepts credentials only as `Authorization: Bearer` (`?token=` is `401 query_token_not_allowed`; a session cookie alone is `401 header_required`). `/rpc`, `/ws`, and `/events` take the same bearer and refuse both `?token=` and the `cadmus_session` cookie. `/ws` and `/events` open with a single-use ticket from `auth.ticket`. Generated OpenAPI and AsyncAPI documents are committed and validated internally (`bun run contract:gen` / `contract:check`); the Worker does not serve them.
- **Unified Schedule & Idle Harvest Engine (`ScheduleTask`)**:
  - Single durable `cadmus.schedule` task (`wait` -> `run`) driving 5-field cron schedules, one-shot `when` timers, and idle knowledge/memory harvest forks (`harvest:<chatKey>`) via a single Durable Object alarm (`ctx.storage.setAlarm`).
- **Out-of-Band `/status`**:
  - Inspects live conversation, bot, usage, harvest watermark, and alarm state out-of-band without polluting conversation transcripts or invoking the LLM.
- **Agent CLI (`packages/cli/`) & Web UI (`packages/web-app/`)**:
  - `cadmus` enumerates every protocol RPC from the contract. See [`packages/cli/README.md`](packages/cli/README.md).
  - React + Vite Web UI (`@cadmus/web-app`), served by the Worker at `/`. `CadmusClient.callRpc` uses `GET`/`POST /api/*` (readonly vs mutating from the protocol `readOnly` flag), sends `Authorization: Bearer`, and keeps `CommandResultFrame` results. The token is not placed on `/api` URLs. Live events still arrive on `GET /ws` (a single-use ticket). Transport is `@cadmus/contract/client`. Deep links such as `/bot/$botId/config` resolve through the SPA fallback.

---

## Quickstart

### 1. Install Dependencies

```bash
bun install
```

### 2. Run the E2E Test Suite

All E2E tests execute inside the real Cloudflare Workers `workerd` runtime via `@cloudflare/vitest-plugin`:

```bash
bun run test
```

### 3. Typecheck Worker, CLI & Web UI

```bash
bun run typecheck
```

### 4. Local Development

Start the Cloudflare Worker locally:

```bash
bun run dev
```

#### Option A: Web UI (Vite)

In a second terminal, start the Web UI development server:

```bash
bun run web-app:dev
```

Open [http://localhost:5174](http://localhost:5174) in your browser. The dev server proxies the same paths as `assets.run_worker_first` in `wrangler.jsonc` (`/health`, `/protocol/schema`, `/ws`, `/events`, `/rpc`, `/api/*`, `/tools-env/*`) to the local Worker at `http://localhost:8787`.

#### Option B: Agent CLI

In a second terminal, drive the local Worker with `cadmus`. Flags override `CADMUS_URL`, `CADMUS_TOKEN`, `CADMUS_ACCOUNT_ID`, and `CADMUS_FAMILY_ID`.

```bash
bun run cli --help
bun run cli --version
bun run cli commands --token dev-cadmus-secret
bun run cli bot.list --token dev-cadmus-secret --account default-account
```

`cadmus --skill` prints a contract-generated SKILL.md. `cadmus send <chatKey> <text>` waits for the turn. Build targets are in [`packages/cli/README.md`](packages/cli/README.md).

### 5. Deployment (Cloudflare Workers)

```bash
bun run build
bun run deploy
```

> [!IMPORTANT]
> **No External SQL Migrations**: Database tables in both D1 (`CADMUS_ADMIN_DB`) and DO SQLite (`CadmusBotFamilyDO`) are self-initializing and self-migrating via code on first access. Never create `migrations/*.sql` files or run `wrangler d1 migrations` commands.

### 6. Edge Caching & Optional Workers KV (`CADMUS_CACHE_KV`)

Cadmus includes an edge caching layer (`packages/worker/src/edge-cache.ts`) for token resolution and Bot Family DO routing info:
- **L1 (In-Memory)**: Always enabled, zero latency, 60s TTL, bounded LRU cache per isolate.
- **L2 (Workers KV)**: Optional distributed cache via `CADMUS_CACHE_KV` binding.
- **Master Secret Fast-Path**: Constant-time comparison on raw token; skips repeat D1 `ensureAccountAndUser` upserts within the isolate.

To enable L2 distributed KV caching across isolates:
```bash
# Create production and preview KV namespaces
wrangler kv namespace create cadmus-cache
wrangler kv namespace create cadmus-cache-preview
```

Then bind them in `wrangler.jsonc`:
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

Cadmus can run completely self-contained on your own hardware or VM using **[`celld`](https://celld.dev)**—an open-source daemon that runs Cloudflare Workers and Durable Objects locally using embedded SQLite "cells" without requiring any external Cloudflare account or cloud database.

The included [`docker/Dockerfile`](docker/Dockerfile) bundles the entire stack into a single, self-sufficient container:
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
  -e CADMUS_AUTH_SECRET="your-secure-auth-secret" \
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

From your host machine:

```bash
bun run cli bot.list --url http://localhost:8787 --token your-secure-auth-secret
```

Or run the CLI directly inside the running container:

```bash
docker exec -it cadmus bun run cli bot.list --url http://localhost:8787 --token your-secure-auth-secret
```

### Configuration Environment Variables

| Variable | Default | Description |
| :--- | :--- | :--- |
| `PORT` | `8787` | HTTP/WebSocket listener port |
| `HOST` | `0.0.0.0` | Network interface to bind |
| `CADMUS_AUTH_SECRET` | `dev-cadmus-secret` | Master admin bearer token for edge authentication |
| `CADMUS_ENCRYPTION_KEY` | `dev-cadmus-encryption-key-32bytes!` | Master key for AES-GCM 256-bit BYOK credential encryption |
| `CADMUS_DEFAULT_TIMEZONE` | `UTC` | Default timezone for scheduled cron expressions |
| `CADMUS_HARVEST_DELAY_MS` | `60000` | Inactivity threshold before idle conversation harvest runs |
| `CADMUS_HEARTBEAT_MS` | `30000` | Daemon heartbeat interval while a tool call is in flight. Unset or non-numeric keeps 30000. A number is rounded and clamped to 50–120000. Tests set `200` in `vitest.config.ts`. Production leaves this unset. |
| `CADMUS_LOG_LEVEL` | `debug` | Logging verbosity (`debug`, `info`, `warn`, `error`) |
| `ANTHROPIC_API_KEY` | *(optional)* | Anthropic API key |
| `OPENAI_API_KEY` | *(optional)* | OpenAI API key |
| `OPENROUTER_API_KEY` | *(optional)* | OpenRouter API key |
| `XAI_API_KEY` | *(optional)* | xAI API key |

---

## Documentation

See [`docs/architecture.md`](docs/architecture.md) for the high-level architecture index and links to detailed subsystem docs.
For coding agents working on this repository, read [`AGENTS.md`](AGENTS.md) first.

