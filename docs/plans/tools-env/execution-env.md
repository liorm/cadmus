# ExecutionEnv (the tools env)

A tools env is the `ExecutionEnv` returned from the harness `env` callback for one bot default or one chat override. pi-durable 1.3.0 already defines that interface (`ExecutionEnv extends FileSystem, Shell` in `dist/env/index.d.ts`, export `@earendil-works/pi-durable/env`). `FileSystem` is the file namespace (`id`, `cwd`, reads, writes, listing, `watch`, `cleanup`). `Shell.exec` runs a command string through the environment's shell, or an argv array with no shell, and streams chunks through `onOutput`. Both return `Result<..., FileError | ExecutionError>` instead of throwing for expected failures.

Cadmus does not define a second provider interface. The family always returns one proxy **(new)** that speaks Durable Object RPC to `CadmusEnvDO`. Provider-specific code is a backend behind that DO. The daemon speaks a wire protocol that mirrors `ExecutionEnv`; only the WebSocket backend sees those frames.

`NodeExecutionEnv` (`@earendil-works/pi-durable/env/node`, `dist/env/node.d.ts`) is the reference implementation the daemon wraps. Its `id` is the fixed string `"node:local"` ("every local environment sees the same files"). The Durable Object never uses `id = "node:local"`. The proxy sets the id in the family, from the resolved namespace.

---

## Where the callback sits

Today `CadmusBotFamilyDO.initHarness` opens the harness with no `env` ([`src/family-do.ts`](../../../src/family-do.ts)):

```ts
const harness = await Harness.open(sqliteStorage, {
  models,
  registry,
  settings: { contextRetentionMs: 0, documentRetentionMs: 0 },
  onReport: (error) => this.log().warn("pi-durable extension report", { error }),
}, context);
```

pi-durable builds the environment at each use, from `HarnessOptions.env`, and never stores it on the session (`dist/harness/types.d.ts`):

```ts
type EnvTarget = {
  conversationId: ConversationId;
  cwd?: string;          // the conversation's agent cwd
  read: DocumentReader;
};

env?: (target: EnvTarget, context: Context) =>
  ExecutionEnv | undefined | Promise<ExecutionEnv | undefined>;
```

`Harness.buildEnv` reads `AgentDoc.cwd` and calls that function (`dist/harness/harness.js`). A throw becomes the tool call's error result (`dist/harness/tool.js` catches `runtime.env()` and `execute()`, and stores `isError` with the message). That path does not call `onReport`. A fresh proxy per call is fine: `edit` and `write` serialize by `env.id` plus canonical path (`withFileMutationQueue` in `dist/tools/file-mutation-queue.js`). Default `toolExecution` is `"parallel"`, so that queue is what keeps two writes of one file ordered inside one isolate. The queue is a module-level `Map` in the worker isolate, not per Durable Object, and it is not distributed. One isolate can host Durable Objects from other accounts. `await previous` takes no abort signal and no timeout; `release()` runs only after `fn()` settles. The family proxy settles that promise itself: the file budget below (~2s) or the exec budget, and a missed heartbeat, `webSocketClose`, or a transport error on the env DO rejects every in-flight frame so a dead peer does not hold the key until the timer. The env DO also queues write/edit-style ops per path across families and across backends (decision 15). `bash` is not in that queue.

**(new)** pass `env` from `initHarness`. The callback is the same for every provider:

1. Reads `target.cwd` as a **bot id** (see below). Missing or unknown id → return `undefined`.
2. Resolves the chat for `target.conversationId` through `cadmus_chat_conversations` (see below). No row means this conversation is not a chat and not a fork of one (the bot root conversation is that case). If the row has `tools_env_enabled = 0`, return `undefined`. That is a harvest child. Do not read a binding and do not throw.
3. Resolves `ToolsEnvSetting` with `resolveToolsEnv` (chat row, bot row, account default). Chat → bot → account; first non-inherit `enabled` wins; first explicit `binding` wins independently ([binding-and-config.md](./binding-and-config.md)). Phase 1 reads the account default, including the built-in `{ envId: "jb_default" }`.
4. If resolved `enabled` is false, or there is no binding → return **`undefined`**. Off is "no env" for this conversation: the same pi-durable `requireEnv` string as unbound. Do **not** throw. The offline throw is only for a binding that exists and whose env DO reports `disconnected` ([reachability.md](./reachability.md)). A harvest child already returned at step 2. Off does not read connection state, does not close a socket, and does not drop a just-bash namespace.
5. Load the env definition for `binding.envId` from the family catalog cache (D1 `cadmus_tools_envs` on miss, no decrypt). A missing row, or a kind phase 1 has not enabled, is the offline throw in step 6. The callback does not branch on kind to pick a class. It always builds the same proxy.
6. RPC `getConnection()` on `CadmusEnvDO` named `env:<accountId>:<envId>`. `disconnected`, or a daemon row that does not exist yet → **throw** `new Error("The tools env for this chat is offline (env disconnected). Chat, memory, knowledge, and schedules still work. Do not retry; the environment reconnects on its own.")`. That is fail-fast: no frame is sent, and the cloud does not try to bring the daemon back. Wording is in [reachability.md](./reachability.md). The bot root conversation uses the same sentence. Generation prepare calls `runtime.env()` and, on a throw, reports it and continues (`dist/harness/generation.js`), so every prepare while a daemon env stays disconnected hits `onReport`. `initHarness` logs that offline sentence at `debug`. Any other report stays `warn` (`this.log().warn("pi-durable extension report", { error })` today). just-bash answers `connected` with no timestamp and no generation, so this step does not throw for a live just-bash definition.
7. Return the proxy from `createExecutionEnv(binding, deps)` **(new)**. `deps` is always the `CADMUS_ENV` namespace, `accountId`, `envId`, `familyId`, the bot id, the chat key when the scope is a chat, the scope (`bot:<botId>` or `chat:<chatKey>`), `sharedWorkspace` from the definition, and the caller ids the accounting hook needs. There is no socket lookup and no `syncAlarm` on this path. The family does not hold a VFS and does not hold the daemon WebSocket.

