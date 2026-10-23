# Review 05: Multi-Scope Precedence and Workspace Persistence

## Objective
Evaluate the 3-tier configuration resolution hierarchy, scope isolation rules, workspace persistence mechanisms, and the knowledge boundary as specified in [`docs/plans/tools-env/binding-and-config.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/binding-and-config.md) and [`docs/plans/tools-env/workspace-persistence.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/workspace-persistence.md).

> [!IMPORTANT]
> **Instructions for the Reviewer**:
> Do NOT implement any code. Audit the scoping rules, configuration precedence, storage isolation, and lifecycle cleanup logic.
> Write all your findings, scope collision risks, persistence leakages, and concrete recommendations to `review-05-results.md` next to this file.

---

## Reference Code & Specifications
1. [`docs/plans/tools-env/binding-and-config.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/binding-and-config.md)
2. [`docs/plans/tools-env/workspace-persistence.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/workspace-persistence.md)
3. [`src/store/sqlite-family.ts`](file:///home/developer/projects/pi-bot-hands/src/store/sqlite-family.ts) (`SqliteBotStore.deleteBot`, `ChatStore.deleteChat`)
4. [`src/extensions/knowledge-tools.ts`](file:///home/developer/projects/pi-bot-hands/src/extensions/knowledge-tools.ts)
5. [`src/schedules.ts`](file:///home/developer/projects/pi-bot-hands/src/schedules.ts) (`executeHarvestFork`)

---

## Specific Areas and Questions to Check

### 1. The 3-Tier Precedence Hierarchy
- Resolution order:
  $$\text{Chat override } (\text{if set}) \longrightarrow \text{Bot pin } (\text{if set}) \longrightarrow \text{Account default } (\text{if set}) \longrightarrow \text{Unbound}$$
- *Audit*:
  - What is the exact semantic difference between `toolsEnv: undefined` vs `toolsEnv: null` on a chat or bot?
  - Does setting `toolsEnv: null` on a chat always fall back to the bot pin?
  - Can an operator configure a chat to be explicitly "unbound" if the bot has an active tools-env default? (The plan claims in Non-Goals: "A binding that means 'no env' while a higher level has one is a non-goal"). Evaluate whether this design limitation creates usability or operational issues.

### 2. Scope Identifiers & Key Formatting
- Scope keys are:
  - `bot:<botId>`
  - `chat:<chatKey>`
- *Audit*:
  - In Cadmus, chat keys are generated as `${bot.id}:${uuid}` in `createChatInternal`, meaning chat keys contain colons.
  - Does the plan safely parse scope strings using strict prefix slicing (`scope.startsWith("bot:")` vs `scope.startsWith("chat:")`) rather than `scope.split(":")`?
  - Does any part of the plan confuse `botId` with `chatKey`?

### 3. Workspace Persistence Modes & Isolation
- **`just-bash` Modes**:
  - `persist: true`: Stored in DO SQLite table `cadmus_tools_env_fs` keyed by `(scope, path)`. Survives DO restarts and isolate eviction.
  - `persist: false`: Stored in an in-memory Map in the DO isolate. Dropped on isolate eviction or restart.
  - *Audit*: What happens when an operator toggles `persist` between `true` and `false` on an existing binding? The plan states: "delete the store the new mode does not use... so the two stores never alias one id." Is this transition atomic and safe against concurrent tool calls?
- **Scope Isolation**:
  - Inheriting chats share `bot:<botId>`.
  - Overriding chats have `chat:<chatKey>`.
  - *Audit*: Verify that an overriding chat can never read, modify, or list files belonging to the bot default VFS or sibling chats.

### 4. Quota Enforcement & Storage Sizing
- Persisted VFS in `cadmus_tools_env_fs` has an 8 MiB cap per scope.
- *Audit*:
  - How is the 8 MiB limit calculated? (e.g. `SUM(LENGTH(content))` vs row overhead).
  - Are directory rows or empty files counted against the 8 MiB?
  - What happens when a `write` or `edit` exceeds 8 MiB? The plan specifies returning `FileError` code `invalid`, leaving status `ready`. Confirm whether `FileError` `invalid` is properly handled by pi-durable's `write` and `edit` tools.

### 5. Deletion & Cleanup Lifecycles
- *Audit cleanup behavior on*:
  1. `chat.close` / `chat.reset`: Should scratch files be preserved or deleted?
  2. `chat.delete`: Does it delete rows in `cadmus_tools_env_fs`, `cadmus_tools_env_state`, and `cadmus_chat_conversations` for `chat:<chatKey>`?
  3. `bot.delete`: Does `SqliteBotStore.deleteBot` cleanly drop all bot-scoped rows and all chat-override rows associated with that `bot_id`?
  4. Ephemeral daemon directories (`.cadmus-ephemeral`): When is `cleanup()` called, and what happens if a daemon disconnects before cleanup completes?

### 6. Strict Separation from Knowledge Store
- Virtual files (`SOUL.md`, `MEMORY.md`, `knowledge/<slug>.md`) live in `cadmus_bot_*` tables.
- *Audit*:
  - Confirm that no tool or hook exists to auto-sync, auto-promote, or mount scratch workspace files into knowledge.
  - Confirm that the `tools-env` prompt identity section explicitly instructs the model to use `knowledge_*` and `memory_*` tools for persistent memory.

---

## Output Format
Save results to `review-05-results.md` next to this file, structured as follows:
```markdown
# Review 05 Results: Multi-Scope Precedence and Workspace Persistence

## Executive Summary
[Assessment of scoping correctness, storage isolation, and lifecycle safety]

## Scope & Persistence Logic Gaps
- **Issue**: [Description]
  - **Plan Reference**: [Citation]
  - **Risk**: [Data leakage, stale state, or quota bypass]
  - **Remediation**: [Exact proposed mechanism]

## Workspace Lifecycle Audit
[Evaluation of bind, unbind, toggle persist, chat delete, and bot delete]

## Scoping & Persistence Checklist
- [ ] 3-tier precedence logic and null vs undefined handling
- [ ] Safe parsing of colon-separated chat keys in scopes
- [ ] Isolation between inheriting chats and chat overrides
- [ ] 8 MiB VFS quota enforcement and error response
- [ ] Atomic store deletion on persist mode toggling
- [ ] Cascading deletion on bot.delete and chat.delete
- [ ] Zero knowledge store leakage or promotion hooks
```
