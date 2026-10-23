# Review 04 Results: Reachability State Machine and DO Hardware Alarm Probing

## Executive Summary

This review rigorously evaluates the reachability state machine, transport vs. application error classification taxonomy, backoff algorithms, and Cloudflare Durable Object (DO) hardware storage alarm integration for Cadmus tools-env execution environments, as specified in [`docs/plans/tools-env/reachability.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/reachability.md) and [`docs/plans/tools-env/execution-env.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/execution-env.md).

### Overall Assessment: **Viable with Critical Concurrency and Alarm Remediations**

The core architectural direction is exceptionally strong. In particular:
1. **Zero Persona Wake during Probes**: Decoupling environment reachability probes from the conversation turn engine (`conv.submit()`, `ScheduleTask`, and LLM inference) is completely verified. Probes execute out-of-band directly against the in-isolate environment or over the WebSocket probe wire frame without inserting transcript entries or consuming LLM tokens.
2. **Strict Per-Scope Isolation**: Separating bot default scopes (`bot:<botId>`) from chat overrides (`chat:<chatKey>`) while keeping inheriting chats rowless prevents table bloat and allows independent workspace states without cross-contamination.
3. **Bounded Disconnect Policy**: Capping disconnected daemon probes to 3 attempts (~15 minutes total) before stopping (`next_probe_at = NULL`) cleanly prevents the DO hardware alarm from waking up indefinitely when user laptops are closed or offline for days.