Scope follows the **binding source**, for just-bash namespaces only: chat `binding` set → `chat:<chatKey>`; otherwise `bot:<botId>`. A chat that is on with no own `binding` uses the bot scope inside the inherited `envId`. A daemon binding has no family namespace. The proxy still carries `familyId`, `botId`, and `chatKey` so the env DO can account the caller.

`EnvTarget.read` can see committed docs. The binding lives on `FamilyStore`, not in a `pi-durable` doc, so the callback uses `requireCadmusServices(context).familyStore` and the account-default cache. It does not decrypt D1. It does not call `harness.commit`. Tool execution can already be on the session mutation line, and a nested `commit` would queue behind itself.

just-bash pays one extra DO RPC hop per op (same-colo, typically small) in exchange for the uniform model. `getConnection()` is the same class of hop, once per tool call, on every kind. Each `ExecutionEnv` method is one RPC. Exec output and watch events stream inside that RPC. The WebSocket backend adds the daemon frame hop behind the DO.

### Which chat, including forks

`getChatByConversationId` ([`SqliteChatStore`](../../../src/store/sqlite-family.ts)) only sees `cadmus_chats`. A schedule fork is a child conversation (`ConversationRecord.parent` in pi-durable `dist/types.d.ts`) and has no chat row. `Harness.conversation(id)` returns a handle and hides `Session.conversation`, which is the call that returns `ConversationRecord`.

**(new)** table, written by Cadmus, read by the callback. This table stays on the family DO. It is not a workspace.

```text
cadmus_chat_conversations (
  conversation_id INTEGER PRIMARY KEY,
  chat_key TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  tools_env_enabled INTEGER NOT NULL DEFAULT 1   -- 1 = normal, 0 = harvest child
)
```

`tools_env_enabled` is an integer flag. It is not a binding. Bindings live in `tools_env_json` on `cadmus_bots` and `cadmus_chats`.

`ChatStore` **(new methods)** owns this table. The callback and the harvest path do not issue the SQL themselves:

- `getConversationRoute(conversationId)` → `{ conversationId, chatKey, botId, toolsEnvEnabled }` or absent.
- `recordConversationRoute(...)` inserts one row.
- `setConversationToolsEnvEnabled(conversationId, enabled)`.
- `deleteConversationRoute(conversationId)`, `deleteConversationRoutesForChat(chatKey)`, and `deleteConversationRoutesForBot(botId)`.

Writers:

- `createChatInternal` inserts the new chat's `conversationId` with `tools_env_enabled = 1`.
- `HarnessOptions.conversationCreated` **(new)**, passed from `initHarness`. The hook runs inside the creating commit, including forks, and receives the child `ConversationRecord` (`dist/harness/types.d.ts`; the commit is `ctx.storage.transaction` in `dist/storage/sqlite/cloudflare.js`). Pi-durable table reads from that hook throw `ReadAfterWrite`. This hook does not read those tables. If `record.parent` is set, it copies `chat_key`, `bot_id`, and `tools_env_enabled` from the parent conversation's row onto the child id. If the parent has no row (fork of the bot root, or a conversation Cadmus does not track), it inserts nothing.

The copy is synchronous `sql.exec` on the family store (`ctx.storage.sql`). On a SQLite-backed Durable Object, `sql.exec` joins the open `storage.transaction`, and it cannot issue `BEGIN`. The route methods used here stay on that path: no `transactionSync`, no `AdminStore`, no `harness.commit`, no `harness.conversation`, no `tx` table read. The session queue is already held for this commit (`queue.hold` around the transaction), so a call back into pi-durable storage waits on itself. A failed commit rolls the route insert back with the conversation row.

`executeStandardFork` needs no extra insert. The copied flag stays 1, so a non-harvest fork of a planning chat resolves that chat's setting (on, off, or inherit). That child row stays for the life of the conversation. pi-durable does not delete conversations, and a later turn on the fork still has to resolve the parent chat's override. `executeHarvestFork` in [`src/schedules.ts`](../../../src/schedules.ts), after `parent.fork` and before `submit`, sets `tools_env_enabled = 0` on the child row. Harvest also keeps coding tools off `HARVEST_TOOLS` ([builtin-tools.md](./builtin-tools.md)). The flag is what stops prompt preparation from building an env. Generation always calls `runtime.env()` (`dist/harness/generation.js`), and a throw there is only reported. Returning `undefined` is the harvest result. The child gets no workspace and no offline error.

After the harvest child has settled (`waitForIdle`, including when submit or the wait throws), `deleteConversationRoute` removes that child id. A missing row and a flag of 0 are the same result for the callback and for the identity sections. The row exists for the child turn, which is why the hook still inserts it. Idle harvest is the cadence that would otherwise keep a row per chat per idle cycle. There is no `transient` column and no alarm sweep of this table. A family isolate that dies before the delete leaves a flag-0 row; the callback returns `undefined` for it. It does not mark an env disconnected.

The bot root conversation (`createBotInternal`) has no parent and no chat row. Coding tools there, if a turn ever runs on it, use the bot default.

`SqliteFamilyStore.ensureSchema` backfills chats that already exist when this table appears. `createChatInternal` does not run for them. Without a row, step 2 treats that conversation as the bot root, and a later `chat.update` override would not apply.

```sql
INSERT OR IGNORE INTO cadmus_chat_conversations (conversation_id, chat_key, bot_id, tools_env_enabled)
SELECT conversation_id, key, bot_id, 1 FROM cadmus_chats;
```

