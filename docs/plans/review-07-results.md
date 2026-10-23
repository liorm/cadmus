# Review 07 Results: Implementation Logic, Edge Cases and Operational Failure Modes

## Executive Summary

This review evaluates the implementation logic, lifecycle behavior, concurrency models, and operational failure modes specified in the Tools Environment design documents:
- [`execution-env.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/execution-env.md)
- [`builtin-tools.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/builtin-tools.md)
- [`reachability.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/reachability.md)
- [`workspace-persistence.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/workspace-persistence.md)
- [`binding-and-config.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/binding-and-config.md)

The tools environment architecture introduces two disparate runtime backends: an in-isolate, zero-network, SQLite-backed virtual shell interpreter (`just-bash`) and an out-of-band reverse WebSocket bridge (`local-daemon`) that proxies filesystem and shell commands to an external host machine.

While the conceptual separation between identity, storage, and execution is well-structured, a rigorous audit of the execution lifecycle, concurrency primitives, transaction boundaries, and transport handling reveals **several critical logic flaws, deadlock hazards, state flapping conditions, and resource leak traps**:

1. **Deadlock Hazard in `conversationCreated`**: The `conversationCreated` hook executes inside a `pi-durable` storage transaction. Attempting to query `pi-durable` via `tx` throws `ReadAfterWrite`, while attempting to perform asynchronous operations across the underlying DO SQLite handle risks contention or deadlocks against `pi-durable`'s internal `SerialQueue`.
2. **Orphaned Process Spawns on the Host Machine**: Cloudflare Durable Objects can hibernate, restart, or evict at any time. When an active `exec` command is running on the host machine and the DO restarts or the WebSocket connection severs, the current design leaves child processes executing as unmonitored orphans on the user's host machine.
3. **Broken Bot Root Turn Resolution**: The plan dictates that missing rows in `cadmus_chat_conversations` return `undefined`, yet also states that bot root turns must fall back to the bot default. Because bot root conversations have no chat row and no `cadmus_chat_conversations` entry, tools invoked on the bot root fail with `"No execution environment is configured"`.
4. **Permanent Storage Leak of Harvest Fork Rows**: The two-step harvest fork pattern (`conversationCreated` blindly copies parent rows with `tools_env = 1`, and `executeHarvestFork` subsequently sets `tools_env = 0`) permanently accumulates unindexed conversation rows in DO SQLite on every idle harvest cycle without any retention or deletion mechanism.
5. **Multi-Socket Race Conditions on Identical Scopes**: When multiple daemon instances or rapid reconnects dial the same `bot:<botId>` scope, the DO maintains multiple tagged WebSockets. In-flight frames can route to zombie sockets, while closing an old socket erroneously trips the scope's reachability into `unreachable` and arms backoff alarms even when a healthy socket is active.
6. **Cross-DO Cache Inconsistency on Account Defaults**: Updating `defaultToolsEnv` via `account.update` updates D1 and the local DO cache, but lacks a fan-out invalidation mechanism to other active Family DOs belonging to the same account. Idle DOs continue serving stale defaults and will fail to rebind scopes, flush superseded VFS rows, or broadcast reachability updates.
7. **Semantic Alarm Bug in `dueProbes()`**: The DO alarm scheduler checks `dueProbes()` (which queries `next_probe_at <= now`), preventing the alarm driver from ever learning about future scheduled probe times (`next_probe_at > now`), breaking the entire probe backoff retry mechanism.

Detailed findings, complete walkthroughs of failure scenarios, and concrete remediations are documented below.

---

## Logic Flaws & Race Conditions

### Finding 1: Dual-Socket Collision and False-Unreachable State on Daemon Reconnect
- **Severity**: **High**
- **Plan Reference**: [`execution-env.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/execution-env.md) lines 166–176; [`reachability.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/reachability.md) lines 84–85, 104.
- **Failure Scenario**:
  1. A daemon connects for `bot:b1`. The DO runs `acceptWebSocket(server, ["tools-env-daemon", "bot:b1"])`. The socket is stored by the runtime (`ws1`).
  2. The daemon process restarts, or the user's local network flaps. The client immediately opens a new TCP connection and reconnects (`ws2`) before Cloudflare has detected that `ws1` is dead or before the TCP FIN/RST is processed.
  3. The DO accepts `ws2` and tags it `["tools-env-daemon", "bot:b1"]`.
  4. Now `this.ctx.getWebSockets("bot:b1")` returns `[ws1, ws2]`.
  5. A model turn arrives and invokes `bash`. The remote proxy calls `this.ctx.getWebSockets("bot:" + botId)`. If it selects `ws[0]`, it sends the JSON frame to `ws1` (the dead/stale socket).
  6. No response is ever received. The command times out after the transport timeout (2 seconds for file/probe, or the exec ceiling), returning `shell_unavailable`.
  7. Moments later, Cloudflare's runtime detects `ws1` TCP termination and fires `CadmusBotFamilyDO.webSocketClose(ws1)`.
  8. `webSocketClose` inspects tags, sees `["tools-env-daemon", "bot:b1"]`, and unconditionally sets `cadmus_tools_env_state` for `bot:b1` to `unreachable`, disarming immediate recovery and arming a 300s disconnect backoff alarm.
  9. **Result**: The bot scope is marked `unreachable` and tools are disabled, despite `ws2` being healthy, connected, and idle.
- **Remediation**:
  Enforce **single-occupancy semantics** on daemon scope tags:
  1. In `CadmusBotFamilyDO.fetch` when accepting a new `/tools-env/ws` connection for a scope tag (e.g. `bot:<botId>` or `chat:<chatKey>`):
     ```ts
     const scopeTag = chatKey ? `chat:${chatKey}` : `bot:${botId}`;
     const existingSockets = this.ctx.getWebSockets(scopeTag);
     for (const oldWs of existingSockets) {
       try {
         oldWs.close(1008, "Replaced by new daemon connection");
       } catch {}
     }
     this.ctx.acceptWebSocket(server, ["tools-env-daemon", scopeTag]);
     ```
  2. In `webSocketClose(ws)`:
     ```ts
     const scopeTag = tags.find((t) => t.startsWith("bot:") || t.startsWith("chat:"));
     if (scopeTag) {
       // Only transition to unreachable if NO OTHER sockets for this scope remain open
       const remaining = this.ctx.getWebSockets(scopeTag).filter((s) => s !== ws);
       if (remaining.length === 0) {
         await this.handleDaemonDisconnect(scopeTag);
       } else {
         this.log().info("daemon socket closed but active replacement socket exists", { scopeTag });
       }
     }
     ```

---

### Finding 2: Unhandled In-Flight Execution and Host Process Orphan Traps
- **Severity**: **High**
- **Plan Reference**: [`execution-env.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/execution-env.md) lines 180–198; [`builtin-tools.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/builtin-tools.md) lines 80–86.
- **Failure Scenario**:
  1. An agent triggers a long-running command (e.g. `bash({ command: "find . -name '*.ts' | xargs wc -l; sleep 20" })`).
  2. The DO sends `{ id: "call_123", method: "exec", args: ... }` over the WebSocket.
  3. The local daemon on the owner's machine spawns a child process using `NodeExecutionEnv` and begins streaming output chunks.
  4. While the process is running on the host machine, the Cloudflare DO isolate restarts (due to DO code upgrade, memory eviction, or network glitch).
  5. The DO isolate reboots. Because `bash` is not marked `replay: "safe"` in `pi-durable`, `pi-durable` resumes the task and treats the unfinished tool call as `interrupted`.
  6. On the host machine, the WebSocket connection to Cloudflare drops.
  7. However, the daemon process does not tie the lifecycle of active `NodeExecutionEnv` child processes to the WebSocket connection. The child process (`sleep 20`, or worse, a runaway build/server script) continues running in the background on the user's laptop as an **orphan**.
  8. When the DO re-establishes a connection and subsequent commands are issued (e.g. running tests or editing files), the orphan process may hold filesystem locks, bind network ports, or consume CPU resources on the host machine.
- **Remediation**:
  The daemon specification in `daemon/` must mandate strict **process tree abort on connection drop**:
  1. The daemon must maintain an `AbortController` per in-flight execution mapped to the wire `id`.
  2. Upon receiving a WebSocket `close` or `error` event, the daemon must immediately call:
     ```ts
     ws.on("close", () => {
       for (const [id, controller] of activeCommands) {
         controller.abort();
       }
       activeCommands.clear();
       nodeExecutionEnv.cleanup().catch((err) => log.warn("cleanup failed", { err }));
     });
     ```
  3. Similarly, on the DO side, `CadmusBotFamilyDO.webSocketClose(ws)` must immediately iterate over all pending in-memory deferred call Promises awaiting responses on that socket, reject them with `new ExecutionError("shell_unavailable", "Daemon connection closed mid-execution")`, and clear the pending map so promises do not hang until timeout.

---

### Finding 3: Missing Row Behavior in `cadmus_chat_conversations` Breaks Bot Root Turns
- **Severity**: **Medium**
- **Plan Reference**: [`execution-env.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/execution-env.md) lines 41–45, 71–72.
- **Failure Scenario**:
  1. `execution-env.md` line 42 specifies step 2 of the `env` callback:
     > *"2. Resolves the chat for `target.conversationId` through `cadmus_chat_conversations` (see below). No row means this conversation is not a chat and not a fork of one (the bot root conversation is that case). If the row has `tools_env = 0`, return `undefined`. That is a harvest child. Do not read a binding and do not throw."*
  2. However, line 71 states:
     > *"The bot root conversation (`createBotInternal`) has no parent and no chat row. Coding tools there, if a turn ever runs on it, use the bot default."*
  3. If step 2 treats "no row" as a reason to return `undefined` (as implied by line 34 of `review-07.md`), any turn submitted directly to the bot's root conversation immediately fails with pi-durable's `"No execution environment is configured"`.
  4. Conversely, if step 2 falls through to step 3 when no row is found, any unmapped internal conversation (e.g. an internal summarization or analysis task) that has `cwd: bot.id` will inadvertently execute against the bot default tools environment, running shell tools against persistent storage without being associated with any chat.