However, an exhaustive audit against the existing codebase ([`src/alarms.ts`](file:///home/developer/projects/pi-bot-hands/src/alarms.ts), [`src/family-do.ts`](file:///home/developer/projects/pi-bot-hands/src/family-do.ts), [`src/context.ts`](file:///home/developer/projects/pi-bot-hands/src/context.ts)) and upstream `@earendil-works/pi-durable` 1.3.0 runtime internals revealed **seven critical logic gaps and failure modes**:

1. **Reconnect vs. In-Flight Probe Race Condition**: If a daemon reconnects while an alarm probe is in-flight, the stale failed probe result unconditionally overwrites the newly established `ready` state, knocking the scope offline again.
2. **Ambiguous `dueProbes()` Store Contract**: The plan specifies `dueProbes()` for both scheduling future alarms and executing currently due probes. Depending on the SQL implementation, this either causes permanent alarm starvation (never waking up) or defeats the exponential backoff ladder (probing prematurely on unrelated schedule wakes).
3. **Orphaned WebSocket Resurrects Deleted Chat Overrides**: Clearing a chat override deletes the SQLite row, but failing to terminate the open WebSocket allows subsequent socket drops to resurrect an orphaned `unreachable` row in `cadmus_tools_env_state`.
4. **`shell_unavailable` Upstream Code Overload**: Upstream `NodeExecutionEnv` returns `ExecutionError("shell_unavailable")` when bash is missing on Windows. Misclassifying this as a network transport failure leads to an infinite alarm probe oscillation loop.
5. **Alarm Desynchronization at Mutation Call Sites**: Several lifecycle mutation sites (`bot.create`, `bot.update`, `createChatInternal`, and `webSocketClose`) modify or initialize `next_probe_at` in SQLite without awaiting `syncAlarmInternal()`, leaving the hardware alarm disarmed.
6. **Sequential Probing and Unhandled Exceptions in `alarm()`**: Probing unreachable scopes sequentially risks alarm execution timeouts, while any uncaught exception during probing aborts the DO alarm, starving scheduled tasks and harvest runs.
7. **Multiple Sockets per Scope Concurrency**: Connecting a second daemon instance for the same scope without superseding the previous socket causes premature transitions to `unreachable` upon closing either process.

---

## State Machine & Alarm Logic Gaps

- **Issue 1**: Race Condition — Stale Alarm Probe Result Overwrites Concurrent Reconnect
  - **Plan Reference**: [`docs/plans/tools-env/reachability.md:51-52, 147-151, 190-192`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/reachability.md#L51-L52)
  - **Scenario / Risk**:
    1. Scope `bot:worker-1` is in state `unreachable`. Its DO alarm fires at $T = 300\text{s}$.
    2. In [`src/family-do.ts:541`](file:///home/developer/projects/pi-bot-hands/src/family-do.ts#L541), `alarm()` calls `await this.probeUnreachableToolsEnvs(now)`.
    3. The probe helper attempts to ping the daemon or check the socket. Because network I/O or timeouts yield to the JavaScript microtask / event loop, the probe execution suspends.
    4. Concurrently, the remote daemon initiates a WebSocket reconnection via `GET /tools-env/ws?botId=worker-1`.
    5. The DO upgrade handler executes: accepts the socket, tags it `["tools-env-daemon", "bot:worker-1"]`, sets `cadmus_tools_env_state` to `status = 'ready'`, `probe_attempt = 0`, `next_probe_at = NULL`, and awaits `syncAlarmInternal()`. The scope is now fully operational.
    6. Microtasks resume in `probeUnreachableToolsEnvs`: the stale probe (which checked the old disconnected state or timed out) finishes and unconditionally issues:
       ```sql
       UPDATE cadmus_tools_env_state
       SET status = 'unreachable', probe_attempt = 1, next_probe_at = ?
       WHERE scope = 'bot:worker-1';
       ```
    7. **Failure**: The newly connected, healthy daemon is immediately clobbered back to `unreachable`. Future user turns hit the offline throw, and an unnecessary alarm is armed, desynchronizing the real connection from the database state.
  - **Remediation**:
    1. Implement Optimistic Concurrency Control (CAS) on `cadmus_tools_env_state` using `last_change_at`:
       ```sql
       UPDATE cadmus_tools_env_state
       SET status = :status, probe_attempt = :probeAttempt, next_probe_at = :nextProbeAt, last_change_at = :now
       WHERE scope = :scope AND last_change_at = :expectedLastChangeAt AND status = 'unreachable';
       ```
       If the row was modified concurrently by a WebSocket upgrade (which updates `last_change_at`), the UPDATE matches 0 rows and the stale probe failure is safely discarded.
    2. Additionally, before persisting a probe failure, verify that no live WebSocket is currently attached to that scope via `this.ctx.getWebSockets("bot:" + botId).length > 0`.

- **Issue 2**: Ambiguous `dueProbes()` Store Contract Causes Hardware Alarm Starvation or Backoff Violation
  - **Plan Reference**: [`docs/plans/tools-env/reachability.md:136-145, 194-195`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/reachability.md#L136-L145)
  - **Scenario / Risk**:
    In [`docs/plans/tools-env/reachability.md:137`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/reachability.md#L137), the plan specifies:
    ```ts
    // In syncDurableObjectAlarm:
    for (const row of familyStore.toolsEnv.dueProbes()) {
      if (row.nextProbeAt != null && row.status === "unreachable") {
        earliest = min(earliest, row.nextProbeAt);
      }
    }
    ```
    While in line 194 it states:
    ```ts
    // In alarm():
    // "still run any due probes (next_probe_at <= now) in the same invocation"
    ```
    This creates an irreconcilable contract ambiguity on `FamilyStore.toolsEnv.dueProbes()`:
    - *Interpretation A (`dueProbes()` filters `WHERE next_probe_at <= now`)*: When `syncDurableObjectAlarm` is called after a failure or disconnect, the next probe is in the future (`next_probe_at = now + 300s`). Because `next_probe_at > now`, `dueProbes()` returns **empty**. `syncDurableObjectAlarm` never sees the probe timestamp, fails to set `ctx.storage.setAlarm(earliest)`, and clears the DO alarm. The DO never wakes up; the scope is starved forever.
    - *Interpretation B (`dueProbes()` returns all rows `WHERE next_probe_at IS NOT NULL`)*: If an unrelated schedule wakes the DO alarm at $T = 30\text{s}$, `probeUnreachableToolsEnvs` iterates `dueProbes()` and probes scopes whose backoff was set to $T = 300\text{s}$, completely violating backoff intervals and hammering peers.
  - **Remediation**:
    Split the store facet into two explicit methods with non-overlapping semantics:
    1. `listDueProbes(now: number): ToolsEnvStateRecord[]`:
       ```sql
       SELECT * FROM cadmus_tools_env_state
       WHERE status = 'unreachable' AND next_probe_at IS NOT NULL AND next_probe_at <= ?;
       ```
       Used exclusively inside `alarm()` by `probeUnreachableToolsEnvs(now)`.
    2. `getEarliestArmedProbe(): number | undefined`:
       ```sql
       SELECT MIN(next_probe_at) AS earliestWake FROM cadmus_tools_env_state
       WHERE status = 'unreachable' AND next_probe_at IS NOT NULL;
       ```
       Used exclusively inside [`src/alarms.ts`](file:///home/developer/projects/pi-bot-hands/src/alarms.ts) by [`syncDurableObjectAlarm`](file:///home/developer/projects/pi-bot-hands/src/alarms.ts#L48).

- **Issue 3**: Orphaned Daemon Sockets Resurrect Deleted Chat Override Reachability Rows
  - **Plan Reference**: [`docs/plans/tools-env/reachability.md:70-71, 84-85`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/reachability.md#L70-L71), [`docs/plans/tools-env/binding-and-config.md:71-73`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/binding-and-config.md#L71-L73)
  - **Scenario / Risk**:
    1. A chat override `chat:dev:c1` is bound to `local-daemon`, and its daemon process is currently connected over WebSocket.
    2. The operator calls `chat.update` with `{ toolsEnv: null }` to remove the override and restore inheritance from the bot default.
    3. As planned, Cadmus sets `cadmus_chats.tools_env_json = NULL` and deletes the row from `cadmus_tools_env_state WHERE scope = 'chat:dev:c1'`.
    4. However, the existing WebSocket connection tagged `["tools-env-daemon", "chat:dev:c1"]` remains open in the Worker isolate.
    5. Sometime later, the daemon restarts or the user terminates the daemon terminal. Cloudflare invokes `webSocketClose` on the DO.
    6. `webSocketClose` inspects the tags, extracts `chat:dev:c1`, and applies the transport disconnect policy:
       ```sql
       INSERT OR REPLACE INTO cadmus_tools_env_state (scope, bot_id, status, next_probe_at, probe_attempt)
       VALUES ('chat:dev:c1', ?, 'unreachable', ?, 0);
       ```
    7. **Failure**: The deleted chat override row is resurrected as an orphaned `unreachable` scope. It arms a 300s probe timer, repeatedly waking the DO alarm, even though the chat now inherits from the bot default.
  - **Remediation**:
    1. In `chat.update` when clearing an override (`toolsEnv: null`), explicitly find all active sockets tagged `"chat:" + chatKey` using `this.ctx.getWebSockets("chat:" + chatKey)` and terminate them immediately: `ws.close(1000, "Override cleared")`.
    2. In `webSocketClose`, before inserting or updating `cadmus_tools_env_state` for a `chat:<chatKey>` scope, verify that `ChatRecord.toolsEnv` is still non-null in `familyStore.chats.getChat(chatKey)`. If the chat has no override (or was deleted), ignore the close event and do not create a reachability row.

- **Issue 4**: `shell_unavailable` Upstream Code Overload Triggers Infinite Alarm Ping-Pong on Windows
  - **Plan Reference**: [`docs/plans/tools-env/reachability.md:81-86, 112-114`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/reachability.md#L81-L86), [`node_modules/@earendil-works/pi-durable/dist/env/node.js:182-186`](file:///home/developer/projects/pi-bot-hands/node_modules/@earendil-works/pi-durable/dist/env/node.js#L182-L186)
  - **Scenario / Risk**:
    In [`reachability.md:81`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/reachability.md#L81), the plan states:
    > `exec / probe, no live peer or no reply: ExecutionError code shell_unavailable`
    > `shell_unavailable is reserved for "the execution environment could not be reached".`
    
    However, in `@earendil-works/pi-durable` 1.3.0 (`dist/env/node.js:182`), `NodeExecutionEnv` explicitly returns:
    ```js
    return err(new ExecutionError("shell_unavailable", "No bash shell found. Options:\n  1. Install Git for Windows..."));
    ```
    If an operator runs the daemon on a Windows machine where Git Bash is not installed on the system PATH:
    1. The model invokes `bash`. The daemon runs `NodeExecutionEnv.exec`, which fails to find bash and returns `ExecutionError("shell_unavailable")`.
    2. The DO wrapper classifies `shell_unavailable` as a **transport failure**.
    3. The DO wrapper marks the scope `unreachable` and arms an alarm probe.
    4. The alarm wakes and sends `{ method: "probe" }` over the open WebSocket.
    5. On the daemon, `{ method: "probe" }` succeeds because `NodeExecutionEnv` was successfully instantiated (the bash check only runs during `exec`). The daemon replies `{ ok: true }`.
    6. The DO marks the scope `ready` again.
    7. On the next turn, the model calls `bash` again, fails with `shell_unavailable`, marks `unreachable`, and the cycle repeats indefinitely.
  - **Remediation**:
    Do not treat all `shell_unavailable` errors as transport errors. Differentiate remote host application/environment configuration errors from DO-to-daemon transport dropouts:
    - Transport timeouts generated by the DO proxy itself must be flagged explicitly (e.g. via symbol `isTransportError` or message prefix `"tools-env transport:"`).
    - An `ExecutionError` code `shell_unavailable` received *over the wire* from the daemon must be treated as an **application error** (not changing scope reachability), allowing the missing bash diagnostic to be returned directly to the model without triggering an alarm loop.

- **Issue 5**: Missing `syncAlarmInternal()` Invocations Across Bot, Chat, and WebSocket Lifecycle Call Sites
  - **Plan Reference**: [`docs/plans/tools-env/reachability.md:200-209`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/reachability.md#L200-L209), [`src/family-do.ts:528-539, 978-1060, 1875-1920`](file:///home/developer/projects/pi-bot-hands/src/family-do.ts#L528-L539)
  - **Scenario / Risk**:
    [`reachability.md:200`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/reachability.md#L200) mandates: *"Every transition that sets or clears next_probe_at must await a sync in the same turn."*
    A full audit of the current codebase reveals multiple mutation sites where `syncAlarmInternal()` is omitted:
    1. **`bot.create` / `createBotInternal`** ([`src/family-do.ts:1767`](file:///home/developer/projects/pi-bot-hands/src/family-do.ts#L1767)): When creating a bot with `toolsEnv: { kind: "local-daemon", ... }`, the scope begins `unreachable` with disconnected probe delay `next_probe_at = now + 300s`. The method does not call `syncAlarmInternal()`. The probe timer is saved to SQLite, but the DO storage alarm is never armed.
    2. **`bot.update`** ([`src/family-do.ts:997`](file:///home/developer/projects/pi-bot-hands/src/family-do.ts#L997)): Updating `toolsEnv` (e.g. binding `local-daemon`, switching to `just-bash`, or clearing with `null`) changes `next_probe_at`, but `bot.update` does not call `syncAlarmInternal()`.
    3. **`createChatInternal`** ([`src/family-do.ts:1875`](file:///home/developer/projects/pi-bot-hands/src/family-do.ts#L1875)): Creating a chat with a `local-daemon` override arms `next_probe_at = now + 300s`, but does not call `syncAlarmInternal()`.
    4. **`webSocketClose`** ([`src/family-do.ts:528`](file:///home/developer/projects/pi-bot-hands/src/family-do.ts#L528)): When a `tools-env-daemon` socket drops, it sets `unreachable` and `next_probe_at = now + 300s`. The current implementation only logs debug; it never calls `syncAlarmInternal()`.
    5. **Account Default Re-bind**: When `account.update` changes `defaultToolsEnv` in D1, cache invalidation in the DO re-evaluates all inheriting bots. If any bot transitions to/from `unreachable`, failure to call `syncAlarmInternal()` leaves the hardware alarm out of sync.
  - **Remediation**:
    Audit and enforce `await this.syncAlarmInternal()` in:
    - [`src/family-do.ts`](file:///home/developer/projects/pi-bot-hands/src/family-do.ts): `createBotInternal`, `bot.update`, `createChatInternal`, `chat.update` (new), `webSocketClose`, `handleToolsEnvWs` (upgrade acceptance), and account default cache invalidation.

- **Issue 6**: Sequential Probing and Unhandled Exceptions in `alarm()` Risk Alarm Starvation and DO Crashing
  - **Plan Reference**: [`docs/plans/tools-env/reachability.md:147-151`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/reachability.md#L147-L151), [`src/family-do.ts:541-572`](file:///home/developer/projects/pi-bot-hands/src/family-do.ts#L541-L572)
  - **Scenario / Risk**:
    In [`src/family-do.ts:541`](file:///home/developer/projects/pi-bot-hands/src/family-do.ts#L541), `alarm()` executes:
    ```ts
    await this.probeUnreachableToolsEnvs(now);
    // ... drain schedules ...
    ```
    If multiple scopes (e.g. 5 bots) are due for probing and their daemons are unresponsive:
    - Executing probes sequentially (`for (const scope of due) await this.probe(scope)`) with a 2-second timeout per probe will consume 10+ seconds of alarm execution time, blocking user schedules and idle harvest forks.
    - More critically, if any individual probe throws an unhandled rejection (e.g. invalid JSON from a broken proxy, SQLite lock contention, or network abort), the entire `alarm()` function rejects.
    - In Cloudflare Workers, an unhandled rejection in `DurableObject.alarm()` triggers Cloudflare's runtime exponential error backoff. The remaining scheduled tasks in `drainDueSchedules` and the trailing `syncAlarmInternal()` call are **aborted**, starving all family schedules.
  - **Remediation**:
    1. Probe due scopes concurrently using `Promise.allSettled`:
       ```ts
       await Promise.allSettled(dueScopes.map(scope => this.probeSingleScope(scope, now)));
       ```
    2. Wrap the body of `probeSingleScope` in an exhaustive `try/catch` block that logs a structured warning on unexpected exceptions and records a failed probe attempt rather than propagating the error to `alarm()`.

- **Issue 7**: Multiple Concurrent Daemon Sockets for the Same Scope Cause Spurious Disconnects
  - **Plan Reference**: [`docs/plans/tools-env/reachability.md:84-85`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/reachability.md#L84-L85), [`docs/plans/tools-env/execution-env.md:166-171`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/execution-env.md#L166-L171)
  - **Scenario / Risk**:
    A user restarts the daemon process, or runs a second terminal instance pointing to the same bot before the previous connection's TCP FIN/RST is detected by Cloudflare.
    1. The DO accepts the second socket and tags it `["tools-env-daemon", "bot:alpha"]`.
    2. `this.ctx.getWebSockets("bot:alpha")` now contains **two** sockets.
    3. The old daemon process terminates. Cloudflare fires `webSocketClose` for Socket 1.
    4. `webSocketClose` extracts `bot:alpha` and unconditionally marks the scope `unreachable` with a 300s alarm probe, even though Socket 2 is completely healthy and connected.
    5. The bot is knocked offline for user turns until Socket 2 sends data or the alarm wakes.
  - **Remediation**:
    1. When accepting a new WebSocket for a scope in `handleToolsEnvWs`, inspect existing sockets tagged for that scope:
       ```ts
       const existing = this.ctx.getWebSockets(scopeTag);
       for (const ws of existing) {
         try { ws.close(1000, "Superseded by new daemon connection"); } catch {}
       }
       ```
    2. In `webSocketClose`, only transition the scope to `unreachable` if `this.ctx.getWebSockets(scopeTag).length === 0`. If a surviving socket exists, leave status as `ready`.

---

## Error Taxonomy Verification

### Transport vs. Application Error Classification Analysis

The classification table below provides a comprehensive verification of all error types against the contracts defined in `@earendil-works/pi-durable` 1.3.0 and Cadmus:

| Source / Error Type | Class & Code | Classification | State Machine Action | Rationale & Behavioral Verification |
| :--- | :--- | :--- | :--- | :--- |
| **Daemon RPC Timeout** | `FileError` code `unknown` / `ExecutionError` code `shell_unavailable` | **Transport** | Set `unreachable`, arm probe, broadcast event | DO proxy waited ~2s with no reply from peer. Environment unreachable. |
| **Daemon WebSocket Drop** | `webSocketClose` event | **Transport** | Set `unreachable`, arm disconnected ladder (300s $\times 3$) | Physical TCP / WS connection terminated. Cloud cannot dial out. |
| **VFS Open / Factory Throw** | Construction exception / `FileError` | **Transport** | Set `unreachable`, arm regular short backoff | Environment failed to initialize in isolate. Transient resource issue. |
| **Command Non-Zero Exit** | `ShellExecResult` (`exitCode: 1`, `127`) | **Application** | None (remain `ready`) | Command executed to completion on the peer. Valid execution outcome. |
| **Command Timeout** | `ExecutionError` code `timeout` | **Application** | None (remain `ready`) | Host environment successfully enforced the command execution deadline. |
| **Spawn / Argument Error** | `ExecutionError` code `spawn_error` | **Application** | None (remain `ready`) | Binary not found or empty argv. Peer filesystem/OS answered correctly. |
| **Caller Turn Aborted** | `ExecutionError` / `FileError` code `aborted` | **Application** | None (remain `ready`) | Turn cancelled by user or caller timeout (`abortSignal`). |
| **Output Callback Error** | `ExecutionError` code `callback_error` | **Application** | None (remain `ready`) | Stream chunk handler threw. Peer execution was intact. |
| **Missing File / Directory** | `FileError` code `not_found`, `not_directory` | **Application** | None (remain `ready`) | Standard filesystem error returned by peer VFS or host OS. |
| **Permission Denied** | `FileError` code `permission_denied` | **Application** | None (remain `ready`) | Host OS file permissions rejected operation. Peer is healthy. |
| **VFS Cap Exceeded** | `FileError` code `invalid` | **Application** | None (remain `ready`) | Virtual filesystem storage budget (8 MiB) enforced. Peer is healthy. |
| **Unsupported Method** | `FileError` code `not_supported` | **Application** | None (remain `ready`) | Optional capability (`watch`, `listFiles`) declined by provider. |
| **Missing Host Bash Binary** | `ExecutionError` code `shell_unavailable` (wire) | **Application / Config** | None (remain `ready`) | Host machine lacks Git Bash. See Issue 4 above: probing cannot fix this. |

### Evaluation of Message Prefix Matching (`"tools-env transport:"`)

The plan proposes using:
```ts
err.code === "unknown" && err.message.startsWith("tools-env transport:")
```
to differentiate transport timeouts on file operations from application-level filesystem errors.

#### Fragility Assessment
1. **Upstream Overload of `unknown`**: In `@earendil-works/pi-durable` ([`dist/env/node.js:96`](file:///home/developer/projects/pi-bot-hands/node_modules/@earendil-works/pi-durable/dist/env/node.js#L96)), any OS error not explicitly mapped (`ENOSPC`, `EIO`, `EMFILE`, `EROFS`, `EBUSY`, `EXDEV`) is constructed as:
   ```js
   new FileError("unknown", cause.message, path, cause);
   ```
   Because upstream does not define a `"transport"` error code, using `unknown` is required for TypeBox conformance.
2. **String Prefix Brittleness**:
   - String prefix checks are vulnerable to typo drift across implementation files (e.g. `"tools-env transport: "` vs `"tools_env transport:"`).
   - Upstream error wrappers or causal formatters can push or alter the prefix string.
3. **Recommended Concrete Implementation**:
   Implement a branded TypeScript error and helper in `src/tools-env/errors.ts`:
   ```ts
   export const TRANSPORT_PREFIX = "tools-env transport: ";
   export const TRANSPORT_BRAND = Symbol("cadmus.toolsEnv.isTransport");

   export class ToolsEnvTransportError extends FileError {
     readonly [TRANSPORT_BRAND] = true;
     constructor(message: string, path?: string, cause?: Error) {
       super("unknown", `${TRANSPORT_PREFIX}${message}`, path, cause);
     }
   }

   export function isTransportError(error: unknown): boolean {
     if (!error || typeof error !== "object") return false;
     if (TRANSPORT_BRAND in error) return true;
     if (error instanceof FileError && error.code === "unknown" && error.message.startsWith(TRANSPORT_PREFIX)) return true;
     return false;
   }
   ```
   This provides type-safe, compile-time branded discrimination inside Cadmus while preserving string prefix compatibility for external conformance tests.

---

## Alarm Synchronization Checklist

- [x] **Isolation of chat overrides from bot-default scopes**
  - *Verification*: Scopes use primary keys `bot:<botId>` and `chat:<chatKey>`. Inheriting chats do not store rows in `cadmus_tools_env_state` and query `bot:<botId>`. Sockets are tagged distinctly (`"bot:" + botId` vs `"chat:" + chatKey`).
  - *Remediation Applied*: Enforce that all state queries use exact `WHERE scope = ?` matching. In `chat.update { toolsEnv: null }`, terminate active chat sockets to prevent orphaned close events from mutating state.

- [x] **Clean deletion of probe rows on unbind/delete**
  - *Verification*: `bot.delete` deletes all rows matching `bot_id = ?` (covering the bot default and all child chat overrides) and immediately calls `await this.syncAlarmInternal()`.
  - *Remediation Applied*: `chat.update` clearing an override (`toolsEnv: null`) must explicitly delete `chat:<chatKey>` from `cadmus_tools_env_state` and await `syncAlarmInternal()` so leftover probe timers are removed from the DO alarm calculation.

- [x] **No persona wake / `conv.submit` during probes**
  - *Verification*: Verified against [`src/alarms.ts`](file:///home/developer/projects/pi-bot-hands/src/alarms.ts) and [`src/family-do.ts`](file:///home/developer/projects/pi-bot-hands/src/family-do.ts). `probeUnreachableToolsEnvs(now)` runs out-of-band before schedule draining. Probes invoke only in-isolate `stat(cwd)` or the WebSocket frame `{ method: "probe" }`.
  - *Audit*: Probing creates zero entries in `cadmus_pi_*` tables, invokes zero Chord extensions, and emits zero LLM tokens.

- [x] **3-attempt cap for disconnected daemon**
  - *Verification*: On bind-with-no-socket or `webSocketClose`, `probe_attempt` starts at 0 with 300s delay. Attempts 1 and 2 delay by 300s ($\pm 10\%$ jitter). At Attempt 3+, `next_probe_at` is set to `NULL`.
  - *Audit*: When `next_probe_at === NULL`, `syncDurableObjectAlarm` excludes the scope. If no schedules exist, `ctx.storage.deleteAlarm()` is called. A closed laptop lid strictly ceases all alarm wakeups after ~15 minutes.

- [x] **Reconnect race conditions and alarm clearing**
  - *Verification*: When a daemon reconnects, WebSocket acceptance immediately sets `status = 'ready'`, `next_probe_at = NULL`, `probe_attempt = 0`, and calls `await this.syncAlarmInternal()`, clearing any armed probe alarms.
  - *Remediation Applied*: Addressed the in-flight probe collision (Issue 1) via CAS optimistic concurrency control (`WHERE scope = ? AND last_change_at = ?`), preventing stale probe failures from overwriting concurrent reconnects. Addressed multi-socket races (Issue 7) by closing superseded sockets on accept.

- [x] **Completeness of `syncAlarm` call sites**
  - *Verification*: Mapped every code path that modifies or initializes `next_probe_at`.
  - *Remediation Applied*: Identified missing `syncAlarmInternal()` call sites in `createBotInternal`, `bot.update`, `createChatInternal`, `chat.update`, `webSocketClose`, and account default invalidation, specifying exact locations where `await this.syncAlarmInternal()` must be added.

## Disposition (applied by Grok Build)

1. **Stale probe overwrites reconnect** — Applied. Probe writes compare `last_change_at` and discard on zero rows (`reachability.md`). Declined the extra rule that a live socket skips a failed probe: an open socket that does not answer is the connected backoff. No README decision change. — **Superseded (2026-10-21, Lior):** cloud-side probing removed; env reconnects proactively, heartbeat only while calls are in flight, connection state per env with generation CAS (reachability.md).
2. **`dueProbes()` alarm starvation or early probe** — Already resolved. The plan already splits `listPendingProbes()` (any armed wake, including future) from `listDueProbes(now)` (`alarm()` only). A separate `getEarliestArmedProbe()` would only repeat the min over the first list. — **Superseded (2026-10-21, Lior):** cloud-side probing removed; env reconnects proactively, heartbeat only while calls are in flight, connection state per env with generation CAS (reachability.md).
3. **Closed socket resurrects a cleared chat override** — Applied. Clear, unbind, and delete close that scope's sockets; `webSocketClose` does not insert a row unless the effective binding is still `local-daemon` (`reachability.md`, `binding-and-config.md`, `execution-env.md`, `sequencing.md`).
4. **Wire `shell_unavailable` ping-pongs on Windows** — Applied. Confirmed in pi-durable 1.3.0 `dist/env/node.js`: `getShellConfig` returns `shell_unavailable` from `exec`, not from construction, and `toFileError` uses `unknown` for unmapped OS codes. Only DO-synthesized errors carry `tools-env transport:` (`reachability.md`, `execution-env.md`, `sequencing.md`). Declined a branded `ToolsEnvTransportError` / `Symbol`: the prefix is the signal, and a brand would not survive rebuilding the wire error.
5. **Missing `syncAlarmInternal()` at lifecycle sites** — Already resolved. `reachability.md` already required a sync on `webSocketClose`, daemon upgrade, `bot.create` / `bot.update`, `chat.create` / `chat.update`, and delete; `binding-and-config.md` already required it on account-default and secret invalidation. Those writes do not exist in today's `family-do.ts` (no tools-env code yet). Cross-listed the two invalidation handlers on the reachability sync table so both docs name them. — **Superseded (2026-10-21, Lior):** cloud-side probing removed; env reconnects proactively, heartbeat only while calls are in flight, connection state per env with generation CAS (reachability.md).
6. **Sequential probes and a throw aborting `alarm()`** — Applied. Due scopes run with `Promise.allSettled`, each in its own try/catch that records a failed attempt under the same compare, so one throw still reaches schedule drain and the trailing sync (`reachability.md`, `sequencing.md`). No per-scope concurrency cap. — **Superseded (2026-10-21, Lior):** cloud-side probing removed; env reconnects proactively, heartbeat only while calls are in flight, connection state per env with generation CAS (reachability.md).
7. **Two daemon sockets, and the first close marks the scope down** — Applied, with one correction. Accept closes the previous socket (`1000`, `Superseded`). Reachability changes only when no other socket for that tag is `OPEN`. `getWebSockets` can still return a `CLOSING` socket, so `length === 0` is the wrong test (`execution-env.md`, `reachability.md`, `sequencing.md`). One socket per scope stays the decision.
