# [TEMPORARY] E2E Test Coverage Gaps & 85% Target Handoff

> [!NOTE]
> **Status:** Temporary / In-Progress planning document.
> **Target:** Bring end-to-end test coverage to $\ge 85\%$ across `@cadmus/worker` and `@cadmus/contract`.

---

## 1. Baseline Summary

As of November 2026, running `bun run coverage` executes all 15 E2E test suites inside `workerd` with V8 coverage collection:

| Package | Lines | Statements | Functions | Branches |
| :--- | :---: | :---: | :---: | :---: |
| **`@cadmus/worker`** | **66.80%** (4,357 / 6,522) | **64.74%** (4,602 / 7,108) | **69.63%** (846 / 1,215) | **56.49%** (2,962 / 5,243) |
| **`@cadmus/contract`** | **58.45%** (218 / 373) | **56.20%** (222 / 395) | **25.00%** (10 / 40) | **9.35%** (13 / 139) |
| **Combined** | **66.35%** (4,575 / 6,895) | **64.29%** (4,824 / 7,503) | **68.20%** (856 / 1,255) | **55.27%** (2,975 / 5,382) |

### Goal
* **Target Line Coverage:** $\ge 85\%$ on `@cadmus/worker` ($\ge 5,544$ covered lines).
* **Deficit:** **+1,187 lines** needed.

---

## 2. Running Coverage

```bash
# Run full E2E suite with coverage reporting
bun run coverage

# View generated HTML report in browser
open coverage/index.html

UI flow coverage (`@cadmus/web-app`) uses the same reporters and no threshold. `bun run coverage:web-app` instruments the Vite build (`CADMUS_COVERAGE=1`) and writes `coverage/web-app` (`text`, `json-summary`, `html`). CI's ui job sets `CADMUS_COVERAGE=1` on the existing flow run. The default `web-app:build` stays uninstrumented.
```

---

## 3. High-Deficit Subsystems & Line Counts

| Subsystem / File | Covered / Total Lines | Current % | Uncovered Lines | Priority |
| :--- | :---: | :---: | :---: | :---: |
| `packages/worker/src/tools-env/namespace.ts` | 193 / 632 | 30.5% | **439** | P0 |
| `packages/worker/src/family-do.ts` | 1,080 / 1,339 | 80.7% | **259** | P0 |
| `packages/worker/src/tools-env/env-do.ts` | 237 / 366 | 64.8% | **129** | P0 |
| `packages/worker/src/models.ts` | 221 / 357 | 61.9% | **136** | P1 |
| `packages/worker/src/tools-env/wire-env.ts` | 0 / 114 | 0.0% | **114** | P1 |
| `packages/worker/src/oauth.ts` | 36 / 143 | 25.2% | **107** | P1 |
| `packages/worker/src/extensions/schedules-tools.ts` | 19 / 120 | 15.8% | **101** | P1 |
| `packages/worker/src/group-chat/drive.ts` | 130 / 204 | 63.7% | **74** | P1 |
| `packages/worker/src/store/d1-admin.ts` | 277 / 349 | 79.4% | **72** | P2 |
| `packages/worker/src/tools-env/ws-backend.ts` | 190 / 260 | 73.1% | **70** | P2 |
| `packages/worker/src/schedules.ts` | 107 / 174 | 61.5% | **67** | P2 |
| `packages/worker/src/extensions/internal-tools.ts` | 134 / 193 | 69.4% | **59** | P2 |
| `packages/worker/src/tools-env/proxy-env.ts` | 55 / 113 | 48.7% | **58** | P2 |
| `packages/worker/src/tools-env/wire.ts` | 80 / 126 | 63.5% | **46** | P2 |
| `packages/worker/src/store/sqlite-family.ts` | 330 / 375 | 88.0% | **45** | P2 |
| `packages/worker/src/extensions/knowledge-tools.ts` | 44 / 81 | 54.3% | **37** | P2 |

---

## 4. Prioritized User Flows to Implement in `e2e/`