The column is `tools_env_enabled`. `INSERT OR IGNORE` is idempotent on the conversation primary key. This statement does not read `cadmus_pi_*`. A fork that already existed at deploy has no route and resolves as the bot root. Forks created after deploy are copied by `conversationCreated`. No chat override exists before this table, so those old forks were already on the bot scope.

---

## `EnvTarget.cwd` is the bot id

pi-bot sets the agent cwd to the bot id, not a filesystem path. `createBotInternal` passes `cwd: slug` and `createChatInternal` passes `cwd: bot.id` ([`src/family-do.ts`](../../../src/family-do.ts)). `toolGateExtension` resolves the bot with `agent.cwd` ([`src/extensions/tool-gate.ts`](../../../src/extensions/tool-gate.ts)). Knowledge tools and harvest do the same. Keep that. Do not `configure` the agent cwd to a workspace path; the gate would stop treating the conversation as a bot.

| | Value | Who reads it |
| :--- | :--- | :--- |
| `AgentDoc.cwd` / `EnvTarget.cwd` | Bot id (slug), today | Tool gate, knowledge tools, the `env` callback's bot lookup |
| `ExecutionEnv.cwd` | Real workspace root inside that env | `bash` (`requireEnv(api).cwd` in `dist/tools/bash.js`), `read` / `write` / `edit` via `absolutePath` |

The callback maps bot id + chat → effective binding → a proxy whose **own** `cwd` is:

| Kind | `ExecutionEnv.cwd` |
| :--- | :--- |
| `just-bash` | Virtual absolute root `/workspace` for that namespace's VFS. The bot id is not a directory in the VFS. |
| `local-daemon`, `persist` true (default on the env definition) | `workspacePath` on the owner machine. The daemon's `NodeExecutionEnv` is constructed with `{ cwd: workspacePath }`. The proxy reports that same `cwd`. Every bot that references this `envId` sees this folder. |
| `local-daemon`, `persist` false | A subfolder `${workspacePath}/.cadmus-ephemeral` belonging to that env. The daemon creates it when missing. A new process empties it on first construct; a later socket from that process reuses it. Deleting the env, or flipping `persist`, follows [workspace-persistence.md](./workspace-persistence.md). Unbinding one bot does not. The parent folder stays. |

Relative tool paths (`notes/out.txt`) resolve against `ExecutionEnv.cwd`. The string in `EnvTarget.cwd` is never joined onto that path.

A future `configure({ cwd: "/some/path" })` would miss the bot row and the callback would return `undefined`. That is the signal to keep cwd as the bot id.

---

## `ExecutionEnv.id` (one id per workspace)

pi-durable: equal ids see the same files at the same paths, whatever their `cwd`. `edit` / `write` also use the id as the mutation-queue key. The proxy sets:

| Env | `id` |
| :--- | :--- |
| just-bash, `sharedWorkspace` false, bot scope | `just-bash:<accountId>:<envId>:<familyId>:bot:<botId>` |
| just-bash, `sharedWorkspace` false, chat scope | `just-bash:<accountId>:<envId>:<familyId>:chat:<chatKey>` |
| just-bash, `sharedWorkspace` true, bot scope | `just-bash:<accountId>:<envId>:shared:bot:<botId>` |
| just-bash, `sharedWorkspace` true, chat scope | `just-bash:<accountId>:<envId>:shared:chat:<chatKey>` |
| remote daemon proxy | `daemon:<accountId>:<envId>` |

`accountId` is in every id because the mutation queue is isolate-global. `familyId` is not globally unique: requests with no family header use `"default"` ([`authenticateRequest`](../../../src/auth.ts)), and [`resolveOrEnsureFamily`](../../../src/index.ts) creates that family per account (`cadmus_families` primary key is `(account_id, family_id)`). Two accounts with family `default` and bot slug `assistant` must not share a queue key. The id is opaque. Do not parse it by splitting on `:`. Chat keys contain colons. SQLite namespaces use columns (`family_id`, `scope`) and do not include `accountId`. One env DO is one account env. The daemon id does not include `familyId`: every family that references the env shares the key when those family DOs happen to share an isolate. They still may not. Cross-isolate ordering is the env DO's per-path queue (decision 15), not this `Map`. A shared just-bash id also omits `familyId`, so two families that share an isolate share the harness queue key for that scope. Private just-bash ids include `familyId` because those namespaces are different files.

Consequences:

- Two chats that inherit one bot just-bash env share one id, so they share one namespace and serialize writes of the same path.
- A chat that sets its own `envId` does not share that id. A file written in the planning chat is absent from a chat that inherits the default, even when both envs are just-bash, and even when both pins name the same `envId` (the chat pin uses `chat:<chatKey>`).
- Two bots do not share a private just-bash id, including two bots in different families of the same account with the same bot id.
- With `sharedWorkspace: true`, those two families share the `shared:` id and the namespace.
- Every bot and chat that references the same daemon `envId` shares one daemon id. They are the same files. `persist: false` does not add a second id: the ephemeral directory is still that env's workspace. A different env id does not share the queue key even if an operator pointed both definitions at the same host path.
- `NodeExecutionEnv`'s `"node:local"` would collapse every env in the process into one namespace. The proxy sets the `daemon:` id. The process on the laptop keeps `"node:local"`, which is correct there: that process really does see one machine filesystem, and Cadmus does not run `withFileMutationQueue` on the laptop (the daemon calls `NodeExecutionEnv` methods directly; the harness queue runs in the family DO, and the cross-family queue runs in the env DO).

Flipping `persist` on a just-bash env drops the store that the new mode does not use for **every namespace of that env** (see [workspace-persistence.md](./workspace-persistence.md)). The id stays on the namespace. Flipping `persist` on a daemon is an edit of the env definition, one workspace for every reference. Flipping `sharedWorkspace` drops every namespace because the id and the primary key change.

---

## Factory and the backend interface **(new)**

