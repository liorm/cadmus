# Review 02: Architectural Invariants and Two-Tier Storage Boundaries

## Objective
Evaluate the plan under [`docs/plans/tools-env/`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/) against Cadmus's core architectural invariants and storage rules as documented in [`AGENTS.md`](file:///home/developer/projects/pi-bot-hands/AGENTS.md) and [`docs/architecture/`](file:///home/developer/projects/pi-bot-hands/docs/architecture/).

> [!IMPORTANT]
> **Instructions for the Reviewer**:
> Do NOT implement any code. Audit the design against the established system invariants.
> Write all your findings, invariant violations, architectural risks, and concrete mitigation recommendations to `review-02-results.md` next to this file.

---

## Reference Documents
1. [`AGENTS.md`](file:///home/developer/projects/pi-bot-hands/AGENTS.md) (Section 1: Core Architectural Invariants)
2. [`docs/architecture/accounts-and-storage.md`](file:///home/developer/projects/pi-bot-hands/docs/architecture/accounts-and-storage.md) (Two-tier storage architecture, D1 vs DO SQLite)
3. [`docs/architecture/protocol-and-turns.md`](file:///home/developer/projects/pi-bot-hands/docs/architecture/protocol-and-turns.md) (Protocol frames, out-of-band status)
4. [`docs/architecture/schedules-alarms-and-bots.md`](file:///home/developer/projects/pi-bot-hands/docs/architecture/schedules-alarms-and-bots.md) (Unified alarms and tasks)
5. [`docs/plans/tools-env/README.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/README.md)
6. [`docs/plans/tools-env/workspace-persistence.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/workspace-persistence.md)
7. [`docs/plans/tools-env/binding-and-config.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/binding-and-config.md)

---

## Specific Invariants to Verify

### 1. Two-Tier Storage Partitioning
- **D1 (`AdminStore`) vs DO SQLite (`FamilyStore`)**:
  - Does the plan strictly place global, account-wide, and security credentials in D1 ([`D1AdminStore`](file:///home/developer/projects/pi-bot-hands/src/store/d1-admin.ts))?
    - `cadmus_accounts.default_tools_env_json`
    - `cadmus_tools_env_secrets`
  - Does the plan strictly place all family-, bot-, and chat-scoped state inside the DO SQLite ([`SqliteFamilyStore`](file:///home/developer/projects/pi-bot-hands/src/store/sqlite-family.ts))?
    - `cadmus_bots.tools_env_json`
    - `cadmus_chats.tools_env_json`
    - `cadmus_tools_env_state`
    - `cadmus_tools_env_fs`
    - `cadmus_chat_conversations`
  - Verify that the DO never queries D1 during tool execution or turns (`createExecutionEnv` must not perform D1 queries or AES-GCM decryptions).

### 2. Zero `pi-durable` Session Doc for Domain Entities
- Verify Invariant #2 from [`AGENTS.md`](file:///home/developer/projects/pi-bot-hands/AGENTS.md):
  - Do `cadmus_tools_env_fs` (the virtual workspace), `cadmus_tools_env_state` (reachability), and `cadmus_chat_conversations` bypass `pi-durable` `defineDoc`?
  - Confirm that `pi-durable` session tables (`cadmus_pi_*`) remain exclusively used for conversation history, turn execution, and durable task steps.

### 3. Cloudflare Account Prefixing & Naming
- Verify Invariant #1 from [`AGENTS.md`](file:///home/developer/projects/pi-bot-hands/AGENTS.md):
  - Are all new tables prefixed with `cadmus_`?
  - Does reverse WebSocket routing preserve the deterministic DO name: `cadmus:${accountId}:${familyId}`?
  - Are bindings and DO classes named in accordance with `CADMUS_` conventions?

### 4. Out-of-Band `/status` Handling
- Verify Invariant #3 from [`AGENTS.md`](file:///home/developer/projects/pi-bot-hands/AGENTS.md):
  - Does the addition of `toolsEnv` status to `handleOutOfBandStatus` strictly execute out-of-band before `conversation.submit()`?
  - Does `/status` avoid appending transcript entries or consuming LLM turn tokens?

### 5. Unified Alarm Driver & Probing Mechanism
- Verify Invariant #4 from [`AGENTS.md`](file:///home/developer/projects/pi-bot-hands/AGENTS.md):
  - Does the plan avoid introducing a separate Worker cron or second alarm mechanism?
  - Are due probes integrated directly into [`syncDurableObjectAlarm`](file:///home/developer/projects/pi-bot-hands/src/alarms.ts) and [`CadmusBotFamilyDO.alarm`](file:///home/developer/projects/pi-bot-hands/src/family-do.ts)?
  - Confirm that reachability probes never invoke `conv.submit()` or wake the bot persona.

### 6. Standalone TUI Boundary
- Verify Invariant #5 from [`AGENTS.md`](file:///home/developer/projects/pi-bot-hands/AGENTS.md):
  - Does [`tui/`](file:///home/developer/projects/pi-bot-hands/tui/) remain strictly independent, importing only `import type` from `src/protocol.ts`?
  - Are new commands or UI updates in TUI implemented without runtime cross-imports into `src/`?

### 7. Idempotent Replay Safety (`replay: "safe"`)
- Verify Invariant #6 from [`AGENTS.md`](file:///home/developer/projects/pi-bot-hands/AGENTS.md):
  - Upstream `CodingTools` (`bash`, `read`, `write`, `edit`) are not declared `replay: "safe"` and must not be wrapped with `api.memo`. Check that the plan explicitly preserves this and does not add unintended replay memos.
  - Check that mutating Cadmus tools (e.g. `create_bot` accepting `toolsEnv`) retain their existing `api.memo` calls.

### 8. Structured Logging Invariant
- Verify Invariant #7 from [`AGENTS.md`](file:///home/developer/projects/pi-bot-hands/AGENTS.md):
  - Check that logging in all new components ([`src/tools-env/`](file:///home/developer/projects/pi-bot-hands/src/tools-env/), DO transport, alarm probes) uses [`getLogger()`](file:///home/developer/projects/pi-bot-hands/src/log.ts) with `familyFields` / `chatFields`.
  - Confirm zero use of `console.log`, `console.warn`, or `console.error`.

---

## Output Format
Save results to `review-02-results.md` next to this file, structured as follows:
```markdown
# Review 02 Results: Architectural Invariants and Two-Tier Storage Boundaries

## Executive Summary
[Assessment of compliance with Cadmus invariants]

## Invariant Violations & Architectural Risks
- **Invariant**: [e.g. Two-Tier Storage / Zero Session Doc / Out-of-band / etc.]
  - **Plan Reference**: [Citation]
  - **Violation / Risk**: [Detailed explanation]
  - **Remediation**: [How to fix the plan to strictly satisfy the invariant]

## Storage Layer Audit
- **D1 Schema & Query Audit**: [Evaluation]
- **DO SQLite Schema & Lock Audit**: [Evaluation]
- **pi-durable Session Boundary Audit**: [Evaluation]

## Invariant Compliance Checklist
- [ ] Invariant 1: Shared Cloudflare Account Prefixing
- [ ] Invariant 2: Two-Tier Storage (No session Docs for domain state)
- [ ] Invariant 3: Out-of-Band /status Only
- [ ] Invariant 4: Unified Schedule & DO Alarm Driver (No cron)
- [ ] Invariant 5: Standalone TUI Package Isolation
- [ ] Invariant 6: Idempotent Replay Safety
- [ ] Invariant 7: Structured Logging Only (Zero console.*)
```
