# Review 01: Cross-Document Inconsistencies and Mismatches

## Objective
Thoroughly inspect all design and specification documents under [`docs/plans/tools-env/`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/) to detect any discrepancies, conflicting details, naming mismatches, schema divergences, or conflicting assumptions between the plan files.

> [!IMPORTANT]
> **Instructions for the Reviewer**:
> Do NOT implement any code. Conduct a rigorous, critical review of the plan documents against one another.
> Write all your findings, conflicts, ambiguities, and concrete resolution recommendations to `review-01-results.md` next to this file.

---

## Documents to Compare and Cross-Check
Inspect and cross-reference every document in the plan:
1. [`docs/plans/tools-env/README.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/README.md) (Index, Goals, Non-Goals, Decisions 1–12, Where state lives)
2. [`docs/plans/tools-env/execution-env.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/execution-env.md) (`env` callback, `EnvTarget.cwd`, `ExecutionEnv.id`, wire protocol, transport routing)
3. [`docs/plans/tools-env/builtin-tools.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/builtin-tools.md) (`CodingTools` install, tool gate, identity prompt sections, limits)
4. [`docs/plans/tools-env/reachability.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/reachability.md) (State machine, error classification, DO alarm driver, probe ladders)
5. [`docs/plans/tools-env/workspace-persistence.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/workspace-persistence.md) (Persistence flags, SQLite VFS cap, knowledge separation)
6. [`docs/plans/tools-env/binding-and-config.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/binding-and-config.md) (Config schemas, secrets in D1, protocol RPCs, UI flow)
7. [`docs/plans/tools-env/sequencing.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/sequencing.md) (Phases 1–3, conformance testing, e2e test plan)

---

## Specific Areas and Questions to Check

### 1. Database Schemas and Column Names
Compare the SQL table definitions across all documents:
- **`cadmus_tools_env_state`**:
  - Compare the schema definition in [`reachability.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/reachability.md) with mentions in [`README.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/README.md), [`binding-and-config.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/binding-and-config.md), and [`sequencing.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/sequencing.md).
  - Are column names (`scope`, `bot_id`, `binding_fp`, `status`, `last_error`, `last_change_at`, `next_probe_at`, `probe_attempt`) identically named and typed everywhere?
- **`cadmus_chat_conversations`**:
  - Compare definition in [`execution-env.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/execution-env.md) (`conversation_id`, `chat_key`, `bot_id`, `tools_env`) with usage in [`README.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/README.md), [`workspace-persistence.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/workspace-persistence.md), and [`sequencing.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/sequencing.md).
- **`cadmus_tools_env_fs`**:
  - Compare schema in [`workspace-persistence.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/workspace-persistence.md) (`scope`, `path`, `is_dir`, `content`, `updated_at`) with mentions in [`README.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/README.md) and [`execution-env.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/execution-env.md).
- **`cadmus_tools_env_secrets`**:
  - Compare definition in [`binding-and-config.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/binding-and-config.md) (`account_id`, `secret_id`, `label`, `kind`, `token_hash`, `iv_hex`, `cipher_hex`, `updated_at`) with descriptions in [`README.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/README.md) and [`execution-env.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/execution-env.md).
- **Altered existing tables**:
  - `cadmus_bots.tools_env_json` vs `cadmus_chats.tools_env_json` vs `cadmus_accounts.default_tools_env_json`. Are nullability and default values consistent?

### 2. Method Signatures and Interface Contracts
- Check `createExecutionEnv`:
  - [`execution-env.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/execution-env.md) mentions `createExecutionEnv(binding, deps)` and `createExecutionEnv(binding, scope)`. Are arguments and dependencies specified consistently?
- Check `FamilyStore` / `AdminStore` facet methods:
  - Compare methods described in [`reachability.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/reachability.md) (`getState`, `setState`, `dueProbes`) with those in [`binding-and-config.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/binding-and-config.md) and [`sequencing.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/sequencing.md).
  - Compare `AdminStore` methods in [`binding-and-config.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/binding-and-config.md) (`listToolsEnvSecrets`, `setToolsEnvSecret`, `getToolsEnvSecret`, `deleteToolsEnvSecret`, `resolveToolsEnvDaemonToken`) with [`README.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/README.md) and [`execution-env.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/execution-env.md).

