# Review 05 Results: Multi-Scope Precedence and Workspace Persistence

## Executive Summary

This review evaluates the 3-tier configuration resolution hierarchy, scope isolation rules, workspace persistence mechanisms, and the knowledge store boundary specified in [`docs/plans/tools-env/binding-and-config.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/binding-and-config.md) and [`docs/plans/tools-env/workspace-persistence.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/workspace-persistence.md).

### Overall Assessment
- **Knowledge Boundary**: The separation between virtual knowledge files (`SOUL.md`, `MEMORY.md`, `knowledge/*.md`) and scratch workspaces is **exemplary**. No auto-sync or promotion hooks exist, idle harvest forks strictly disable coding tools and tools environments via `tools_env = 0`, and prompt identity sections explicitly steer durable notes to `knowledge_*` and `memory_*` tools.
- **Precedence & Scoping**: The resolution order is well-structured, but the deliberate omission of an explicit "unbound" override creates a severe operational trap: once an account default is configured, **no bot or chat can opt out of having a tools environment**.
- **Scope Parsing**: The plan explicitly recognizes that chat keys contain colons (`${bot.id}:${uuid}`) and mandates prefix slicing (`startsWith("chat:")`), which avoids naive `split(":")` bugs.
- **Lifecycle & Storage Gaps**: Critical flaws were identified in the cascading deletion logic and schema definition:
  1. `cadmus_tools_env_fs` lacks a `bot_id` column, making the plan's proposed `DELETE FROM cadmus_tools_env_fs WHERE bot_id = ?` invalid SQL and resulting in leaked chat-override VFS rows on `bot.delete`.
  2. Toggling `persist` between `true` and `false` is not synchronized with in-flight tool calls via `withFileMutationQueue`, risking orphaned SQLite rows or stale in-memory state.
  3. The 8 MiB quota is enforced only on the persisted SQLite VFS, leaving the ephemeral in-memory VFS unconstrained and vulnerable to Worker isolate OOM crashes.
  4. Quota calculation fails to handle overwrite/replacement deltas correctly.
  5. The daemon's `.cadmus-ephemeral` directory lacks crash/disconnect recovery and multi-scope reference management.

---

## Scope & Persistence Logic Gaps

