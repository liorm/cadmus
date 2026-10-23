# Tools-env Reachability

**Supersedes decision 1 (2026-10-21, Lior).** The 20 Oct 2026 decision — per-scope reachability in `CadmusBotFamilyDO`, DO-alarm probes, a short backoff for just-bash and for a connected daemon, and three 300s probes then `next_probe_at = NULL` for a disconnected daemon — is withdrawn. The cloud does not probe and does not recover an environment. There is no probe frame, no probe ladder, no `next_probe_at`, no `probe_attempt`, no probe-only alarm, and no third source in `syncDurableObjectAlarm`. Family alarms stay schedules and harvest only ([`src/alarms.ts`](../../../src/alarms.ts)). There is no Worker cron.

The daemon, and every future env manager that keeps a connection ([issue #16](https://github.com/liorm/pi-bot/issues/16)), is **proactive**. It reconnects by itself. Reconnect means ready: the connection row is `connected`.

**Unify (decision 16).** just-bash is a backend inside the same `CadmusEnvDO` as a daemon (`env:<accountId>:<envId>`). It is always `connected`. It has no socket, no heartbeat, and no `cadmus_env_connection` row. It uses the same RPC surface, the same in-flight registry, and the same `FileError` / `ExecutionError` shapes as the WebSocket backend. The socket, heartbeat, and generation rules below apply to the `ws-remote` backend only.

While a daemon env is disconnected, the bot stays fully usable: `turn.submit`, soul/memory/knowledge tools, `cadmus.schedule` user schedules, idle harvest (`harvest:<chatKey>`). Coding-tool calls that resolve to that env fail with the offline error below. A planning chat whose `envId` is just-bash still runs `bash` (that call RPCs the just-bash env DO). A sibling chat that resolves to the disconnected daemon sees the offline error.

---

## Off returns `undefined`. Offline throws.

pi-durable: no `env` option, or a callback that returns `undefined`, makes built-in tools fail with `Error("No execution environment is configured")` (`requireEnv` in `dist/tools/env.js`). A throw from the callback is caught around `runtime.env()` and becomes that call's error result (`dist/harness/tool.js`). The message is the thrown message.

| Situation | Callback | What the model sees |
| :--- | :--- | :--- |
| Resolved env **off**, or no binding (every level inherit and account default unset; or cwd is not a bot id) | Return `undefined` | Coding tools are not offered. If a call still happens: `No execution environment is configured` |
| Resolved **just-bash** | Return the proxy. `getConnection()` is `connected`. | The call runs on the just-bash backend inside that env DO. |
| Resolved **local-daemon** (or a later connected manager) and the env DO reports `disconnected`, or the env DO has no connection row yet | Throw `Error("The tools env for this chat is offline (env disconnected). Chat, memory, knowledge, and schedules still work. Do not retry; the environment reconnects on its own.")` | That sentence |
| Call already in flight, then the socket dies, a heartbeat is missed, or the env DO RPC fails | The proxy returns a transport-class `ExecutionError` or `FileError` (below) | `tools-env transport: env disconnected` |

Off is "no env" for this conversation, the same as unbound: the harness callback returns `undefined`. That is why off does not throw the offline sentence — there is no env to recover, and coding tools are not offered. The throw is reserved for a binding that exists and is down (the model still sees the four names while on). Returning `undefined` for disconnected would collapse "off" and "daemon is down" into the same pi-durable string. A just-bash definition is not down.

The family does not discover disconnect by probing. It asks `CadmusEnvDO` with one RPC when it is about to build an env (turn preparation, the `env` callback, `/status`, `bot.get` / `chat.get`). Disconnected → throw, before any wire frame. That is fail-fast. There is no cloud-initiated recovery. just-bash takes this same RPC and receives `connected`.

A disconnect **during** a call that already started is not this throw. The env DO fails that call with a transport-class error, message `tools-env transport: env disconnected`. `exec` uses `ExecutionError` code `shell_unavailable`. A file method uses `FileError` code `unknown`. The prefix is still the signal that the DO synthesized the error ([execution-env.md](./execution-env.md)). The same classification as before: a peer reply without that prefix is an application result and does not change connection status. A wire `shell_unavailable` (bash missing in `NodeExecutionEnv.exec`) and a wire `FileError` `unknown` stay application. A just-bash interpreter error is application and leaves status `connected`. An RPC that dies because the env DO reset is transport, for every backend, and just-bash still has no row to CAS.

Prompt preparation catches the offline throw and still sends the turn (`dist/harness/generation.js`). `initHarness` logs that sentence at `debug`. Other reports stay `warn`. Tool execution stores the throw as the tool result and does not report it.

---

## `CadmusEnvDO` **(new)** — one DO per account env

Envs are per account and can be shared across bot families. Connection state does **not** live in `CadmusBotFamilyDO`. There is no family table `cadmus_tools_env_connections`, no `cadmus_tools_env_fs`, and no daemon socket on the family DO. just-bash VFS and the usage rollup live on this DO ([workspace-persistence.md](./workspace-persistence.md), [execution-env.md](./execution-env.md)).

**(new)** Durable Object class `CadmusEnvDO`, binding `CADMUS_ENV`, instance name `env:<accountId>:<envId>`. SQLite class, same `cadmus_` prefix rule as the family DO. Phase 1 creates the class for the just-bash backend. Phase 3 adds the WebSocket backend on the same class. It owns:

- The backend for this definition: just-bash (interpreter and VFS) or, in phase 3, one WebSocket from the daemon or a future env manager. One socket per daemon env, not per family, bot, or chat. A just-bash env has no socket.
- The upgrade for `GET /tools-env/ws?envId=<envId>`, phase 3, and only when `kind` is `local-daemon`. Auth runs once at the edge (bearer shape, then `token_hash`). The edge strips inbound `X-Cadmus-*`, sets `X-Cadmus-Tools-Env-Secret-Id` from the token row, and copies `X-Cadmus-Env-Capabilities: confinement` only when the daemon listed that token. It forwards to this DO, not to `cadmus:${accountId}:${familyId}`. The DO compares the secret header to the env definition and, when `confineToWorkspace` is true, requires the capability token, both before `acceptWebSocket`.
- The connection row in **this** DO's SQLite, for the WebSocket backend only.
- The in-flight call registry for every family that is using the env, for every backend.
- The 30s heartbeat, armed only for the WebSocket backend while that registry is non-empty.
- The per-path mutation queue (decision 15), for every backend.
- `cadmus_env_usage` (the accounting hook).

The env **definition** (kind, label, `workspacePath`, `persist`, `confineToWorkspace`, `sharedWorkspace`, pairing `secretId`) is account-scoped in D1 `cadmus_tools_envs`, next to accounts and credentials. Encrypted secret bytes stay in `cadmus_tools_env_secrets`. Bots and chats store `{ envId }`, not a copy of that config ([binding-and-config.md](./binding-and-config.md)).

The family harness callback returns an `ExecutionEnv` proxy for every kind. The proxy forwards filesystem and shell ops to the env DO over Durable Object RPC. The WebSocket backend forwards them over the WebSocket to the daemon. The just-bash backend runs them in this DO. The family holds no socket, no connection row, and no VFS.

Hibernation attachments live on the env DO for the daemon socket. On accept, `serializeAttachment` stores `{ envId, generation }` on that socket. Tags and the attachment survive hibernation. The family DO's protocol `/ws` path is unchanged and is not tagged in order to hide daemon sockets, because those sockets are not in the family DO. A just-bash DO can hibernate when no RPC is in flight. It has no socket to pin it.

### Connection row

One row per **WebSocket** env DO. just-bash does not insert a row. `getConnection()` on a just-bash DO returns `{ status: "connected" }` without reading this table.

```text
cadmus_env_connection (
  env_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,             -- connected | disconnected
  generation INTEGER NOT NULL,      -- monotonic; bumped on every successful accept
  connected_at INTEGER,
  disconnected_at INTEGER,
  last_error TEXT
)
```

`connected` is what earlier drafts called `ready`. `disconnected` is what they called `unreachable`. Those older words are not stored.

Bots and chats do not have a copy of this row. Their reachability is **derived** by reading it (family RPC `getConnection()`). One reconnect updates one row, and every family that references the `envId` sees `connected` on its next read.

There is no `cadmus_tools_env_state` on the family DO. Persist and sharing are columns on the D1 definition. A `persist` or `sharedWorkspace` change is `applyConfig` on the env DO ([workspace-persistence.md](./workspace-persistence.md)).

### Generation CAS

Every successful daemon accept bumps the generation and writes `connected` in **one** statement, then attaches that generation to the socket:

```sql
UPDATE cadmus_env_connection
SET status = 'connected',
    generation = generation + 1,
    connected_at = ?,
    disconnected_at = NULL,
    last_error = NULL
WHERE env_id = ?;
```

Insert `generation = 1` when the row is absent, in the same turn, still one write. Read the new generation back and `serializeAttachment` it before any other await.

Every disconnect write is a compare-and-swap on the generation the writer observed (the socket attachment, or the generation a tool call captured when it sent its frame):

```sql
UPDATE cadmus_env_connection
SET status = 'disconnected',
    disconnected_at = ?,
    last_error = ?
WHERE env_id = ? AND generation = ?;
```

Zero rows means discard. A stale disconnect from an old socket, or from a chat's tool call that started before a reconnect, cannot override a newer connect.

A new connect for the same env supersedes any older socket: bump and attach first, then `close` the previous socket (`1000`, reason `Superseded`). The old socket's `webSocketClose` runs the CAS with **its** attachment generation, which no longer matches, so the row stays `connected`.

The DO input and output gates are single-threaded. That is not enough. An await yields: a tool RPC can be waiting on the daemon while an upgrade or a `webSocketClose` runs. The CAS is the race control. just-bash has no generation to CAS.

### Rejected shapes

- **Per bot or per chat session.** A reconnect would write every bot and chat that uses the env, and each of those writes can race a tool call. One row, one update.
- **Per family DO.** The env is shared across families. A family row would duplicate the socket and the status, and the families would disagree after one of them reconnects. A per-family just-bash VFS would split the same way. Namespaces inside one env DO are the isolation boundary, not a second DO per family.
- **just-bash without an env DO.** The callback would return a different object per kind, and accounting, limits, and the per-path queue would have two homes.

---

## Heartbeat — only while daemon calls are in flight

Idle sockets send nothing. No heartbeat, no alarm, no ping. The env DO may hibernate with the WebSocket attached. That is the hibernation-friendly case. A just-bash env never starts this timer, even when its in-flight registry is non-empty. The registry still tracks those RPCs so a DO failure fails them with the transport error.

While `inFlight > 0` on a `ws-remote` backend, counted across **all** families, the env DO sends an application frame `{ id, method: "heartbeat" }` every 30s. The daemon replies `{ id, ok: true }` on that id. The deadline is one interval: no matching reply within 30s is a missed heartbeat. The DO then closes the socket, rejects every in-flight call (every family) with `tools-env transport: env disconnected`, and CAS-marks `disconnected` with `last_error = "heartbeat_timeout"`.

The timer is a `setTimeout` in the env DO isolate, armed when the WebSocket backend's count goes from 0 to 1 and cleared when it returns to 0. It is **not** `ctx.storage.setAlarm`.

Why a timer and not an alarm: an in-flight family RPC keeps the isolate awake, so hibernation cannot start until the last call returns, and `setTimeout` fires for that whole stretch (including a `bash` longer than 30s, and including calls from other families that hold their own RPCs). When the count hits zero the timer is cleared and nothing is scheduled. An alarm would be a second clock that must be deleted on every idle transition, can fire after the last call if `deleteAlarm` races, and would wake an idle env DO. This design does not wake an idle env. Family `syncDurableObjectAlarm` does not learn about envs.

A WebSocket protocol ping is not the heartbeat. The daemon's reply has to land in the same frame handler as tool results, so a missed reply is visible to the in-flight registry. The runtime may answer a protocol ping on its own.

---

## What marks `disconnected`

Any of these, and only through the CAS above, and only for the WebSocket backend:

| Cause | `last_error` | In-flight calls |
| :--- | :--- | :--- |
| Missed heartbeat | `heartbeat_timeout` | All of them fail with `env disconnected` |
| `webSocketClose` / `webSocketError` for the current generation, or a network failure the DO observes on that socket | `socket_closed` (or the short error text, no tokens) | All of them fail the same way |
| A tool call's own transport timeout or socket error, using the generation captured when that call was sent | `socket_closed` | That call fails; the CAS also drops the connection if the generation is still current, which fails the others |

A superseded close, a close whose generation lost the CAS, and a toggle-off (which does not close this socket) do not change the row.

Application results do not change the row: non-zero exit, `timeout`, `spawn_error`, `not_found`, `permission_denied`, a wire `shell_unavailable`, a wire `unknown`, a just-bash cap `invalid`.

A just-bash RPC that fails because the DO reset returns the transport-class error for that call and does not write `cadmus_env_connection`. The next `getConnection()` is `connected` again.

---

## Daemon backoff

The cloud never dials the laptop. The daemon reconnects on its own.

| Event | Behavior |
| :--- | :--- |
| Network error, socket drop, or a missed upgrade that is not 401 or 409 | Exponential backoff with jitter, capped. First delay 1s, then double, cap 60s, jitter ±20%. Reset the attempt counter after a successful upgrade (`101` and the DO has accepted). |
| HTTP `401` | Stop. The token is rejected. Do not tight-loop. |
| HTTP `409` `confinement_unavailable` | Stop until config changes. Do not retry on a timer. The operator restarts the daemon, or the process reloads config, after `confineToWorkspace` or the OS sandbox mechanism changes. A slow poll would only repeat a rejection the cloud cannot fix. |
| Successful accept | Row is `connected`. The next tool call runs. Reconnect **is** ready. No probe is required first. |

Future managers from issue #16 that keep a connection use this same backoff and the same env DO. This plan does not specify those managers. just-bash has nothing to reconnect.

---

## Toggle-off and confinement

**Toggle-off does not close the env socket and is not a failure.** The 20 Oct rule that toggling a scope off closed that scope's socket assumed one socket per bot or chat. That rule is superseded with decision 1: the socket is per env and shared. Other bots and other families may still be in a call. Toggling one conversation off returns `undefined` for calls that start after the toggle, keeps just-bash namespaces and the daemon folder, and does not CAS the connection row. An in-flight call on that conversation finishes on the proxy it already holds. The tool gate blocks a coding-tool call that has not started. Adding or removing `coding-tools` waits until the next turn preparation ([binding-and-config.md](./binding-and-config.md)).

**Confinement `409`** stays a rejection at upgrade, before `acceptWebSocket`. No WebSocket frame carries the capability. When the reject happens and a socket is already `connected`, leave that row alone (do not disconnect a live peer). When no socket is connected, set `last_error = "confinement_unavailable"` and leave `status = 'disconnected'` without bumping `generation`. The daemon's backoff on `409` stops until config changes, as above. just-bash does not upgrade and does not return `409`. Its confinement is the VFS boundary.

**Secret revoke** is a real close, unlike toggle-off. The edge tells that daemon env's `CadmusEnvDO` to close the socket (`1008`, reason `Pairing secret revoked`) and CAS-disconnect with `last_error = "secret_missing"` if the generation still matches. In-flight calls fail with `env disconnected`. Families are not walked to flip per-bot rows; their next RPC sees `disconnected`. just-bash envs have no secret.

---

## How the family learns, and how the model is told

Pull, on the calls that already need the answer: turn preparation (identity section), the `env` callback, `/status`, `bot.get`, `chat.get`. One `getConnection()` RPC for every kind. A missing daemon row is `disconnected` (the daemon has never accepted). A just-bash DO returns `connected`.

**(optional / later)** the env DO notifies interested families when a daemon's status changes, so the UI can update without a poll. Phase 3 does not build that subscription and does not give the env DO a family-DO binding. Do not block the daemon on it. just-bash has no status transition to notify.

1. **Two identity sections** in `identityExtension` ([builtin-tools.md](./builtin-tools.md)). `tools-env` renders when the resolved env is on, the derived status is `connected`, and a coding tool is offered. `tools-env-unavailable` renders when the resolved env is on, the derived status is `disconnected`, and a coding tool is offered. Off and unbound omit both. just-bash takes the connected section when the tools are offered, because `getConnection()` said so. The unavailable section says the environment reconnects on its own. It does not say the cloud is probing.
2. **Tool result** from the callback throw, or, if the call was already running, from the transport `ExecutionError` / `FileError`. Do not retry; the environment reconnects on its own. That reconnect sentence is for a daemon. A just-bash transport error is still the same prefix if the RPC itself failed.
3. **Do not strip** `bash` / `read` / `write` / `edit` from a conversation whose resolved env is on, even while a daemon env is disconnected. The unavailable section is the prompt signal. It is a snapshot. The call reads status again at `runtime.env()`. A reconnect during the turn can succeed after `tools-env-unavailable` was rendered. A drop during the turn returns the transport error after `tools-env` was rendered. There is no turn-initial gate in `beforeTool`.
4. **`/status`** out-of-band: nested `toolsEnv: { enabled, enabledSource, kind?, envId?, bindingSource?, status?, connectedAt?, lastError? }`. No `nextProbeAt`. `status` is `connected` or `disconnected` when enabled is true and a binding won. Off omits `status`. just-bash reports `connected` and omits `connectedAt` / `lastError`. Protocol fields are camelCase. The connection columns stay snake_case. Still zero transcript entries, zero LLM.

The model is not woken when the daemon reconnects. The next user or schedule turn sees `connected` in the identity section if the pull says so. If a chat is idle, do nothing. Do not inject a synthetic user message.

---

## How the UI is told

`bot.get` / `chat.get` / `account.toolsEnvs.list` show the derived connection: `status`, `connectedAt`, `lastError`. They do not show a next probe time. When `status` is `disconnected` and `lastError` is `confinement_unavailable`, the badge is that config error, not a retry countdown. When `lastError` is `secret_missing`, the badge says the pairing is gone. just-bash shows `connected` from phase 1, with no timestamps.

Phase 2 can list daemon env definitions and bindings. It does not show a live daemon connection, because the WebSocket acceptor arrives in phase 3. Treat a daemon binding as not yet connected; do not render a probe spinner. just-bash rows show `connected`.

A `tools-env.reachability` push event is **optional / later**, with the family notification above. Phase 1 does not emit it. Phase 3 UI reads the pull fields. Daemon sockets are not in the family DO, so they cannot receive `ServerFrame`s from `broadcastEvent`.

---

## Logging

`getLogger()` with `familyFields` / `chatFields` on the family path, and a child with `envId` on the env DO. Fields: `toolsEnvStatus`, `generation` (WebSocket backend), `inFlight`, `providerKind`. No `probeAttempt`, no `nextProbeAt`, no secrets, no command text, no file bodies. `debug` on accept and on a CAS that matches zero rows. `warn` on heartbeat timeout and on a current-generation socket close. Never `console.*`.

---

## Per-path queue (decision 15)

pi-durable still serializes `edit` / `write` inside one harness by `ExecutionEnv.id` (`withFileMutationQueue`). Two family DOs are two harnesses, often two isolates, so that queue does not order a bot in family A against a bot in family B.

**Decision:** the env DO also serializes mutating file ops per canonical path, with an in-memory queue, for **every** backend including just-bash. In the queue: `writeFile`, `appendFile`, `truncateFile`, `renameFile`, `createDir`, `remove`, and the write half of `edit`. Not in the queue: `exec` / `bash`, reads, `exists`, readers, `watch`.

Why: every byte already funnels through this one DO, so the queue is the first place that sees both families. It is memory only, which is enough — if the isolate dies, the in-flight RPCs fail anyway and there is no lock to persist. Bash stays concurrent; shells do not take the file lock. The per-harness queue still runs in front of this one when both calls share an isolate. `ExecutionEnv.id` for a daemon is `daemon:<accountId>:<envId>`, so those harnesses share a key when they do share an isolate. A private just-bash id includes `familyId` and `envId`. A `sharedWorkspace` id uses `shared` in place of `familyId`, so two families that share an isolate also share that harness key. The env DO queue is what orders them when they do not share an isolate.

The queue key is the namespace plus the canonical path. A private namespace includes `family_id`, so two families writing `bot:assistant` `/workspace/a.txt` on one just-bash env do not block each other. A shared namespace does. Daemon paths have no family segment. The 8 MiB check stays one SQLite statement inside the just-bash backend, because different paths are not in one queue ([workspace-persistence.md](./workspace-persistence.md)).
