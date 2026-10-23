# Review 01 Results: Cross-Document Inconsistencies and Mismatches

## Executive Summary

A comprehensive, cross-document inspection was conducted across all 7 architecture and sequencing plan documents under [`docs/plans/tools-env/`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/) and compared against the existing codebase implementation in [`src/`](file:///home/developer/projects/pi-bot-hands/src/).

Overall, the plan establishes a robust, thoughtful architecture for introducing execution environments to Cadmus bots. The two-tier storage model (Cloudflare D1 for global account secrets vs. DO SQLite for per-family state), the lazy reachability classification, out-of-band alarm probing, and reuse of `@earendil-works/pi-durable` built-in `CodingTools` conform well to Cadmus architectural invariants.

However, several **critical blockers**, **major API/store interface gaps**, and **subtle cross-document divergences** were identified:
1. **Critical Database Schema Defect**: `cadmus_tools_env_fs` omits `bot_id`, making the specified cascade deletion in `deleteBot` impossible or erroneous.
2. **Phase Sequencing Conflict**: `sequencing.md` states in Phase 1 that `local-daemon` is rejected until Phase 3, but Phase 2 specifies accepting and validating `local-daemon` bindings on `bot.update` and `chat.update`.
3. **DO Alarm Scheduling Bug in Spec**: The semantics of `dueProbes()` in `reachability.md` conflate "probes due now" with "all armed future probes", which would cause `syncDurableObjectAlarm` to fail to schedule future alarm wakeups.
4. **Signature Discrepancy on Factory**: `createExecutionEnv(binding, scope)` is invoked in the callback flow without passing the required dependency injection bundle specified in the factory definition.
5. **Resolution Source Inconsistency**: `/status` and `reachability.md` describe `source` as `bot | chat` (omitting `account` and `unbound`), directly conflicting with `binding-and-config.md`'s 4-tier resolution hierarchy.

Below are the detailed findings categorized by severity, along with concrete proposed resolutions for each issue.

---

## Critical Mismatches (Blockers / Conflicting Specs)

### 1. `cadmus_tools_env_fs` Schema Lacks `bot_id`, but `deleteBot` is Specified to Delete by `bot_id`
- **Issue**: The schema definition for the persisted just-bash VFS table `cadmus_tools_env_fs` lacks a `bot_id` column, but multiple documents specify that `deleteBot` deletes rows from this table matching `bot_id`.
- **Document A**: [`docs/plans/tools-env/workspace-persistence.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/workspace-persistence.md#L34-L42)
  > ```sql
  > cadmus_tools_env_fs (
  >   scope TEXT NOT NULL,      -- bot:<botId> | chat:<chatKey>
  >   path TEXT NOT NULL,       -- normalized POSIX path under /workspace
  >   is_dir INTEGER NOT NULL,
  >   content BLOB,
  >   updated_at INTEGER NOT NULL,
  >   PRIMARY KEY (scope, path)
  > )
  > ```
- **Document B**: [`docs/plans/tools-env/workspace-persistence.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/workspace-persistence.md#L48) & [`docs/plans/tools-env/binding-and-config.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/binding-and-config.md#L189)
  > "`SqliteBotStore.deleteBot` already deletes souls, memories, knowledge, and schedules for the bot. It does not delete chats. Extend it to delete `cadmus_tools_env_fs`, `cadmus_tools_env_state`, and `cadmus_chat_conversations` where `bot_id` matches."
  > "Extend it to delete tools-env state, VFS, and conversation-map rows for that `bot_id` (bot scope and every chat scope)."
- **Impact**: In SQLite, executing `DELETE FROM cadmus_tools_env_fs WHERE bot_id = ?` will fail immediately with `SqliteError: no such column: bot_id`. Chat override scopes have `scope = 'chat:' || chatKey`, which cannot be matched by `bot_id` without joining or subquerying. If an implementer attempts to clean up `cadmus_tools_env_fs` by `bot_id`, it will crash at runtime.
- **Proposed Fix**: Add `bot_id TEXT NOT NULL` to `cadmus_tools_env_fs` (matching `cadmus_tools_env_state` and `cadmus_chat_conversations`), indexed by `bot_id`:
  ```sql
  CREATE TABLE IF NOT EXISTS cadmus_tools_env_fs (
    scope TEXT NOT NULL,
    bot_id TEXT NOT NULL,
    path TEXT NOT NULL,
    is_dir INTEGER NOT NULL,
    content BLOB,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (scope, path)
  );
  CREATE INDEX IF NOT EXISTS idx_cadmus_tools_env_fs_bot_id ON cadmus_tools_env_fs (bot_id);
  ```

---

### 2. Phase 2 vs Phase 3 Sequencing Conflict on `local-daemon` Binding Acceptance
- **Issue**: Phase 1 states that `local-daemon` is rejected until Phase 3, but Phase 2 specifies accepting and validating `local-daemon` bindings on bots and chats.
- **Document A**: [`docs/plans/tools-env/sequencing.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/sequencing.md#L31) (Phase 1)
  > "Phase 1's allowed kind is `just-bash`. Reject `local-daemon` until phase 3 can open a socket, so a stored daemon bind cannot look `ready`."
- **Document B**: [`docs/plans/tools-env/sequencing.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/sequencing.md#L71) (Phase 2) & [`docs/plans/tools-env/binding-and-config.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/binding-and-config.md#L60-L65)
  > "`kind: 'local-daemon'` requires `secretId` and `workspacePath`, on both `bot.update` and `chat.update`."
  > "Validation on `bot.create` / `bot.update`, on `chat.create` / `chat.update`... `local-daemon` requires `secretId` and a non-empty `workspacePath`."
- **Impact**: Implementers in Phase 2 are left with a contradiction: should `bot.update` and `chat.update` reject `local-daemon` (per Phase 1 line 31) or validate and accept `local-daemon` (per Phase 2 line 71)? Furthermore, if Phase 2 accepts `local-daemon`, what is its reachability status before Phase 3 implements the `/tools-env/ws` route and daemon socket?
- **Proposed Fix**: Reconcile the sequencing timeline:
  - In Phase 1: Only `kind: "just-bash"` is permitted; `local-daemon` is rejected with validation error `unsupported_kind`.
  - In Phase 2: `ToolsEnvBinding` validation for `local-daemon` is enabled, permitting operators to store pairing tokens in D1 and set account defaults or bot pins. Any scope configured with `local-daemon` in Phase 2 immediately enters `status: "unreachable"` with `next_probe_at = NULL` (disconnected daemon policy, waiting for Phase 3 dial).
  - Update `sequencing.md` line 31 to read: "Phase 1's allowed kind is `just-bash`. Reject `local-daemon` in Phase 1 until Phase 2 enables pairing secret storage and binding validation."

---

### 3. Alarm Wakeup Stalling: Semantic Conflict Between Alarm Calculation and Probe Execution in `dueProbes()`
- **Issue**: `reachability.md` uses `dueProbes()` to compute `earliest` for DO alarm scheduling in `syncDurableObjectAlarm`, but also implies `dueProbes()` only returns probes that are due now.
- **Document A**: [`docs/plans/tools-env/reachability.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/reachability.md#L136-L142)
  > ```ts
  > for (const row of familyStore.toolsEnv.dueProbes()) {
  >   if (row.nextProbeAt != null && row.status === "unreachable") {
  >     earliest = min(earliest, row.nextProbeAt);
  >   }
  > }
  > ```
- **Document B**: [`docs/plans/tools-env/reachability.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/reachability.md#L188-L194)
  > "After the bound, `dueProbes` ignores the row, so `syncDurableObjectAlarm` does not wake the DO for this scope."
  > "If `alarm()` wakes for a schedule, still run any **due** probes (`next_probe_at <= now`) in the same invocation so one `setAlarm` covers all work."
- **Impact**: If `dueProbes()` queries `WHERE next_probe_at <= ?` (`now`), it will return zero rows when a failure just occurred and `next_probe_at` is set in the future (`now + 5s`). Consequently, `syncDurableObjectAlarm` will NEVER find `earliest` for upcoming probes, and `ctx.storage.setAlarm` will never be programmed! The recovery probe will stall indefinitely unless an unrelated schedule wakes the DO. Conversely, if `dueProbes()` returns all rows where `next_probe_at IS NOT NULL`, calling it in `alarm()` would prematurely execute probes that are not yet due.
- **Proposed Fix**: Explicitly separate this into two distinct methods on `FamilyStore.toolsEnv`:
  1. `listPendingProbes(): ToolsEnvStateRow[]`: Queries `SELECT * FROM cadmus_tools_env_state WHERE next_probe_at IS NOT NULL AND status = 'unreachable'`. Used by `syncDurableObjectAlarm` to calculate `earliest`.
  2. `listDueProbes(now: number): ToolsEnvStateRow[]`: Queries `SELECT * FROM cadmus_tools_env_state WHERE next_probe_at IS NOT NULL AND next_probe_at <= ? AND status = 'unreachable'`. Used by `alarm()` / `probeUnreachableToolsEnvs(now)` to execute only due probes.

---

### 4. Contradictory Signatures for `createExecutionEnv` Between Call Site and Definition
- **Issue**: The callback step-by-step description specifies calling `createExecutionEnv(binding, scope)`, but the factory definition specifies `createExecutionEnv(binding, deps)`.
- **Document A**: [`docs/plans/tools-env/execution-env.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/execution-env.md#L45)
  > "5. Otherwise returns `createExecutionEnv(binding, scope)` (new)."
- **Document B**: [`docs/plans/tools-env/execution-env.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/execution-env.md#L122-L123)
  > "`createExecutionEnv(binding, deps) → ExecutionEnv` in something like `src/tools-env/create-env.ts`. `deps` is the family store, the scope, the bot id, the chat key when the scope is a chat, the socket lookup, and `syncAlarm`."
- **Impact**: Following step 5 results in a missing dependency error at construction time. The factory cannot instantiate `just-bash` (which requires `familyStore` for SQLite VFS operations) or the remote daemon proxy (which requires `socketLookup` and `syncAlarm`).
- **Proposed Fix**: Update step 5 in `execution-env.md` to pass the dependencies object:
  ```ts
  return createExecutionEnv(binding, {
    familyStore: services.familyStore,
    scope,
    botId,
    chatKey,
    getWebSockets: (tag: string) => this.ctx.getWebSockets(tag),
    syncAlarm: () => services.syncAlarm(),
  });
  ```

---

### 5. Resolution Source Inconsistency: `/status` Omits `"account"` and `"unbound"`
- **Issue**: `builtin-tools.md` and `reachability.md` restrict the `/status` `source` property to `"bot"` or `"chat"`, omitting `"account"` and `"unbound"`, while `binding-and-config.md` defines a 4-level resolution hierarchy.
- **Document A**: [`docs/plans/tools-env/builtin-tools.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/builtin-tools.md#L116) & [`docs/plans/tools-env/reachability.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/reachability.md#L217)
  > "`toolsEnv: { source, kind, status, lastError?, nextProbeAt? }` (new)... `source` is `bot`, `chat`, or omitted when unbound."
  > "include effective kind, source (`bot` or `chat`), status, `last_error`, `next_probe_at`."
- **Document B**: [`docs/plans/tools-env/binding-and-config.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/binding-and-config.md#L73) & [`docs/plans/tools-env/binding-and-config.md`](file:///home/developer/plans/tools-env/binding-and-config.md#L185)
  > "`chat.get` also returns the effective binding and which level won (`chat`, `bot`, `account`, or unbound)"
  > "`toolsEnvSource` (`'chat'` | `'bot'` | `'account'` | `'unbound'`)"
- **Impact**: When a bot inherits the account default, `/status` would report `source: "bot"` (or fail schema validation), misleading operators into thinking the bot has an explicit pin. Furthermore, UI and TUI clients checking `/status` vs `chat.get` will encounter mismatched source enum types.
- **Proposed Fix**: Standardize `toolsEnvSource` across all protocol responses and `/status`:
  ```ts
  export const ToolsEnvSourceSchema = Type.Union([
    Type.Literal("chat"),
    Type.Literal("bot"),
    Type.Literal("account"),
    Type.Literal("unbound"),
  ]);
  export type ToolsEnvSource = Static<typeof ToolsEnvSourceSchema>;
  ```
  Update `/status` to return `source: ToolsEnvSource`.

---

## Major Discrepancies (Terminology / API Signature Gaps)

### 6. Missing TypeScript Interface Declarations for `cadmus_chat_conversations` and `cadmus_tools_env_fs`
- **Issue**: The plans define SQL tables `cadmus_chat_conversations` ([`execution-env.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/execution-env.md#L56-L62)) and `cadmus_tools_env_fs` ([`workspace-persistence.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/workspace-persistence.md#L34-L42)), but do not define the corresponding TypeScript methods on `FamilyStore` (`src/store/family-interface.ts`).
- **Context**: In Cadmus, all database operations on DO SQLite are mediated by `FamilyStore` facets (`bots`, `files`, `chats`, `schedules`, `harvest`). The `env` callback and `executeHarvestFork` need to read and update `cadmus_chat_conversations`.
- **Proposed Fix**: Extend `FamilyStore` in `src/store/family-interface.ts` with explicit facet methods:
  ```ts
  export interface ConversationRoutingRecord {
    conversationId: number;
    chatKey: string;
    botId: string;
    toolsEnvEnabled: boolean; // mapped from tools_env INTEGER
  }

  export interface ChatStore {
    // ... existing methods
    getConversationRoute(conversationId: number): ConversationRoutingRecord | undefined;
    recordConversationRoute(route: ConversationRoutingRecord): void;
    setConversationToolsEnvEnabled(conversationId: number, enabled: boolean): void;
    deleteConversationRoutesForChat(chatKey: string): void;
  }
  ```

---

### 7. Missing Specification for `AdminStore.updateAccount` Patch Parameter
- **Issue**: [`binding-and-config.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/binding-and-config.md#L110) states that `account.update` accepts `defaultToolsEnv: ToolsEnvBinding | null`, and that column `cadmus_accounts.default_tools_env_json` stores this value. However, `AdminStore.updateAccount` in [`src/store/admin-interface.ts`](file:///home/developer/projects/pi-bot-hands/src/store/admin-interface.ts#L51-L54) currently only takes `patch: { name?: string; timezone?: string }`.
- **Impact**: Without updating `AdminStore.updateAccount`, the edge handler executing `account.update` cannot persist `defaultToolsEnv` to D1.
- **Proposed Fix**: Document the update to `AdminStore.updateAccount`:
  ```ts
  updateAccount(
    accountId: string,
    patch: {
      name?: string;
      timezone?: string;
      defaultToolsEnv?: ToolsEnvBinding | null;
    },
  ): Promise<AccountRecord>;
  ```

---

### 8. Unspecified Property Name for Effective Binding in `chat.get` Result
- **Issue**: [`binding-and-config.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/binding-and-config.md#L185) states: "`(new) chat.get also includes toolsEnvSource ('chat' | 'bot' | 'account' | 'unbound'), the effective binding (no secrets), and toolsEnvStatus of the scope that effective binding uses.`"
- **Context**: `ChatRecord` already contains an optional `toolsEnv` field (which represents the stored chat override). The result of `chat.get` needs a distinct property name for the resolved effective binding to avoid colliding with `chat.toolsEnv`.
- **Proposed Fix**: Explicitly name the property `effectiveToolsEnv` in `ChatGetResultSchema`:
  ```ts
  export const ChatGetResultSchema = Type.Object({
    chat: ChatRecordSchema,
    effectiveToolsEnv: Type.Optional(Type.Union([ToolsEnvBindingSchema, Type.Null()])),
    toolsEnvSource: ToolsEnvSourceSchema,
    toolsEnvStatus: ToolsEnvStatusSchema,
  });
  ```

---

### 9. Undefined DO Invalidation on Account Secret Deletion
- **Issue**: [`binding-and-config.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/binding-and-config.md#L159) states: "If a `secretId` is deleted, mark every bot scope and chat scope whose effective binding uses it `unreachable` with `last_error = "secret_missing"`, `next_probe_at = NULL`... and `syncAlarmInternal()`."
- **Context**: Secret deletion occurs at the Worker Edge via `account.toolsEnvSecrets.delete` operating on D1 table `cadmus_tools_env_secrets`. However, `cadmus_tools_env_state` lives in DO SQLite inside individual `CadmusBotFamilyDO` instances. The document does not describe how the DO is notified of secret deletion.
- **Proposed Fix**: Follow the established pattern from `AccountCredentialStore` (`bustAccountCredentialCaches` via `stub.invalidateCredentialCache` or internal fetch `/__internal/credentials/invalidate`):
  When `account.toolsEnvSecrets.delete` executes on the edge, iterate over all families in the account via `adminStore.listFamilies(accountId)` and call `stub.invalidateToolsEnvSecret(secretId)` or POST `/__internal/tools-env/invalidate-secret`.

---

### 10. Lifecycle Ambiguity for Ephemeral Directory Cleanup on Daemon
- **Issue**: [`execution-env.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/execution-env.md#L90,L190,L220) states that for `local-daemon` with `persist: false`, `${workspacePath}/.cadmus-ephemeral` is removed "in `cleanup()` on unbind of the last scope that uses that root."
- **Context**: In `@earendil-works/pi-durable`, `ExecutionEnv.cleanup()` is a standard lifecycle hook called by the harness after task or tool turns. If the DO proxy forwards routine `cleanup()` frames to the daemon and the daemon wipes the directory on every `cleanup()`, temporary workspace files will not survive across consecutive turns in the same conversation.
- **Proposed Fix**: Differentiate in the wire protocol between routine `ExecutionEnv.cleanup()` (which kills processes but preserves files) and explicit scope unbinding:
  - `{ id, method: "cleanup" }`: Kills lingering processes for the turn.
  - `{ id, method: "destroyWorkspace" }`: Unlinks `.cadmus-ephemeral` when the chat override or bot binding is deleted/cleared.

---

### 11. TypeBox Validation Inconsistency on `BotCreateCommandSchema.toolsEnv`
- **Issue**: [`binding-and-config.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/binding-and-config.md#L173) specifies `bot.create` payload as `optional toolsEnv: ToolsEnvBinding` (without `null`). However, line 227 states that in `BotModal`, selecting "Account default" submits `toolsEnv: null`.
- **Impact**: If `bot.create` schema does not permit `null`, submitting `{ toolsEnv: null }` from the web UI will fail TypeBox validation with `ProtocolValidationError`.
- **Proposed Fix**: Define `toolsEnv: Type.Optional(Type.Union([ToolsEnvBindingSchema, Type.Null()]))` in `BotCreateCommandSchema`, matching `BotUpdateCommandSchema`.

---

### 12. Potential `AccountEventSchema` Validation Failure on New Secret Actions
- **Issue**: [`binding-and-config.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/binding-and-config.md#L204) recommends broadcasting `account.event` with actions `tools_env_secret.set` / `tools_env_secret.deleted`.
- **Context**: In [`src/protocol/frames.ts`](file:///home/developer/projects/pi-bot-hands/src/protocol/frames.ts#L367-L380), `AccountEventSchema` currently requires `providerId: Type.String()`. Tools env secrets do not have a `providerId`; they have a `secretId`.
- **Impact**: Emitting an `account.event` without `providerId` violates the TypeBox schema and fails schema validation.
- **Proposed Fix**: Adopt a dedicated event schema `ToolsEnvSecretEventSchema` (`type: "account.tools_env_secret"` with fields `accountId`, `secretId`, `action: "set" | "deleted"`), or relax `AccountEventSchema` to make `providerId` optional and add `secretId?: string`.

---

## Minor Inconsistencies (Typographical / Non-functional Divergences)

### 13. Property Casing Discrepancies in `/status` (`last_error` vs `lastError`)
- **Detail**: [`reachability.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/reachability.md#L217) writes `/status` fields in snake_case (`status`, `last_error`, `next_probe_at`), whereas [`builtin-tools.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/builtin-tools.md#L116) writes them in camelCase (`status`, `lastError`, `nextProbeAt`).
- **Proposed Fix**: Align on camelCase (`lastError`, `nextProbeAt`), consistent with all Cadmus protocol objects.

### 14. Undefined Serialized Format for `binding_fp`
- **Detail**: [`reachability.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/reachability.md#L34) and [`binding-and-config.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/binding-and-config.md#L119) refer to `binding_fp` on `cadmus_tools_env_state` storing a fingerprint of `(kind, persist, secretId, workspacePath)` without defining its format.
- **Proposed Fix**: Specify `binding_fp` as a deterministic JSON string: `JSON.stringify({ kind, persist: persist ?? true, secretId: binding.secretId ?? null, workspacePath: binding.workspacePath ?? null })`.

### 15. Missing Explicit `ALTER TABLE` Statement for `cadmus_accounts`
- **Detail**: While `binding-and-config.md` provides explicit SQL `ALTER TABLE` snippets for `cadmus_bots` and `cadmus_chats`, for `cadmus_accounts` ([line 110](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/binding-and-config.md#L110)) it only states in text: "column `cadmus_accounts.default_tools_env_json` (nullable JSON of `ToolsEnvBinding`)".
- **Proposed Fix**: Add the explicit migration snippet for completeness:
  ```sql
  ALTER TABLE cadmus_accounts ADD COLUMN default_tools_env_json TEXT;
  ```

### 16. Omitted HTTP Status Codes for DO `/tools-env/ws` Rejections
- **Detail**: [`execution-env.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/execution-env.md#L176) and [`binding-and-config.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/binding-and-config.md#L215) specify that the DO rejects a `chatKey` dial when that chat has no `local-daemon` override, and rejects dials with mismatched `secretId`, but omit explicit HTTP response codes.
- **Proposed Fix**: Explicitly document that DO returns `400 Bad Request` for invalid query parameters and `403 Forbidden` for secret mismatch.

### 17. Potential `NaN` in `syncDurableObjectAlarm` Min Pseudo-code
- **Detail**: [`reachability.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/reachability.md#L140) writes `earliest = min(earliest, row.nextProbeAt)`. In TypeScript, `earliest` starts as `undefined`, and `Math.min(undefined, number)` results in `NaN`.
- **Proposed Fix**: Use the standard Cadmus alarm comparison:
  ```ts
  if (earliest === undefined || row.nextProbeAt < earliest) {
    earliest = row.nextProbeAt;
  }
  ```

### 18. Naming Friction: `tools_env` Flag in `cadmus_chat_conversations`
- **Detail**: In `cadmus_bots` and `cadmus_chats`, `tools_env_json` stores a serialized binding object. In `cadmus_chat_conversations`, `tools_env` is an integer flag (`1` = normal, `0` = harvest child). Naming this column `tools_env` causes confusion with `tools_env_json`.
- **Proposed Fix**: Document clearly in comments that `tools_env` in `cadmus_chat_conversations` is an integer boolean flag (`tools_env_enabled`), or rename the column to `tools_env_enabled`.

---

## Checklist of Documents Verified

- [x] **README.md vs execution-env.md**
  - Verified `ExecutionEnv.id` format, `env` callback placement, `EnvTarget.cwd` mapping to bot id, just-bash virtual root `/workspace`, harvest fork exclusion (`tools_env = 0`).
- [x] **README.md vs builtin-tools.md**
  - Verified `CodingTools` installation in `initHarness`, tool gating when `bot.tools` is undefined, `code.execute` vs coding tools distinction, identity prompt sections.
- [x] **README.md vs reachability.md**
  - Verified lazy reachability state machine, DO-owned alarm recovery, probe ladders (5s–300s vs 300s × 3 then stop), offline error message.
- [x] **README.md vs workspace-persistence.md**
  - Verified 8 MiB SQLite VFS cap, persistence flag defaults (`true`), no promotion to knowledge, and file mutation ordering.
- [x] **README.md vs binding-and-config.md**
  - Verified bot pin, chat override, account default, D1 secrets table `cadmus_tools_env_secrets`, and `account.toolsEnvs.list`.
- [x] **README.md vs sequencing.md**
  - Verified phase breakdown (Phase 1–3), conformance test runner (Bun), and e2e test strategy with `faux/echo`.
- [x] **execution-env.md vs reachability.md**
  - Verified error classification (`ExecutionError` / `FileError` transport vs application), wire `probe` frame, and offline throw wording.
- [x] **execution-env.md vs binding-and-config.md**
  - Verified socket URL parameters (`familyId`, `botId`, `chatKey`), tag names (`protocol-client`, `tools-env-daemon`), and token authentication at WebSocket upgrade.
- [x] **reachability.md vs sequencing.md**
  - Verified regular vs disconnected probe delay ladders, backoff reset on reconnect, and unit test boundaries.
- [x] **execution-env.md vs workspace-persistence.md**
  - Verified VFS scoping (`bot:<botId>` vs `chat:<chatKey>`), in-memory vs SQLite VFS, and ephemeral folder cleanup semantics.
- [x] **builtin-tools.md vs reachability.md**
  - Verified `tools-env` and `tools-env-unavailable` prompt section conditions, and `/status` payload fields.
- [x] **binding-and-config.md vs sequencing.md**
  - Identified and resolved the Phase 2 vs Phase 3 conflict on `local-daemon` binding acceptance.

---

## Disposition (applied by Grok Build)

1. **`cadmus_tools_env_fs` lacks `bot_id`** — Applied. Added denormalized `bot_id` plus `idx_cadmus_tools_env_fs_bot_id`, and `toolsEnvFs.deleteForBot` / `deleteScope`, in `workspace-persistence.md` (index row in `README.md`). `deleteBot` can match chat scopes without parsing `scope`. — **Superseded (2026-10-21, Lior):** the table moved to `CadmusEnvDO` (`family_id`, `scope`, `bot_id`). The family store has no `toolsEnvFs`. Delete is an RPC (`deleteNamespace` / `deleteNamespacesForBot`).
2. **Phase 2 vs Phase 3 `local-daemon` acceptance** — Applied. `sequencing.md`: phase 1 rejects `local-daemon` with `unsupported_kind`; phase 2 stores the bind as `unreachable` with `next_probe_at` null and does not arm probes; phase 3 is what accepts the socket. A stored daemon bind still cannot look `ready` early. README decisions 1–12 unchanged. — **Superseded (2026-10-21, Lior):** cloud-side probing removed; env reconnects proactively, heartbeat only while calls are in flight, connection state per env with generation CAS (reachability.md).
3. **`dueProbes()` used for both future wakes and due probes** — Applied. `reachability.md` splits `listPendingProbes()` (alarm schedule, includes future `next_probe_at`) and `listDueProbes(now)` (`alarm()` only). — **Superseded (2026-10-21, Lior):** cloud-side probing removed; env reconnects proactively, heartbeat only while calls are in flight, connection state per env with generation CAS (reachability.md).
4. **`createExecutionEnv(binding, scope)` vs `(binding, deps)`** — Applied. `execution-env.md` step 5 now calls `createExecutionEnv(binding, deps)` and lists the same dependency bundle as the factory.
5. **`/status` source omits `account` and `unbound`** — Applied. `ToolsEnvSource` (`chat` | `bot` | `account` | `unbound`) is defined in `binding-and-config.md` and used by `/status` in `builtin-tools.md` and `reachability.md`. Identity section source text includes `account`.
6. **No store methods for conversation routes or the VFS** — Applied. `execution-env.md` adds `ChatStore` route methods (`getConversationRoute`, `recordConversationRoute`, `setConversationToolsEnvEnabled`, deletes). `workspace-persistence.md` adds the `toolsEnvFs` delete methods. File bytes stay behind the just-bash env; no second CRUD surface. — **Superseded (2026-10-21, Lior):** conversation routes stay on the family. VFS bytes and their deletes live on `CadmusEnvDO`, not on `FamilyStore`.
7. **`AdminStore.updateAccount` patch omits `defaultToolsEnv`** — Applied. `binding-and-config.md` extends the patch and names the D1 write. Confirmed today's signature is `{ name?: string; timezone?: string }` in `src/store/admin-interface.ts`.
8. **Effective binding on `chat.get` has no property name** — Applied. Named `effectiveToolsEnv` (`ToolsEnvBinding | null`) in `binding-and-config.md`. `chat.toolsEnv` stays the stored override. `sequencing.md` phase 2 asserts `effectiveToolsEnv` and `toolsEnvSource`.
9. **Secret delete does not say how the DO is told** — Applied. `binding-and-config.md` fans out `stub.invalidateToolsEnvSecret(secretId)` via `listFamilies`, matching `bustAccountCredentialCaches` in `src/family-do.ts`. The edge clears `default_tools_env_json` first.
10. **Ephemeral directory wiped by routine `cleanup`** — Applied, narrower than proposed. `execution-env.md` and `workspace-persistence.md`: `cleanup` only kills processes (`Shell.cleanup` is owner shutdown; pi-durable's harness never calls it after a turn). `.cadmus-ephemeral` is removed only when the DO sends `deleteEphemeral: true` on unbind of the last scope. Did not add `destroyWorkspace`.
11. **`bot.create` rejects `toolsEnv: null`** — Applied. `binding-and-config.md`: `bot.create` accepts `ToolsEnvBinding | null`; omitted and `null` both store no pin, matching the BotModal Account-default submit.
12. **`AccountEventSchema` requires `providerId`** — Applied. `binding-and-config.md` drops the `account.event` option. New frame `account.tools_env_secret` (`accountId`, `secretId`, `action`, `when`). Confirmed the closed credential action union in `src/protocol/frames.ts`.
13. **`/status` snake_case vs camelCase** — Applied. `reachability.md` and `builtin-tools.md` use `lastError` and `nextProbeAt`. SQLite columns stay snake_case. — **Superseded (2026-10-21, Lior):** cloud-side probing removed; env reconnects proactively, heartbeat only while calls are in flight, connection state per env with generation CAS (reachability.md).
14. **`binding_fp` format undefined** — Applied. `reachability.md` specifies `JSON.stringify({ kind, persist, secretId, workspacePath })` with resolved `persist` and nulls for absent fields. `binding-and-config.md` points at that string.
15. **No `ALTER` for `cadmus_accounts`** — Applied. `binding-and-config.md` adds `ALTER TABLE cadmus_accounts ADD COLUMN default_tools_env_json TEXT`, same PRAGMA-then-ALTER path as `timezone` in `src/store/d1-admin.ts`.
16. **No HTTP status for `/tools-env/ws` rejections** — Applied. `execution-env.md` and `binding-and-config.md`: `400` for a bad `botId` or a `chatKey` with no `local-daemon` override, `403` for a `secretId` mismatch, before `acceptWebSocket`. Unknown token stays `401`.
17. **`min(undefined, wake)` is `NaN`** — Applied. `reachability.md` uses the `earliest === undefined || wake < earliest` comparison from `src/alarms.ts`. — **Superseded (2026-10-21, Lior):** cloud-side probing removed; env reconnects proactively, heartbeat only while calls are in flight, connection state per env with generation CAS (reachability.md).
18. **`tools_env` flag vs `tools_env_json`** — Applied. Renamed the conversation-map column to `tools_env_enabled` in `execution-env.md`, `builtin-tools.md`, `workspace-persistence.md`, `sequencing.md`, and the README state table.