### Priority 0: Confinement & Tools Environment Flows (~500+ lines)
*Target Files:* [`packages/worker/src/tools-env/namespace.ts`](file:///Users/developer/projects/pi-bot/packages/worker/src/tools-env/namespace.ts), [`packages/worker/src/tools-env/env-do.ts`](file:///Users/developer/projects/pi-bot/packages/worker/src/tools-env/env-do.ts)

1. **Storage Quota Enforcement (Unhappy Flow)**:
   * Action: Exceed the 8 MiB `NAMESPACE_BYTE_CAP` via confinement command execution (e.g., generating large file).
   * Verify: `CapError` is caught, mapped to `{ code: "invalid", message: "ENOSPC: namespace byte limit exceeded" }` without crashing the isolate.
2. **Path Traversal & Filesystem Edge Errors (Unhappy Flows)**:
   * Read directory as file: verify `EISDIR` $\rightarrow$ `is_directory`.
   * Access path through file: verify `ENOTDIR` $\rightarrow$ `not_directory`.
   * Nonexistent file read: verify `ENOENT` $\rightarrow$ `not_found`.
   * Invalid file creation / collisions: verify `invalid`.
3. **File Watching & Buffer Overflow**:
   * Subscribe to directory watch via `tools.watch`.
   * Trigger filesystem mutations, verify change events received over event channel.
   * Overflow watcher event buffer: verify `{ overflow: true }` event.
   * Unsubscribe via `tools.unwatch`.
4. **Command Execution Cancellation & Abort**:
   * Execute long command (`sleep 10`) with `AbortController`.
   * Send abort signal mid-turn: verify command terminates cleanly, partial output preserved, process state cleaned up.
5. **Heartbeat Timeout & Session Termination**:
   * Inactive environment exceeding `CADMUS_HEARTBEAT_MS` transitions to disconnected.

---

### Priority 0: Turn Queueing, Interruption & Virtual Files (~260 lines)
*Target Files:* [`packages/worker/src/family-do.ts`](file:///Users/developer/projects/pi-bot/packages/worker/src/family-do.ts)

1. **Turn Queueing Modes**:
   * While a turn is in flight:
     * Mode `reject`: verify immediate conflict error `{ code: "turn_in_progress" }`.
     * Mode `queue`: verify turn is appended to queue and processed sequentially.
     * Mode `steer`: verify steering text is appended to turn guidance context.
2. **Turn Abort & Interruption (`turn.abort`, `turn.interrupt`)**:
   * Send `turn.abort` during generation.
   * Verify turn finishes with aborted state; subsequent turn on the same chat succeeds with intact transcript.
3. **Virtual File Knowledge Operations**:
   * **Frontmatter Parsing (Happy)**: `file.write` to `knowledge/<slug>.md` with frontmatter (`description`, `category`) $\rightarrow$ parsed into metadata.
   * **Missing Description (Unhappy)**: `file.write` without description $\rightarrow$ reject with `invalid_knowledge`.
   * **Optimistic Concurrency Conflict (Unhappy)**: `file.write` with mismatched `expectedVersion` $\rightarrow$ conflict error.
   * **Delete (Happy)**: `file.delete` on `knowledge/<slug>.md` $\rightarrow$ removes entry.
   * **Delete System Files (Unhappy)**: `file.delete` on `SOUL.md` or `MEMORY.md` $\rightarrow$ reject with `invalid_path`.
4. **Slash Command Handling**:
   * `/status`: verify intercepted out-of-band, returns system status, zero transcript entries added, zero LLM calls.
   * `/reset`, `/compact`, `/help`: verify return `unsupported_command`.

---

### Priority 1: Schedules, Alarms & Tool Invocations (~160 lines)
*Target Files:* [`packages/worker/src/extensions/schedules-tools.ts`](file:///Users/developer/projects/pi-bot/packages/worker/src/extensions/schedules-tools.ts), [`packages/worker/src/schedules.ts`](file:///Users/developer/projects/pi-bot/packages/worker/src/schedules.ts)

1. **Schedule Tool Types**:
   * Bot calls `schedule_create` with:
     * `kind: "absolute"` (specific timestamp).
     * `kind: "cron"` (cron syntax `0 12 * * *`).
     * `target: { mode: "fork" }` (forks chat on wake).
   * Bot calls `schedule_update` (adjusting wake time/interval).
   * Bot calls `schedule_delete` (removing schedule).
2. **Invalid Schedule Parameters (Unhappy Flows)**:
   * Invalid cron expression (e.g. `bad * cron`) $\rightarrow$ tool returns structured error.
   * Target chat belonging to a different bot $\rightarrow$ rejected.
3. **Knowledge Tool Deletion**:
   * Bot calls `knowledge_delete` tool for a slug $\rightarrow$ verify deletion and side-effect memoization.

---

### Priority 1: Group Chat Autonomous Limits & Forget Mode (~90 lines)
*Target Files:* [`packages/worker/src/group-chat/drive.ts`](file:///Users/developer/projects/pi-bot/packages/worker/src/group-chat/drive.ts), [`packages/worker/src/group-chat/limits.ts`](file:///Users/developer/projects/pi-bot/packages/worker/src/group-chat/limits.ts)

1. **Ephemeral Group Chat (`mode: "forget"`)**:
   * Initiate group chat with `mode: "forget"`.
   * Verify multi-bot turn coordination completes, final synthesis returned, and chat transcript entries cleaned up.
2. **Group Chat Round & Timeout Limits (Unhappy / Limit Flows)**:
   * Max rounds exceeded $\rightarrow$ status transitions to `"capped"`.
   * Total timeout reached $\rightarrow$ status transitions to `"timed_out"`.

---

### Priority 1: OAuth Flows & Tenant Isolation (~120 lines)
*Target Files:* [`packages/worker/src/oauth.ts`](file:///Users/developer/projects/pi-bot/packages/worker/src/oauth.ts), [`packages/worker/src/store/d1-admin.ts`](file:///Users/developer/projects/pi-bot/packages/worker/src/store/d1-admin.ts)

1. **OAuth Lifecycle**:
   * Initiate flow with `account.oauth.start`.
   * Check status with `account.oauth.status`.
   * Cancel pending flow with `account.oauth.cancel` $\rightarrow$ verify status transitions to `"cancelled"`.
2. **Tenant Isolation Enforcements (Unhappy Flow)**:
   * Account B attempts to read or mutate Account A's bot, file, or schedule $\rightarrow$ 404 / unauthorized.
3. **REST Protocol Header Rejections (Unhappy Flows)**:
   * Query parameter token `GET /api/*?token=...` $\rightarrow$ 401 `{ error: { code: "query_token_not_allowed" } }`.
   * Cookie without Bearer header `GET /api/*` $\rightarrow$ 401 `{ error: { code: "header_required" } }`.
