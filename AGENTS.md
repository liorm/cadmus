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
     - Anything that belongs inside one Bot Family's conversations and chats lives in **`FamilyStore`** ([`packages/worker/src/store/family-interface.ts`](packages/worker/src/store/family-interface.ts) -> [`SqliteFamilyStore`](packages/worker/src/store/sqlite-family.ts) on DO SQLite).
     - Anything global or administrative (users, auth tokens, accounts, user-to-account memberships, account-level encrypted BYOK credentials, and the `account <-> family <-> DO` catalog) lives in **`AdminStore`** ([`packages/worker/src/store/admin-interface.ts`](packages/worker/src/store/admin-interface.ts) -> [`D1AdminStore`](packages/worker/src/store/d1-admin.ts) on Cloudflare D1).
     - `pi-durable` is used strictly for conversations, transcript entries, model turns, and durable tasks (`ScheduleTask`, `SearchBotTask`).

3. **No Slash Commands; Status Is `chat.status`**:
   - Live bot/chat runtime status is the `chat.status` RPC (`{ status }`). The web-app header reads that record. Slash commands are not a protocol verb.
   - Legacy slash commands (`/status`, `/new`, `/reset`, `/clear`, `/compact`, `/stop`, `/help`) return `unsupported_command` from `turn.submit` and never append to the transcript or invoke the LLM.

4. **Unified Schedule & Idle Harvest Mechanism (`ScheduleTask`)**:
   - Do **not** introduce a separate `HarvestTask`.
   - Cron schedules, one-shot `when` timers, and idle harvest timers (`id = "harvest:<chatKey>"`, `internal = true`, `kind = "when"`, `target = { mode: "fork", chatKey, at, harvest: true }`) all execute through the single [`ScheduleTask`](packages/worker/src/schedules.ts) (`cadmus.schedule`, phases: `wait` -> `run`).
   - [`syncDurableObjectAlarm`](packages/worker/src/alarms.ts) inspects `harness.inspect(BACKGROUND_CONTEXT)` and enabled schedules in `FamilyStore` to program `ctx.storage.setAlarm(nextWake)`.

