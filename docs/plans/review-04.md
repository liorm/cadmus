# Review 04: Reachability State Machine and DO Hardware Alarm Probing

## Objective
Evaluate the reachability state machine, transport vs. application error classification, backoff algorithms, and DO hardware alarm integration as specified in [`docs/plans/tools-env/reachability.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/reachability.md) and [`docs/plans/tools-env/execution-env.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/execution-env.md).

> [!IMPORTANT]
> **Instructions for the Reviewer**:
> Do NOT implement any code. Rigorously evaluate the reachability state machine, error taxonomy, backoff mechanics, and alarm synchronization logic.
> Write all your findings, edge-case vulnerabilities, alarm desynchronization risks, and concrete mitigation recommendations to `review-04-results.md` next to this file.

---

## Reference Code & Specifications
1. [`docs/plans/tools-env/reachability.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/reachability.md)
2. [`docs/plans/tools-env/execution-env.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/execution-env.md)
3. [`src/alarms.ts`](file:///home/developer/projects/pi-bot-hands/src/alarms.ts) (`syncDurableObjectAlarm`, `scheduledWakeTime`)
4. [`src/family-do.ts`](file:///home/developer/projects/pi-bot-hands/src/family-do.ts) (`alarm()`, `syncAlarmInternal`)
5. [`src/context.ts`](file:///home/developer/projects/pi-bot-hands/src/context.ts) (`CadmusServices.syncAlarm`)

---

## Specific Areas and Questions to Check

### 1. State Machine & Scoping
- **States**: `unbound`, `ready`, `unreachable`.
- **Per-Scope Isolation**:
  - Scopes are `bot:<botId>` (the default) or `chat:<chatKey>` (chat override).
  - Inheriting chats do NOT have their own row; they query `bot:<botId>`.
  - *Audit*: Can a state update to a chat override scope accidentally mutate or invalidate the bot-level default scope?
  - *Audit*: When a chat override is deleted via `chat.update { toolsEnv: null }`, does deleting the `chat:<chatKey>` row cleanly restore inheritance without leaving stale alarm probe timers?

### 2. Transport vs. Application Error Taxonomy
The plan draws a strict line between transport failures and application-level errors:
- **Transport Errors** (trigger `unreachable` + arm probe + broadcast event):
  - Environment construction failure / VFS open error.
  - WebSocket drop (`webSocketClose` on `tools-env-daemon` socket).
  - RPC timeout with no peer reply (`shell_unavailable` / `FileError` `unknown` with prefix `"tools-env transport:"`).
- **Application Errors** (remain `ready` + no status change + no probe):
  - Command non-zero exit code (e.g. exit code 1 or 127).
  - Command execution timeout (`ExecutionError` code `timeout`).
  - Missing command or empty argv (`spawn_error`).
  - Missing file or directory (`FileError` code `not_found`).
  - Write exceeding VFS cap (`FileError` code `invalid`).
- *Audit*:
  - Are there edge cases where an application error could be misclassified as a transport error? (e.g. a daemon returning an unformatted error string or throwing an uncaught exception).
  - Is the `"tools-env transport:"` message prefix check robust against localization or upstream formatting changes in `FileError`?

### 3. Alarm Multiplexing & Probing Without LLM Turn
- In [`src/alarms.ts`](file:///home/developer/projects/pi-bot-hands/src/alarms.ts), `syncDurableObjectAlarm` evaluates the earliest wake time among:
  1. `harness.inspect(BACKGROUND_CONTEXT)`
  2. Enabled rows in `cadmus_schedules`
  3. **(new)** Due probes from `familyStore.toolsEnv.dueProbes()`
- *Audit*:
  - When `alarm()` fires, `probeUnreachableToolsEnvs(now)` runs inline before draining schedules.
  - Does the probe frame (`{ method: "probe" }`) or in-isolate `stat(cwd)` completely bypass `conv.submit()`?
  - Does a successful or failed probe avoid creating any entries in `cadmus_pi_*` or emitting LLM tokens?

### 4. Backoff Ladders & Disconnected Daemon Policy
- **Connected / In-isolate Ladder**:
  - 5s $\rightarrow$ 15s $\rightarrow$ 30s $\rightarrow$ 60s $\rightarrow$ 120s $\rightarrow$ 300s (with $\pm 10\%$ jitter).
- **Disconnected Daemon Ladder**:
  - 300s $\times 3$ attempts, then **stop** (`next_probe_at = NULL`).
  - Reconnect is the primary recovery mechanism: daemon WebSocket upgrade sets `ready` immediately and clears `next_probe_at`.
- *Audit*:
  - What happens if a laptop lid is closed for 2 days? Does the DO alarm wake up indefinitely, or does it strictly stop after 3 attempts?
  - If a daemon reconnects while an alarm is already scheduled for that scope, does `syncAlarmInternal()` cancel or advance the alarm cleanly?
  - What happens if a reconnect occurs *during* the execution of an alarm probe?

### 5. Mandatory Alarm Synchronization Call Sites
- The plan states that **every** transition setting or clearing `next_probe_at` must await `syncAlarmInternal()` / `services.syncAlarm()`.
- *Audit*:
  - Check the list of transitions: env wrapper transport error, `webSocketClose`, daemon WS upgrade, `bot.update`, `chat.update`, `bot.delete`, `chat.delete`, secret deletion.
  - Are there any code paths where `next_probe_at` is modified in SQLite but `syncAlarm` is not called, leaving the DO hardware alarm desynchronized?

---

## Output Format
Save results to `review-04-results.md` next to this file, structured as follows:
```markdown
# Review 04 Results: Reachability State Machine and DO Hardware Alarm Probing

## Executive Summary
[Assessment of the state machine, error taxonomy, and alarm probing reliability]

## State Machine & Alarm Logic Gaps
- **Issue**: [Description]
  - **Plan Reference**: [Citation]
  - **Scenario / Risk**: [Concrete walkthrough of failure mode]
  - **Remediation**: [Exact proposed algorithm or rule change]

## Error Taxonomy Verification
[Detailed analysis of transport vs. application error classification]

## Alarm Synchronization Checklist
- [ ] Isolation of chat overrides from bot-default scopes
- [ ] Clean deletion of probe rows on unbind/delete
- [ ] No persona wake / conv.submit during probes
- [ ] 3-attempt cap for disconnected daemon
- [ ] Reconnect race conditions and alarm clearing
- [ ] Completeness of syncAlarm call sites
```
