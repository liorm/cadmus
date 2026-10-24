# AGENTS.md — Coding Agent Handbook for Cadmus (`cadmus`)

This document contains everything an autonomous coding agent needs to understand, modify, and verify the Cadmus codebase.

---

## 1. Core Architectural Invariants

1. **Shared Cloudflare Account Prefixing**:
   - The Cloudflare account is shared across projects. Keep all bindings, classes, DO names, and SQLite tables prefixed with `cadmus` / `CADMUS_`:
     - Durable Object class: `CadmusBotFamilyDO` (`CADMUS_BOT_FAMILY` binding)
     - Deterministic DO instance name: `cadmus:${accountId}:${familyId}`
     - Global D1 binding: `CADMUS_ADMIN_DB` (`cadmus-admin`)
     - All D1 tables and DO SQLite tables use the `cadmus_` prefix (`cadmus_pi_` for `pi-durable` internal tables).

2. **Two-Tier Storage Boundary (No `pi-durable` Session `Doc`s for Domain Entities)**:
   - Do **not** use `pi-durable` `defineDoc` session documents to store bots, files, chats, schedules, or harvest notes.
   - **Rule of Thumb**:
     - Anything that belongs inside one Bot Family's conversations and chats lives in **`FamilyStore`** ([`src/store/family-interface.ts`](src/store/family-interface.ts) -> [`SqliteFamilyStore`](src/store/sqlite-family.ts) on DO SQLite).
     - Anything global or administrative (users, auth tokens, accounts, user-to-account memberships, account-level encrypted BYOK credentials, and the `account <-> family <-> DO` catalog) lives in **`AdminStore`** ([`src/store/admin-interface.ts`](src/store/admin-interface.ts) -> [`D1AdminStore`](src/store/d1-admin.ts) on Cloudflare D1).
     - `pi-durable` is used strictly for conversations, transcript entries, model turns, and durable tasks (`ScheduleTask`, `SearchBotTask`).

3. **Out-of-Band `/status` Only**:
   - Slash command `/status` is intercepted out-of-band in `CadmusBotFamilyDO` before `conversation.submit()`.
   - It must **never** append entries to the conversation transcript or invoke the LLM.
   - Other legacy slash commands (`/new`, `/reset`, `/clear`, `/compact`, `/stop`, `/help`) are intentionally omitted and return `unsupported_command`.

4. **Unified Schedule & Idle Harvest Mechanism (`ScheduleTask`)**:
   - Do **not** introduce a separate `HarvestTask`.
   - Cron schedules, one-shot `when` timers, and idle harvest timers (`id = "harvest:<chatKey>"`, `internal = true`, `kind = "when"`, `target = { mode: "fork", chatKey, at, harvest: true }`) all execute through the single [`ScheduleTask`](src/schedules.ts) (`cadmus.schedule`, phases: `wait` -> `run`).
   - [`syncDurableObjectAlarm`](src/alarms.ts) inspects `harness.inspect(BACKGROUND_CONTEXT)` and enabled schedules in `FamilyStore` to program `ctx.storage.setAlarm(nextWake)`.

5. **Standalone TUI (`tui/`)**:
   - `tui/` is an independent project with its own [`tui/package.json`](tui/package.json) and [`tui/tsconfig.json`](tui/tsconfig.json) (`verbatimModuleSyntax: true`).
   - Never import runtime code from `src/` into `tui/src/`. Only `import type { ... } from "../../src/protocol.js"` is allowed.

6. **Idempotent Replay Safety (`replay: "safe"`)**:
   - All mutating agent tools (`knowledge_update`, `knowledge_delete`, `memory_update`, `schedule_create`, `schedule_update`, `schedule_delete`, `create_bot`, `message_bot`, `web.fetch`) must memoize their side-effect results via `await api.memo(key, value, context)` so `pi-durable` task replay across DO restarts never duplicates mutations.

7. **Structured Logging Only (`src/log.ts`, Zero `console.*`)**:
   - Never use `console.log`, `console.warn`, `console.error`, or `console.debug` anywhere in the codebase.
   - Always log through [`getLogger()`](src/log.ts) (configured via [`setupLogger()`](src/log.ts) / [`ensureLogger()`](src/log.ts), supporting `{ type: "console", level, stream, colors }`, `{ type: "custom", logger }`, and `{ type: "silent" }`) with structured `LogFields` and `.child(chatFields(...))` / `.child(familyFields(...))`.

