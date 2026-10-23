# Review 03 Results: Upstream Integration with pi-durable and Coding Tools

## Executive Summary

This review evaluates the architectural design and upstream contracts for integrating `@earendil-works/pi-durable` 1.3.0 and its built-in `CodingTools` extension (`bash`, `read`, `write`, `edit`) into Cadmus, as specified in [`docs/plans/tools-env/builtin-tools.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/builtin-tools.md) and [`docs/plans/tools-env/execution-env.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/execution-env.md).

### Overall Feasibility: **Viable with Critical Remediations**

The decision to adopt pi-durable's native `CodingTools` and `ExecutionEnv` abstraction instead of creating custom Cadmus-specific shell and file provider interfaces is architecturally sound. It eliminates duplicate tool registries, aligns with pi-durable's streaming execution model, and integrates cleanly with Durable Object SQLite storage.

However, a rigorous inspection of `@earendil-works/pi-durable` 1.3.0 runtime internals revealed **three critical contract risks/gaps** that must be addressed prior to implementation:

1. **Cross-Account In-Isolate Queue Collision**: The plan's proposed `ExecutionEnv.id` patterns for `just-bash` (`just-bash:<familyId>:bot:<botId>`) omit `accountId`. Because `withFileMutationQueue` uses a module-level singleton `Map` within the Cloudflare Worker isolate, multiple Durable Object instances belonging to different accounts that share the default family name (`default`) and identical bot IDs will cross-serialize or block file writes across tenant boundaries.
2. **Opt-In Tool Configuration Gap**: The plan assumes calling `toToolRegs(bot.tools)` in `createChatInternal` and `conv.configure` will make `bash`, `read`, `write`, and `edit` available to the model. In pi-durable 1.3.0, `agent.tools` acts solely as a filter over tools composed from `agent.extensions`. If `coding-tools` is omitted from `HarnessOptions.settings.extensions`, setting `agent.tools` alone will **never** compose coding tools for the conversation. Cadmus must explicitly update `agent.extensions` (`{ add: [{ name: "coding-tools" }] }`).
3. **Deadlock Vulnerability in `withFileMutationQueue`**: In `dist/tools/file-mutation-queue.js`, the mutex queue awaits previous file mutations without an abort signal or timeout. If a remote daemon WebSocket call hangs without an enforced RPC timeout, `release()` is never called, causing permanent in-isolate deadlocks for any subsequent `write` or `edit` operations on that file path.

---

## Upstream Integration & Contract Risks

