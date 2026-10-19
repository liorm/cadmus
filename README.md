# Cadmus (`cadmus`) — Cloud-Native Multi-Bot Agent Runtime

Cadmus is the cloud-native V2 architecture of `pi-bot`, built on **Cloudflare Workers**, **Cloudflare D1**, and **SQLite-backed Cloudflare Durable Objects (`CadmusBotFamilyDO`)** over [`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable) and [`@earendil-works/pi-ai`](https://www.npmjs.com/package/@earendil-works/pi-ai).

## Key Highlights

- **Two-Tier Storage Architecture**:
  - **Global Admin Database (`CADMUS_ADMIN_DB` on Cloudflare D1)**: Stores cross-family account data — users, auth tokens, accounts, user-to-account memberships, AES-GCM 256-bit encrypted BYOK credentials, and the Bot Families catalog (`account_id <-> family_id <-> do_name`).
  - **Per-Family Durable Object (`CadmusBotFamilyDO` on DO SQLite)**: Co-locates all bots, chats, virtual files (`SOUL.md`, `MEMORY.md`, `knowledge/<slug>.md` with CAS optimistic concurrency), schedules, harvest watermarks/notes (`cadmus_*` tables), and `pi-durable` conversations/tasks (`cadmus_pi_*` tables) for one Bot Family inside a single SQLite-backed Durable Object (`cadmus:<accountId>:<familyId>`).
- **Schema-Validated Protocol + `ProtocolShim`**:
  - UI-agnostic JSON protocol (`POST /rpc`, `GET /ws` WebSocket, `GET /events` SSE) validated with TypeBox and exported as standard JSON Schema at `GET /protocol/schema`.
- **Unified Schedule & Idle Harvest Engine (`ScheduleTask`)**:
  - Single durable `cadmus.schedule` task (`wait` -> `run`) driving 5-field cron schedules, one-shot `when` timers, and idle knowledge/memory harvest forks (`harvest:<chatKey>`) via a single Durable Object alarm (`ctx.storage.setAlarm`).
- **Out-of-Band `/status`**:
  - Inspects live conversation, bot, usage, harvest watermark, and alarm state out-of-band without polluting conversation transcripts or invoking the LLM.
- **Standalone TUI Client (`tui/`)**:
  - Independent package with its own `package.json` and `tsconfig.json` that drives the Worker/DO purely over the wire protocol.

---

## Quickstart

### 1. Install Dependencies

```bash
bun install
bun install --cwd tui
```

### 2. Run the E2E Test Suite

All E2E tests execute inside the real Cloudflare Workers `workerd` runtime via `@cloudflare/vitest-plugin`:

```bash
bun run test
```

### 3. Typecheck Worker & Standalone TUI

```bash
bun run typecheck
```

### 4. Local Development & Standalone TUI

Start the Cloudflare Worker locally:

```bash
bun run dev
```

In a second terminal, launch the standalone TUI against your local Worker:

```bash
bun run tui
# Or pass explicit flags:
bun run tui -- --url http://localhost:8787 --token dev-cadmus-secret --account default-account --family default
```

Inside the TUI:
- `:bot new <slug> <name> [model]` — Create a bot (defaults to offline `faux/echo` model)
- `:chat new <botId> [title]` — Create a chat and switch to it
- `:use <chatKey>` — Switch active chat
- `:status` (or `/status`) — Inspect live chat/bot status out-of-band
- `:files <botId>` / `:read <botId> <path>` — Inspect `SOUL.md`, `MEMORY.md`, and `knowledge/<slug>.md`
- `:cred set <provider> <apiKey>` — Configure an encrypted BYOK credential (`xai`, `openai`, `anthropic`)
- `:help` — List all TUI meta-commands

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

### 4. Connect with the Standalone TUI

From your host machine:

```bash
bun run tui -- --url http://localhost:8787 --token your-secure-auth-secret
```

Or run the TUI directly inside the running container:

```bash
docker exec -it cadmus bun run tui -- --url http://localhost:8787 --token your-secure-auth-secret
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
| `CADMUS_LOG_LEVEL` | `debug` | Logging verbosity (`debug`, `info`, `warn`, `error`) |
| `ANTHROPIC_API_KEY` | *(optional)* | Anthropic API key |
| `OPENAI_API_KEY` | *(optional)* | OpenAI API key |
| `OPENROUTER_API_KEY` | *(optional)* | OpenRouter API key |
| `XAI_API_KEY` | *(optional)* | xAI API key |

---

## Documentation

See [`docs/architecture.md`](docs/architecture.md) for the high-level architecture index and links to detailed subsystem docs.
For coding agents working on this repository, read [`AGENTS.md`](AGENTS.md) first.