### 1. Inability to Opt Out of Account Default Tools-Env (The "No Unbound" Trap)
- **Plan Reference**: [`binding-and-config.md#chat-record-field-new`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/binding-and-config.md#L41), [`README.md#non-goals`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/README.md#L30)
- **Risk**: Operational and safety violation.
  The plan states in Non-Goals:
  > *"A binding that means 'no env' while a higher level has one is a non-goal. `toolsEnv: null` on a chat uses the bot, then the account default. `toolsEnv: null` on a bot uses the account default."*
  
  This creates an architectural lock-in:
  - If an account configures `defaultToolsEnv` (e.g. `just-bash` or a paired `local-daemon`), **every single bot in every family in that account is forced to have a tools environment** unless it pins a different binding.
  - A non-coding bot (e.g., customer service, persona chat, or an untrusted bot) cannot opt out.
  - A chat under a bot that has an active binding cannot be made conversational-only. If the operator wants a discussion-only chat where coding tools are guaranteed not to run, they cannot unbind the chat. Overriding with `just-bash` still allows shell and VFS operations.
- **Remediation**:
  Allow an explicit `{ kind: "none" }` binding in `ToolsEnvBinding`:
  ```ts
  type ToolsEnvBinding =
    | { kind: "none" }
    | { kind: "just-bash"; persist?: boolean }
    | { kind: "local-daemon"; persist?: boolean; secretId: string; workspacePath: string };
  ```
  When `{ kind: "none" }` is encountered at the chat or bot level, configuration resolution immediately terminates as **unbound** without falling back to the higher tier. The `env` callback returns `undefined`, and coding tools are disabled for that conversation.

---

### 2. Missing `bot_id` in `cadmus_tools_env_fs` Causes Syntax Error or Storage Leakage on `bot.delete`
- **Plan Reference**: [`workspace-persistence.md#just-bash-vfs-sketch-new`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/workspace-persistence.md#L34-L42), [`workspace-persistence.md#L48`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/workspace-persistence.md#L48), [`binding-and-config.md#L189`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/binding-and-config.md#L189)
- **Risk**: SQL exception on `bot.delete` or permanent disk space leakage in DO SQLite.
  The plan sketches `cadmus_tools_env_fs` as:
  ```sql
  cadmus_tools_env_fs (
    scope TEXT NOT NULL,      -- bot:<botId> | chat:<chatKey>
    path TEXT NOT NULL,       -- normalized POSIX path under /workspace
    is_dir INTEGER NOT NULL,
    content BLOB,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (scope, path)
  )
  ```
  Then in both docs it specifies:
  > *"Extend `SqliteBotStore.deleteBot` to delete `cadmus_tools_env_fs`, `cadmus_tools_env_state`, and `cadmus_chat_conversations` where `bot_id` matches."*
  
  However, `cadmus_tools_env_fs` does **not** have a `bot_id` column!
  - If code executes `DELETE FROM cadmus_tools_env_fs WHERE bot_id = ?`, SQLite throws `SQLITE_ERROR: no such column: bot_id`.
  - If code executes `DELETE FROM cadmus_tools_env_fs WHERE scope = 'bot:' || ?`, it drops only the bot-scope VFS and leaves all chat-override VFS rows (`chat:<chatKey>`) orphaned in DO SQLite forever.
- **Remediation**:
  Denormalize `bot_id` into `cadmus_tools_env_fs`:
  ```sql
  cadmus_tools_env_fs (
    scope TEXT NOT NULL,
    bot_id TEXT NOT NULL,
    path TEXT NOT NULL,
    is_dir INTEGER NOT NULL,
    content BLOB,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (scope, path)
  );
  CREATE INDEX idx_cadmus_tools_env_fs_bot ON cadmus_tools_env_fs (bot_id);
  ```
  This allows a clean cascading delete: `DELETE FROM cadmus_tools_env_fs WHERE bot_id = ?`.

---

### 3. Non-Atomic Persist Mode Toggling Under Concurrent Tool Invocations
- **Plan Reference**: [`workspace-persistence.md#L46-L47`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/workspace-persistence.md#L46-L47), [`binding-and-config.md#L119`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/binding-and-config.md#L119)
- **Risk**: Stale state, state corruption, or orphaned persisted files.
  The plan states:
  > *"On that flip, delete the store the new mode does not use (SQLite rows for that scope when switching to memory, the in-memory map when switching to SQLite) so the two stores never alias one id."*
  
  In `@earendil-works/pi-durable`, `write` and `edit` tools serialize through `withFileMutationQueue(env, path)`. However, RPC commands (`bot.update`, `chat.update`, `account.update`) execute in `CadmusBotFamilyDO.executeCommand` without acquiring the mutation queue lock.
  - If a turn or background task is in the middle of executing a `write`, `edit`, or `bash` call that writes to SQLite, and `bot.update` deletes SQLite rows to toggle `persist: false`, the in-flight tool call can commit rows *after* the delete. The binding is now `persist: false`, but orphaned rows remain in `cadmus_tools_env_fs`.
  - Furthermore, `createExecutionEnv` is called per tool invocation. Where does the in-memory Map live? If it lives on the DO instance (e.g. `Map<string, InMemoryFs>`), clearing it while a tool invocation holds a reference creates an inconsistency.
- **Remediation**:
  1. Store the in-memory VFS in a DO-level registry keyed by `ExecutionEnv.id`.
  2. When toggling `persist`, acquire the file mutation queue for the scope or execute the toggle inside the conversation's turn boundary (or ensure no turn is active before dropping stores).
  3. Perform SQLite deletion and `cadmus_bots.tools_env_json` / `cadmus_tools_env_state` updates inside a single DO SQLite transaction (`this.sql.exec("BEGIN TRANSACTION; ... COMMIT;")`).

---

### 4. Missing Quota Enforcement on Ephemeral (`persist: false`) In-Memory VFS
- **Plan Reference**: [`workspace-persistence.md#just-bash-vfs-sketch-new`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/workspace-persistence.md#L44), [`builtin-tools.md#limits`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/builtin-tools.md#L77)
- **Risk**: Cloudflare Worker isolate crash via Out-of-Memory (OOM).
  The 8 MiB quota is explicitly specified only for the `cadmus_tools_env_fs` SQLite table:
  > *"The cap is 8 MiB sum of `content` per `scope` (decision 7). Writes that would exceed fail with `FileError` code `invalid`"*
  
  However, for `persist: false`, the VFS lives in JavaScript memory in the DO isolate. Cloudflare Worker isolates have a strict 128 MiB memory limit. If an ephemeral `just-bash` session generates a large file (e.g., via `cat /dev/zero > out` or `python` script), an unconstrained in-memory Map will cause an uncatchable Worker OOM crash, terminating the entire DO isolate and dropping all active WebSocket connections.
- **Remediation**:
  The in-memory VFS implementation must enforce the exact same 8 MiB total content cap as the SQLite VFS. Any write, append, or edit exceeding 8 MiB in memory must return `FileError` code `invalid`.

---

### 5. Quota Calculation Overwrite Bug
- **Plan Reference**: [`workspace-persistence.md#just-bash-vfs-sketch-new`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/workspace-persistence.md#L44)
- **Risk**: False-positive write rejections on file updates.
  The plan specifies `SUM(content)` per scope.
  If an implementation checks `current_total + new_content.byteLength > 8 MiB` before writing:
  Suppose a scope currently has 7 MiB of files, including a 4 MiB file `data.bin`. The model edits or overwrites `data.bin` with a new 4 MiB file.
  A naive check `7 MiB + 4 MiB = 11 MiB > 8 MiB` will reject the write with `FileError` `invalid`, even though the net storage after overwrite remains 7 MiB!
- **Remediation**:
  Quota validation must check the net delta:
  $$\text{current\_bytes} - \text{existing\_file\_bytes} + \text{new\_file\_bytes} \le 8\text{ MiB}$$
  For performance, maintain `bytes_used` in `cadmus_tools_env_state` rather than running a full `SUM(LENGTH(content))` table scan across all rows on every file write.

---

### 6. Ephemeral Daemon (`.cadmus-ephemeral`) Cleanup Leaks and Multi-Scope Ambiguity
- **Plan Reference**: [`workspace-persistence.md#decision-2`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/workspace-persistence.md#L16), [`execution-env.md#wire-protocol-new`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/execution-env.md#L190), [`execution-env.md#lifecycle`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/execution-env.md#L220)
- **Risk**: Host disk leakage and corrupted ephemeral workspaces.
  The plan specifies:
  > *"The daemon works in `${workspacePath}/.cadmus-ephemeral` and deletes that subfolder in `cleanup()` when the last scope using that effective root unbinds."*
  
  Issues:
  1. **Disconnections & Crashes**: If the daemon process crashes, machine reboots, or network disconnects before unbind, `cleanup()` is never delivered over the wire. The directory remains on disk.
  2. **No Reconnect Sanitization**: When the daemon reconnects, the plan does not state whether `${workspacePath}/.cadmus-ephemeral` is purged or reused. If reused, stale files from crashed sessions violate `persist: false` semantics; if wiped immediately on connect, a brief network blip wipes active workspace files mid-turn!
  3. **Multi-Scope Tracking**: The wire protocol frame is simply `{ id, method: "cleanup" }`. The daemon cannot know whether other scopes in the DO are using the same root unless the DO maintains reference counts. But on DO isolate restart, DO in-memory reference counts are wiped!
- **Remediation**:
  1. Scope `.cadmus-ephemeral` with an instance or scope identifier (e.g. `${workspacePath}/.cadmus-ephemeral/${scopeHash}`).
  2. On daemon clean startup, purge orphaned ephemeral folders whose scopes are not active.
  3. Only send `{ method: "cleanup" }` from the DO when the scope is explicitly deleted or unbound.

---

## Workspace Lifecycle Audit

| Lifecycle Event | Expected Behavior | Plan Specification Assessment | Gaps / Recommendations |
| :--- | :--- | :--- | :--- |
| **Bind Bot Default** (`bot.create` / `bot.update`) | Initializes reachability state (`ready` for just-bash, `unreachable` with backoff for local-daemon). Inheriting chats immediately see the new binding. | **Correct**. Optimistic bind for just-bash; daemon waits for socket. Calls `syncAlarmInternal()`. | If the account default was in use and differed in kind/persist, old just-bash VFS rows must be purged. |
| **Bind Chat Override** (`chat.create` / `chat.update`) | Creates isolated scope `chat:<chatKey>`. Inheriting chats are unaffected. Does not copy files from bot default. | **Correct**. Explicitly isolated. Sockets are tagged separately. | Ensure `chat.update` with `toolsEnv: null` cleans up `chat:<chatKey>` reachability and VFS rows. |
| **Unbind Chat Override** (`chat.update` with `toolsEnv: null`) | Clears override. Drops `cadmus_tools_env_fs` and `cadmus_tools_env_state` for `chat:<chatKey>`. Reverts to bot default. | **Correct**. Preserves `cadmus_chat_conversations` so conversation resolution continues to function. | Ensure in-memory map is also removed from isolate cache if the override was `persist: false`. |
| **Unbind Bot Default** (`bot.update` with `toolsEnv: null`) | Clears pin. Reverts to account default. If kind/path differs, resets scope and drops old VFS. | **Correct**. Chats that inherit follow the new effective binding; chat overrides remain untouched. | If account default is null, bot becomes unbound. |
| **Toggle Persist Mode** (`persist: true <-> false`) | Flips persistence backing store for that scope. Store not used by new mode must be dropped. | **Partial / Flawed**. Not synchronized with active tool executions. | Must serialize against `withFileMutationQueue` or turn execution to prevent orphaned SQLite rows. |
| **`chat.close` / `chat.reset`** | `chat.close` closes chat; `chat.reset` resets transcript with handoff. | **Correct**. Scratch files are preserved across reset/close. | Note: Closed chats retain VFS rows indefinitely. A future retention/GC policy is recommended. |
| **`chat.delete`** | Deletes chat record, conversation mapping, reachability row, and VFS rows. | **Deficient**. `SqliteChatStore.deleteChat` does not have access to DO WebSockets to trigger daemon `cleanup()`. | Add DO-level orchestration method before calling store deletion. |
| **`bot.delete`** | Deletes bot, souls, memories, knowledge, schedules. Drops all bot-scope and chat-override tools-env state. | **Critical Defect**. `cadmus_tools_env_fs` lacks `bot_id`, causing SQL failure or leaking chat-override VFS rows. Also, `cadmus_chats` are not deleted today. | Denormalize `bot_id` onto `cadmus_tools_env_fs`. Cascade delete `cadmus_chats` and all child tools-env state. |

---

## Scoping & Persistence Checklist

- [x] **3-tier precedence logic and null vs undefined handling**
  - *Audit*: Precedence order ($\text{Chat} \to \text{Bot} \to \text{Account} \to \text{Unbound}$) is consistently evaluated. `toolsEnv: null` on chat reverts to bot; `toolsEnv: null` on bot reverts to account.
  - *Identified Gap*: Lack of `{ kind: "none" }` prevents opting out of an account default.
- [x] **Safe parsing of colon-separated chat keys in scopes**
  - *Audit*: Chat keys generated by `createChatInternal` contain colons (`${bot.id}:${uuid}`). Scope keys (`chat:<chatKey>`) must not be parsed with `scope.split(":")`.
  - *Plan Conformance*: The plan explicitly documents that prefixes `bot:` and `chat:` must be sliced (`scope.startsWith(...)`), ensuring UUIDs and colons in keys are preserved.
- [x] **Isolation between inheriting chats and chat overrides**
  - *Audit*: Inheriting chats resolve to `bot:<botId>`. Overriding chats resolve to `chat:<chatKey>`.
  - *Verification*: `cadmus_tools_env_fs` uses `PRIMARY KEY (scope, path)`. Overriding chats have distinct `ExecutionEnv.id` values and separate VFS namespaces. An overriding chat cannot read, write, or list bot-default or sibling files.
- [ ] **8 MiB VFS quota enforcement and error response**
  - *Audit*: Plan specifies 8 MiB limit on persisted SQLite VFS, returning `FileError` code `invalid` (handled as an application error, keeping status `ready`).
  - *Identified Gaps*:
    1. Ephemeral (`persist: false`) in-memory VFS has no quota, risking Worker isolate OOM crashes.
    2. Overwrites do not subtract the replaced file size before comparing against the quota.
- [ ] **Atomic store deletion on persist mode toggling**
  - *Audit*: Toggling `persist` drops the unused store.
  - *Identified Gap*: The RPC handler does not synchronize with `withFileMutationQueue` or active tool calls, allowing concurrent writes to leak rows into SQLite.
- [ ] **Cascading deletion on `bot.delete` and `chat.delete`**
  - *Audit*: Deletion of bots and chats must clean up VFS and state rows.
  - *Identified Gap*: `cadmus_tools_env_fs` schema does not have `bot_id`, making `DELETE FROM cadmus_tools_env_fs WHERE bot_id = ?` fail and orphaning chat-override VFS rows.
- [x] **Zero knowledge store leakage or promotion hooks**
  - *Audit*: Virtual knowledge files (`cadmus_bot_*`) and scratch workspaces are completely segregated.
  - *Verification*: `HARVEST_TOOLS` omits coding tools, `tools_env = 0` is set on harvest forks, diffing operates exclusively on `cadmus_bot_*`, and identity prompts strictly direct durable memory to `knowledge_*` and `memory_*` tools.

## Disposition (applied by Grok Build)

1. **Inability to opt out of an account default (`{ kind: "none" }`)** — Declined. README non-goal and `binding-and-config.md` already say `toolsEnv: null` inherits and there is no "unbound while a higher level is set". `bot.tools` is still the switch that offers `bash` / `read` / `write` / `edit`; a bound env does not put a shell on a bot that did not list those names. A per-chat opt-out of the tools is the other non-goal. No decision change. — **Overridden by Lior (2026-10-21):** explicit tri-state toggle (inherit / on / off) added; see binding-and-config.md.
2. **Missing `bot_id` on `cadmus_tools_env_fs`** — Already resolved. The sketch already has `bot_id`, `idx_cadmus_tools_env_fs_bot_id`, and `deleteForBot(botId)` (`workspace-persistence.md`). `cadmus_tools_env_state` and `cadmus_chat_conversations` already have `bot_id` (`reachability.md`, `execution-env.md`). Confirmed today's `SqliteBotStore.deleteBot` does not delete chats; the plan already keeps that and only adds tools-env rows. Cascading `cadmus_chats` stays out of this plan. Clarified that the DO, not the store, sends daemon `cleanup` before close (`workspace-persistence.md`, `binding-and-config.md`). — **Superseded (2026-10-21, Lior):** `cadmus_tools_env_fs` is env-DO SQLite (`family_id`, `scope`, `bot_id`). There is no `cadmus_tools_env_state`. `cadmus_chat_conversations` stays on the family. Namespace delete is an RPC to the env DO.
3. **Persist flip races in-flight tools** — Applied, with a correction. The flip's SQLite delete shares one synchronous `storage.transaction` with the binding write. Mutations resolve `persist` and a DO-level map at write time, so a resumed call does not recreate the dropped store (`workspace-persistence.md`, `execution-env.md`, `sequencing.md`). Declined taking `withFileMutationQueue` from the RPC: it is per path, it skips `bash`, and waiting on it from `bot.update` while the tool holds it deadlocks the isolate. `sql.exec` joins `storage.transaction` and does not issue `BEGIN`. — **Superseded (2026-10-21, Lior):** `persist` is on the env definition. `applyConfig` on `CadmusEnvDO` runs that transaction. The map is in the env DO. `bot.update` does not flip `persist`.
4. **No 8 MiB cap on `persist: false`** — Applied. Decision 7 now covers the SQLite store and the isolate map. The same `FileError` `invalid` leaves status `ready`. pi-durable `write` / `edit` already `getOrThrow` a failed `Result` into the tool error (`builtin-tools.md`, `workspace-persistence.md`, `sequencing.md`). — **Superseded (2026-10-21, Lior):** both stores are in the env DO, the cap is per namespace, and status is `connected`. No per-file cap.
5. **Quota ignores the replaced blob** — Already resolved. The plan already counts the new blob and not the old one, and already rejects a `vfs_bytes` column because a check separated from the insert lets two paths both pass. The in-memory cap uses that same replacement rule with no await between check and put (`workspace-persistence.md`).
6. **`.cadmus-ephemeral` leak and refcount** — Applied in part. A new daemon process empties the directory on first construct; a later socket from that process reuses it. "Last scope" is stored bindings in this family, not an isolate counter. `cleanup` is sent before `close`, and the daemon deletes only when it has no other live session (`workspace-persistence.md`, `execution-env.md`, `binding-and-config.md`, `sequencing.md`). Declined per-scope subdirectories: same secret and effective root share one `ExecutionEnv.id` (decision 8). — **Closed (2026-10-21, Lior):** the daemon folder belongs to the account env. Another family's reference is the same folder on purpose. Unbinding one bot does not delete it. just-bash isolation is a namespace inside that env's DO (`sharedWorkspace` defaults to false).