- **Issue 1**: Cross-Account File Mutation Queue Collisions due to Missing `accountId` in `ExecutionEnv.id`
  - **pi-durable Component / API**: [`dist/tools/file-mutation-queue.js:3-7`](file:///home/developer/projects/pi-bot/node_modules/@earendil-works/pi-durable/dist/tools/file-mutation-queue.js#L3-L7) (`queues = new Map()`, `mutationKey(env, path) = "${env.id}\\0${canonical}"`)
  - **Plan Reference**: [`docs/plans/tools-env/execution-env.md:100-118`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/execution-env.md#L100-L118)
  - **Risk / Gap**: In Cloudflare Workers, a single V8 isolate frequently hosts multiple Durable Object instances across different accounts. The `queues` map in `file-mutation-queue.js` is a module-scoped JavaScript singleton. The plan proposes `ExecutionEnv.id` formats:
    - Bot default: `just-bash:<familyId>:bot:<botId>`
    - Chat override: `just-bash:<familyId>:chat:<chatKey>`
    In Cadmus, `familyId` defaults to `"default"` for all newly created accounts (see [`src/store/d1-admin.ts:648`](file:///home/developer/projects/pi-bot-hands/src/store/d1-admin.ts#L648) and [`src/family-do.ts:183`](file:///home/developer/projects/pi-bot-hands/src/family-do.ts#L183)). If Account A and Account B both have a bot named `"assistant"` in family `"default"`, their `ExecutionEnv.id` strings are identical (`just-bash:default:bot:assistant`). As a result, file writes to `/workspace/scratch.txt` in Account A will queue behind and serialize with writes from Account B. A transport delay or hang in one account would directly stall unrelated accounts.
  - **Remediation**: Include `accountId` in all `ExecutionEnv.id` strings:
    - `just-bash, bot default`: `just-bash:<accountId>:<familyId>:bot:<botId>`
    - `just-bash, chat override`: `just-bash:<accountId>:<familyId>:chat:<chatKey>`
    - `local-daemon`: `daemon:<accountId>:<secretId>:<workspacePath>`

- **Issue 2**: `agent.extensions` Omission Prevents Tool Offerings on Opted-In Bots
  - **pi-durable Component / API**: [`dist/harness/agent.js:160-249`](file:///home/developer/projects/pi-bot/node_modules/@earendil-works/pi-durable/dist/harness/agent.js#L160-L249) (`resolveAgent`, `selectExtensions`, `filterTools`, `applyChange`)
  - **Plan Reference**: [`docs/plans/tools-env/builtin-tools.md:13-20`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/builtin-tools.md#L13-L20)
  - **Risk / Gap**: The plan correctly notes that `coding-tools` must be omitted from `settings.extensions` passed to `Harness.open` to avoid exposing shell tools to unconfigured bots. However, the plan states:
    > *"Per conversation, add the `coding-tools` extension only when this bot's `bot.tools` includes one of `bash`, `read`, `write`, `edit`... `toToolRegs` already turns a name list into the agent tool selection."*
    
    In Cadmus today ([`src/family-do.ts:101-106`](file:///home/developer/projects/pi-bot-hands/src/family-do.ts#L101-L106)), `toToolRegs` only sets `AgentChange.tools`. It does **not** configure `AgentChange.extensions`.
    In pi-durable's `resolveAgent`:
    ```ts
    const extensions = selectExtensions(state?.extensions, snapshot, settings);
    // composed is built strictly from the selected extensions
    const enabled = filterTools([...composed.values()], state?.tools);
    ```
    If `coding-tools` is not in `settings.extensions`, and `state.extensions` is undefined, `selectExtensions` only selects host `settings.extensions`. Thus `composed` will **never** contain `bash`, `read`, `write`, or `edit`. Setting `agent.tools: ["bash"]` will filter over an empty composed set, resulting in **zero** coding tools being offered to the LLM.
  - **Remediation**: Cadmus must explicitly pass `agent.extensions` in `conv.configure`, `createChatInternal`, and `createBotInternal`. When `bot.tools` contains any coding tools, pass:
    ```ts
    extensions: { add: [{ name: "coding-tools" } as unknown as Extension] }
    ```
    When `bot.tools` removes them, pass `{ remove: [{ name: "coding-tools" } as unknown as Extension] }`.

- **Issue 3**: Unbounded Deadlock in `withFileMutationQueue` on Remote Daemon WebSocket Stalls
  - **pi-durable Component / API**: [`dist/tools/file-mutation-queue.js:32-51`](file:///home/developer/projects/pi-bot/node_modules/@earendil-works/pi-durable/dist/tools/file-mutation-queue.js#L32-L51) (`withFileMutationQueue`)
  - **Plan Reference**: [`docs/plans/tools-env/execution-env.md:197-199`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/execution-env.md#L197-L199)
  - **Risk / Gap**: In `withFileMutationQueue`:
    ```ts
    const previous = queues.get(key) ?? Promise.resolve();
    // ...
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (queues.get(key) === tail) queues.delete(key);
    }
    ```
    Notice that `await previous` does **not** accept an `AbortSignal` or timeout. If Tool Call 1 enters `fn()` and dispatches an RPC frame to a remote daemon over WebSocket, and the connection stalls or the peer fails to respond:
    - If the DO proxy does not enforce an explicit, bounded timer on the pending frame promise, `fn()` will never settle.
    - `release()` will never be called.
    - Any subsequent tool call (or parallel tool call in the same turn) attempting to `write` or `edit` that canonical path will wait on `await previous` forever, ignoring conversation abort signals.
  - **Remediation**:
    1. The DO-side remote `ExecutionEnv` proxy must attach a strict timeout (e.g. 2,000 ms for file operations) to every pending RPC request.
    2. Upon WebSocket `close` or transport error in `webSocketClose` / `webSocketError`, the proxy must immediately reject all in-flight request promises with a transport `FileError` (code `unknown`, message prefix `tools-env transport:`). This ensures `release()` runs in the `finally` block and unblocks queued calls.

- **Issue 4**: `generation.js` Prepare Catch-and-Report Behavior for Offline Scopes
  - **pi-durable Component / API**: [`dist/harness/generation.js:58-66`](file:///home/developer/projects/pi-bot/node_modules/@earendil-works/pi-durable/dist/harness/generation.js#L58-L66) (`GenerationTask.prepare`)
  - **Plan Reference**: [`docs/plans/tools-env/reachability.md:11-24`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/reachability.md#L11-L24), [`builtin-tools.md:94-96`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/builtin-tools.md#L94-L96)
  - **Risk / Gap**: When a scope is `unreachable`, the plan specifies that the harness `env` callback throws:
    ```ts
    throw new Error("The tools env for this chat is offline. Chat, memory, knowledge, and schedules still work. Do not retry; recovery is automatic.");
    ```
    In `generation.js`:
    ```ts
    let env;
    try {
      env = await runtime.env(context);
    } catch (error) {
      if (context.abortSignal?.aborted) throw error;
      report(error);
    }
    ```
    Audit confirms:
    - `generation.js` catches the error, sets `env = undefined`, and continues prompt rendering. It does **not** fail or retry the generation task, so crash loops are impossible.
    - However, `report(error)` delegates directly to `HarnessOptions.onReport`, which in Cadmus calls `this.log().warn("pi-durable extension report", { error })` ([`src/family-do.ts:390`](file:///home/developer/projects/pi-bot-hands/src/family-do.ts#L390)). Consequently, **every turn prepare on an offline chat will emit a warning log**, even though being offline is an expected system state.
  - **Remediation**: In `CadmusBotFamilyDO.initHarness`, update the `onReport` callback to inspect the error. If `error.message` matches the offline sentinel prefix, log at `debug` level rather than `warn`.

- **Issue 5**: Ambiguity Between Provider-Native `code.execute` Sandbox and `bash` Persistent Workspace
  - **pi-durable Component / API**: [`src/models.ts:241-250`](file:///home/developer/projects/pi-bot-hands/src/models.ts#L241-L250) (`NATIVE_TOOLS.xai["code.execute"]`), [`src/extensions/web-tools.ts:107-121`](file:///home/developer/projects/pi-bot-hands/src/extensions/web-tools.ts#L107-L121)
  - **Plan Reference**: [`docs/plans/tools-env/builtin-tools.md:54-66, 98-111`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/builtin-tools.md#L54-L66)
  - **Risk / Gap**: For xAI models, `code.execute` is rewritten into the provider-native `code_interpreter`. This interpreter executes in a remote, stateless server sandbox managed by xAI and has **no access** to the bot's `/workspace` virtual filesystem or the local daemon folder.
    If both tools are offered, models frequently default to `code.execute` when asked to run Python scripts or tests. When `code.execute` runs, it fails to find the repository files created by `write`.
    Furthermore, if the tools env is offline, the plan's `tools-env-unavailable` section states: *"The tools env for this chat is unavailable... It cannot run commands or touch files."* The LLM could interpret this as disabling `code.execute` as well, or inversely attempt to use `code.execute` to manipulate workspace files.
  - **Remediation**:
    - In `tools-env` prompt section, make the boundary explicit:
      `"Use bash, read, write, and edit for this chat's workspace. code.execute runs in an isolated provider sandbox with NO access to workspace files."`
    - In `tools-env-unavailable` prompt section, state clearly:
      `"The workspace tools env is offline (bash, read, write, edit are unavailable). code.execute (if enabled) remains an independent stateless computation sandbox with no workspace file access."`

---

## Security & Default-On Analysis

### The `bot.tools === undefined` Contract in Cadmus

In current Cadmus behavior:
- `BotRecord.tools === undefined` represents "all default Cadmus tools allowed" (`knowledge_*`, `memory_*`, `schedules_*`, `create_bot`, `message_bot`, `web.fetch`, and provider-native tools).
- In [`src/extensions/tool-gate.ts:36`](file:///home/developer/projects/pi-bot-hands/src/extensions/tool-gate.ts#L36), `beforeTool` exits early if `bot.tools === undefined`, permitting the call.

### Multi-Layer Defense Evaluation

The plan specifies a strict three-layer defense to prevent existing or newly created bots from accidentally acquiring shell/file execution capabilities:

1. **Host-Level Isolation (Offer Gate)**:
   - In `CadmusBotFamilyDO.initHarness`, `Harness.open` is configured with `settings: { extensions: [ ...cadmusExtensions ] }`, explicitly omitting `coding-tools`.
   - By default, pi-durable's `selectExtensions` falls back to `settings.extensions`. Therefore, unless a conversation explicitly opts into `coding-tools`, the extension is never composed and the tools are never presented to the LLM.
2. **Policy Enforcement Gate (`toolGateExtension.beforeTool`)**:
   - `toolGateExtension` will intercept `bash`, `read`, `write`, and `edit`.
   - If `call.name` is one of these four coding tools, it will **require** `bot.tools !== undefined && bot.tools.includes(call.name)`.
   - If `bot.tools === undefined` (legacy/default bot) or if `bot.tools` omits the tool, `beforeTool` immediately returns `{ block: "Tool '<name>' is disabled for bot '<id>'." }`.
3. **Execution Environment Callback Guard**:
   - If a tool call somehow bypassed the prompt and gate, `requireEnv(api)` invokes the `HarnessOptions.env` callback.
   - For an unbound conversation or a bot without a valid binding, the callback returns `undefined`.
   - `requireEnv` then throws `Error("No execution environment is configured")`.
4. **Schedule & Harvest Child Isolation**:
   - Idle harvest forks (`executeHarvestFork` in [`src/schedules.ts`](file:///home/developer/projects/pi-bot-hands/src/schedules.ts)) explicitly configure `tools: toToolRegs(HARVEST_TOOLS)` and set `tools_env = 0` in `cadmus_chat_conversations`.
   - The `env` callback returns `undefined` immediately when `tools_env = 0`, completely shielding harvest tasks from workspace access.

### Audit Verdict
The security gate design is **airtight against unauthorized tool execution**. A newly created bot or legacy bot with `bot.tools === undefined` cannot invoke `bash` or file tools under any circumstances. However, as noted in Issue 2, the implementation must ensure that legitimate opt-in via `bot.tools` correctly configures `agent.extensions`.

---

## Upstream Contract Checklist

- [x] **Harness env callback signature & return handling**
  - Verified against [`dist/harness/types.d.ts:513-525`](file:///home/developer/projects/pi-bot/node_modules/@earendil-works/pi-durable/dist/harness/types.d.ts#L513-L525) and [`dist/harness/harness.js:137-143`](file:///home/developer/projects/pi-bot/node_modules/@earendil-works/pi-durable/dist/harness/harness.js#L137-L143).
  - Signature `(target: EnvTarget, context: Context) => ExecutionEnv | undefined | Promise<ExecutionEnv | undefined>` matches.
  - Returning `undefined` correctly causes `requireEnv` to throw `"No execution environment is configured"`.
  - Throwing from `env` callback during tool execution is caught by `dist/harness/tool.js:298-309` and cleanly recorded as a tool error result entry.
  - Throwing during `GenerationTask.prepare` is caught by `dist/harness/generation.js:58-66` and reported to `onReport` without crashing the task.

- [x] **EnvTarget.cwd (botId) vs ExecutionEnv.cwd (workspace root)**
  - Verified across [`dist/tools/path-utils.js:8-25`](file:///home/developer/projects/pi-bot/node_modules/@earendil-works/pi-durable/dist/tools/path-utils.js#L8-L25), [`dist/tools/bash.js:35`](file:///home/developer/projects/pi-bot/node_modules/@earendil-works/pi-durable/dist/tools/bash.js#L35), and [`dist/env/node.js:574`](file:///home/developer/projects/pi-bot/node_modules/@earendil-works/pi-durable/dist/env/node.js#L574).
  - `EnvTarget.cwd` is populated from `AgentDoc.cwd` and passed solely to the `env` callback.
  - Upstream `read`, `write`, `edit`, and `bash` resolve paths and process directories strictly against `ExecutionEnv.cwd` via `env.absolutePath()` and `requireEnv(api).cwd`.
  - `EnvTarget.cwd = botId` never leaks into shell commands or filesystem paths.

- [x] **withFileMutationQueue interaction with ExecutionEnv.id**
  - Verified in [`dist/tools/file-mutation-queue.js:4-26`](file:///home/developer/projects/pi-bot/node_modules/@earendil-works/pi-durable/dist/tools/file-mutation-queue.js#L4-L26).
  - Mutex key is `${env.id}\0${canonicalPath}`.
  - **Correction required**: Proposed `ExecutionEnv.id` formats must include `accountId` to prevent cross-tenant mutex collisions in shared worker isolates.
  - **Correction required**: Remote proxy must enforce bounded timeouts on all RPC frames to prevent permanent queue lockups when remote daemons stall.

- [x] **CodingTools registration without host default-on exposure**
  - Verified in [`dist/harness/agent.js:231-248`](file:///home/developer/projects/pi-bot/node_modules/@earendil-works/pi-durable/dist/harness/agent.js#L231-L248).
  - Passing `settings.extensions` without `coding-tools` prevents global exposure.
  - **Correction required**: Opting in per conversation requires configuring `AgentChange.extensions: { add: [...] }`, not merely `AgentChange.tools`.

- [x] **Image processor omission and memory impact**
  - Verified in [`dist/tools/read.js:46-128`](file:///home/developer/projects/pi-bot/node_modules/@earendil-works/pi-durable/dist/tools/read.js#L46-L128) and [`dist/tools/image-processor.js:1-8`](file:///home/developer/projects/pi-bot/node_modules/@earendil-works/pi-durable/dist/tools/image-processor.js#L1-L8).
  - Without an image processor, `read` successfully passes inline formats (`PNG`, `JPEG`, `GIF`, `WebP`) up to 2000x2000 and 4.5 MB.
  - Files exceeding limits or requiring conversion (e.g. BMP) return graceful tool diagnostics (`code: "unsupported_image"`), with no unhandled exceptions or isolate crashes.
  - Omitting `createCloudflarePhotonImages` successfully protects Cloudflare Worker isolates from irreversible WebAssembly linear memory retention.

- [x] **code.execute vs bash segregation**
  - Verified in [`src/models.ts:241-248`](file:///home/developer/projects/pi-bot-hands/src/models.ts#L241-L248) and [`src/extensions/web-tools.ts:107-121`](file:///home/developer/projects/pi-bot-hands/src/extensions/web-tools.ts#L107-L121).
  - `code.execute` maps to provider-native `code_interpreter` on xAI and is completely separate from `ExecutionEnv`.
  - Prompts must explicitly instruct the LLM that `code.execute` has zero access to `/workspace` files and that `bash` is the exclusive tool for workspace operations.

## Disposition (applied by Grok Build)

- **Issue 1 — Cross-account file-mutation queue collisions**: Applied. `withFileMutationQueue` is a module-level `Map`, and `familyId` `"default"` is per account, so the old ids could alias across tenants in one isolate. `ExecutionEnv.id` now includes `accountId` (`execution-env.md`, `workspace-persistence.md`, `sequencing.md`). Same-account daemon binds with the same secret and effective root still share an id. SQLite scopes stay `bot:` / `chat:` without `accountId`.
- **Issue 2 — `agent.extensions` required to offer coding tools**: Applied. `toToolRegs` only sets `AgentChange.tools`, and `resolveAgent` composes tools from selected extensions. Opt-in is `extensions: { add: [{ name: "coding-tools" }] }` plus the tool filter; opt-out is `{ remove }`. An extensions array is rejected in the plan because it would replace the host selection (`builtin-tools.md`, `binding-and-config.md`, `sequencing.md`).
- **Issue 3 — Unbounded deadlock in `withFileMutationQueue`**: Applied. The plan already required a ~2s file/probe budget, so a missing reply is not a permanent lock if that budget is implemented. Added that `webSocketClose` and transport errors reject in-flight frames immediately, because the upstream queue has no abort and no timeout (`execution-env.md`). — **Superseded (2026-10-21, Lior):** cloud-side probing removed; env reconnects proactively, heartbeat only while calls are in flight, connection state per env with generation CAS (reachability.md).
- **Issue 4 — Offline prepare logged at `warn`**: Applied. `generation.js` reports the env throw and continues; `tool.js` records it and does not report. `onReport` logs the offline sentence at `debug` and leaves other reports at `warn` (`execution-env.md`, `reachability.md`).
- **Issue 5 — `code.execute` vs workspace `bash`**: Applied. Ready and unavailable identity text now say `code.execute` is a separate provider sandbox with no workspace files. The unavailable section still does not name `bash` / `read` / `write` / `edit`. Decision 6 in `README.md` records that wording (`builtin-tools.md`, `reachability.md`, `sequencing.md`).
- **EnvTarget.cwd vs ExecutionEnv.cwd, image `read` without Photon, default-on gate**: Already resolved. Upstream path resolution uses `ExecutionEnv.cwd` only. Image limits and `unsupported_image` match the plan. `bot.tools === undefined` still does not offer coding tools once Issue 2's extension patch is in place. No further doc change.
