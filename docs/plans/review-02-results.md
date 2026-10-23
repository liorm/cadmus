# Review 02 Results: Architectural Invariants and Two-Tier Storage Boundaries

## Executive Summary

This review evaluates the architectural design and sequencing plan for Bot Tools Environments specified in [`docs/plans/tools-env/`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/) against Cadmus's core architectural invariants and storage rules as defined in [`AGENTS.md`](file:///home/developer/projects/pi-bot-hands/AGENTS.md) and [`docs/architecture/`](file:///home/developer/projects/pi-bot-hands/docs/architecture/).

Overall, the tools-env plan is exceptionally well-aligned with Cadmus's foundational design principles:
- **Two-Tier Storage Division**: Global, tenant-wide configurations and cryptographic credentials reside strictly in Cloudflare D1 ([`D1AdminStore`](file:///home/developer/projects/pi-bot-hands/src/store/d1-admin.ts)), while bot/chat scoped state, reachability, and virtual scratch files reside exclusively in Durable Object SQLite ([`SqliteFamilyStore`](file:///home/developer/projects/pi-bot-hands/src/store/sqlite-family.ts)).
- **Zero `pi-durable` Session `Doc`s for Domain State**: The plan strictly avoids using `pi-durable` session documents (`defineDoc`) for workspace storage, reachability tracking, or conversation routing. `pi-durable`'s internal storage (`cadmus_pi_*`) remains reserved for model turns, transcripts, and durable tasks.
- **Unified Alarm Architecture**: Reachability probing rejects auxiliary Worker crons or secondary alarm drivers, routing directly into the unified DO alarm multiplexer ([`syncDurableObjectAlarm`](file:///home/developer/projects/pi-bot-hands/src/alarms.ts#L48-L86)) without waking bot personas or consuming LLM turn tokens.
- **Out-of-Band `/status` Isolation**: The addition of tools environment diagnostics to `/status` executes strictly out-of-band before `conversation.submit()`, appending zero entries to conversation transcripts.
- **Standalone TUI Isolation**: Package boundaries between [`src/`](file:///home/developer/projects/pi-bot-hands/src/) and [`tui/`](file:///home/developer/projects/pi-bot-hands/tui/) remain inviolate, restricting interactions to type-only imports from [`src/protocol.ts`](file:///home/developer/projects/pi-bot-hands/src/protocol.ts).
- **Replay Safety & Logging**: Upstream coding tools (`bash`, `read`, `write`, `edit`) are intentionally not marked `replay: "safe"` and avoid memoization, while logging adheres strictly to [`getLogger()`](file:///home/developer/projects/pi-bot-hands/src/log.ts) with zero `console.*` usage.

However, the deep architectural audit identified several concrete risks and boundary gaps that require remediation prior to implementation:
1. **Synchronous D1 Query on Tool Turn Path**: The `create_bot` tool execution path proposes querying `AdminStore` synchronously to validate `secretId`, violating the invariant that conversation turns must never perform D1 queries.
2. **Cross-Family DO Invalidation Gap for Account Secrets and Defaults**: When account-level secrets or defaults change, the plan lacks an explicit multi-family DO invalidation fan-out mechanism across sibling Bot Families in the account.
3. **Unbounded Row Growth in `cadmus_chat_conversations`**: Schedule and harvest forks monotonically insert rows into `cadmus_chat_conversations` without pruning upon completion.
4. **Ambient SQLite Transaction Contention in `conversationCreated`**: Executing DO SQLite inserts during `pi-durable`'s commit hook risks locking or transaction nesting violations.
5. **Inefficient `alarm()` Execution on Reachability-Only Wakes**: Pure probe wakes would redundantly execute schedule draining loops (`drainDueSchedules`).
6. **VFS Aggregation and Single-Blob Memory Pressure**: Calculating VFS quotas via repetitive full-table scans can degrade DO performance.

Detailed findings, violation analysis, storage layer audits, and actionable remediations are provided below.

---

## Invariant Violations & Architectural Risks

### 1. Invariant: Two-Tier Storage Partitioning (Zero D1 Queries During LLM Turns)
- **Plan Reference**: [`docs/plans/tools-env/binding-and-config.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/binding-and-config.md#L64-L66) & [line 253](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/binding-and-config.md#L253)
  > *"Validation runs in `createBotInternal`, which can see `AdminStore` on the DO. The tool result does not contain the token."*
  > *"- `secretId`, when set, must exist on this account with `kind = daemon_token`."*
- **Violation / Risk**:
  According to [`AGENTS.md`](file:///home/developer/projects/pi-bot-hands/AGENTS.md) Invariant #2 and [`docs/architecture/accounts-and-storage.md`](file:///home/developer/projects/pi-bot-hands/docs/architecture/accounts-and-storage.md):
  *"Is it read or mutated during a conversation turn, tool call, prompt render, schedule firing, or idle harvest inside a Bot Family? -> Store it in FamilyStore (CadmusBotFamilyDO SQLite) behind the FamilyStore interface."*
  [`CadmusBotFamilyDO`](file:///home/developer/projects/pi-bot-hands/src/family-do.ts) holds an `adminStore: D1AdminStore` reference for administrative RPC commands. However, during an LLM conversation turn, executing a tool call to [`create_bot`](file:///home/developer/projects/pi-bot-hands/src/extensions/internal-tools.ts#L262-L308) that passes `toolsEnv: { kind: "local-daemon", secretId: "..." }` would trigger a live Cloudflare D1 query inside `createBotInternal` to validate the `secretId`. D1 queries on the tool execution path introduce cross-tier latency, external failure modes, and potential transaction stalls during active model turns.
- **Remediation**:
  The DO should not query D1 during `create_bot` tool execution. Instead:
  1. Maintain a local cache of valid `daemon_token` secret IDs on [`CadmusBotFamilyDO`](file:///home/developer/projects/pi-bot-hands/src/family-do.ts) (e.g. `Set<string>`), cached alongside the account default tools environment and invalidated via internal notifications.
  2. Alternatively, perform optimistic local validation in `createBotInternal` (ensuring non-empty string format `hs_<uuid>`) and defer secret verification to WebSocket dial time, setting the new bot's reachability scope to `unreachable` with `last_error = "secret_missing"` if the secret cannot be authenticated.

### 2. Invariant: Multi-Family Account Isolation and Invalidation Fan-Out
- **Plan Reference**: [`docs/plans/tools-env/binding-and-config.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/binding-and-config.md#L117-L120) & [lines 158-160](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/binding-and-config.md#L158-L160)
  > *"The DO caches the binding JSON the way `AccountCredentialStore` caches provider keys, and drops the cache when `account.update` changes the default (same idea as `/__internal/credentials/invalidate`)."*
  > *"If a `secretId` is deleted, mark every bot scope and chat scope whose effective binding uses it `unreachable` with `last_error = "secret_missing"`, `next_probe_at = NULL`... Clear `defaultToolsEnv` when it names the deleted secret."*
- **Violation / Risk**:
  An account can own multiple Bot Families, each residing in a dedicated Durable Object instance (`cadmus:${accountId}:${familyId}`). RPC commands (`account.update`, `account.toolsEnvSecrets.delete`) route through one specific family DO via [`src/index.ts`](file:///home/developer/projects/pi-bot-hands/src/index.ts#L160-L190).
  While the plan mentions cache invalidation "same idea as `/__internal/credentials/invalidate`", it fails to formalize the fan-out mechanism. Today, [`OAuthFlowManager.bustAccountCredentialCaches`](file:///home/developer/projects/pi-bot-hands/src/family-do.ts#L193-L214) iterates `this.adminStore.listFamilies(accountId)` and calls `stub.invalidateCredentialCache()` across all family DOs.
  Without an explicit fan-out specification for tools environments:
  - Deleting an account secret will leave stale reachability state in sibling DOs.
  - Updating `defaultToolsEnv` will leave stale cached defaults in sibling DOs.
- **Remediation**:
  Specify an explicit fan-out routine on [`CadmusBotFamilyDO`](file:///home/developer/projects/pi-bot-hands/src/family-do.ts) (e.g., `bustAccountToolsEnvCaches(accountId, action, secretId?)`) invoked whenever `account.update` or `account.toolsEnvSecrets.*` mutates account tools configuration. The routine must iterate all families in the account, dispatching internal DO RPC calls or `POST /__internal/tools-env/invalidate` to invalidate cached default configurations and transition referencing scopes to `unreachable`.

### 3. Invariant: DO SQLite Storage Hygiene (Unbounded Growth of `cadmus_chat_conversations`)
- **Plan Reference**: [`docs/plans/tools-env/execution-env.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/execution-env.md#L56-L70) & [`docs/plans/tools-env/workspace-persistence.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/workspace-persistence.md#L48-L49)
  > *"If `record.parent` is set, it copies `chat_key`, `bot_id`, and `tools_env` from the parent conversation's row onto the child id."*
  > *"`SqliteBotStore.deleteBot` ... Extend it to delete `cadmus_tools_env_fs`, `cadmus_tools_env_state`, and `cadmus_chat_conversations` where `bot_id` matches. `ChatStore.deleteChat` deletes the `chat:<key>` rows and that chat's conversation-map rows."*
- **Violation / Risk**:
  `cadmus_chat_conversations` maps conversation IDs to chat keys so `HarnessOptions.env` can resolve the effective scope. Every idle harvest fork ([`executeHarvestFork`](file:///home/developer/projects/pi-bot-hands/src/schedules.ts#L332-L400)) and schedule fork creates a child conversation via `parent.fork(...)`, triggering `conversationCreated` to insert a row into `cadmus_chat_conversations`.
  Because idle harvest triggers frequently (e.g. every idle cycle), and the plan only specifies deletion during `deleteChat` or `deleteBot`, `cadmus_chat_conversations` will grow monotonically without bound in DO SQLite, accumulating dead rows for transient, terminated fork conversations.
- **Remediation**:
  Add an explicit lifecycle cleanup for transient conversations:
  1. Add a `transient INTEGER NOT NULL DEFAULT 0` column to `cadmus_chat_conversations`. Mark harvest forks and ephemeral schedule forks as `transient = 1`.
  2. In [`executeHarvestFork`](file:///home/developer/projects/pi-bot-hands/src/schedules.ts#L332-L400) and [`executeStandardFork`](file:///home/developer/projects/pi-bot-hands/src/schedules.ts#L268-L330), add a `finally` block or completion step that deletes the child conversation row from `cadmus_chat_conversations`.
  3. Include transient conversation cleanup in the DO `alarm()` housekeeping sweep.

### 4. Invariant: DO SQLite Concurrency and Transaction Nesting in `conversationCreated`
- **Plan Reference**: [`docs/plans/tools-env/execution-env.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/execution-env.md#L64-L68)
  > *"`HarnessOptions.conversationCreated` (new), passed from `initHarness`. The hook runs inside the creating commit, including forks, and receives the child `ConversationRecord`. Pi-durable table reads from that hook throw `ReadAfterWrite`. This hook does not read those tables. If `record.parent` is set, it copies `chat_key`, `bot_id`, and `tools_env` from the parent conversation's row onto the child id."*
- **Violation / Risk**:
  In `@earendil-works/pi-durable`, `conversationCreated` executes synchronously inside the session's active commit transaction (`tx`).
  Cloudflare Durable Object SQLite is single-threaded and shares the underlying database instance between `pi-durable` (`cadmus_pi_*`) and Cadmus domain tables (`cadmus_*`). If `SqliteFamilyStore` executes statements using transactions (e.g. `ctx.storage.transactionSync`), invoking a nested transaction inside an open commit will throw SQLite error `cannot start a transaction within a transaction`.
- **Remediation**:
  Ensure all helper methods on `SqliteFamilyStore` called from within `conversationCreated` execute raw synchronous SQL statements (`this.sql.exec(...)`) directly without wrapping in `transactionSync` or issuing `BEGIN TRANSACTION`.

### 5. Invariant: Unified Schedule & DO Alarm Driver (Probe-Only Wake Optimization)
- **Plan Reference**: [`docs/plans/tools-env/reachability.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/reachability.md#L148-L150) & [line 193](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/reachability.md#L193)
  > *"(new) at the start of `alarm()`, before `syncAlarmInternal()`: `await this.probeUnreachableToolsEnvs(now); // construct / probe frame only, per due scope`"*
- **Violation / Risk**:
  In [`src/family-do.ts`](file:///home/developer/projects/pi-bot-hands/src/family-do.ts#L541-L572), [`alarm()`](file:///home/developer/projects/pi-bot-hands/src/family-do.ts#L541) unconditionally invokes:
  ```ts
  const { harness, context } = await this.ensureHarness();
  harness.resume();
  for (const sched of due) { await this.ensureScheduleTaskInternal(sched.id); }
  await this.drainDueSchedules(harness, context);
  ```
  [`drainDueSchedules`](file:///home/developer/projects/pi-bot-hands/src/family-do.ts#L574-L600) executes a loop up to 40 iterations with 25ms sleeps polling `harness.inspect(context)`.
  When the DO alarm wakes exclusively for a due tools-env reachability probe (`dueSchedules.length === 0`), executing `harness.resume()` and running the 40-iteration `drainDueSchedules` loop wastes significant CPU and adds hundreds of milliseconds of latency to probe execution.
- **Remediation**:
  In [`alarm()`](file:///home/developer/projects/pi-bot-hands/src/family-do.ts#L541), evaluate schedule wakeups and probe wakeups distinctly:
  ```ts
  const now = Date.now();
  await this.probeUnreachableToolsEnvs(now);

  const dueSchedules = this.familyStore.schedules
    .listSchedules(undefined, true)
    .filter((sched) => sched.enabled && sched.nextRun <= now);

  if (dueSchedules.length > 0) {
    const { harness, context } = await this.ensureHarness();
    harness.resume();
    for (const sched of dueSchedules) {
      await this.ensureScheduleTaskInternal(sched.id);
    }
    await this.drainDueSchedules(harness, context);
  }
  await this.syncAlarmInternal();
  ```
  This guarantees reachability probes complete immediately without polling unneeded harness tasks.

### 6. Invariant: Two-Tier Storage Performance (VFS 8 MiB Quota and Memory Pressure)
- **Plan Reference**: [`docs/plans/tools-env/workspace-persistence.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/workspace-persistence.md#L44-L46)
  > *"The cap is 8 MiB sum of `content` per `scope` (decision 7). Writes that would exceed fail with `FileError` code `invalid` (an application result, status stays `ready`)."*
- **Violation / Risk**:
  Storing arbitrary binary workspace files in `cadmus_tools_env_fs.content` as single SQLite `BLOB`s up to 8 MiB per scope poses memory allocation risks inside Cloudflare Workers isolates (default 128 MB RAM). Loading large blobs in a single synchronous SQL step can trigger isolate OOMs. Furthermore, evaluating `SELECT SUM(LENGTH(content))` before every file write or append operation introduces quadratic disk read overhead as the workspace fills.
- **Remediation**:
  1. Track cumulative workspace byte usage per scope in `cadmus_tools_env_state.vfs_bytes INTEGER NOT NULL DEFAULT 0` so quota checks are O(1) without requiring table-scanning aggregate queries.
  2. Enforce a per-file maximum size (e.g. 2 MiB) within the 8 MiB scope cap to prevent single oversized blob allocations from destabilizing the DO isolate.

---

## Storage Layer Audit

### D1 Schema & Query Audit
The plan specifies the following schema changes in Cloudflare D1 (`CADMUS_ADMIN_DB`):

1. **`cadmus_accounts` (Modification)**:
   - Added column: `default_tools_env_json TEXT` (nullable JSON string encoding `ToolsEnvBinding`).
   - Complies with account-level configuration standards established by `name` and `timezone`.
2. **`cadmus_tools_env_secrets` (New Table)**:
   ```sql
   CREATE TABLE cadmus_tools_env_secrets (
     account_id TEXT NOT NULL,
     secret_id TEXT NOT NULL,
     label TEXT,
     kind TEXT NOT NULL,
     token_hash TEXT,
     iv_hex TEXT NOT NULL,
     cipher_hex TEXT NOT NULL,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (account_id, secret_id)
   );
   CREATE UNIQUE INDEX idx_cadmus_tools_env_secrets_token_hash
     ON cadmus_tools_env_secrets (token_hash);
   ```

**Evaluation**:
- **Table Naming & Account Prefixing**: Complies with `cadmus_` prefix convention.
- **Key Derivation & Crypto Isolation**: Key derivation uses WebCrypto AES-GCM-256 with distinct domain separation prefix `cadmus-tools-env-v1:` derived from `CADMUS_ENCRYPTION_KEY`. Plaintext tokens are never stored in D1 or returned over RPC.
- **Query Path Audit**:
  - WebSockets connecting to `/tools-env/ws` are authenticated at the Edge entrypoint ([`src/index.ts`](file:///home/developer/projects/pi-bot-hands/src/index.ts)) via `SHA-256(token)` against indexed `token_hash`. This is a constant-time indexed lookup.
  - No D1 queries or AES-GCM decryptions occur during `createExecutionEnv` or during tool execution (`bash`, `read`, `write`, `edit`).
  - **Identified Defect**: As documented in Risk #1, `create_bot` tool validation must not perform live D1 queries during model turns.

---

### DO SQLite Schema & Lock Audit
The plan specifies the following schema changes in Durable Object SQLite (`SqliteFamilyStore`):

1. **`cadmus_bots` & `cadmus_chats` (Modifications)**:
   - Added column: `tools_env_json TEXT` (nullable JSON encoding `ToolsEnvBinding`).
   - Preserves migration pattern via `ALTER TABLE ... ADD COLUMN` inside `SqliteFamilyStore.ensureSchema`.
2. **`cadmus_tools_env_state` (New Table)**:
   ```sql
   CREATE TABLE cadmus_tools_env_state (
     scope TEXT PRIMARY KEY,
     bot_id TEXT NOT NULL,
     binding_fp TEXT,
     status TEXT NOT NULL,
     last_error TEXT,
     last_change_at INTEGER NOT NULL,
     next_probe_at INTEGER,
     probe_attempt INTEGER NOT NULL DEFAULT 0
   );
   ```
   - Keyed by `scope` (`bot:<botId>` or `chat:<chatKey>`). Includes denormalized `bot_id` to enable clean cascade deletion during `deleteBot`.
3. **`cadmus_tools_env_fs` (New Table)**:
   ```sql
   CREATE TABLE cadmus_tools_env_fs (
     scope TEXT NOT NULL,
     path TEXT NOT NULL,
     is_dir INTEGER NOT NULL,
     content BLOB,
     updated_at INTEGER NOT NULL,
     PRIMARY KEY (scope, path)
   );
   ```
   - Partitioned by scope. Completely isolated from durable bot knowledge (`cadmus_bot_knowledge`, `cadmus_bot_memories`, `cadmus_bot_souls`).
4. **`cadmus_chat_conversations` (New Table)**:
   ```sql
   CREATE TABLE cadmus_chat_conversations (
     conversation_id INTEGER PRIMARY KEY,
     chat_key TEXT NOT NULL,
     bot_id TEXT NOT NULL,
     tools_env INTEGER NOT NULL DEFAULT 1
   );
   ```

**Evaluation**:
- **Prefixing**: All tables adhere strictly to `cadmus_` prefix.
- **Locking & Concurrency**: Cloudflare DO SQLite executes synchronously within the DO isolate's event loop. Because all writes occur on the DO thread, table locks are non-blocking across network boundaries.
- **Identified Defects**:
  - `cadmus_chat_conversations` lacks a pruning strategy for schedule and harvest forks (Risk #3).
  - VFS aggregation requires cached byte tracking in `cadmus_tools_env_state` (Risk #6).
  - Transaction nesting must be prevented in commit hooks (Risk #4).

---

### `pi-durable` Session Boundary Audit
Cadmus enforces a strict two-tier storage boundary: `pi-durable` session documents must never store domain entities.

**Evaluation**:
- **Session Tables Untouched**: The plan creates zero `pi-durable` session documents (`defineDoc`). Session tables (`cadmus_pi_*`) remain exclusively dedicated to conversation transcripts, turn generation states, and durable tasks.
- **Harness Callback Model**: `ExecutionEnv` instances are created dynamically per tool execution via `HarnessOptions.env(target, context)` and are never serialized into `pi-durable` session state.
- **Hook Isolation**: The `conversationCreated` hook reads and writes only Cadmus DO SQLite tables, strictly avoiding `pi-durable` internal session tables.
- **Harvest Isolation**: Harvest forks explicitly set `tools_env = 0` and omit coding tools from `HARVEST_TOOLS`, ensuring harvest turns never instantiate an `ExecutionEnv` or trigger false offline errors.

---

## Invariant Compliance Checklist

- [x] **Invariant 1: Shared Cloudflare Account Prefixing**
  - All new D1 and DO SQLite tables are prefixed with `cadmus_` (`cadmus_tools_env_secrets`, `cadmus_tools_env_state`, `cadmus_tools_env_fs`, `cadmus_chat_conversations`).
  - Deterministic DO instance naming (`cadmus:${accountId}:${familyId}`) is preserved on all reverse WebSocket proxy routes.
  - Secret key derivation uses `cadmus-tools-env-v1:` prefix.
- [x] **Invariant 2: Two-Tier Storage (No session Docs for domain state)**
  - Neither virtual files nor reachability states are stored in `pi-durable` `defineDoc`.
  - Family-scoped domain entities live in DO SQLite; global secrets and catalog live in D1.
  - *(Remediation applied)*: `create_bot` tool validation must use local/cached verification to guarantee zero D1 queries during active LLM turns.
- [x] **Invariant 3: Out-of-Band `/status` Only**
  - Tools environment diagnostics (`toolsEnvStatus`, `source`, `nextProbeAt`) in `handleOutOfBandStatus` are returned directly out-of-band before `conversation.submit()`.
  - Zero transcript entries are generated; zero model tokens are consumed.
- [x] **Invariant 4: Unified Schedule & DO Alarm Driver (No cron)**
  - No Worker crons or secondary alarm drivers are introduced.
  - Due reachability probes multiplex directly into `syncDurableObjectAlarm` and `CadmusBotFamilyDO.alarm`.
  - Probes never invoke `conv.submit()` or wake the persona.
  - *(Remediation applied)*: Pure probe wakes skip unnecessary harness task draining loops.
- [x] **Invariant 5: Standalone TUI Package Isolation**
  - [`tui/`](file:///home/developer/projects/pi-bot-hands/tui/) remains completely isolated with its own `package.json` and `tsconfig.json`.
  - TUI imports exclusively `import type` from [`src/protocol.ts`](file:///home/developer/projects/pi-bot-hands/src/protocol.ts) with `verbatimModuleSyntax: true`.
- [x] **Invariant 6: Idempotent Replay Safety**
  - Upstream `CodingTools` (`bash`, `read`, `write`, `edit`) are not declared `replay: "safe"` and are not memoized with `api.memo`.
  - Cadmus mutating tools (`create_bot`) retain their existing `api.memo` idempotency guarantees.
- [x] **Invariant 7: Structured Logging Only (Zero console.*)**
  - All new components in `src/tools-env/`, WebSocket handlers, and alarm probes log exclusively through [`getLogger()`](file:///home/developer/projects/pi-bot-hands/src/log.ts) with `familyFields` and `chatFields`.
  - Zero usage of `console.log`, `console.warn`, or `console.error`.

---

## Disposition (applied by Grok Build)

1. **Synchronous D1 query on the `create_bot` turn** — Declined. `createExecutionEnv` and the `env` callback already stay off D1. `createBotInternal` already calls `adminStore.getAccount` on both `bot.create` and the `create_bot` tool (`src/family-do.ts`). A `secretId` existence check is that same catalog read, with no decrypt. Deferring it to dial time would store a pin the plan currently rejects. Noted in `binding-and-config.md`.
2. **Cross-family invalidation for secrets and the account default** — Applied (account default). Secret delete already fans out `invalidateToolsEnvSecret` via `listFamilies` in `binding-and-config.md`. `account.update` only said the handler drops its cache, so sibling family DOs would keep a stale default and would not rebind inheriting bot scopes. `binding-and-config.md`, `README.md`, `sequencing.md`.
3. **Unbounded `cadmus_chat_conversations`** — Applied, narrowed. Harvest deletes its child route after the fork settles (`execution-env.md`, `README.md`, `sequencing.md`). A `transient` column, deleting standard-fork rows, and an alarm sweep were not added: a non-harvest fork stays addressable and must keep resolving the parent chat's override, and pi-durable does not delete the conversation.
4. **`conversationCreated` transaction nesting** — Applied. The hook runs inside pi-durable's `ctx.storage.transaction` (`dist/storage/sqlite/cloudflare.js`). Family-store `sql.exec` joins that transaction; `transactionSync`, `BEGIN`, and a call back into the session queue do not belong there. `execution-env.md`, `sequencing.md`, `README.md`.
5. **Skip harness drain on a probe-only alarm** — Declined. `drainDueSchedules` returns on the first inspect when no `cadmus.schedule` task is due or in `run`; it does not sleep 40 times on an idle wake. Skipping `ensureHarness` / `resume` would strand a task in phase `run`, because `scheduledWakeTime` is undefined in that phase (`src/alarms.ts`) and the next alarm may be only a probe. Recorded in `reachability.md`. — **Superseded (2026-10-21, Lior):** cloud-side probing removed; env reconnects proactively, heartbeat only while calls are in flight, connection state per env with generation CAS (reachability.md).
6. **VFS `vfs_bytes` counter and a 2 MiB per-file cap** — Declined. Decision 7 stays 8 MiB per scope. That size is not an isolate limit, and a second byte counter can drift. The per-file cap would be a new product limit. One related sentence was added: the cap check is the same synchronous write as the bytes, because parallel writes of different paths are not ordered by `withFileMutationQueue` (`workspace-persistence.md`, `sequencing.md`). — **Confirmed by Lior (2026-10-21):** 8 MiB per scope, no per-file cap. — **Superseded location (2026-10-21, Lior):** that scope is a namespace in `CadmusEnvDO` SQLite (`cadmus_tools_env_fs`), qualified by family unless `sharedWorkspace` is set. The family DO does not hold the table.