### 3. Decisions Alignment
Cross-check Decisions 1 through 12 in [`README.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/README.md) against the sub-documents:
- Decision 1 (reachability, alarm recovery, disconnected daemon 3-probe limit) $\leftrightarrow$ [`reachability.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/reachability.md).
- Decision 4 & 5 (bot pin, chat override, scoping `bot:<id>` vs `chat:<key>`) $\leftrightarrow$ [`binding-and-config.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/binding-and-config.md) & [`execution-env.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/execution-env.md).
- Decision 6 (identity sections `tools-env` and `tools-env-unavailable`) $\leftrightarrow$ [`builtin-tools.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/builtin-tools.md).
- Decision 7 (8 MiB SQLite VFS cap) $\leftrightarrow$ [`workspace-persistence.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/workspace-persistence.md).
- Decision 8 (daemon account pairing vs one WS per scope) $\leftrightarrow$ [`execution-env.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/execution-env.md) & [`binding-and-config.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/binding-and-config.md).
- Decision 9 (5s default timeout for just-bash) $\leftrightarrow$ [`builtin-tools.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/builtin-tools.md) & [`execution-env.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/execution-env.md).
- Decision 11 (Harvest forks get no env) $\leftrightarrow$ [`execution-env.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/execution-env.md) & [`builtin-tools.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/builtin-tools.md).

### 4. Protocol Types, Commands, and Events
- Check `ToolsEnvBinding` union schema:
  - Compare TypeBox definition in [`binding-and-config.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/binding-and-config.md) with descriptions in [`README.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/README.md), [`execution-env.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/execution-env.md), and [`workspace-persistence.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/workspace-persistence.md).
- Check `tools-env.reachability` event frame:
  - Compare payload fields in [`reachability.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/reachability.md) (`botId`, `chatKey`, `scope`, `status`, `kind`, `lastError`, `nextProbeAt`, `when`) with references in [`binding-and-config.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/binding-and-config.md) and [`builtin-tools.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/builtin-tools.md).

### 5. Constants, Limits, and Identifiers
- `ExecutionEnv.id` formats:
  - Verify that `just-bash:<familyId>:bot:<botId>`, `just-bash:<familyId>:chat:<chatKey>`, and `daemon:<secretId>:<workspacePath>` match across [`execution-env.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/execution-env.md), [`workspace-persistence.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/workspace-persistence.md), and [`sequencing.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/sequencing.md).
- Backoff delay ladders:
  - Check the regular ladder (5s, 15s, 30s, 60s, 120s, 300s) and disconnected ladder (300s x 3, then stop) between [`reachability.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/reachability.md) and [`sequencing.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/sequencing.md).

---

## Output Format
Save results to `review-01-results.md` next to this file, structured as follows:
```markdown
# Review 01 Results: Cross-Document Inconsistencies and Mismatches

## Executive Summary
[High-level evaluation of cross-document consistency]

## Critical Mismatches (Blockers / Conflicting Specs)
- **Issue**: [Description]
  - **Document A**: [Quote / Citation]
  - **Document B**: [Quote / Citation]
  - **Impact**: [Why this breaks implementation]
  - **Proposed Fix**: [Concrete recommended resolution]

## Major Discrepancies (Terminology / API Signature Gaps)
...

## Minor Inconsistencies (Typographical / Non-functional Divergences)
...

## Checklist of Documents Verified
- [ ] README.md vs execution-env.md
- [ ] README.md vs builtin-tools.md
- [ ] README.md vs reachability.md
- [ ] README.md vs workspace-persistence.md
- [ ] README.md vs binding-and-config.md
- [ ] README.md vs sequencing.md
- [ ] execution-env.md vs reachability.md
- [ ] execution-env.md vs binding-and-config.md
- [ ] reachability.md vs sequencing.md
```
