---
name: contract-backend
description: >-
  Contract-first backend workflow for Cadmus (@cadmus/contract + @cadmus/worker + black-box workerd E2E tests).
  Use whenever adding or modifying protocol commands, schemas, routes, agent tools, SSE/WS events,
  Durable Object / D1 storage, or Worker handlers.
---

# Contract-First Backend Workflow (`contract-backend`)

Use this workflow whenever adding or modifying protocol commands, payload/result schemas, REST `/api/*` routes, agent tools, SSE/WS events, Durable Object / D1 storage, or Worker command handlers.

Because the Web UI (`@cadmus/web-app`) and CLI (`@cadmus/cli`) run against the real contract and Worker runtime, **Contract + Backend + Black-Box Worker E2E must be locked and green before any Web UI surface work begins.**

---

## Step 1: Lock the Contract First (`packages/contract/`)

1. **Define / Update Schemas & Types**:
   - Command names, payload schemas, and result schemas: [`packages/contract/src/commands.ts`](../../../packages/contract/src/commands.ts) and [`packages/contract/src/oauth.ts`](../../../packages/contract/src/oauth.ts).
   - Shared domain records, error codes, and `/ws` / `/events` frame unions: [`packages/contract/src/types.ts`](../../../packages/contract/src/types.ts).
   - Agent tool-name constants: [`packages/contract/src/tools.ts`](../../../packages/contract/src/tools.ts).
2. **Mark Query Commands `readOnly: true`**:
   - Set `readOnly: true` in the TypeBox schema options on every non-mutating command.
   - [`packages/worker/src/protocol/rest.ts`](../../../packages/worker/src/protocol/rest.ts) derives `GET /api/*` (query-encoded payload) vs `POST /api/*` (JSON body) directly from this flag. Never maintain a parallel method list.
3. **Regenerate Derived Artifacts**:
   ```bash
   bun run contract:gen
   ```
   This updates [`packages/contract/generated/routes.ts`](../../../packages/contract/generated/routes.ts) (`API_ROUTES` and `encodePayloadQuery`), [`packages/contract/generated/openapi.json`](../../../packages/contract/generated/openapi.json), and [`packages/contract/generated/asyncapi.json`](../../../packages/contract/generated/asyncapi.json).
4. **Verify Contract & Import Boundaries**:
   ```bash
   bun run contract:check
   bun run boundaries
   ```
   `@cadmus/contract` may only depend on `typebox`. Clients (`web-app`, `cli`) never import `@cadmus/worker` or `@cadmus/daemon`.

---

## Step 2: Implement Backend (`packages/worker/`)

1. **Wire Typed Command Handlers**:
   - Command handler types are defined in [`packages/worker/src/command-handlers.ts`](../../../packages/worker/src/command-handlers.ts), implemented on `CadmusBotFamilyDO.commandHandlers` in [`packages/worker/src/family-do.ts`](../../../packages/worker/src/family-do.ts) (with edge-level routes in [`packages/worker/src/index.ts`](../../../packages/worker/src/index.ts)). The handler map is exhaustively typed against `@cadmus/contract`—missing or mismatched handlers fail `bun run typecheck`.
   - `/rpc` and `/api/*` share the same authentication (`authenticateRequest`) and command dispatch pipeline. Do not add bespoke route dispatchers outside the command map.
2. **Respect the Two-Tier Storage Boundary**:
   - **`FamilyStore` (DO SQLite)**: [`packages/worker/src/store/family-interface.ts`](../../../packages/worker/src/store/family-interface.ts) -> [`packages/worker/src/store/sqlite-family.ts`](../../../packages/worker/src/store/sqlite-family.ts). Stores all per-family domain entities: bots, chats, virtual files (`SOUL.md`, `MEMORY.md`, `knowledge/*`), schedules, and harvest notes. Schema self-initializes in `SqliteFamilyStore.initialize()`.
   - **`AdminStore` (Cloudflare D1)**: [`packages/worker/src/store/admin-interface.ts`](../../../packages/worker/src/store/admin-interface.ts) -> [`packages/worker/src/store/d1-admin.ts`](../../../packages/worker/src/store/d1-admin.ts). Stores global accounts, users, memberships, auth tokens, encrypted BYOK credentials, and the `account <-> family <-> DO` catalog.
   - **D1 Schema Versioning**: Never create SQL migration files. If and only if D1 tables or columns change in `d1-admin.ts`, update `D1AdminStore.initialize()` and increment `CADMUS_SCHEMA_VERSION`.
   - **No `pi-durable` Docs for Domain State**: Keep `pi-durable` strictly for conversations, transcript entries, model turns, and durable tasks (`ScheduleTask`, `SearchBotTask`).
3. **Idempotent Replay Safety (`replay: "safe"`)**:
   - Every mutating agent tool in [`packages/worker/src/extensions/`](../../../packages/worker/src/extensions/) (`cadmus-tools.ts`, `knowledge-tools.ts`, `schedules-tools.ts`, `web-tools.ts`, etc. — covering `knowledge_update`, `knowledge_delete`, `memory_update`, `schedule_create`, `schedule_update`, `schedule_delete`, `create_bot`, `message_bot`, `web.fetch`, etc.) must wrap its side effects in `await api.memo(key, value, context)` so `pi-durable` replay across Durable Object restarts never duplicates mutations.
4. **Structured Logging Only**:
   - Always log via [`getLogger()`](../../../packages/worker/src/log.ts) with `.child(chatFields(...))` or `.child(familyFields(...))`. Never use `console.log`, `console.warn`, `console.error`, or `console.debug`.

---

## Step 3: Update CLI / Daemon Consumers (`packages/cli/`, `packages/daemon/`)

1. **Agent CLI (`packages/cli/`)**:
   - Standard commands, `--help`, `commands`, and `--skill` auto-generate at runtime from `API_ROUTES` and `@cadmus/contract/schemas`.
   - If a change affects streaming or special CLI verbs (`send`, `events`) or output formatting, update `packages/cli/src/` and `packages/cli/tests/` (verified via `bun run test:cli`).
2. **Confinement Daemon (`packages/daemon/`)**:
   - If the change modifies remote host execution or `env.*` / `exec.*` wire frames, update `packages/daemon/src/`, `packages/daemon/tests/` (`bun run test:daemon`), and `tests/conformance/`.

---

## Step 4: Black-Box E2E Verification (`e2e/*.test.ts`)

1. **Contract Conformance**:
   - When adding a new command, add coverage in [`e2e/contract-conformance.test.ts`](../../../e2e/contract-conformance.test.ts) so every protocol command is exercised through the Worker.
2. **Feature Black-Box E2E Tests**:
   - Add or update black-box tests in `e2e/*.test.ts` importing strictly from `./helpers.js` (`useWorkerFixture`, `uniqueAccountId`, `callApi`, `sendRpc`, `connectTestWs`, `workerFetch`).
   - Provision a fresh account per test with `uniqueAccountId()`. Use the offline deterministic model `faux/echo` (and `[tool:<name> <jsonArgs>]` prompts when testing tool execution).
   - Never import `@cadmus/worker` internals inside `e2e/*.test.ts` (white-box DO tests belong in `packages/worker/tests/*.test.ts`).
3. **Mandatory Verification Gate**:
   Run and pass all backend checks before starting frontend work:
   ```bash
   bun run contract:check
   bun run boundaries
   bun run typecheck
   bun run test:conformance
   bun run test
   ```
