# Review 07: Implementation Logic, Edge Cases and Operational Failure Modes

## Objective
Evaluate the plan under [`docs/plans/tools-env/`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/) for subtle logic flaws, race conditions, edge cases, lifecycle traps, and operational failure modes.

> [!IMPORTANT]
> **Instructions for the Reviewer**:
> Do NOT implement any code. Search deeply for unhandled runtime paths, concurrency anomalies, deadlock hazards, and logical flaws.
> Write all your findings, edge-case scenarios, race conditions, and concrete remediation recommendations to `review-07-results.md` next to this file.

---

## Reference Code & Specifications
1. [`docs/plans/tools-env/execution-env.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/execution-env.md)
2. [`docs/plans/tools-env/builtin-tools.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/builtin-tools.md)
3. [`docs/plans/tools-env/reachability.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/reachability.md)
4. [`docs/plans/tools-env/workspace-persistence.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/workspace-persistence.md)
5. [`docs/plans/tools-env/binding-and-config.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/binding-and-config.md)
6. [`src/family-do.ts`](file:///home/developer/projects/pi-bot-hands/src/family-do.ts)
7. [`src/schedules.ts`](file:///home/developer/projects/pi-bot-hands/src/schedules.ts)

---

## Specific Areas and Questions to Check

### 1. Conversation Mapping & Fork Tracking (`cadmus_chat_conversations`)
The `env` callback maps `target.conversationId` $\rightarrow$ chat via `cadmus_chat_conversations`:
- `createChatInternal` inserts the chat's root conversation ID with `tools_env = 1`.
- `HarnessOptions.conversationCreated` copies the parent's `chat_key`, `bot_id`, and `tools_env` onto the child ID.
- `executeHarvestFork` explicitly sets `tools_env = 0` on the child conversation ID before submitting the turn.
- *Audit*:
  - **Deadlock / Read-After-Write Risk**: The plan notes that `conversationCreated` runs inside the creating commit in pi-durable. Does writing to `cadmus_chat_conversations` inside this hook risk SQLite transaction contention or ordering locks with `pi-durable`'s own storage?
  - **Fork Timing Race**: What happens if `executeHarvestFork` forks a conversation, but a turn begins before `tools_env = 0` is updated?
  - **Missing Rows**: What happens if a conversation ID is not found in `cadmus_chat_conversations` (e.g. the bot root conversation, or an unmapped internal task)? The plan says it returns `undefined`. Is this behavior correct for bot root turns?

### 2. DO Hibernation & Asynchronous In-Flight Commands
- Cloudflare Durable Objects hibernate when idle and can be restarted / evicted:
- *Audit*:
  - What happens if an `exec` command is currently running on the daemon when the DO hibernates or restarts?
  - The plan states that `CodingTools` are **not** declared `replay: "safe"` (so a turn crash becomes an `interrupted` result). Does the daemon continue running the child process as an orphan on the owner machine?
  - Does the daemon handle WebSocket connection drops by killing active child processes?

### 3. Dynamic Account Default Invalidation & Cache Consistency
- `AccountRecord.defaultToolsEnv` is stored in D1.
- The DO caches the account default JSON to avoid D1 queries on the hot path.
- *Audit*:
  - How is this DO cache invalidated when an operator updates `defaultToolsEnv` via `account.update`?
  - The plan mentions `/__internal/credentials/invalidate`. Does changing the account default trigger an invalidation call across all active Family DOs belonging to that account?
  - If a bot inherits the account default, and that default changes from `just-bash` to `local-daemon`, what happens to existing reachability rows and SQLite VFS rows?

### 4. Prompt Section Race Conditions & Identity Flapping
- Prompt rendering evaluates `tools-env` vs `tools-env-unavailable` at the start of a turn:
- *Audit*:
  - What happens if the tools-env scope is `ready` when the prompt renders, but the daemon disconnects before the model outputs a `bash` tool call?
  - What happens if the scope is `unreachable` when the prompt renders (showing `tools-env-unavailable`), but the daemon reconnects mid-turn?
  - If the model calls `bash` while the prompt displayed `tools-env-unavailable`, does the execution succeed, fail, or cause confusing conversational state?

### 5. Multi-Client & Multi-Family Daemon Concurrency
- Decision 8 states: "One account pairing may be associated with many bots, including bots in different families. The daemon still opens one `/tools-env/ws` per `local-daemon` scope."
- *Audit*:
  - If a daemon script connects to 5 different bots across 2 families, it opens 5 separate WebSockets.
  - Can two daemons dial in with the same token and scope simultaneously? What happens if a second daemon connects to an already-open `bot:<botId>` socket? Does the DO drop the old socket or reject the new one?

---

## Output Format
Save results to `review-07-results.md` next to this file, structured as follows:
```markdown
# Review 07 Results: Implementation Logic, Edge Cases and Operational Failure Modes

## Executive Summary
[Assessment of edge cases, race conditions, and concurrency resilience]

## Logic Flaws & Race Conditions
- **Issue**: [Description]
  - **Severity**: [High / Medium / Low]
  - **Plan Reference**: [Citation]
  - **Failure Scenario**: [Concrete walkthrough of events]
  - **Remediation**: [Exact algorithmic or design fix]

## Concurrency & Lifecycle Edge Cases
[Deep dive on DO hibernation, fork races, cache invalidation, and multiple sockets]

## Robustness Checklist
- [ ] Safe conversationCreated hook execution without transaction deadlocks
- [ ] Orphaned process prevention on daemon when DO disconnects
- [ ] Reliable account default cache invalidation across DO instances
- [ ] Clean prompt generation during reachability status transitions
- [ ] Conflict resolution when multiple daemon sockets dial the same scope
```