5. **Agent CLI (`packages/cli/`)**:
   - `packages/cli/` is `@cadmus/cli` (bin `cadmus`). It replaces the old readline TUI. Commands, `--help`, `commands`, and `--skill` are generated at runtime from `API_ROUTES` and the contract command schemas. `send` and `events` are the only special verbs.
   - It ships like `packages/daemon`: `bun build --compile` scripts, gitignored `dist/`, `version.ts`, and `--version`.
   - `packages/cli/src/` imports `@cadmus/contract/types`, `@cadmus/contract/routes`, `@cadmus/contract/tools`, `@cadmus/contract/client`, and `@cadmus/contract/schemas`. It does not import `packages/worker/` or `packages/daemon/`. See [API boundaries](#4-api-boundaries).

6. **Idempotent Replay Safety (`replay: "safe"`)**:
   - All mutating agent tools (`knowledge_update`, `knowledge_delete`, `memory_update`, `schedule_create`, `schedule_update`, `schedule_delete`, `create_bot`, `message_bot`, `web.fetch`) must memoize their side-effect results via `await api.memo(key, value, context)` so `pi-durable` task replay across DO restarts never duplicates mutations.

7. **REST `/api/*` Is a Translation of the Protocol, Not a Second Dispatcher**:
   - Readonly vs mutating is the TypeBox `readOnly` option on each command schema in [`packages/contract`](packages/contract) (`commands.ts` and `oauth.ts`). Do not keep a parallel method map.
   - [`isCommandReadOnly`](packages/worker/src/protocol/rest.ts) / path mapping (`file.read` ↔ `/api/file/read`) live in [`packages/worker/src/protocol/rest.ts`](packages/worker/src/protocol/rest.ts), re-exported from [`packages/worker/src/protocol.ts`](packages/worker/src/protocol.ts). Path strings live in [`packages/worker/src/protocol/rest-encode.ts`](packages/worker/src/protocol/rest-encode.ts) and do not import TypeBox. `encodePayloadQuery` has one implementation, generated into `@cadmus/contract/routes` and re-exported from `packages/worker/src/protocol.ts`. Do not keep a second encoder or a parallel hand-written readonly list.
   - `/api/*` authenticates with the same `authenticateRequest` path as `/rpc`, then runs the shared command dispatch. It does not replace `/rpc` or `/ws`. `/api` calls that path with `{ allowQueryToken: false, allowCookie: false }`: the only credential is `Authorization: Bearer`. A `token` query parameter is **401** `{ error: { code: "query_token_not_allowed" } }` even when a valid header is also present, and the query value is never logged. A `cadmus_session` cookie without that header is **401** `{ error: { code: "header_required" } }`. `/rpc`, `/ws`, and `/events` accept the same `Authorization: Bearer` credential and refuse both the query token and the `cadmus_session` cookie. `/ws` and `/events` open with a single-use ticket from `auth.ticket`, not with the bearer in the URL. `token` is not a reserved `/api` query key. OpenAPI and AsyncAPI documents are internal generated artifacts; the Worker does not serve them. `/api/openapi.json` and `/api/asyncapi.json` are unknown `/api` paths (header auth first, then **404**).
   - The Web UI `CadmusClient.callRpc` / `sendCommand` keep their signatures and `CommandResultFrame` results, but the HTTP call is `/api/*` via `@cadmus/contract/routes` (`API_ROUTES` and `encodePayloadQuery`). The web bundle ships that route table, not the TypeBox schemas. Transport failures and non-JSON bodies reject. HTTP and protocol error JSON resolves as `{ ok: false, error }`. `GET /ws` stays event-only. The TUI prefers an open WebSocket and falls back to the same `/api` routes. The `sendRpc` test helper still uses `/rpc`.

8. **Structured Logging Only (`packages/worker/src/log.ts`, Zero `console.*`)**:
   - Never use `console.log`, `console.warn`, `console.error`, or `console.debug` anywhere in the codebase.
   - Always log through [`getLogger()`](packages/worker/src/log.ts) (configured via [`setupLogger()`](packages/worker/src/log.ts) / [`ensureLogger()`](packages/worker/src/log.ts), supporting `{ type: "console", level, stream, colors }`, `{ type: "custom", logger }`, and `{ type: "silent" }`) with structured `LogFields` and `.child(chatFields(...))` / `.child(familyFields(...))`.

9. **Self-Initializing DB Schemas (Zero SQL Migration Files / No D1 Migrations)**:
   - Neither D1 nor Durable Object SQLite uses external SQL migration files (e.g. `migrations/*.sql`) or `wrangler d1 migrations` commands.
   - **Do not add a `migrations/` directory, `migrations_dir` in `wrangler.jsonc`, or `db:migrate:*` scripts in `package.json`**.
   - **Cloudflare D1 (`CADMUS_ADMIN_DB`)**: Schema is self-initializing and self-migrating in code inside [`packages/worker/src/store/d1-admin.ts`](packages/worker/src/store/d1-admin.ts) (`D1AdminStore.initialize()`), using `CREATE TABLE IF NOT EXISTS`, column inspection via `PRAGMA table_info`, and non-destructive `ALTER TABLE ADD COLUMN`.
     - **Schema Version Marker & Cold Isolate Guard**: D1 tracks schema version in `cadmus_schema_meta` (`key = 'version'`). Code defines `CADMUS_SCHEMA_VERSION` (currently `2`). On cold isolate boot, a single cheap read checks `cadmus_schema_meta`; full CREATE/PRAGMA/ALTER migrations execute only if the stored version is older or missing.
     - **Bumping Schema Version**: When altering or adding D1 tables/columns in [`packages/worker/src/store/d1-admin.ts`](packages/worker/src/store/d1-admin.ts), always increment `CADMUS_SCHEMA_VERSION` so new isolates and migrations apply automatically.
     - **Warm Isolate Bypass (Zero Round-Trips)**: The Edge worker caches D1 initialization per isolate lifecycle (`ensureAdminStoreInitialized` / `isD1DatabaseInitialized`). Warm requests bypass schema initialization completely (0 queries).
     - **Narrow Missing-Schema Fallback**: If a query encounters a "no such table" or "no such column" error, the D1 wrapper automatically invalidates isolate cache, forces schema migration, and retries the operation once.
   - **DO SQLite (`CadmusBotFamilyDO`)**: Schema is self-initializing in code inside [`packages/worker/src/store/sqlite-family.ts`](packages/worker/src/store/sqlite-family.ts) (`SqliteFamilyStore.initialize()`), using `CREATE TABLE IF NOT EXISTS` and index creation. DO class declarations use Wrangler class migrations in `wrangler.jsonc` (`new_sqlite_classes`), not SQL files.
   - Deployment is pure `bun run deploy` (`wrangler deploy --keep-vars`) without any pre-deployment database migration steps.

10. **Task & Issue Management via GitHub Issues**:
   - All tasks, performance improvements, bug fixes, and feature tickets are managed directly via **GitHub Issues** on [`liorm/cadmus`](https://github.com/liorm/cadmus/issues) using the GitHub CLI (`gh issue ...`).
   - Do not create or track tickets in local markdown documents unless explicitly requested.

11. **Verification & Check Cadence (No Speculative Checks Upfront)**:
   - **Do not run `bun run check:all`, test suites, or linters at the start of a task** before doing anything. Start working on the user's request immediately.
   - Run targeted checks (e.g. `bun run typecheck`, specific tests) or `bun run check:all` strictly **at the end** after making code changes to verify your modifications.
   - **Do not run `bun run web-app:screens` automatically**: Screenshots are strictly run on-demand only when explicitly requested by the user. Never run `bun run web-app:screens` as part of automated verification.

---

## 2. Project Layout

```text
├── packages/
│   ├── contract/                # @cadmus/contract declarations (types, schemas, generated routes, OpenAPI, AsyncAPI)
│   ├── worker/                  # @cadmus/worker Cloudflare Worker backend (/health, /protocol/schema, /rpc, /api, auth, DOs)
│   ├── web-app/                 # @cadmus/web-app Vite + React web UI (TanStack Router, served at /app)
│   ├── login-app/               # @cadmus/login-app Vite + React sign-in app (served at /login)
│   ├── cli/                     # @cadmus/cli agent CLI (bin `cadmus`)
│   └── daemon/                  # @cadmus/daemon Linux confinement daemon & CLI
├── scripts/                     # contract generator and API boundary check
├── tests/                       # Conformance tests (daemon wire, preview config, etc.)
├── e2e/                         # Protocol-first E2E tests running in workerd
└── docs/                        # Architecture index and sub-docs
```

---

## 3. Running & Writing Tests

### Testing Philosophy: Black-Box E2E Over Unit Tests

Unit testing is secondary. **Black-box End-to-End (E2E) tests are paramount** to guarantee that the system as a whole behaves correctly without leaking internal implementation details:
1. **Backend & Protocol API (`e2e/*.test.ts`)**: Black-box tests running against the real Worker runtime (`workerd` via Vitest / `cloudflare:test`), interacting strictly through HTTP/WS contract calls (`callApi`, `sendRpc`, `connectTestWs`, `workerFetch`). These guarantee that the API is solid, tenant-isolated, durable, and replay-safe across DO restarts.
2. **Web App Frontend**: The Playwright UI-flow suites (`packages/web-app/tests/flows`, `packages/web-app/tests/desktop`, `bun run test:ui`) are parked and excluded from CI and `check:all`. Do not maintain them. They may be revived later. Until they return, web UI changes are checked with `bun run --cwd packages/web-app test` (unit tests), `bun run typecheck`, and, when asked, `bun run web-app:screens`.
3. **Always Add / Update E2E Tests**: When introducing new features or modifying behavior, prioritize adding or updating black-box E2E tests (`e2e/*.test.ts` for backend/protocol changes). Unit tests should only be used for small isolated algorithmic utilities (e.g. text parsing, time formatting).

### Commands

```bash
# Run full E2E test suite in workerd
bun run test

# Contract conformance (daemon wire tests + every command through the Worker)
bun run test:conformance

# Regenerate committed routes, OpenAPI, and AsyncAPI, or fail if they are stale
bun run contract:gen
bun run contract:check

# Typecheck root, contract, cli, web-app, daemon, and worker (two projects at a time)
bun run typecheck

# Lint and format with Biome
bun run lint
bun run format
bun run format:check

# Static stages share two processes, then e2e runs alone. Same stages as before.
bun run check:all
```

### How to Write E2E & Worker Tests

1. Place black-box E2E tests under `e2e/*.test.ts`.
   - `e2e/` is strictly black-box: no file in `e2e/` may import from `packages/*` (`@cadmus/worker`, `@cadmus/web-app`, `@cadmus/cli`, `@cadmus/daemon`).
   - Only [`e2e/helpers.ts`](e2e/helpers.ts) may import `@cadmus/contract/{types,routes,tools,client,schemas}` and `cloudflare:test` (`SELF`). Every `e2e/*.test.ts` file imports only from `./helpers.js` (and `vitest`), calls [`useWorkerFixture`](e2e/helpers.ts) inside `describe(...)` to start/stop the Worker fixture, and interacts with the system strictly via HTTP/WS contract calls (`callApi`, `sendRpc`, `connectTestWs`, `workerFetch`).
   - Place white-box workerd tests (tests that inspect `env.CADMUS_BOT_FAMILY`, `env.CADMUS_ENV`, `env.CADMUS_ADMIN_DB`, `runDurableObjectAlarm`, `runInDurableObject`, `installProviderToolCapture`, or internal Worker modules) under `packages/worker/tests/*.test.ts` and pure Worker unit tests under `packages/worker/tests/unit/*.test.ts`.
   - Place non-worker integration/conformance tests under `tests/{conformance,contract,scripts}/` and package-scoped tests under `packages/{cli,daemon,web-app}/tests/`.
2. Provision a fresh Cadmus account per test with [`uniqueAccountId`](e2e/helpers.ts) (`crypto.randomUUID()`). Do not hardcode a shared account id (`acct-1`, `acct`, `default-account`, and the like). A Vitest worker reuses one workerd, so D1 rows, KV keys, Durable Object names (`cadmus:${accountId}:${familyId}`, `env:${accountId}:${envId}`), auth-token hashes, and isolate memo keys collide when two tests reuse an id. Compare assertions to the generated id. A tenant-isolation test uses two ids from the helper. Omitting `accountId` on a master-secret call authenticates as `default-account`; do not do that for a test that writes. Family and bot slugs stay scoped under that account.
   Parallel-safety for the rest of the shared worker state:
   - Restore global stubs before the test returns: `globalThis.fetch`, `env.CADMUS_ADMIN_DB.prepare` / `batch`, and `setupLogger` (back to `{ type: "silent" }`). `afterEach` alone is not enough when a test replaces the stub mid-body.
   - Auth tokens stored in D1 are unique by hash for the whole database. Generate the token (`crypto.randomUUID()`). Do not reuse a literal member token.
   - Tests that drop D1 tables or rewrite `cadmus_schema_meta` restore the schema before the test returns. The version row is database-global.
   - `EdgeCache.clearAllMemory` and `clearAllEdgeCaches` wipe isolate-wide caches. Call them only around the assertion that needs a cold cache, and clear again in `finally` if the test marked entries.
   - Do not install fake timers. Do not bind a fixed port. Egress stays on the in-worker mocks; there is no live network.
4. Use the deterministic offline model `faux/echo`:
   - Standard user text `"Hello"` replies with `"echo(<visibleUserMessages>): Hello"`.
   - Embed `[tool:<toolName> <jsonArgs>]` in a user prompt to trigger a real tool call through `pi-durable`'s tool execution pipeline during a turn.
   - Embed `[remember: <fact>]` or `[learn:<slug> <body>]` in a user prompt and trigger `await runDurableObjectAlarm(stub)` from `cloudflare:test` to test the full idle harvest fork -> tool call -> file diff -> `HarvestNote` pipeline.

### Test timing

Do not sleep for a fixed multi-second gap in e2e. Wait until the event or condition you care about, with a bounded deadline. A check that something did **not** happen still has to wait, and that wait must be several times the interval so a late timer on a 2-vCPU runner is not a false pass. Timing knobs are Worker bindings (`CADMUS_HARVEST_DELAY_MS`, `CADMUS_HEARTBEAT_MS` in `vitest.config.ts`). Leave the binding unset in production so the code default stays in force. Parse overrides in one place: non-numeric values use the default, and numbers are clamped. `bun run test` includes `e2e/contract-conformance.test.ts` and runs files in parallel with `maxWorkers: 2` (one miniflare per worker). `bun run test:conformance` still runs the bun conformance tests and that file by itself. `check:all` runs the bun conformance tests as their own stage and the vitest file only inside `bun run test`, after the static stages, so the web build does not share the CPUs with workerd.

### Web app rendering evidence

Do **NOT** automatically run `bun run web-app:screens`. Screenshot generation is strictly on-demand when explicitly requested by the user. Never commit screenshots. If the user asks for screenshots, attach the relevant PNGs to the PR with `gh pr comment <N> --body-file <md> --attach <png>...` (or `gh pr create/edit --attach`).

The command is local only. It is not part of CI or `check:all`. It starts the local worker through `playwright.screens.config.ts`, uses a per-run account and the Pixel 7 viewport, and launches Playwright Chromium. PNGs land in gitignored `packages/web-app/.screens/` as `<screen>-<theme>.png`.

---

## 4. API boundaries

The backend publishes the API as [`@cadmus/contract`](packages/contract). That package is declarations: command names, payload and result schemas, the `readOnly` flag, error codes, record types, the `{ error: { code, message } }` envelope, and the `/ws` and `/events` message unions. The only dependency is `typebox`.

Clients never import backend source. `packages/web-app/src` and `packages/cli/src` import `@cadmus/contract/types` (types only), `@cadmus/contract/routes` (the small generated route table and query encoder), `@cadmus/contract/tools` (tool-name constants only), and `@cadmus/contract/client` (the shared REST and WebSocket transport). The CLI also imports `@cadmus/contract/schemas` so help and `--skill` stay generated from the command schemas. They do not import `packages/worker/`, `packages/daemon/`, or the generated OpenAPI and AsyncAPI documents. The web bundle does not import schemas. OpenAPI (`packages/contract/generated/openapi.json`) and AsyncAPI (`packages/contract/generated/asyncapi.json`) are internal, committed, validated artifacts. The Worker does not serve them and does not import them, so they are not in the Worker bundle.

Contract changes are explicit and reviewed. Edit the schemas under `packages/contract/src`, then run `bun run contract:gen`. Commit the regenerated `packages/contract/generated/routes.ts`, `openapi.json`, and `asyncapi.json`. `bun run contract:check` regenerates those files in memory, formats them, and fails if the committed copies differ. `bun run boundaries` (`scripts/check-boundaries.ts`) fails if a client imports backend source, anything other than `@cadmus/contract/types`, `@cadmus/contract/routes`, `@cadmus/contract/tools`, and `@cadmus/contract/client` (plus `@cadmus/contract/schemas` in `packages/cli`), or the contract imports anything other than `typebox`. The scanner reads whole-file `import`, `export ... from`, `import type`, dynamic `import()`, and `require()`, including when the specifier is on a later line. Biome `noRestrictedImports` overrides on `packages/web-app/**` and `packages/cli/**` reject `packages/worker/`, `packages/daemon/`, the bare `@cadmus/contract` package, and the generated OpenAPI and AsyncAPI documents. The web-app override also rejects `@cadmus/contract/schemas`. Both checks run at the start of `bun run check:all`. `@cadmus/contract/routes` stays the generated route table (`API_ROUTES` and `encodePayloadQuery`). Tool-name constants live only on `@cadmus/contract/tools`.

All packages live under `packages/*` and are unified Bun workspace members. Packages depend on sibling workspace packages using `"workspace:*"`.

Bump `CADMUS_SCHEMA_VERSION` only when D1 tables or columns change in [`packages/worker/src/store/d1-admin.ts`](packages/worker/src/store/d1-admin.ts). A contract or HTTP change does not bump that version. The handler map in [`packages/worker/src/command-handlers.ts`](packages/worker/src/command-handlers.ts) is typed so a missing or mismatched command handler fails `bun run typecheck`.

---

## 5. Multi-Surface Feature Workflow (Contract -> Backend -> Web Surfaces)

Because `@cadmus/web-app` executes against the real local Cloudflare Worker and generated `@cadmus/contract` routes, full-stack features have a strict **sequential dependency**:

1. **Phase 1 — Contract & Backend ([`.agents/skills/contract-backend/SKILL.md`](.agents/skills/contract-backend/SKILL.md))**:
   - Lock schemas in `packages/contract/src/*`, run `bun run contract:gen`, and verify `bun run contract:check` + `bun run boundaries`.
   - Implement Worker handlers (`packages/worker/src/family-do.ts`, `packages/worker/src/index.ts`, typed via `packages/worker/src/command-handlers.ts`), tools (`packages/worker/src/extensions/*`), and storage in `packages/worker/src/store/*` (plus CLI/Daemon updates in `packages/{cli,daemon}/` if applicable).
   - Add/update black-box Worker E2E tests in `e2e/*.test.ts` (and `e2e/contract-conformance.test.ts` for new commands).
   - **Gate 1**: `bun run typecheck && bun run test:conformance && bun run test` must pass before starting Phase 2.

2. **Phase 2 — Dual Web Surfaces ([`.agents/skills/web-surfaces/SKILL.md`](.agents/skills/web-surfaces/SKILL.md) & [`packages/web-app/AGENTS.md`](packages/web-app/AGENTS.md))**:
   - Wire shared state/RPC calls once in `packages/web-app/src/context/CadmusContext.tsx`, `packages/web-app/src/hooks/*`, and `packages/web-app/src/lib/*`.
   - Deliver first-class UI on both **Mobile (`390×844`)** and the **Persistent Desktop Command Cockpit (`1440×900`)** (`CockpitFrame` Stage / `FleetDeck` / `TelemetryDeck` / `CommandPalette`, with zero mobile `AppShell` ejection on Desktop).
   - The Playwright UI-flow suites (`packages/web-app/tests/flows`, `packages/web-app/tests/desktop`, `bun run test:ui`) are parked and excluded from CI and `check:all`. Do not maintain them. They may be revived later.
   - **Gate 2**: `bun run typecheck && bun run --cwd packages/web-app test` must pass.

3. **Subagent Execution Strategy**:
   - **Small / Single-Layer Changes**: A single Coder agent executes Phase 1 then Phase 2 sequentially.
   - **Multi-Surface Features**: Dispatch a `contract-backend` Coder subagent to complete and verify Phase 1 (Gate 1 green), then dispatch a `web-surfaces` Coder subagent to complete and verify Phase 2 (Gate 2 green).
   - **Architect Review**: Always run the `architect-review` phase across the combined diff after implementation completes.

---

## 6. Issue Labels and Workflow

Issue labels on GitHub control whether an agent may work on an issue and what it may do on its own.

- **`needs-*` (any label starting with `needs-`)**: Lior is gating the issue. Do not start implementing it until he removes the label.
  - **`needs-plan`**: the plan must be worked out with Lior and approved by him before work starts.
  - **`needs-ui-prototype`**: iterate on a UI prototype with Lior before work starts.
- **`ready-for-dev`**: an agent may implement the issue end to end and squash-merge its PR without further approval, once review, `bun run check:all` and CI all pass. Without this label, or an explicit go-ahead from Lior, an agent never merges a PR.
- **`in-progress`**: add it when work on the issue starts, and remove it when the work ends (the PR is merged or the work stops).

When an issue's plan or design changes, update the issue description itself rather than adding a comment, so the description always holds the current plan.