- **Remediation**:
  Make `cadmus_chat_conversations` an explicit and exhaustive mapping:
  1. In `createBotInternal`, explicitly insert the bot's root conversation into `cadmus_chat_conversations`:
     ```sql
     INSERT INTO cadmus_chat_conversations (conversation_id, chat_key, bot_id, tools_env)
     VALUES (?, '', ?, 1);
     ```
     (Using an empty string `chat_key: ''` to indicate it is the bot root conversation, which has no chat override).
  2. Step 2 of the `env` callback then becomes completely deterministic:
     ```ts
     const convRow = familyStore.toolsEnv.getConversationMap(target.conversationId);
     if (!convRow || convRow.toolsEnv === 0) {
       return undefined; // Unmapped conversation or harvest fork
     }
     const botId = convRow.botId;
     const chatKey = convRow.chatKey || undefined;
     ```
  3. This completely eliminates ambiguity, prevents unmapped internal tasks from inheriting coding tools, and guarantees that bot root turns resolve cleanly to the bot default tools environment.

---

### Finding 4: Unbounded Accumulation of Dead Harvest Rows in `cadmus_chat_conversations`
- **Severity**: **Medium**
- **Plan Reference**: [`execution-env.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/execution-env.md) lines 56–70; [`schedules.ts`](file:///home/developer/projects/pi-bot-hands/src/schedules.ts) lines 392–430.
- **Failure Scenario**:
  1. An idle harvest schedule executes every few minutes whenever users are chatting (`ScheduleTask` phase `run`).
  2. `executeHarvestFork` calls `await parent.fork(...)`.
  3. In `pi-durable`, `parent.fork` triggers the `HarnessOptions.conversationCreated` hook.
  4. The hook checks `record.parent`, finds the parent chat row in `cadmus_chat_conversations`, and copies it onto the child conversation ID with `tools_env = 1`.
  5. `executeHarvestFork` then executes `UPDATE cadmus_chat_conversations SET tools_env = 0 WHERE conversation_id = child.id`.
  6. The harvest turn runs, diffs files, records the `HarvestNote`, and completes.
  7. The child conversation is terminal. However, the row `{ conversation_id: child.id, chat_key, bot_id, tools_env: 0 }` remains in `cadmus_chat_conversations` forever.
  8. Over months of operation, thousands of harvest forks are created and settled. `cadmus_chat_conversations` grows monotonically without bound, bloating DO SQLite storage and degrading lookup performance on active conversations.
- **Remediation**:
  1. In `executeHarvestFork`, add a cleanup step in a `finally` block:
     ```ts
     try {
       // run harvest turn...
     } finally {
       familyStore.toolsEnv.deleteConversationMap(child.id);
     }
     ```
  2. Alternatively, rather than inserting and updating, do not insert harvest forks into `cadmus_chat_conversations` at all. Since `executeHarvestFork` configures the child conversation with `HARVEST_TOOLS` exclusively, and `HARVEST_TOOLS` does not include `bash`, `read`, `write`, or `edit`, the `env` callback is never invoked during a harvest turn. If `conversationCreated` skips copying when `record.parent` has no need for a child env or if harvest forks are marked ownerless, dead rows will never accumulate.

---

### Finding 5: Semantic Alarm Driver Bug in `dueProbes()` Prevents Future Alarm Scheduling
- **Severity**: **High**
- **Plan Reference**: [`reachability.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/reachability.md) lines 134–145, 198–209; [`alarms.ts`](file:///home/developer/projects/pi-bot-hands/src/alarms.ts) lines 48–85.
- **Failure Scenario**:
  1. A tools-env scope experiences a transport failure.
  2. The wrapper transitions `cadmus_tools_env_state` to `unreachable`, computes the first retry delay (e.g. `now + 5000`), sets `next_probe_at = now + 5000`, and awaits `services.syncAlarm()`.
  3. `services.syncAlarm()` calls `syncDurableObjectAlarm(storage, harness, familyStore)`.
  4. Lines 134–142 of `reachability.md` specify:
     ```ts
     for (const row of familyStore.toolsEnv.dueProbes()) {
       if (row.nextProbeAt != null && row.status === "unreachable") {
         earliest = min(earliest, row.nextProbeAt);
       }
     }
     ```
  5. The method name is `dueProbes()`. In standard SQL store patterns, `dueX()` returns rows where `timestamp <= now` (see `listSchedules` in `src/family-do.ts` line 545: `sched.nextRun <= now`).
  6. Because the probe is scheduled 5 seconds in the **future** (`next_probe_at = now + 5000 > now`), a query filtering `next_probe_at <= now` returns **zero rows**.
  7. Consequently, `earliest` remains `undefined` (or only reflects unrelated schedules). `ctx.storage.setAlarm()` is never called for the probe!
  8. The DO goes to sleep and never wakes up at `now + 5000`. The probe is never executed.
- **Remediation**:
  Separate **due probe execution** from **earliest alarm scheduling**:
  1. Add `earliestNextProbe(now?: number): number | undefined` to `familyStore.toolsEnv`:
     ```sql
     SELECT MIN(next_probe_at) as earliest
     FROM cadmus_tools_env_state
     WHERE status = 'unreachable' AND next_probe_at IS NOT NULL;
     ```
  2. In `syncDurableObjectAlarm` in `src/alarms.ts`:
     ```ts
     const probeWake = familyStore.toolsEnv.earliestNextProbe();
     if (probeWake !== undefined && (earliest === undefined || probeWake < earliest)) {
       earliest = probeWake;
     }
     ```
  3. Reserve `dueProbes(now: number)` strictly for `CadmusBotFamilyDO.alarm()` to find rows where `next_probe_at <= now` that must be actively probed during that alarm tick.

---

### Finding 6: Silent Reachability Flapping and Stale Identity in Mid-Turn Reconnection
- **Severity**: **Medium**
- **Plan Reference**: [`builtin-tools.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/builtin-tools.md) lines 93–113; [`reachability.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/reachability.md) lines 212–220.
- **Failure Scenario**:
  1. A bot scope is currently `unreachable`.
  2. The user submits a prompt: *"Please inspect src/index.ts and find any bugs"*.
  3. At turn start, generation prepares the system prompt. It evaluates `identityExtension`. Because status is `unreachable`, it renders `tools-env-unavailable`:
     > *"The tools env for this chat is unavailable (local-daemon, bot default). It cannot run commands or touch files. Recovery is automatic. Do not try to use it. Keep chatting."*
  4. Crucially, the model's tool schema still lists `read`, `write`, `edit`, and `bash` as available tools because `bot.tools` includes them.
  5. While the model is generating its first tokens, the user starts the daemon on their laptop.
  6. The daemon connects to the DO. The DO accepts the WebSocket and immediately flips status to `ready` with `next_probe_at = NULL`.
  7. The LLM ignores the text prompt instruction ("do not try to use it") because the tool definitions for `read` are present in its schema, and issues a tool call: `read({ path: "src/index.ts" })`.
  8. Pi-durable executes the tool call. It calls `runtime.env()`.
  9. The `env` callback inspects `cadmus_tools_env_state`. Because the daemon reconnected, status is now `ready`!
  10. The `read` tool executes across the WebSocket and successfully returns the file contents!
  11. The model completes the turn and responds to the user with the file analysis.
  12. **Resulting Discrepancy**: The transcript active context contains a system prompt explicitly declaring that the tools environment is completely offline and commands cannot be run, directly followed by tool calls that succeeded. On the next turn, if the daemon disconnects again, the model oscillates between conflicting instructions, degrading prompt adherence and model trust.
- **Remediation**:
  1. **Dynamic Tool Gating in `beforeTool`**: While a scope is `unreachable`, `beforeTool` in `tool-gate.ts` should enforce the offline policy even if the tool is declared in `bot.tools`, blocking the tool call before `execute` if the scope was unreachable at the start of the turn:
     ```ts
     if (isCodingTool(call.name) && turnInitialStatus === "unreachable") {
       return { block: "The tools environment was unavailable at the start of this turn. Please wait for the next turn to use tools." };
     }
     ```
  2. Alternatively, accept the optimistic recovery as a feature, but ensure the identity section helper explicitly documents this behavior so unit tests can assert on the transition contract.

---

### Finding 7: Ghost Chat Override Resurrections after Override Cleared
- **Severity**: **Medium**
- **Plan Reference**: [`binding-and-config.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/binding-and-config.md) lines 70–73, 215; [`execution-env.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/execution-env.md) lines 176, 220.
- **Failure Scenario**:
  1. A chat override is configured with `local-daemon` on `chatKey: c1`.
  2. The daemon is actively connected on `GET /tools-env/ws?familyId=f1&botId=b1&chatKey=c1`. The socket is tagged `["tools-env-daemon", "chat:c1"]`.
  3. The user clears the chat override via `chat.update` with `toolsEnv: null`.
  4. Per `binding-and-config.md` line 71, `chat.update` sets `cadmus_chats.tools_env_json = NULL`, deletes the `chat:c1` reachability row in `cadmus_tools_env_state`, and deletes VFS rows.
  5. However, `chat.update` **fails to close the active WebSocket** `chat:c1`.
  6. Minutes later, the user shuts down the daemon on their laptop.
  7. Cloudflare fires `webSocketClose(ws)` on the DO.
  8. `webSocketClose` reads the tag `chat:c1`. It executes `handleDaemonDisconnect("chat:c1")`.
  9. `handleDaemonDisconnect` executes:
     `INSERT OR REPLACE INTO cadmus_tools_env_state (scope, bot_id, status, ...) VALUES ('chat:c1', 'b1', 'unreachable', ...)`.
  10. **Result**: A phantom reachability state row `chat:c1` is resurrected in `cadmus_tools_env_state` with status `unreachable`! It arms probe alarms and broadcasts misleading `tools-env.reachability` events to the UI, even though the chat has no override and should inherit the bot default.
- **Remediation**:
  1. When clearing a chat override in `chat.update`:
     ```ts
     const overrideSockets = this.ctx.getWebSockets(`chat:${chatKey}`);
     for (const ws of overrideSockets) {
       try {
         ws.close(1000, "Chat override cleared");
       } catch {}
     }
     ```
  2. In `handleDaemonDisconnect(scope)`: Check if the scope is a chat override (`scope.startsWith("chat:")`). If the chat record does not exist or has `toolsEnv == null`, **do not** write to `cadmus_tools_env_state` and do not arm any alarms.

---

## Concurrency & Lifecycle Edge Cases

### 1. `conversationCreated` Execution Inside pi-durable Commit Transactions

The plan introduces `cadmus_chat_conversations` to map `conversationId` to `(chatKey, botId, toolsEnv)`.
In `execution-env.md` line 67:
> *"The hook runs inside the creating commit, including forks, and receives the child `ConversationRecord`. Pi-durable table reads from that hook throw `ReadAfterWrite`. This hook does not read those tables. If `record.parent` is set, it copies `chat_key`, `bot_id`, and `tools_env` from the parent conversation's row onto the child id."*

#### Concurrency Analysis
In `pi-durable`, every commit executes inside an isolated asynchronous callback passed to `DurableObjectSqliteDatabase.transaction()`:
```ts
this.queue.hold(() => this.storage.transaction(async () => { ... }))
```
Inside this transaction, `pi-durable` holds a lock on its internal `SerialQueue`. Any call made to `DurableObjectSqliteDatabase` methods (`exec`, `run`, `get`, `all`) will detect `this.pending > 0` and enqueue the call behind `this.tail`.

If `conversationCreated` were to call any `pi-durable` storage method, or call any method on `Harness` that attempts to acquire a storage lock, the hook would **deadlock immediately**, hanging the Durable Object permanently.

Furthermore, within `pi-durable`'s `Transaction` object (`tx`), any table read (such as `tx.conversation(record.parent)`) throws a `ReadAfterWrite` exception because a conversation creation has already modified the transaction write set.

#### Safe Pattern Verification
Because Cadmus's `SqliteFamilyStore` operates directly on `this.ctx.storage.sql` (bypassing `DurableObjectSqliteDatabase`), raw SQL executions like:
```sql
SELECT chat_key, bot_id, tools_env FROM cadmus_chat_conversations WHERE conversation_id = ?
```
and
```sql
INSERT INTO cadmus_chat_conversations (conversation_id, chat_key, bot_id, tools_env) VALUES (?, ?, ?, ?)
```
will execute synchronously on the underlying SQLite connection without contending on `pi-durable`'s `SerialQueue`.
However, this safety holds **only if**:
1. `conversationCreated` touches **only** `familyStore` raw SQLite tables.
2. `conversationCreated` **never** awaits `harness.conversation()`, `harness.commit()`, or any `tx.*` table query.
3. If the outer `pi-durable` commit fails and rolls back, Cloudflare DO SQLite rolls back the entire `storage.transaction()`, ensuring that the insert into `cadmus_chat_conversations` is rolled back atomically with the conversation creation.

---

### 2. Distributed Account Default Cache Invalidation Across DO Instances

In `binding-and-config.md` line 117:
> *"The family DO does not decrypt D1 on the tool path. `CadmusServices` gains `getAccountDefaultToolsEnv(): ToolsEnvBinding | null`. The DO caches the binding JSON the way `AccountCredentialStore` caches provider keys, and drops the cache when `account.update` changes the default (same idea as `/__internal/credentials/invalidate`)."*

#### Failure Analysis
An account in Cadmus can contain multiple Bot Families. Each Bot Family is hosted on a distinct Durable Object instance (`cadmus:${accountId}:${familyId}`).
When an operator calls `account.update({ defaultToolsEnv: { kind: "local-daemon", ... } })`:
1. The RPC is routed to the specific Family DO handling that connection (e.g. Family 1).
2. Family 1 writes the updated JSON into D1 (`cadmus_accounts.default_tools_env_json`).
3. Family 1 invalidates its local in-memory cache and rebinds its own inheriting bots.
4. **However**, Family 2 and Family 3 are running in separate DO isolates elsewhere in Cloudflare's network.
5. Family 2 and Family 3 receive no notification of this change. Their cached `defaultToolsEnv` remains whatever they loaded at startup.
6. Bots in Family 2 continue running turns against the old default (e.g. `just-bash` instead of `local-daemon`), writing to old VFS stores, and failing to arm alarms or connect to daemons.

#### Remediation Architecture
`account.update` must execute the exact same distributed invalidation fan-out pattern used by credentials:
1. When `defaultToolsEnv` is modified in `account.update`, the handling DO must query D1:
   ```ts
   const targetFamilies = await this.adminStore.listFamilies(meta.accountId);
   ```
2. Fan out an invalidation request to all sibling Family DOs via internal RPC:
   ```ts
   await Promise.allSettled(
     targetFamilies.map(async (family) => {
       const doId = this.env.CADMUS_BOT_FAMILY.idFromName(family.doName);
       const stub = this.env.CADMUS_BOT_FAMILY.get(doId);
       await stub.fetch("https://cadmus.internal/__internal/tools-env/invalidate", {
         method: "POST",
         headers: { "Content-Type": "application/json" },
         body: JSON.stringify({ defaultToolsEnv: newDefault }),
       });
     })
   );
   ```
3. Inside each Family DO's `/__internal/tools-env/invalidate` handler:
   - Invalidate the cached account default.
   - Scan all local bot records where `tools_env_json IS NULL`.
   - Compare each bot's `cadmus_tools_env_state.binding_fp` against the new default fingerprint.
   - For any mismatched bot scope:
     - Clear stale VFS rows if moving away from `just-bash`.
     - Initialize optimistic reachability (`ready` for `just-bash`, `unreachable` with 300s backoff for `local-daemon`).
     - Call `syncAlarmInternal()` to adjust alarms.
     - Emit `tools-env.reachability` event to protocol clients.

---

### 3. VFS Storage Cap Race Under Parallel Tool Execution

In `workspace-persistence.md` line 44:
> *"The cap is 8 MiB sum of content per scope (decision 7). Writes that would exceed fail with `FileError` code `invalid` (an application result, status stays ready)."*
And in `execution-env.md` line 37:
> *"Default `toolExecution` is `parallel`, so that queue is what keeps two writes of one file in one isolate ordered. It is in-process."*

#### Concurrency Analysis
`pi-durable` uses `withFileMutationQueue` to serialize concurrent edits to the **same** file path. However, when an agent model issues multiple parallel tool calls touching **different** files (e.g. `write("file_a.bin", 5MB)` and `write("file_b.bin", 5MB)` in the same round):
1. The mutation queues for `file_a` and `file_b` execute concurrently.
2. Tool A reads current storage: `SUM(LENGTH(content)) = 0 MB`. 0 + 5 <= 8, write permitted.
3. Tool B reads current storage before Tool A commits: `SUM(LENGTH(content)) = 0 MB`. 0 + 5 <= 8, write permitted.
4. Both writes commit to SQLite. Total storage becomes 10 MB, violating the 8 MiB hard limit.

#### Remediation
In SQLite VFS, enforce the quota atomically using a SQL trigger or an atomic CTE/transaction check during the write statement:
```sql
INSERT INTO cadmus_tools_env_fs (scope, path, is_dir, content, updated_at)
SELECT ?, ?, 0, ?, ?
WHERE (
  SELECT COALESCE(SUM(LENGTH(content)), 0)
  FROM cadmus_tools_env_fs
  WHERE scope = ? AND path != ?
) + LENGTH(?) <= 8388608;
```
If `changes() === 0`, throw `new FileError("invalid", "Workspace storage quota exceeded (8 MiB limit)")`.

---

## Robustness Checklist

- [x] **Safe `conversationCreated` hook execution without transaction deadlocks**
  - Hook must interact strictly with raw `SqliteFamilyStore` tables and never invoke `tx.*` table reads, `harness.conversation()`, or `harness.commit()`.
  - Missing conversation mappings must be eliminated by inserting bot root conversations upon creation.
- [x] **Orphaned process prevention on daemon when DO disconnects**
  - Host daemon must attach listeners to WebSocket `close` and `error` events to immediately abort all active child execution trees and invoke `NodeExecutionEnv.cleanup()`.
  - DO must drain and reject all pending deferred promises upon `webSocketClose`.
- [x] **Reliable account default cache invalidation across DO instances**
  - `account.update` must execute distributed fan-out invalidation across all sibling Family DOs in the account.
  - Invalidation must eagerly scan inheriting bots, re-fingerprint scopes, reset reachability state, and synchronize DO alarms.
- [x] **Clean prompt generation during reachability status transitions**
  - Gating in `beforeTool` must enforce turn-initial reachability invariants to prevent contradictory transcripts where unavailable prompts precede successful tool results.
- [x] **Conflict resolution when multiple daemon sockets dial the same scope**
  - DO must enforce single-occupancy on daemon scope tags (`bot:<botId>` and `chat:<chatKey>`), closing previous sockets with code `1008` before accepting replacements.
  - `webSocketClose` must ignore closing events if a replacement socket for the same scope is already connected.

## Disposition (applied by Grok Build)

1. **Dual-socket collision and false-unreachable** — Already resolved. `execution-env.md` accepts one socket, then closes the previous one in the same turn (`1000`, `Superseded`). `reachability.md` writes `unreachable` only when no other socket for that tag is `OPEN`, ignoring the socket that just closed and any that are `CLOSING`. `sequencing.md` phase 3 tests the superseded close and the cleared-override close. Close code `1008` stays the policy/revoke code, not the replace code.
2. **In-flight exec and host process orphans** — Applied. Hibernation keeps the WebSocket, so the child keeps running. A real close (restart, deploy, drop, `Superseded`, unbind) aborts that socket's execs, readers, and watches via `context.abortSignal`. `NodeExecutionEnv.cleanup` runs only when no other live socket shares that instance, because one process may hold one socket per scope. A drop does not delete `.cadmus-ephemeral`. The DO already rejects that socket's pending frames. Docs: `execution-env.md`, `workspace-persistence.md`, `sequencing.md` (phase 3 work row and a `daemon/` test; workerd e2e stays on a scripted peer).
3. **Missing `cadmus_chat_conversations` row breaks bot root turns** — Already resolved. Step 2 returns `undefined` only when `tools_env_enabled = 0`. No row plus a known bot id is the bot root and uses the bot default (`execution-env.md`). `cadmus.search_bot` sets `cwd: null` and `tools: []` (`src/extensions/internal-tools.ts`), so it stops at step 1. A synthetic `chat_key: ''` row is not added.
4. **Unbounded harvest rows** — Already resolved. `executeHarvestFork` sets `tools_env_enabled = 0` before submit and `deleteConversationRoute` after `waitForIdle`, including when submit or the wait throws. A crash before that delete leaves a flag-0 row the callback treats as no env. Non-harvest fork rows stay, because a later turn still resolves the parent chat.
5. **`dueProbes()` never schedules a future alarm** — Already resolved. `syncDurableObjectAlarm` walks `listPendingProbes()` (`next_probe_at IS NOT NULL`, including future wakes). `alarm()` runs `listDueProbes(now)` only. The plan states that one method for both would skip future wakes or run probes early (`reachability.md`). — **Superseded (2026-10-21, Lior):** cloud-side probing removed; env reconnects proactively, heartbeat only while calls are in flight, connection state per env with generation CAS (reachability.md).
6. **Mid-turn reachability flapping** — Applied as a contract note. The identity section is a snapshot; the call reads status again in the `env` callback. A reconnect during the turn can succeed after `tools-env-unavailable`. A turn-initial `beforeTool` block is not added: decision 6 and `reachability.md` keep `bash` / `read` / `write` / `edit` on the agent so a chat whose own scope is `ready` still has them. Docs: `builtin-tools.md`, `reachability.md`.
7. **Ghost chat-override row after the override is cleared** — Already resolved. `chat.update` `{ toolsEnv: null }` closes `chat:<chatKey>` sockets in the same turn as the row delete (`binding-and-config.md`). `webSocketClose` inserts nothing unless the effective binding is still `local-daemon` and `last_error` is not `secret_missing` (`reachability.md`). Phase 3 asserts the chat row is gone after that close.
8. **`conversationCreated` deadlock** — Already resolved, and it matches pi-durable. The hook runs inside `ctx.storage.transaction` (`dist/session/transaction.js`). `tx` table reads throw `ReadAfterWrite`. Family-store `sql.exec` joins that transaction and does not take the session queue. The plan forbids `harness.commit`, `harness.conversation`, and `tx` reads (`execution-env.md`).
9. **Account-default cache across family DOs** — Already resolved. `account.update` fans `invalidateToolsEnvDefault()` to every family of the account, including the handler, the same way `bustAccountCredentialCaches` does (`binding-and-config.md`). `sequencing.md` phase 2 tests a second family.
10. **Parallel writes can pass the 8 MiB cap** — Already resolved. The cap check is the same synchronous write as the bytes, on SQLite and on the in-memory map, and replacement counts the new blob only (`workspace-persistence.md`). Phase 1 conformance requires two different paths whose sizes each fit and whose sum does not to stay at or under 8 MiB.