`createExecutionEnv(binding, deps) → ExecutionEnv` in `src/tools-env/create-env.ts` **always** returns the proxy (`src/tools-env/proxy-env.ts`). `deps` are the `CADMUS_ENV` namespace, `accountId`, `envId`, `familyId`, scope, `sharedWorkspace`, bot id, and chat key. The type the tools see is `ExecutionEnv` alone: `id`, `cwd`, the file methods, `exec`, `watch`, and `cleanup`.

The env DO picks a backend from the definition's `kind`. The family does not.

```ts
type ConnectionSnapshot = {
  status: "connected" | "disconnected";
  generation?: number;       // WebSocket backend only
  connectedAt?: number;
  disconnectedAt?: number;
  lastError?: string;
};

interface ToolsEnvBackend {
  readonly kind: "just-bash" | "ws-remote";
  getConnection(): ConnectionSnapshot;
  // ExecutionEnv surface the DO invokes after the pre-op limit check
  // and, for mutating file ops, after the per-path queue:
  // cwd, reads, writes, list, exists, readers, exec, watch, cleanup.
}
```

| Backend | Lifecycle | Status |
| :--- | :--- | :--- |
| `just-bash` (phase 1) | Interpreter and VFS inside this DO. No socket. | `getConnection()` always returns `{ status: "connected" }`. No generation, no heartbeat. |
| `ws-remote` (phase 3) | One WebSocket to the daemon or a future manager. Upgrade, supersede, heartbeat while `inFlight > 0`, generation CAS. | Reads and writes `cadmus_env_connection`. |
| Later [issue #16](https://github.com/liorm/pi-bot/issues/16) manager | Another backend behind this same DO. Spawn and destroy stay inside the DO. | If it keeps a connection, it uses the WebSocket lifecycle. The family still sees the proxy. |

RPC surface the proxy calls, on every kind:

- `getConnection(): ConnectionSnapshot`
- One method RPC per `ExecutionEnv` operation, carrying `caller: { familyId, botId, chatKey: string | null }` and the namespace (`familyId`, `scope`, `sharedWorkspace`). Exec `onOutput` and watch events stream on that RPC.
- `deleteNamespace` / `deleteNamespacesForBot` / `applyConfig` for lifecycle, not for tool calls.

The in-flight registry lives on the env DO for every backend. A method RPC enters it before the backend runs and leaves it when the result is sent. The heartbeat timer is armed only by the `ws-remote` backend, and only while that registry is non-empty. A just-bash DO never sends `heartbeat`.

Application results pass through with no status change. A failed RPC (the DO reset mid-call, or the WebSocket backend synthesized a transport error) uses `ExecutionError` code `shell_unavailable` or `FileError` code `unknown` with message prefix `tools-env transport:`. The same classes and the same prefix for every backend. just-bash has no heartbeat miss and no socket close. A just-bash `FileError` / `ExecutionError` from the interpreter does not use the prefix and does not invent a connection row.

`CadmusServices` ([`src/context.ts`](../../../src/context.ts)) gains `getAccountDefaultToolsEnv(): { envId: string } | null` in phase 1. The factory does not decrypt D1 on the tool path. just-bash has no secret. The daemon was authenticated at upgrade by `token_hash`. The family loads non-secret definition fields from the cached catalog. `workspacePath` for the proxy's `cwd` comes from that cache.

---

## Accounting hook **(new)**

Minimal, on the env DO only. Phase 1 records counters. It does not add a product quota beyond the 8 MiB namespace cap, and it does not export them.

Counted, per completed op:

| Field | What |
| :--- | :--- |
| `ops` | One per op, split by kind: `read`, `write`, `exec`, `other`. File reads, list, and `exists` are `read`. `writeFile`, `appendFile`, `truncateFile`, `renameFile`, `createDir`, `remove`, and the write half of `edit` are `write`. `exec` is `exec`. `watch` and `cleanup` are `other`. |
| `bytes_read` / `bytes_written` | File bytes only. Bash stdout is not added here. |
| `bash_runtime_ms` | Wall time of `exec` inside the backend. |
| `errors` | One when the result is a `FileError` or `ExecutionError`, including transport-class errors. |

Key: this DO is already one env. The row is also keyed by caller `family_id`, `bot_id`, and `chat_key` (`''` when the turn has no chat). Bot-root and harvest never call in, so they do not get rows.

Stored in env DO SQLite:

```text
cadmus_env_usage (
  grain TEXT NOT NULL,            -- hour | day
  bucket_start INTEGER NOT NULL,  -- UTC epoch of that hour or day
  family_id TEXT NOT NULL,
  bot_id TEXT NOT NULL,
  chat_key TEXT NOT NULL,
  op_kind TEXT NOT NULL,          -- read | write | exec | other
  ops INTEGER NOT NULL,
  bytes_read INTEGER NOT NULL,
  bytes_written INTEGER NOT NULL,
  bash_runtime_ms INTEGER NOT NULL,
  errors INTEGER NOT NULL,
  PRIMARY KEY (grain, bucket_start, family_id, bot_id, chat_key, op_kind)
)
```

Phase 1 upserts the hour row and the day row in the same turn, after the op. A counter failure is logged and does not fail the op. There is no client RPC to read the table in this plan. A test reads it through the env DO's storage. Optional later: export the rollup to D1 or Analytics Engine. Not a phase here.

Limits hook in before the backend runs: `checkOpLimits(caller, opKind)` on the env DO. Phase 1 returns allowed. A later limit reads `cadmus_env_usage` for the current hour or day and rejects the op before the per-path queue and before the interpreter or the socket frame. The 8 MiB cap stays in the just-bash write path, not in this function.

---

## just-bash backend

JavaScript bash interpreter **inside `CadmusEnvDO`**. No network, no host agent. The package is an implementation detail; it is not in the repo today. One interpreter per namespace. Namespaces do not share a filesystem.

The object behind the proxy must be a real `ExecutionEnv`, because [sequencing.md](./sequencing.md) runs `createEnvConformance` against the proxy pointed at this DO:

| Concern | Behavior |
| :--- | :--- |
| `exec(string)` | Interpreter runs the script. Honor `onOutput` (`stdout` / `stderr` separately), `timeout`, abort, and `window` / `skipped` so the conformance tail test passes. Chunks stream on the open DO RPC. |
| `exec(argv)` | `shell` option `["bash", "-c"]` (or `["sh", "-c"]`) runs the next argument in the interpreter. Any other program, and an empty argv, returns `ExecutionError` code `spawn_error`. Do not spawn host processes. |
| Files | `read*` / `writeFile` / `appendFile` / `truncateFile` / `renameFile` / `listDir` / `openDirReader` / `openBinaryReader` / `openTextLineReader` / temp files / `exists` / `createDir` / `remove` / path helpers. `listFiles` may be omitted (`createEnvConformance` option `listFiles: false`). |
| Symlinks | Conformance uses the suite default `symlinks: true`. `FileSystem` has no symlink method (`dist/env/index.d.ts`). The suite creates links by `exec` of `ln -s`, as one script with `&&` and relative targets (`target.txt`, `sub`, `../data/real.md` in `dist/testing/env-conformance.js`). The interpreter implements that. Readers follow a link unless `noFollow` refuses the final component (`openBinaryReader` returns `invalid`). Earlier components still resolve. |
| `watch` | Required by the suite (`timeoutMs` 30s). Mode `"polling"` inside the env DO: the VFS has no host watcher. Mutations through backend methods and through the interpreter notify active watchers in this DO. The proxy forwards those events on the open RPC. Each suite step waits about 3s (`expectChange`), so a poll has to report inside that window. Watching a symlink reports that watched path when the target file changes. |
| `id` / `cwd` | As above. The proxy sets `id`. `cleanup` drops the in-memory map entry for this namespace. It does not drop SQLite rows; unbind does that via `deleteNamespace`. |
| Reachability | Always `connected`. The call still enters the in-flight registry. No heartbeat, no `cadmus_env_connection` row, no generation, no alarm. |
| Cloudflare | Workers CPU for the interpreter is the env DO's budget. The family's wait is the RPC. The backend's own timeout is 5 seconds when `bash` passes none. That becomes `ExecutionError` code `timeout`, which is an application result. |

Mutating file ops take the env DO per-path queue before the backend runs (decision 15). `exec` does not.

---

## Remote env and the daemon

A process on the owner's machine **dials out**. The cloud never opens an inbound port on the LAN. The family DO returns the same proxy it returns for just-bash. That proxy forwards file and shell ops to `CadmusEnvDO` over DO RPC. The `ws-remote` backend forwards them over its one WebSocket. The daemon wraps `new NodeExecutionEnv({ cwd })` rooted at the env's folder. The family holds no daemon socket. Phase 3 adds this backend. Phase 1's DO class is already there; a daemon `envId` is rejected until phase 2 stores the row, and phase 2's `getConnection()` stays `disconnected` until phase 3 accepts a socket.

### Transport

Existing `/ws` is the protocol client socket on `CadmusBotFamilyDO`. [`src/index.ts`](../../../src/index.ts) runs `authenticateRequest` ([`src/auth.ts`](../../../src/auth.ts)), then any `Upgrade: websocket` is forwarded as pathname `/ws`. The family DO repeats that match (`pathname === "/ws" || Upgrade === "websocket"`) and `acceptWebSocket(server)` with **no tags** ([`src/family-do.ts`](../../../src/family-do.ts)). `broadcastEvent` calls `getWebSockets()` with no tag. That path stays the protocol path. Daemon sockets are not accepted there, so phase 3 does not retag `/ws` as `protocol-client` and does not filter `broadcastEvent`. A tag filter that skipped untagged sockets would silence today's clients.

The daemon dials the **env DO**, not the family. Bots stay rows in family SQLite. The URL does not carry `familyId`, `botId`, or `chatKey`.

**(new) transport:**

1. One socket per account env. URL: `wss://<cadmus>/tools-env/ws?envId=<envId>`. `Authorization: Bearer <daemon token>`. When this process will confine the session, the upgrade also sends `X-Cadmus-Env-Capabilities: confinement`. One process keeps one connection. Bots do not dial. Families do not dial. Every family that references the `envId` shares this socket via RPC. A just-bash env has no URL.
2. Handle `/tools-env/ws` **before** `authenticateRequest`. A daemon token is not a user token and would 401. Before `SHA-256` or D1, require `GET` and `Upgrade: websocket` (`426` otherwise) and a bearer of `cadmus_dt_` plus 64 hex characters (`401` otherwise). Anything else does not touch D1. Look up `SHA-256(token)` in `cadmus_tools_env_secrets.token_hash` (indexed, `kind = daemon_token`). The row supplies `account_id` and `secret_id`. Load `cadmus_tools_envs` for that account and `envId`. Unknown env is `404`. The row's `kind` must be `local-daemon` (`404` for a just-bash env). `secret_id` on the env must equal the token row (`403` otherwise). Do not decrypt on this path. Do not consult `cadmus_families` for this route.
3. Forward to `CadmusEnvDO` id `env:<accountId>:<envId>` (binding `CADMUS_ENV`), pathname `/tools-env/ws`. [`forwardToFamilyDO`](../../../src/index.ts) is the wrong target. A sibling helper copies `originalRequest.headers`, deletes every inbound header whose name starts with `X-Cadmus-`, then sets `X-Cadmus-Account-Id` from the token row and `X-Cadmus-Tools-Env-Secret-Id` from that same row. After the strip, it sets `X-Cadmus-Env-Capabilities` from the daemon's upgrade request only when that request listed the token `confinement` (comma-separated; any other token is dropped). The env DO reads the secret only from that header and compares it to the env definition. It reads the capability only from the edge-set header. Both checks run before `acceptWebSocket`. A client cannot keep a forged `X-Cadmus-*` header.
4. Tighten the generic upgrade match in **both** `src/index.ts` and `CadmusBotFamilyDO.fetch` to `url.pathname === "/ws"`. Otherwise a daemon upgrade that missed the route above would land on the family protocol socket.
5. Add `/tools-env/ws` to `assets.run_worker_first` in [`wrangler.jsonc`](../../../wrangler.jsonc) (today `/health`, `/protocol/schema`, `/ws`, `/events`, `/rpc`). SPA fallback would otherwise serve `index.html`. Binding `CADMUS_ENV` / class `CadmusEnvDO` and the SQLite migration land in phase 1 with the just-bash backend, not in phase 3.
6. On the env DO, accept with tag `tools-env-daemon` only. Bump `generation`, write `connected`, and `serializeAttachment({ envId, generation })` in that order, then close any previous socket (`1000`, reason `Superseded`). The old close's generation CAS does not match, so the row stays `connected`. Hibernation keeps the attachment. Reject before `acceptWebSocket`: `401` missing or unknown token, `403` secret mismatch, `404` unknown `envId` or a just-bash env, `409` when the env has `confineToWorkspace: true` and the capability header lacks `confinement` (see [Workspace confinement](#workspace-confinement)). A `409` does not accept and does not disconnect a socket that is already `connected`. When no socket is connected, set `last_error = "confinement_unavailable"` and leave `status = 'disconnected'` without bumping `generation`. Capability is not read from a WebSocket frame. The daemon stops retrying a `409` until config changes ([reachability.md](./reachability.md)).
7. Family `broadcastEvent` is unchanged. Daemon sockets are not in the family DO, so they cannot see chat or turn frames.
8. `webSocketMessage` / `webSocketClose` / `webSocketError` for the daemon run on `CadmusEnvDO`. A frame that is a `ClientCommand` closes `1008` and does not run `executeCommand`. The family DO's `webSocketMessage` stays the protocol path. A current-generation close or error CAS-marks `disconnected` and fails every in-flight call with `env disconnected`. A stale generation does not.
9. Tool calls do not search `getWebSockets` in the family. The family RPC hits the env DO, which sends on its single `OPEN` socket for the attached generation. No D1 decrypt on that path.

The env DO checks that the env definition's `secretId` is the secret just authenticated. That compare is the header against the D1 definition (cached on the env DO, no plaintext token). It is not a per-bot or per-chat check. A bot that is toggled off does not cause a `400` on the upgrade: the socket is shared, and off is a family resolution result.

The daemon is a separate package (proposed `daemon/`, own `package.json`, not in the Worker bundle). It depends on `@earendil-works/pi-durable` and constructs `NodeExecutionEnv`. It may import the wire types from `src/tools-env/wire.ts`. It must not import the Worker entry or the TUI. The TUI rule is unchanged: `tui/src/` imports only `import type` from `../../src/protocol.js`.

### Wire protocol **(new)**

Small JSON frames, not `ClientCommand`. Keep them off `src/protocol.ts` so the TUI and web schema stay UI-facing. One WebSocket, correlated by `id`. Methods match `ExecutionEnv`. The just-bash backend does not speak this protocol.

| Frame | Maps to |
| :--- | :--- |
| `{ id, method, args }` → `{ id, ok, value }` or `{ id, ok: false, error: { kind: "file" \| "exec", code, message, path?, spillPath? } }` | Each `FileSystem` method and `Shell.exec`'s final `Result` |
| `{ id, event: "output", text, stream, skipped? }` | `exec` `onOutput`, in arrival order, while the call is open. Forward `ShellExecOptions.window` and `spill` so the daemon's `NodeExecutionEnv` can omit the tail and spill on the owner machine. |
| `{ id, method: "reader.next" \| "reader.close", readerId }` | `BinaryReader`, `TextLineReader`, `DirReader` sessions opened by a previous call |
| `{ id, method: "watch", targets }` then `{ id, event: "watch", change }` and `{ id, method: "watch.close" }` | `FileSystem.watch`. `NodeExecutionEnv.watch` is native. Proxy it through the env DO to the family RPC. |
| `{ id, method: "heartbeat" }` → `{ id, ok: true }` | App-level heartbeat. The `ws-remote` backend sends it only while `inFlight > 0`. The daemon replies. A missed reply within 30s is `env disconnected`. Idle sockets send nothing. Not an `ExecutionEnv` method. just-bash does not send it. |
| `{ id, method: "cleanup", deleteEphemeral?: true }` | Kill child processes only, matching `NodeExecutionEnv.cleanup` and `Shell.cleanup` ("for its owner's shutdown, never for one request" in `dist/env/index.d.ts`). The harness does not call `cleanup` after a tool turn. The env DO sends this frame when the **env definition** is deleted, or when that definition's `persist` flag changes, before it closes the socket. Unbinding one bot does not. `deleteEphemeral: true` only on delete or on a flip away from `persist: false`, and the daemon removes `.cadmus-ephemeral` only when it has no other live session on that cwd. A new process empties the directory the first time it constructs that cwd. Any other `cleanup` leaves the folder. |

`listFiles` is optional on the interface. `NodeExecutionEnv` does not implement it (pi-durable README, Environment). The proxy omits it. Callers, and the conformance suite with `listFiles: false`, fall back. A daemon that cannot watch returns `FileError` code `not_supported`; the shipped daemon wraps `NodeExecutionEnv` and does watch. Coding tools do not call `watch`. The method exists so the remote object is an `ExecutionEnv` the conformance suite can run.

Inbound frames are checked in `src/tools-env/wire.ts` (kept off `src/protocol.ts`). A text frame longer than 6 MiB closes that daemon socket with `1009` before `JSON.parse`. The ceiling fits one image `reader.read` under pi-durable `DEFAULT_IMAGE_LIMITS` (4.5 MB of base64, `dist/tools/image-processor.js`). Binary payloads on the wire are base64 strings, not JSON arrays of numbers. A frame that fails the schema is dropped for that socket and does not change the connection row, and it does not tear down the env DO. `error.code` must be a `FileErrorCode` or an `ExecutionErrorCode` from `@earendil-works/pi-durable/env` (`dist/env/index.d.ts`). Any other code is a schema failure. The env DO rebuilds `FileError` / `ExecutionError` from a valid payload so `bash` and `getOrThrow` see the same classes they see on a just-bash backend. `id` and `readerId` match calls this socket opened. One socket is one env, shared by every family. An unknown `id` or `readerId` is ignored.

There is no `probe` method. A missing workspace directory is a later `exists` / `read` result (`not_found`), not a dead peer. Confinement is the upgrade header, checked before `acceptWebSocket`.

No reply within the exec budget, or within ~2s for file calls, becomes an error the env DO synthesizes: `ExecutionError` code `shell_unavailable` (exec) or `FileError` code `unknown` (file methods). A missed heartbeat or a socket close uses the same classes with message `tools-env transport: env disconnected`. The prefix, not the code, is how the family tells a synthesized error from a peer reply. The env DO does not add the prefix when it rebuilds a wire error, and it strips a leading `tools-env transport:` from a peer `message` before classifying. A peer that copies the prefix stays an application result and does not CAS the connection row. A script's stdout is not that `message`; `NodeExecutionEnv` maps OS errors into it. The same settle happens earlier when the socket closes or errors: reject that socket's in-flight frames then, and do not leave them pending until the timer. `withFileMutationQueue` has no timeout of its own; this is what runs its `finally`. Any daemon reply is forwarded as that result and does not change connection status. That includes `timeout`, `spawn_error`, `not_found`, a non-zero `exitCode`, `shell_unavailable` (bash or `shellPath` missing in `NodeExecutionEnv.exec`), and `unknown`. See [reachability.md](./reachability.md).

Write/edit-style methods take the env DO's per-path in-memory queue before the frame is sent (decision 15). `exec` does not. Two families editing one path are ordered there. Two `bash` calls are not. The same queue wraps just-bash mutations.

Hibernation does not drop the WebSocket. The attachment (`envId`, `generation`) survives it. Later output or a family RPC wakes the env DO, and the child on the owner machine keeps running. Idle hibernation sends no heartbeat and sets no alarm. The socket does close on an isolate restart, a deploy, a network drop, or a `Superseded` close. The daemon aborts every call that socket still has open and starts its backoff. A superseded close must not flip the new generation to `disconnected`. Toggle-off does not close this socket ([binding-and-config.md](./binding-and-config.md)). `Shell.exec` kills only that command's process tree when `context.abortSignal` fires (`dist/env/index.d.ts`). Readers and watches opened on that socket close with it. `NodeExecutionEnv.cleanup` kills every child that instance still tracks (`dist/env/node.js`). Call it on a drop. One process holds one socket for this env (decision 8). A drop does not delete `.cadmus-ephemeral`. The explicit `cleanup` frame is what env delete and a `persist` flip send before `close`.

The cloud never dials the host; the daemon is the only side that opens the socket. Workspace confinement is the `confineToWorkspace` flag below, not [issue #16](https://github.com/liorm/pi-bot/issues/16).

---

## Workspace confinement

`confineToWorkspace` is a column on `cadmus_tools_envs` (decision 14). Bindings do not carry it. Each provider declares a capability `supportsConfinement`. Validation rejects `true` on a kind that does not support it (`confinement_unsupported`), and does not ignore the flag ([binding-and-config.md](./binding-and-config.md)).

| Kind | `supportsConfinement` | Meaning |
| :--- | :--- | :--- |
| `just-bash` | `true` (implied) | The VFS **is** the whole world the env can see. There is no host. The row stores `true`. `false` is rejected: just-bash cannot unconfine. |
| `local-daemon` | `true` (runtime) | The daemon sends `X-Cadmus-Env-Capabilities: confinement` on the upgrade only when an OS-level mechanism is present and will be used. `true` is stored on the env definition; the daemon enforces it or refuses to start. `false` or omitted: no jail. |
| Future [issue #16](https://github.com/liorm/pi-bot/issues/16) manager | per manager | Docker / microVM isolation is that manager's job. If a kind's `supportsConfinement` is false, `confineToWorkspace: true` is rejected at validation. |

### just-bash

No extra checks. Paths live under `/workspace` inside the namespace. `..`, absolute paths, and symlinks that would leave `/workspace` are `FileError` `invalid` or `not_found` from the VFS itself. `bash` in the interpreter cannot see the host. A private namespace cannot see another family's namespace. A `sharedWorkspace` namespace is one VFS on purpose.

### Daemon (Phase 3)

When `confineToWorkspace` is **true**:

1. **File surface** (every `ExecutionEnv` path: `read*` / `writeFile` / `appendFile` / `truncateFile` / `renameFile` / `listDir` / readers / `exists` / `createDir` / `remove` / `watch` / `stat` if present). `realpath` the path (follow symlinks). If the resolved path is outside `workspacePath` (including via `..`, an absolute path, or a symlink that escapes), return `FileError` code `permission_denied` with that path. Do this in the daemon before `NodeExecutionEnv`, so a wire call cannot skip it.
2. **`exec` cwd.** Construct `NodeExecutionEnv` with `{ cwd: workspacePath }` (or the ephemeral subfolder). If a later cwd would leave the workspace, refuse with `ExecutionError` `spawn_error` (or `permission_denied` on a file-like cwd helper).
3. **`bash` / `exec(string)` is not confined by path checks.** An arbitrary shell can `cd /` or open `/etc/passwd`. This plan does **not** claim a realpath jail confines `bash`. For `confineToWorkspace: true` the daemon must wrap `exec` in an OS-level mechanism when one is available:
   - Linux: bubblewrap (`bwrap`) bind-mounting `workspacePath` as the sandbox root, and/or landlock, and/or a user namespace.
   - macOS: `sandbox-exec`.
   - Send `X-Cadmus-Env-Capabilities: confinement` on the upgrade request only when that mechanism is present and will be used. Do not put the capability on a heartbeat frame or any other WebSocket frame.
4. **Refuse rather than a weaker mode.** If the env has `confineToWorkspace: true` and the mechanism is unavailable, the daemon **does not start** that session (exit with a clear error at process start when the flag is on the command line, and do not open the socket). The env DO rejects the upgrade with `409` **before** `acceptWebSocket` when `X-Cadmus-Env-Capabilities` does not include `confinement`. Frames cannot decide that status: the 101 completes only after the DO accepts. On that `409`, if a socket is already connected, leave the row alone. If none is, set `last_error = "confinement_unavailable"` and leave `disconnected` without bumping `generation`. The daemon does not retry until config changes. There is no documented best-effort "path checks only" mode for `bash`: that would claim a jail the shell can leave.

When `confineToWorkspace` is **false** or omitted: do not realpath-jail, do not require bwrap / sandbox-exec. The daemon prints **one line at startup**: it runs as that OS user, and `workspacePath` is the working directory, not a sandbox. That warning is **only** for confinement off. The trust boundary is then the OS user the operator started.

Flipping `confineToWorkspace` on a daemon edits the env definition. The next upgrade enforces it. Bots are not rewritten. just-bash stores `true` only, so there is no confine flip to drop a VFS for. `sharedWorkspace` and `persist` flips are the just-bash drops ([workspace-persistence.md](./workspace-persistence.md)).

Full isolation (containers, microVMs, network/resource limits) remains [issue #16](https://github.com/liorm/pi-bot/issues/16).

---

## Extension point ([issue #16](https://github.com/liorm/pi-bot/issues/16))

A Docker / microVM sandbox manager is another `ToolsEnvBackend` inside `CadmusEnvDO`. The family `env` callback stays the proxy. The manager does not add tools. A manager that keeps a connection uses the `ws-remote` lifecycle: one socket, proactive backoff, heartbeat only while calls are in flight, generation CAS. Extra secrets (registry credentials and similar) are separate D1 secret kinds ([binding-and-config.md](./binding-and-config.md)). This plan does not add those kinds. Confinement of just-bash and `local-daemon` is the section above, not this issue.

---

## Lifecycle

| Event | just-bash env DO | local-daemon env DO |
| :--- | :--- | :--- |
| Bind bot or chat on | Validate `envId` on the account and `kind = just-bash`. Reuse the namespace when the scope and `envId` are unchanged. Always `connected`. | Validate `envId` and `kind = local-daemon`. Do not open a socket from the family. Status is whatever `cadmus_env_connection` already says (`disconnected` until the daemon accepts). Phase 2 has no acceptor yet, so the throw stays. Chat settings are not rewritten. |
| Daemon upgrade | The route answers `404`. | Accept on `CadmusEnvDO` → `connected`, generation bumped. Missing confinement token while the env requires it → `409` before accept. |
| Toggle off (`{ enabled: false }`) | Keep the namespace. A call that starts after the toggle gets `undefined`. | Keep the folder. Do not close the shared socket. Do not CAS the connection row. An in-flight call finishes. The next call on this conversation gets `undefined`. Other families keep using the env. |
| Toggle on after off | Namespace still there. | Same reference. If the daemon is connected, the next call runs. If not, the callback throws offline until the daemon reconnects. |
| Tool call (resolved on) | Callback returns the proxy. The DO runs the just-bash backend for that namespace. | Callback returns the proxy, or throws offline when `getConnection()` is `disconnected`. |
| Tool call (resolved off) | Callback returns `undefined`. Coding tools are not offered. | Same. |
| Transport failure | That call's transport-class error. No connection row, no alarm. The next call tries again. Status stays `connected`. | CAS `disconnected` for the current generation. In-flight calls on every family fail with `env disconnected`. The daemon reconnects on its backoff. |
| Application error | Stay `connected`. Non-zero exit, `timeout`, `spawn_error`, `not_found`, cap `invalid`. | Same. The connection row stays `connected`. |
| Heartbeat | None. The in-flight registry still tracks the RPC. | Only while calls are in flight. None when idle. No alarm. |
| Clear to inherit (`toolsEnv: null`) | RPC `deleteNamespace` for that chat scope. Later calls use the bot namespace. | Drop the reference only. Do not `cleanup`, do not close the socket, do not delete the env's folder. Other references keep it. |
| `bot.delete` / `chat.delete` | RPC `deleteNamespacesForBot` or `deleteNamespace`. | Drop references in that family. The env DO and the socket stay while the env definition exists. |
| Delete the env definition | Drop the DO's VFS, usage rows, and map for that env. | Env DO sends `cleanup` (`deleteEphemeral` when `persist` is false), closes the socket, CAS-disconnects. In-flight calls fail. |
| `persist` or `sharedWorkspace` update | `applyConfig` drops the store the new mode does not use, or every namespace when sharing changes. | `persist` flip sends `cleanup` as above. `sharedWorkspace` is rejected on this kind. |

---

## Logging

Use `getLogger()` in [`src/log.ts`](../../../src/log.ts) with `.child(familyFields(...))` / `chatFields(...)` on the family path, and `envId` plus `generation` (when the backend has one) on the env DO. Never `console.*`. Log kind, bot id, chat key, method, connection status, and error code — not daemon tokens, command text, or file bodies. The just-bash backend logs on the env DO. The family logs the RPC, not the file bytes.
