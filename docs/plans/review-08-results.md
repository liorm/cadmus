# Review 08 Results: Phasing, Feasibility and Test Strategy

## Executive Summary

This review audits the implementation phasing, delivery sequencing, upstream conformance test feasibility, whole-flow E2E testability in Cloudflare `workerd`, and regression safety specified in [`docs/plans/tools-env/sequencing.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/sequencing.md) and its companion architectural plans ([`README.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/README.md), [`binding-and-config.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/binding-and-config.md), [`builtin-tools.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/builtin-tools.md), [`execution-env.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/execution-env.md), [`reachability.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/reachability.md), [`workspace-persistence.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/workspace-persistence.md)).

### Key Findings
1. **Phasing & Decoupling**: The 3-phase delivery model is architecturally sound and preserves existing bot behavior. Phase 1 (`just-bash` + Harness `env` callback + DO state machine + chat overrides) can ship to production independently. Phase 2 (D1 secrets + account defaults + RPCs + UI) can safely merge before Phase 3 (remote WebSocket transport + daemon package) because un-dialed `local-daemon` bindings gracefully enter bounded `unreachable` state without dialing out or crashing. However, **two hidden forward dependencies and one backward-compatibility migration gap** were identified in Phase 1:
   - Existing chats created before Phase 1 will be missing from `cadmus_chat_conversations` unless backfilled by `ensureSchema`.
   - Phase 1 resolution logic assumes `services.getAccountDefaultToolsEnv()` exists, but the D1 column and store methods are only introduced in Phase 2.
   - Reachability events (`tools-env.reachability`) are defined in Phase 2, but the DO reachability state machine is built in Phase 1.
2. **Upstream Conformance Feasibility (`@earendil-works/pi-durable/testing`)**:
   - `createEnvConformance` executes cleanly under Bun without Node C++ native bindings.
   - **Crucial Requirement for `just-bash`**: The upstream conformance suite creates symlinks by running `env.exec([...shell, "ln -s ..."])`. The `just-bash` shell interpreter must implement the `ln` command (`ln -s`), and its virtual filesystem (VFS) must resolve relative symlinks and handle `noFollow`.
   - File watching (`watch: true`) can be satisfied in-process without host OS file watchers because all mutations in `just-bash` pass through `ExecutionEnv` methods or the shell interpreter.
3. **Test Runner Collision Risk**:
   - Running bare `bun test` in this repository scans the entire workspace and attempts to execute `e2e/*.test.ts`, which immediately crashes because `cloudflare:test` is only provided within Vitest's `workerd` environment. A dedicated script (e.g. `bun run test:conformance`) and test-path configuration are required.
4. **Whole-Flow E2E Driving (`faux/echo`)**:
   - In-workerd simulation of the Phase 3 reverse WebSocket daemon via `SELF.fetch` (`res.webSocket.accept()`) is 100% feasible without network egress and conforms to the zero-mock storage philosophy.
   - However, `faux/echo` in [`src/models.ts`](file:///home/developer/projects/pi-bot-hands/src/models.ts) **cannot drive parallel tool calls or multi-tool chains in a single turn**, and its non-greedy regex `\{[\s\S]*?\}` truncates JSON payloads containing `}]`. Tests must submit tool directives sequentially across distinct turns, and the parser regex should be made resilient.

---

## Phasing & Dependency Gaps

### Issue 1: Pre-existing Chats Missing from `cadmus_chat_conversations`
- **Plan Reference**: [`docs/plans/tools-env/execution-env.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/execution-env.md#L41-L68); [`docs/plans/tools-env/sequencing.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/sequencing.md#L18).
- **Bottleneck / Forward Dependency**:
  In Phase 1, `cadmus_chat_conversations` is introduced to map `conversation_id -> { chat_key, bot_id, tools_env }`. The `env` callback uses this table to resolve the active chat key. Step 2 of the callback resolution states: *"No row means this conversation is not a chat and not a fork of one (the bot root conversation is that case)."*
  For chats created in production before Phase 1 deployment, `cadmus_chats` has rows, but `cadmus_chat_conversations` will be empty. If an operator later attempts to apply a chat override (`chat.update`) or if a turn runs on an existing chat, the `env` callback will misclassify the conversation as an unbound bot root conversation and fail to apply the chat scope.
- **Remediation**:
  In [`src/store/sqlite-family.ts`](file:///home/developer/projects/pi-bot-hands/src/store/sqlite-family.ts) (`SqliteFamilyStore.ensureSchema`), execute an idempotent backfill migration when creating `cadmus_chat_conversations`:
  ```sql
  INSERT OR IGNORE INTO cadmus_chat_conversations (conversation_id, chat_key, bot_id, tools_env)
  SELECT conversation_id, key, bot_id, 1 FROM cadmus_chats;
  ```

---

### Issue 2: Forward Dependency on Account Default Resolution in Phase 1
- **Plan Reference**: [`docs/plans/tools-env/sequencing.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/sequencing.md#L23); [`docs/plans/tools-env/binding-and-config.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/binding-and-config.md#L110-L119); [`docs/plans/tools-env/execution-env.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/execution-env.md#L43).
- **Bottleneck / Forward Dependency**:
  `execution-env.md` specifies that the `env` callback fallback hierarchy is:
  `Chat override -> BotRecord.toolsEnv -> services.getAccountDefaultToolsEnv() -> undefined`.
  However, the D1 column `cadmus_accounts.default_tools_env_json`, the `AccountRecord.defaultToolsEnv` property, and the DO cache invalidation logic are only added in **Phase 2**.
  If Phase 1 DO code attempts to call an un-stubbed `getAccountDefaultToolsEnv()` or expects `AdminStore` methods that do not yet exist, Phase 1 will fail compilation or runtime calls.
- **Remediation**:
  In Phase 1, explicitly specify that `CadmusServices.getAccountDefaultToolsEnv` is either optional (`services.getAccountDefaultToolsEnv?.() ?? null`) or a deterministic stub returning `null`. The resolution logic in Phase 1 must terminate at `BotRecord.toolsEnv` without making calls into D1 `cadmus_accounts`.

---

### Issue 3: Reachability Event Frame (`tools-env.reachability`) Deferred to Phase 2
- **Plan Reference**: [`docs/plans/tools-env/sequencing.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/sequencing.md#L65); [`docs/plans/tools-env/reachability.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/reachability.md#L228-L232).
- **Bottleneck / Forward Dependency**:
  Phase 1 implements `cadmus_tools_env_state`, the DO alarm probe multiplexer, and transport error classification in the env wrapper. When an environment transitions between `ready` and `unreachable`, `reachability.md` specifies broadcasting a `tools-env.reachability` `ServerEvent`.
  However, `sequencing.md` schedules the definition of `tools-env.reachability` in `src/protocol/frames.ts` for **Phase 2**. If the Phase 1 state machine calls `broadcastEvent({ type: "tools-env.reachability", ... })`, TypeScript typechecking under `bun check` will fail because the frame variant does not exist in `ServerFrame`.
- **Remediation**:
  Define the `tools-env.reachability` TypeBox schema and union variant in [`src/protocol/frames.ts`](file:///home/developer/projects/pi-bot-hands/src/protocol/frames.ts) in **Phase 1**. In Phase 1, `broadcastEvent` can broadcast it to current connected protocol clients (since no daemons exist yet in Phase 1 or 2, socket tag filtering can remain in Phase 3). Alternatively, explicitly specify that Phase 1 state transitions do not broadcast frames and are only observable via `/status`. Defining the frame in Phase 1 is recommended for protocol completeness.

---

### Issue 4: TypeBox Binding Union vs. Phase 1 `local-daemon` Rejection
- **Plan Reference**: [`docs/plans/tools-env/sequencing.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/sequencing.md#L31); [`docs/plans/tools-env/binding-and-config.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/binding-and-config.md#L47-L68).
- **Bottleneck / Forward Dependency**:
  `sequencing.md` requires: *"Phase 1's allowed kind is `just-bash`. Reject `local-daemon` until phase 3 can open a socket, so a stored daemon bind cannot look `ready`."*
  If `ToolsEnvBindingSchema` in `src/protocol/records.ts` is defined with only `kind: "just-bash"` in Phase 1, updating it to include `kind: "local-daemon"` in Phase 2 causes a protocol schema change.
  Conversely, if `ToolsEnvBindingSchema` includes `local-daemon` in Phase 1, how is `local-daemon` rejected?
- **Remediation**:
  Define the full discriminated union (`just-bash` | `local-daemon`) in `src/protocol/records.ts` in Phase 1 so protocol schema types remain stable. In Phase 1 command handlers (`createBotInternal`, `chat.create`, `chat.update`, `bot.update`), enforce semantic validation:
  ```ts
  if (binding.kind === "local-daemon") {
    throw new ProtocolValidationError("Kind 'local-daemon' is not supported in this version", "unsupported_kind");
  }
  ```
  In Phase 2, remove this gate and replace it with `secretId` existence checks in `cadmus_tools_env_secrets`.

---

## Testability & Framework Evaluation

### 1. Bun Compatibility for Upstream Conformance (`@earendil-works/pi-durable/testing`)
- **Inspection of `@earendil-works/pi-durable/dist/testing/`**:
  - `createEnvConformance` is completely runner-agnostic and relies only on pure TypeScript/JavaScript interfaces (`EnvConformanceOptions`, `ExecutionEnv`). It imports no Node.js native C++ addons.
  - `createExpectAssertions` accepts any assertion library exposing `toBeTruthy`, `toBe`, `toEqual`, `toMatchObject`, `toBeGreaterThan`, and `rejects.toThrow`. We verified with `bun -e` that Bun's native `bun:test` `expect` supports all these assertion primitives.
  - `registerEnvConformance(runner, name, withEnv, options)` binds cleanly with `{ describe, it, expect }` from `bun:test`.

### 2. Test Runner Isolation (`bun test` vs `vitest run`)
- **Issue**:
  In `package.json`, `"test": "vitest run"` runs E2E tests inside Cloudflare's `workerd` environment using `@cloudflare/vitest-plugin`.
  When running `bun test` in the root workspace, Bun auto-discovers all files matching `*.test.ts`. Running `bun test` directly fails on all 10 `e2e/*.test.ts` files with:
  `error: Cannot find package 'cloudflare:test'`.
- **Remediation**:
  1. Place conformance tests in a dedicated directory outside `e2e/`, such as `tests/conformance/just-bash.test.ts`.
  2. Add an explicit script to `package.json`:
     ```json
     "test:conformance": "bun test tests/conformance"
     ```
  3. Ensure `vitest.config.ts` continues to only include `e2e/**/*.test.ts` (`include: ["e2e/**/*.test.ts"]`), and add a root `bunfig.toml` if necessary to exclude `e2e/` from bare `bun test`.

### 3. `just-bash` VFS Symlinks and Watch Implementation
- **Inspection of `createEnvConformance` test cases**:
  - Case `binary reader follows symlinks unless noFollow refuses the final one` lines 507-508:
    ```js
    const linked = await env.exec([...shell, "ln -s target.txt link.txt && ln -s sub dirlink"], undefined, context);
    assert.strictEqual(getOrThrow(linked).exitCode, 0);
    ```
    The test suite creates symlinks **by executing shell commands**. Therefore, `just-bash`'s shell interpreter must support the `ln` command (`ln -s <target> <link>`). If `just-bash` only supports `echo`, `cat`, etc., but lacks `ln`, the conformance suite will fail immediately.
  - Case `watch reports changes to the file a watched symbolic link points to` lines 523-535:
    The test watches a symbolic link (`config/AGENTS.md`) and mutates the target file (`data/real.md`). The watcher on the symlink must receive the change notification.
  - **In-Isolate File Watcher**:
    Because `just-bash` runs entirely in memory or DO SQLite, there are no OS-level filesystem events (like Linux `inotify`). However, because every modification to the VFS passes through `ExecutionEnv` methods (`writeFile`, `appendFile`, `truncateFile`, `renameFile`, `remove`) or the interpreter's internal redirection, `just-bash` can dispatch change events to active `watch` callbacks in-process upon each mutation. This requires no host OS dependencies.

### 4. E2E Turn Driving via `faux/echo`
- **Inspection of `echoResponse` in [`src/models.ts`](file:///home/developer/projects/pi-bot-hands/src/models.ts#L427-L523)**:
  - `TOOL_DIRECTIVE_REGEX = /\[tool:([a-zA-Z0-9_.-]+)\s+(\{[\s\S]*?\})\]/;`
  - **Single Tool Call Limit**: The regex only matches the first tool call in the user prompt. `echoResponse` returns an `AssistantMessage` with a single `fauxToolCall`.
  - **Single Turn Step Limit**: Once a tool executes and pi-durable returns the `toolResult` message, `echoResponse` checks:
    ```ts
    if (lastToolResult && lastToolResult.role === "toolResult") {
      return fauxAssistantMessage(`echo(${userCount}): ${cleanedText} -> ${resultText}`);
    }
    ```
    This immediately concludes the turn. It does not iterate over subsequent tool calls.
  - **Unterminated String Truncation**: Because the argument match is `\{[\s\S]*?\}`, any JSON payload where the content includes `}]` (e.g., writing JS code `const a = [{ x: 1 }];`) matches up to the internal `}]`, causing a `SyntaxError` on `JSON.parse` which silently drops the tool call.
  - **E2E Strategy Requirement**:
    Tests in `e2e/tools-env-just-bash.test.ts` and `e2e/tools-env-daemon.test.ts` must submit tool directives **one per turn across separate `turn.submit` calls**:
    - Turn 1: `[tool:write {"path":"notes.txt","content":"hello"}]`
    - Turn 2: `[tool:read {"path":"notes.txt"}]`
    - Turn 3: `[tool:bash {"command":"cat notes.txt"}]`
    Do not combine multiple tool calls in a single `turn.submit`.

### 5. In-Workerd Daemon Peer Simulation (Phase 3)
- In Cloudflare's Vitest runner (`@cloudflare/vitest-plugin`), `SELF.fetch` supports in-memory WebSocket upgrades.
- In [`e2e/helpers.ts`](file:///home/developer/projects/pi-bot-hands/e2e/helpers.ts#L112-L121), `connectTestWs` already upgrades protocol WebSockets in-memory via `res.webSocket.accept()`.
- For Phase 3 E2E testing, a helper `connectTestDaemonPeer(token, familyId, botId, chatKey?)` can call:
  ```ts
  const res = await SELF.fetch(`http://example.com/tools-env/ws?familyId=${familyId}&botId=${botId}`, {
    headers: { Upgrade: "websocket", Authorization: `Bearer ${token}` }
  });
  const ws = res.webSocket;
  ws.accept();
  ```
  The scripted peer can respond to wire protocol frames (`{ id, method: "probe" }`, `{ id, method: "exec" }`, etc.) completely inside workerd without real network egress or external processes, fully complying with the Zero-Mock Storage invariant.

---

## Delivery Checklist

| Milestone | Status | Assessment & Notes |
| :--- | :---: | :--- |
| **Phase 1 production viability without Phase 2/3** | **CONDITIONAL** | Viable **only after** adding the `cadmus_chat_conversations` backfill migration in `ensureSchema` (Issue 1) and stubbing `getAccountDefaultToolsEnv` (Issue 2). Existing bots with `tools === undefined` are protected by `settings.extensions` and `tool-gate`. |
| **Safe rejection of `local-daemon` in Phase 1** | **READY** | Enforce validation rejection in `createBotInternal`, `chat.create`, and `bot.update` when `kind === "local-daemon"`. |
| **Bun compatibility for `pi-durable` conformance tests** | **CONDITIONAL** | Runner-compatible with `bun:test`, but requires a dedicated script (`test:conformance`) to avoid runner collision with `e2e/*.test.ts` (Issue 4). `just-bash` must implement `ln -s` in its interpreter (Section 2.3). |
| **In-workerd WebSocket peer scripting for Phase 3 E2E** | **READY** | Validated via `SELF.fetch` + `res.webSocket.accept()`. Allows full wire protocol and disconnect testing in Miniflare without external egress or DO mocks. |
| **Full preservation of existing test suite (harvest, schedules, RPC)** | **READY** | Harvest child marks `tools_env = 0` in `executeHarvestFork`, coding tools are omitted from `HARVEST_TOOLS`, and identity sections are skipped. `e2e/schedules-and-harvest.test.ts` remains green. |

---

## Disposition (applied by Grok Build)

1. **Pre-existing chats missing from `cadmus_chat_conversations`** — Applied. `ensureSchema` runs `INSERT OR IGNORE` from `cadmus_chats` into `tools_env_enabled` (the review SQL named that column `tools_env`). It does not read `cadmus_pi_*`. A fork that already existed at deploy stays on the bot root; no override can predate the table. Docs: `execution-env.md`, `sequencing.md`, README state table.
2. **Forward dependency on `getAccountDefaultToolsEnv` in phase 1** — Applied. Phase 1 resolves chat override, else the bot pin, else `undefined`, and does not call the method or read `cadmus_accounts`. Phase 2 adds the call with the column. Docs: `sequencing.md`, `execution-env.md`, `binding-and-config.md`. — **Superseded (2026-10-21, Lior):** every env, including just-bash, is an account env DO. Phase 1 creates `jb_default`, reads the account default, and calls `getAccountDefaultToolsEnv`.
3. **`tools-env.reachability` deferred to phase 2** — Applied, with the phase-3 tag left where it was. The frame and the emit move to phase 1 so the state machine typechecks. Phase 1 uses today's untagged `broadcastEvent` (`getWebSockets()` in `src/family-do.ts`). Filtering to `protocol-client` before `/ws` is tagged would drop the event. UI subscription stays phase 2. Docs: `sequencing.md`, `reachability.md`, `builtin-tools.md`, README topology, sequencing constraint 7.
4. **TypeBox union vs phase 1 `local-daemon` rejection** — Applied. `binding-and-config.md` already defined the full union and `unsupported_kind`. `sequencing.md` now says phase 1 ships that union and the handlers reject `local-daemon` without storing it, so `/protocol/schema` does not gain a variant in phase 2.
5. **`createEnvConformance` under Bun** — Already resolved. `dist/testing/` is plain TypeScript (`createExpectAssertions` uses `toBe` / `toEqual` / `toMatchObject` / `toBeGreaterThan` / `rejects.toThrow`). No Node native addon. The plan already registers the suite with Bun. No new design.
6. **Bare `bun test` loads `e2e/`** — Applied. Conformance lives in `tests/conformance/`. Script `test:conformance` is `bun test tests/conformance`. Root `bunfig.toml` sets `[test] pathIgnorePatterns = ["e2e/**"]`. `bun run test` stays Vitest with `include: ["e2e/**/*.test.ts"]` (`package.json`, `vitest.config.ts`). A DO SQLite reopen stays in `e2e/`. Doc: `sequencing.md`.
7. **just-bash `ln -s`, `noFollow`, and symlink watch** — Applied. `FileSystem` has no symlink method. `dist/testing/env-conformance.js` creates links only via `exec` of `ln -s` (with `&&` and relative targets) and expects `openBinaryReader` `noFollow` on the final component. The symlink watch case writes the target and waits on the watched link path; `expectChange` gives about 3s. Polling stays inside the just-bash backend (no host watcher). Docs: `execution-env.md`, README decision 12 (same decision, the suite's actual requirement). Docker and microVM stay on issue #16. — **Superseded (2026-10-21, Lior):** that backend runs in `CadmusEnvDO`. Conformance targets the family proxy against that DO. The family does not hold the VFS.
8. **`faux/echo` cannot chain tools, and `\{[\s\S]*?\}` truncates** — Applied. Confirmed in `echoResponse` (`src/models.ts`): one directive, and a later `toolResult` ends the turn. E2E submits one directive per `turn.submit`. Phase 1 makes the matcher take a balanced JSON object and still returns one `fauxToolCall`. Harvest and search-bot branches stay. Doc: `sequencing.md`.
9. **In-workerd daemon peer** — Already resolved. Phase 3 already scripts the peer and forbids mocking `FamilyStore`, the gate, and alarms. One sentence now points at `connectTestWs` (`SELF.fetch` + `res.webSocket.accept()` in `e2e/helpers.ts`). Doc: `sequencing.md`.
10. **Zero-mock storage and harvest regression** — Already resolved. `sequencing.md` already mocks only the phase 3 peer, keeps `e2e/schedules-and-harvest.test.ts` in the phase 1 list, and repeats harvest, schedules, tool-gate, and `/status` on the regression checklist. The checklist's `tools_env` name in this review is the flag now called `tools_env_enabled`.
