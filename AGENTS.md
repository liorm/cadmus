# AGENTS.md — Coding Agent Handbook for Cadmus (`cadmus`)

This document contains everything an autonomous coding agent needs to understand, modify, and verify the Cadmus codebase.

---

## 1. Core Architectural Invariants

1. **Shared Cloudflare Account Prefixing**:
   - The Cloudflare account is shared across projects. Keep all bindings, classes, DO names, and SQLite tables prefixed with `cadmus` / `CADMUS_`:
     - Durable Object class: `CadmusBotFamilyDO` (`CADMUS_BOT_FAMILY` binding)
     - Deterministic DO instance name: `cadmus:${accountId}:${familyId}`
     - Global D1 binding: `CADMUS_ADMIN_DB` (`cadmus-admin`)
     - Optional KV cache binding: `CADMUS_CACHE_KV` (`cadmus-cache`, keys prefixed `cadmus:v1:${envTag}:...`)
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
   - `tui/src/` imports only `@cadmus/contract/types` and `@cadmus/contract/routes`. It does not import `src/` or `daemon/`. See [API boundaries](#4-api-boundaries).

6. **Idempotent Replay Safety (`replay: "safe"`)**:
   - All mutating agent tools (`knowledge_update`, `knowledge_delete`, `memory_update`, `schedule_create`, `schedule_update`, `schedule_delete`, `create_bot`, `message_bot`, `web.fetch`) must memoize their side-effect results via `await api.memo(key, value, context)` so `pi-durable` task replay across DO restarts never duplicates mutations.

7. **REST `/api/*` Is a Translation of the Protocol, Not a Second Dispatcher**:
   - Readonly vs mutating is the TypeBox `readOnly` option on each command schema in [`packages/contract`](packages/contract) (`commands.ts` and `oauth.ts`). Do not keep a parallel method map.
   - [`isCommandReadOnly`](src/protocol/rest.ts) / path mapping (`file.read` ↔ `/api/file/read`) live in [`src/protocol/rest.ts`](src/protocol/rest.ts), re-exported from [`src/protocol.ts`](src/protocol.ts). Path strings live in [`src/protocol/rest-encode.ts`](src/protocol/rest-encode.ts) and do not import TypeBox. `encodePayloadQuery` has one implementation, generated into `@cadmus/contract/routes` and re-exported from `src/protocol.ts`. Do not keep a second encoder or a parallel hand-written readonly list.
   - `/api/*` authenticates with the same `authenticateRequest` path as `/rpc`, then runs the shared command dispatch. It does not replace `/rpc` or `/ws`. `/api` calls that path with `{ allowQueryToken: false, allowCookie: false }`: the only credential is `Authorization: Bearer`. A `token` query parameter is **401** `{ error: { code: "query_token_not_allowed" } }` even when a valid header is also present, and the query value is never logged. A `cadmus_session` cookie without that header is **401** `{ error: { code: "header_required" } }`. `/rpc`, `/ws`, and `/events` still accept the query token and the session cookie. `token` is not a reserved `/api` query key. OpenAPI and AsyncAPI documents are internal generated artifacts; the Worker does not serve them. `/api/openapi.json` and `/api/asyncapi.json` are unknown `/api` paths (header auth first, then **404**).
   - The Web UI `CadmusClient.callRpc` / `sendCommand` keep their signatures and `CommandResultFrame` results, but the HTTP call is `/api/*` via `@cadmus/contract/routes` (`API_ROUTES` and `encodePayloadQuery`). The web bundle ships that route table, not the TypeBox schemas. Transport failures and non-JSON bodies reject. HTTP and protocol error JSON resolves as `{ ok: false, error }`. `GET /ws` stays event-only. The TUI prefers an open WebSocket and falls back to the same `/api` routes. The `sendRpc` test helper still uses `/rpc`.

8. **Structured Logging Only (`src/log.ts`, Zero `console.*`)**:
   - Never use `console.log`, `console.warn`, `console.error`, or `console.debug` anywhere in the codebase.
   - Always log through [`getLogger()`](src/log.ts) (configured via [`setupLogger()`](src/log.ts) / [`ensureLogger()`](src/log.ts), supporting `{ type: "console", level, stream, colors }`, `{ type: "custom", logger }`, and `{ type: "silent" }`) with structured `LogFields` and `.child(chatFields(...))` / `.child(familyFields(...))`.

9. **Self-Initializing DB Schemas (Zero SQL Migration Files / No D1 Migrations)**:
   - Neither D1 nor Durable Object SQLite uses external SQL migration files (e.g. `migrations/*.sql`) or `wrangler d1 migrations` commands.
   - **Do not add a `migrations/` directory, `migrations_dir` in `wrangler.jsonc`, or `db:migrate:*` scripts in `package.json`**.
   - **Cloudflare D1 (`CADMUS_ADMIN_DB`)**: Schema is self-initializing and self-migrating in code inside [`src/store/d1-admin.ts`](src/store/d1-admin.ts) (`D1AdminStore.initialize()`), using `CREATE TABLE IF NOT EXISTS`, column inspection via `PRAGMA table_info`, and non-destructive `ALTER TABLE ADD COLUMN`.
     - **Schema Version Marker & Cold Isolate Guard**: D1 tracks schema version in `cadmus_schema_meta` (`key = 'version'`). Code defines `CADMUS_SCHEMA_VERSION` (currently `1`). On cold isolate boot, a single cheap read checks `cadmus_schema_meta`; full CREATE/PRAGMA/ALTER migrations execute only if the stored version is older or missing.
     - **Bumping Schema Version**: When altering or adding D1 tables/columns in [`src/store/d1-admin.ts`](src/store/d1-admin.ts), always increment `CADMUS_SCHEMA_VERSION` so new isolates and migrations apply automatically.
     - **Warm Isolate Bypass (Zero Round-Trips)**: The Edge worker caches D1 initialization per isolate lifecycle (`ensureAdminStoreInitialized` / `isD1DatabaseInitialized`). Warm requests bypass schema initialization completely (0 queries).
     - **Narrow Missing-Schema Fallback**: If a query encounters a "no such table" or "no such column" error, the D1 wrapper automatically invalidates isolate cache, forces schema migration, and retries the operation once.
   - **DO SQLite (`CadmusBotFamilyDO`)**: Schema is self-initializing in code inside [`src/store/sqlite-family.ts`](src/store/sqlite-family.ts) (`SqliteFamilyStore.initialize()`), using `CREATE TABLE IF NOT EXISTS` and index creation. DO class declarations use Wrangler class migrations in `wrangler.jsonc` (`new_sqlite_classes`), not SQL files.
   - Deployment is pure `bun run deploy` (`wrangler deploy --keep-vars`) without any pre-deployment database migration steps.

10. **Task & Issue Management via GitHub Issues**:
   - All tasks, performance improvements, bug fixes, and feature tickets are managed directly via **GitHub Issues** on [`liorm/pi-bot`](https://github.com/liorm/pi-bot/issues) using the GitHub CLI (`gh issue ...`).
   - Do not create or track tickets in local markdown documents unless explicitly requested.

---

## 2. Project Layout

```text
├── packages/contract/           # @cadmus/contract declarations (types, schemas, generated routes, OpenAPI, AsyncAPI)
├── scripts/                     # contract generator and API boundary check
├── src/
│   ├── index.ts                 # Worker Edge entrypoint (/health, /protocol/schema, /rpc, /api, auth, routing)
│   ├── api-adapter.ts           # /api/* ↔ ClientCommand translation (uses the /rpc dispatch path)
│   ├── command-handlers.ts      # CommandHandlerMap: one handler per contract command
│   ├── family-do.ts             # CadmusBotFamilyDO (RPC, WS, SSE, alarm(), pi-durable harness)
│   ├── log.ts                   # Structured logger (setupLogger, getLogger, chatFields, familyFields)
│   ├── protocol.ts              # Re-exports the contract plus server REST and validation helpers
│   ├── shim.ts                  # ProtocolShim interface & defaultJsonShim
│   ├── auth.ts                  # Edge auth (Bearer; cookie and ?token= on /rpc /ws /events only)
│   ├── edge-cache.ts            # Two-tier Edge Cache (L1 LRU memory + optional L2 Workers KV)
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

# Contract conformance (daemon wire tests + every command through the Worker)
bun run test:conformance

# Regenerate committed routes, OpenAPI, and AsyncAPI, or fail if they are stale
bun run contract:gen
bun run contract:check

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

---

## 4. API boundaries

The backend publishes the API as [`@cadmus/contract`](packages/contract). That package is declarations: command names, payload and result schemas, the `readOnly` flag, error codes, record types, the `{ error: { code, message } }` envelope, and the `/ws` and `/events` message unions. The only dependency is `typebox`.

Clients never import backend source. `web/src` and `tui/src` import `@cadmus/contract/types` (types only) and `@cadmus/contract/routes` (the small generated route table and query encoder). They do not import `src/`, `daemon/`, `@cadmus/contract/schemas`, or the generated OpenAPI and AsyncAPI documents. Our clients do not depend on those documents. OpenAPI (`packages/contract/generated/openapi.json`) and AsyncAPI (`packages/contract/generated/asyncapi.json`) are internal, committed, validated artifacts. The Worker does not serve them and does not import them, so they are not in the Worker bundle.

Contract changes are explicit and reviewed. Edit the schemas under `packages/contract/src`, then run `bun run contract:gen`. Commit the regenerated `packages/contract/generated/routes.ts`, `openapi.json`, and `asyncapi.json`. `bun run contract:check` regenerates those files in memory, formats them, and fails if the committed copies differ. `bun run boundaries` (`scripts/check-boundaries.ts`) fails if a client imports backend source, anything other than `@cadmus/contract/types` and `@cadmus/contract/routes`, or the contract imports anything other than `typebox`. The scanner reads whole-file `import`, `export ... from`, `import type`, dynamic `import()`, and `require()`, including when the specifier is on a later line. Biome `noRestrictedImports` overrides on `web/**` and `tui/**` reject `src/`, `daemon/`, the bare `@cadmus/contract` package, `@cadmus/contract/schemas`, and the generated OpenAPI and AsyncAPI documents. Both checks run at the start of `bun run check:all`.

`packages/contract` is the only Bun workspace member. `web/` and `tui/` stay separate packages and depend on the contract with `"@cadmus/contract": "file:../packages/contract"`, so Cloudflare Workers Builds can keep running `bun install --cwd web` without a workspace install. Do not add `web/` or `tui/` to the root workspaces, and do not change `wrangler.jsonc` to alias the package.

Bump `CADMUS_SCHEMA_VERSION` only when D1 tables or columns change in [`src/store/d1-admin.ts`](src/store/d1-admin.ts). A contract or HTTP change does not bump that version. The handler map in [`src/command-handlers.ts`](src/command-handlers.ts) is typed so a missing or mismatched command handler fails `bun run typecheck`.