8. **Self-Initializing DB Schemas (Zero SQL Migration Files / No D1 Migrations)**:
   - Neither D1 nor Durable Object SQLite uses external SQL migration files (e.g. `migrations/*.sql`) or `wrangler d1 migrations` commands.
   - **Do not add a `migrations/` directory, `migrations_dir` in `wrangler.jsonc`, or `db:migrate:*` scripts in `package.json`**.
   - **Cloudflare D1 (`CADMUS_ADMIN_DB`)**: Schema is self-initializing and self-migrating in code inside [`src/store/d1-admin.ts`](src/store/d1-admin.ts) (`D1AdminStore.initialize()`), using `CREATE TABLE IF NOT EXISTS`, column inspection via `PRAGMA table_info`, and non-destructive `ALTER TABLE ADD COLUMN`.
   - **DO SQLite (`CadmusBotFamilyDO`)**: Schema is self-initializing in code inside [`src/store/sqlite-family.ts`](src/store/sqlite-family.ts) (`SqliteFamilyStore.initialize()`), using `CREATE TABLE IF NOT EXISTS` and index creation. DO class declarations use Wrangler class migrations in `wrangler.jsonc` (`new_sqlite_classes`), not SQL files.
   - Deployment is pure `bun run deploy` (`wrangler deploy --keep-vars`) without any pre-deployment database migration steps.

9. **Task & Issue Management via GitHub Issues**:
   - All tasks, performance improvements, bug fixes, and feature tickets are managed directly via **GitHub Issues** on [`liorm/pi-bot`](https://github.com/liorm/pi-bot/issues) using the GitHub CLI (`gh issue ...`).
   - Do not create or track tickets in local markdown documents unless explicitly requested.

---

## 2. Project Layout

```text
├── src/
│   ├── index.ts                 # Worker Edge entrypoint (/health, /protocol/schema, auth, routing)
│   ├── family-do.ts             # CadmusBotFamilyDO (RPC, WS, SSE, alarm(), pi-durable harness)
│   ├── log.ts                   # Structured logger (setupLogger, getLogger, chatFields, familyFields)
│   ├── protocol.ts              # TypeBox schemas & types for all commands and server frames
│   ├── shim.ts                  # ProtocolShim interface & defaultJsonShim
│   ├── auth.ts                  # Edge request authentication (Bearer, cookie, D1 member tokens)
│   ├── context.ts               # CadmusServices Chord context binding
│   ├── models.ts                # pi-ai Models, AccountCredentialStore, xAI native tools, faux/echo
│   ├── cron.ts                  # 5-field cron parser and nextCron calculator
│   ├── schedules.ts             # Unified ScheduleTask (cron, when, and harvest forks)
│   ├── alarms.ts                # Unified DO Alarm Driver (scheduledWakeTime & setAlarm)
│   ├── store/
│   │   ├── admin-interface.ts   # Global AdminStore interface
│   │   ├── d1-admin.ts          # Cloudflare D1 implementation + Web Crypto AES-GCM 256-bit
│   │   ├── family-interface.ts  # Per-family FamilyStore interface
│   │   └── sqlite-family.ts     # DO SQLite implementation + CAS & unified diffing
│   └── extensions/
│       ├── identity.ts          # 5 prompt sections (soul, system, knowledge, memory, date)
│       ├── knowledge-tools.ts   # knowledge_read/update/delete, memory_read/update
│       ├── schedules-tools.ts   # schedule_create/list/update/delete
│       ├── internal-tools.ts    # create_bot, search_bot (SearchBotTask), message_bot
│       ├── tool-gate.ts         # Per-bot tool policy enforcement (beforeTool hook)
│       └── web-tools.ts         # web.fetch and provider-native tool stubs
├── tui/                         # Standalone TUI client package
├── e2e/                         # Protocol-first E2E tests running in workerd
└── docs/                        # Architecture index and sub-docs
```

---

## 3. Running & Writing Tests

### Commands

```bash
# Run full E2E test suite in workerd
bun run test

# Typecheck both root Worker and standalone TUI (fast native check via bun check)
bun run typecheck
bun check

# Lint and format with Biome
bun run lint
bun run format
bun run format:check
bun run check:all
```

### How to Write E2E Tests

1. Place E2E tests under `e2e/*.test.ts`.
2. Use [`sendRpc`](e2e/helpers.ts) (for `POST /rpc`) and [`connectTestWs`](e2e/helpers.ts) (for `GET /ws` WebSocket) over `SELF.fetch` from `cloudflare:test`.
3. Use unique `accountId` / `familyId` scopes per test to isolate D1 and Durable Object state cleanly.
4. Use the deterministic offline model `faux/echo`:
   - Standard user text `"Hello"` replies with `"echo(<visibleUserMessages>): Hello"`.
   - Embed `[tool:<toolName> <jsonArgs>]` in a user prompt to trigger a real tool call through `pi-durable`'s tool execution pipeline during a turn.
   - Embed `[remember: <fact>]` or `[learn:<slug> <body>]` in a user prompt and trigger `await runDurableObjectAlarm(stub)` from `cloudflare:test` to test the full idle harvest fork -> tool call -> file diff -> `HarvestNote` pipeline.
