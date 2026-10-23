# Sequencing Plan

Each phase is independently shippable: it merges with tests, keeps existing bots working (coding tools stay opt-in, so a bot that does not list `bash` / `read` / `write` / `edit` does not see them), and does not require later phases to be useful.

Toolchain is **Bun**. Whole-flow bot tests run the way Cadmus already runs them: `bun run test` → Vitest inside workerd (`e2e/*.test.ts`, `sendRpc` / `connectTestWs` in [`e2e/helpers.ts`](../../../e2e/helpers.ts), `faux/echo`, `runDurableObjectAlarm` from `cloudflare:test`). `ExecutionEnv` conformance for the just-bash **proxy** also runs under that Vitest workerd project, because the subject is `CadmusEnvDO`. The phase 3 daemon wire suite runs under `bun test` via `createEnvConformance` / `registerEnvConformance` from `@earendil-works/pi-durable/testing`. Pure helpers may use `bun test` when they import no Worker/DO types.

No tools-env implementation exists yet. Do not expand scope into `pi-durable` session docs, a second harvest task, or a Cadmus shell tool.

Decision 1's cloud-side probing is superseded (2026-10-21, Lior). No phase arms probes, writes `next_probe_at` / `probe_attempt`, or adds a third source to `syncDurableObjectAlarm`. Family alarms stay schedules and harvest. Decision 16 (same day): every env, including just-bash, is `CadmusEnvDO`. Phase 1 ships that DO, the just-bash backend, the family proxy, the D1 definition, and the accounting hook. The daemon socket, the heartbeat, generation CAS, and `cadmus_env_connection` land in phase 3 on the same class ([reachability.md](./reachability.md)).

---

## Phase 1 — env DO, just-bash backend, proxy, D1 definition

**Ship:** `CadmusEnvDO` (`env:<accountId>:<envId>`) runs the just-bash backend. The family `env` callback returns the proxy for every resolved on binding. Account create inserts `jb_default` (`persist: true`, `confineToWorkspace: true`, `sharedWorkspace: false`) and sets `default_tools_env_json` to `{ envId: "jb_default" }`. A bot can pin `{ enabled: true, binding: { envId } }`, inherit that default, or turn the env **off**. A chat can pin another just-bash `envId`, inherit, or turn **off**. The operator opts in to `bash` / `read` / `write` / `edit`; off still hides those tools. Namespaces live in the env DO (8 MiB cap, retained on off). Identity and `/status` show the effective env and where it came from. Bots that do not list coding tools do not see them, including bots that inherit `jb_default`. Chats with no setting share the bot namespace.

just-bash is always `connected` through `getConnection()`. Phase 1 does not open a daemon socket, does not store `cadmus_env_connection`, and does not arm a heartbeat. The in-flight registry and the per-path queue exist and cover just-bash. There is no family fingerprint table and no family VFS table. The identity chooser that picks `tools-env` vs `tools-env-unavailable` is a pure helper in this phase; every just-bash turn that offers coding tools renders `tools-env`. Phase 1 does not emit `tools-env.reachability`. Family `broadcastEvent` stays today's untagged `getWebSockets()`.

| Work | Touches (planned) |
| :--- | :--- |
| `env` callback on `Harness.open`, always the proxy or `undefined` or the offline throw | `CadmusBotFamilyDO.initHarness` |
| `conversationCreated` copies the chat key and `tools_env_enabled` onto fork conversation ids, synchronous family-store SQL only. `ensureSchema` backfills existing `cadmus_chats` into that table (`tools_env_enabled = 1`) | `initHarness`; `SqliteFamilyStore.ensureSchema`; `ChatStore` route methods |
| Harvest child sets `tools_env_enabled = 0` before submit, and deletes that child route after the fork settles | `executeHarvestFork` |
| `createCodingTools()` installed; `settings.extensions` lists Cadmus extensions without `coding-tools` | `initHarness` |
| `CadmusEnvDO`, binding `CADMUS_ENV`, SQLite migration `new_sqlite_classes: ["CadmusEnvDO"]`, instance `env:<accountId>:<envId>`. just-bash backend, in-flight registry, per-path queue, `cadmus_tools_env_fs`, `cadmus_env_usage`, `checkOpLimits` pass-through | **new** env DO. Document the wrangler binding and migration; this plan set does not edit `wrangler.jsonc` |
| Proxy `ExecutionEnv` | **new** `src/tools-env/` (`create-env`, `proxy-env`, just-bash backend) |
| `cadmus_tools_envs` (just-bash rows), built-in `jb_default`, `default_tools_env_json`, catalog cache, `getAccountDefaultToolsEnv`, `invalidateToolsEnvCatalog` | `D1AdminStore`, `AdminStore`, `AccountRecord`, `account.update`, `account.toolsEnvs.create` / `update` / `delete` / `list` for kind `just-bash` |
| `tools_env_json` on bots and chats. Binding is `{ envId }` only | `SqliteFamilyStore.ensureSchema`, `BotStore`, `ChatStore`. No `cadmus_tools_env_fs` and no `cadmus_tools_env_state` on the family |
| `resolveToolsEnv` pure helper + `ToolsEnvSetting` TypeBox (`{ enabled, binding?: { envId } } \| null`). Phase 1 resolution is chat → bot → account, and the account default is `jb_default` after create. Handlers accept a just-bash `envId` and reject a `local-daemon` id with `unsupported_kind` | `src/protocol/records.ts`, **new** helper, `bot.create` / `bot.update`, `chat.create`, **new** `chat.update`, `create_bot` optional `toolsEnv` |
| Coding-tool gate when `bot.tools` is `undefined` or omits the name, **or** resolved env is off | `src/extensions/tool-gate.ts` |
| New conversations set `extensions: { add: [{ name: "coding-tools" }] }` only if those names are listed **and** resolved env is on, and `{ remove }` otherwise. `bot.update`, `chat.update`, and `invalidateToolsEnvCatalog` do not sweep stored conversations; the next turn preparation compares resolved enabled to the agent's extension selection and `configure`s only when they differ. `toToolRegs` is only the tool filter | `createBotInternal`, `createChatInternal`; turn preparation for later flips |
| Identity sections `tools-env` and `tools-env-unavailable` (chooser helper) + `/status` | `identity.ts`, `handleOutOfBandStatus`. just-bash `/status` reports `status: "connected"` and omits `connectedAt` / `lastError`. No `nextProbeAt` |
| Accounting upsert after each op; `checkOpLimits` returns allowed | env DO |

just-bash script errors, non-zero exits, `timeout`, `spawn_error`, and `not_found` stay `connected`. They are application results. The env ceiling when `bash` omits `timeout` is 5 seconds. The VFS cap is 8 MiB per namespace on the env DO's SQLite and its isolate map. Phase 1's stored kind is `just-bash`. Phase 1 does not retag `/ws` and does not filter `broadcastEvent`.

**Conformance:** `createEnvConformance` against the **proxy** pointed at a just-bash `CadmusEnvDO`, under Vitest workerd (`e2e/tools-env-just-bash.conformance.test.ts`, not `bun test`). `withEnv` must hand each case a fresh empty namespace (unique scope on a dedicated env id) whose `cwd` is `/workspace`, and await the callback once (`dist/testing/env-conformance.d.ts`). Use `persist: false` so cases do not share SQLite rows. `shell: ["bash", "-c"]` (or `sh`) routed at the interpreter, including `ln -s`. `symlinks: true`. `listFiles: false` unless implemented. Watch cases are mandatory (`timeoutMs` 30s, polling inside the env DO, events forwarded on the open RPC, including a watched symlink whose target changed, inside the suite's ~3s step). Register with `registerEnvConformance` and Vitest's `describe` / `it` / `expect`. A second test reopens a `persist: true` env on the env DO and checks one file survives eviction of the caller, and that an 8 MiB cap rejects the next write with `FileError` `invalid`. Two writes of different paths whose sizes each fit and whose sum does not must leave the namespace at or under 8 MiB. Replacing a file counts the new blob only. The in-memory map enforces that same cap. The DO SQLite reopen stays in `e2e/`. Do not use bare `bun test` from the repo root. Bun discovers `e2e/*.test.ts`, and those files import `cloudflare:test`, which exists only in the Vitest workerd run.

**E2E:** `e2e/tools-env-just-bash.test.ts` — unique `accountId` / `familyId`. Account create has already set the default to `jb_default`. `bot.create` with `tools` including `bash`, `read`, `write`, `edit`. Inherit is enough for the bot namespace. A pin is `toolsEnv: { enabled: true, binding: { envId: "jb_default" } }`.

`faux/echo` (`echoResponse` in [`src/models.ts`](../../../src/models.ts)) runs one `[tool:name {...}]` per user message. After that `toolResult`, the next step is the echo summary, not another tool. Each `turn.submit` carries one directive. Phase 1 teaches the matcher to take a balanced JSON object. Today's `\{[\s\S]*?\}` stops at the first `}`, `JSON.parse` throws, and the turn becomes a plain echo, so a `write` body that contains `}` never calls the tool. The change still returns one `fauxToolCall`. It does not chain tools in one turn, and it does not change the harvest or search-bot branches.

- Two chats with no override, one directive per `turn.submit`: `[tool:bash {"command":"echo hi"}]`, then `[tool:write ...]`, `[tool:read ...]`, `[tool:edit ...]`. A file written in one inheriting chat is visible to the other. Assert transcript `turn.tool_result`. The bytes are in the env DO, under `family_id` plus `bot:<botId>`.
- A second just-bash env (`account.toolsEnvs.create`, `persist: true`). A third chat created with `toolsEnv: { enabled: true, binding: { envId } }` (or `chat.update` after create): a file written there is absent from an inheriting chat, and a file on the bot namespace is absent from the chat namespace. Both survive a later turn on the same chat. Pinning the **same** `jb_default` on the chat still uses `chat:<chatKey>`, so it does not see the bot namespace.
- A non-zero command leaves just-bash `connected`. There is no `cadmus_env_connection` row and no family alarm change. `runDurableObjectAlarm` is not how this env recovers.
- Clear the account default to `null`. A bot with `bash` in `tools` and no pin is **not** offered coding tools. A direct `bash` call is gated. If the callback runs, it returns `undefined` (`No execution environment is configured`). Restore the default afterward in tests that need it.
- A bot with `tools: ["memory_read"]` cannot call `bash` (gate), including on a chat that pins a just-bash `envId`.
- A bot with `tools` omitted does not get coding tools offered, and a direct `bash` call is blocked, even though the account default is `jb_default`. A bot whose `tools` lists `bash` **and** whose resolved env is on is offered it because the agent change added the `coding-tools` extension, not because the tool name was listed alone.
- Bot `{ enabled: false }` (binding kept) while `tools` lists `bash`: coding tools are not offered; `env` returns `undefined`. Chat `{ enabled: true, binding: { envId } }` on that bot, `envId` a just-bash env: coding tools are offered and `bash` runs on the **chat** namespace.
- Chat `{ enabled: false }` on a bot that is on: that chat is not offered coding tools; a sibling inheriting chat still is. Toggle that chat off and back `{ enabled: true }` with the same binding: the retained file is still there (do not `deleteNamespace` on off). Family `syncDurableObjectAlarm` is not called for the toggle.
- `bot.update` / `chat.update` that flips resolved enabled does not `configure` other stored conversations in the update turn. The next `turn.submit` on an affected chat is where `coding-tools` is added or removed. A `bash` already running when the toggle to off lands finishes; the following turn is not offered coding tools.
- `bot.create` / `chat.update` `{ enabled: true }` with no `binding`, after the default was cleared → `tools_env_on_without_config`. With the default set, that write resolves to `jb_default`. `account.toolsEnvs.create` with `confineToWorkspace: false` on just-bash is rejected. `true` is accepted. `kind: "local-daemon"` on create is `unsupported_kind`. A binding that carries `persist`, `kind`, `secretId`, or `workspacePath` is rejected.
- Two families of one account, one just-bash env, `sharedWorkspace: false`, both with bot id `assistant`: a file written in family A is absent from family B. Each namespace has its own 8 MiB cap. A second env with `sharedWorkspace: true`: the same scope string in both families sees the same file and shares one 8 MiB cap. Flipping `sharedWorkspace` drops the old namespaces (the previous file is gone).
- After a `write` and a `bash`, `cadmus_env_usage` on that env DO has incremented `ops`, `bytes_written`, and `bash_runtime_ms` for that `family_id` / `bot_id` / `chat_key`, on both `hour` and `day` grains. The other family's counters stay unchanged. An application error increments `errors` and leaves status `connected`.
- A standard schedule fork of the chat pin runs `bash` against the chat namespace, not the bot namespace. Its `cadmus_chat_conversations` row is still there after the fork settles. A harvest fork does not build an env, does not offer coding tools, and its conversation-map row is gone after the fork settles (`e2e/schedules-and-harvest.test.ts` must keep passing).
- `create_bot` with `toolsEnv: { enabled: true, binding: { envId: "jb_default" } }` pins it on. `create_bot` with `{ enabled: false }` pins off. `create_bot` without `toolsEnv` leaves the row null (inherit `jb_default`).
- Clearing the chat pin with `chat.update` `{ toolsEnv: null }` makes the next `bash` on that chat see the bot namespace. The chat namespace in the env DO is gone. That is inherit, not off.
- `account.toolsEnvs.update` that flips `persist` drops the store the new mode does not use. The next write on that env uses the new store. `bot.update` cannot flip `persist`.
- `/status` for an on just-bash chat nests `toolsEnv.status: "connected"`, `kind: "just-bash"`, and `envId`, and has no `nextProbeAt`. Off nests `enabled: false` and omits status.

**Egress mocks:** none. The env DO is local to workerd. The extra hop is DO RPC.

**Done when:** a Cloudflare-hosted family can give a bot a scratch shell through pi-durable's coding tools by RPCing a just-bash env DO, one chat can use a separate namespace, two families on one env stay isolated unless `sharedWorkspace` is set, usage counters move per caller, and bots that do not opt in keep today's tool list.

**Implementation notes (phase 1):**

- VFS rows add a `kind` column (`file`, `dir`, or `symlink`). Symlink targets are stored in `content`. The plan sketch had `is_dir` plus a blob and no symlink kind. The 8 MiB cap counts regular file bytes only. The just-bash default layout is not counted.
- Watch events cross the family proxy by polling `takeWatchEvents`. A live `ReadableStream` from Durable Object RPC does not reliably deliver chunks to the caller. The env DO still polls signatures about every 50 ms and again on each drain.
- Owner defaults applied here: `account.toolsEnvs.list` includes `supportsConfinement` (just-bash is true). `confineToWorkspace: false` on just-bash create or update is `confinement_required`. Turning an env off mid-turn lets the in-flight coding-tool call finish; later coding-tool calls in that turn are blocked by the tool gate.
- A direct `bash` call when coding tools are not selected is rejected by pi-durable as `Tool bash is not available` before the tool gate runs. The gate still returns `Tool 'bash' is disabled for bot '<id>'.` when a selected coding tool is no longer allowed. `account.toolsEnvs.create`, `update`, and `delete` fan `invalidateToolsEnvCatalog` out to other families so a cached catalog does not hide a new env id. That fan-out passes a null previous and next default, so it drops the cache and does not delete namespaces.

---

## Phase 2 — Daemon env rows, secrets, protocol polish, UI

**Ship:** operators can store an account-level daemon token, create an account env definition that points at that token, set the account default to a daemon `envId` or back to `jb_default` or `null`, and see or edit a bot pin and a chat pin without hand-editing JSON. The UI binds `envId`. It shows just-bash as `connected`. It does not show a live daemon connection badge. The env DO class already exists. A turn whose resolved env has `kind: local-daemon` throws the offline error and does not open a socket, because the WebSocket backend is phase 3. `getConnection()` for that row is `disconnected`.

Depends on Phase 1 binding types, the env DO, and `chat.update`.

| Work | Touches |
| :--- | :--- |
| Daemon columns on `cadmus_tools_envs` (`workspace_path`, `secret_id`; `shared_workspace` must stay 0) | `D1AdminStore`, `AdminStore` |
| `cadmus_tools_env_secrets` + AES-GCM, no `family_id` | same |
| `token_hash` on `daemon_token` | same table |
| `account.toolsEnvSecrets.*` | `protocol/commands.ts`, `executeCommand` |
| Web account default + env catalog + `BotModal` pin + coding-tool checkbox | account settings, `web/src/components/BotDirectory.tsx`. The pin is `{ envId }`. `persist` and `sharedWorkspace` are on the env form. No next-probe field and no daemon connection badge |
| Web `NewChatModal` pin + chat header (kind and envId) | `web/src/components/ChatWorkspace.tsx` |
| TUI `:bot` / `:chat` / status line | `tui/src/` type-only protocol import |
| `create_bot` may name an existing daemon `envId` | `internal-tools.ts`. It rejects `token`, `secretId`, `workspacePath`, `persist`, and `kind` on the binding |

**Tests:** e2e credentials-style test (see `e2e/auth-and-account.test.ts`) for set/list/delete (no plaintext in list). `account.toolsEnvSecrets.set` mints `cadmus_dt_` + 64 hex, returns that token once, and rejects a caller-supplied `token`. `daemon_token` rows persist a hash, not the raw token, and have no family column. `account.toolsEnvs.create` for a daemon stores workspace, persist, and `confineToWorkspace` on the env row and a `secretId` that already exists on the account, and rejects `sharedWorkspace: true`. Several daemon rows may share one secret and stay different `envId`s. `account.toolsEnvs.list` returns `jb_default` as a real row, each other env, and `default`. just-bash `connection` is `connected`. Daemon rows omit `connection`. `account.update` with `defaultToolsEnv: { envId: "jb_default" }` makes a bot with a null pin use that env without writing `tools_env_json`, including a bot in a second family of the same account (the handler fans `invalidateToolsEnvCatalog` out; the sibling drops its cache and reloads the default, and does not `configure` stored conversations in that turn. The next turn preparation on an inheriting chat adds or removes `coding-tools` to match the new resolved `enabled`. The fan-out does not call `syncAlarmInternal`). Account on + bot `{ enabled: false }` (binding omitted or kept): inheriting chat is not offered coding tools; `env` returns `undefined`. Bot `{ enabled: true }` with no `binding` uses the account env. Bindings reject `secretId`, `workspacePath`, `persist`, `confineToWorkspace`, and `sharedWorkspace`. Phase 2 stores a daemon `envId`. It does not accept a socket. A `turn.submit` that resolves to that daemon env throws the offline error (`env disconnected` / the environment reconnects on its own). The UI does not render a daemon connection badge or a probe spinner. Web component test pattern in `web/src/components.test.tsx` for the modal payloads (Inherit / On / Off, and a daemon choice that submits `envId` only). Reject a bind with an inline `token`. `chat.get` reports `toolsEnvEnabled`, `toolsEnvEnabledSource`, `effectiveToolsEnv` (kind and config from the definition), and `toolsEnvBindingSource`: `"chat"` for a chat `binding`, `"bot"` when the bot binding wins, `"account"` when both inherit the default, `"unbound"` when none is set. Enabled source is `"chat"` when the chat pins on or off. Deleting a secret in phase 2 removes the secret row, flags daemon env rows that named it, and clears `defaultToolsEnv` when it names one of those envs. There is no socket to revoke yet, and families are not walked to flip per-bot rows. just-bash keeps working.

**Done when:** UI can set the account default, pin `jb_default` or another just-bash env on a bot or a chat, create a daemon env definition, and mint a pairing token that Phase 3's daemon will use. A stored daemon bind fails fast until that phase. just-bash remains usable with no secret and no socket.

**Implementation notes (phase 2):**

- Deleted pairing secrets flag daemon env rows with `secret_missing` and keep `secret_id`. The plan says to flag rows that named the secret, and `cadmus_env_connection.last_error` is phase 3. List adds `secretMissing: true` only when the flag is set. `chat.get` and `bot.get` report `toolsEnvLastError: "secret_missing"` when that daemon env is the resolved on env. `account.toolsEnvs.update` accepts `secretId` and `workspacePath` on a daemon row so the flag can be cleared with a new secret. The phase 2 update sketch listed label, persist, and confinement only.
- The family reports `disconnected` for `local-daemon` without calling `CadmusEnvDO.getConnection()`. That method still returns `connected` for every row. Phase 2 does not open a socket and does not add a socket-count RPC. A daemon turn throws the offline error before `stub()`.
- Daemon env ids use an `ld_` prefix (`jb_` stays just-bash, `jb_default` stays reserved). Secret ids use `hs_`, as in the table sketch.
- Ciphertext uses the existing `encryptJson` helper (`cadmus-byok-v1` and `CADMUS_ENCRYPTION_KEY`). The plan allows reusing that helper or duplicating it with a `cadmus-tools-env-v1` prefix.
- `account.toolsEnvSecrets.set` does not check membership role. `account.credentials.set` does not either, and this handler follows that path.
- An incomplete `local-daemon` create (label only) is `invalid_tools_env`. The phase 1 e2e expected `unsupported_kind` before this kind was accepted.
- `account.toolsEnvs.update` looks up `secretId` whenever the field is present, including the id already stored on the row. The secret must still exist with kind `daemon_token` before `secret_missing` is cleared. A label-only update leaves the flag set.
- Secret delete sets `default_tools_env_json` to null only when `json_extract(default_tools_env_json, '$.envId')` still names one of the flagged daemon envs.
- `chat.update { toolsEnv: null }` deletes a just-bash chat namespace only. Unpinning a daemon env drops the chat reference and does not RPC the env DO.
- **Superseded (2026-10-21):** `bot.update` with `tools: null` used to store an omitted allowlist (the default tool set). The web bot editor sent `null` when an edit left no explicit tool names. That reset is withdrawn. A missing or `null` `tools` field on `bot.update` leaves the stored allowlist unchanged. An array replaces it. `[]` is an explicit allowlist of zero gated tools: coding tools are not offered, and the tool gate blocks every other name. On `bot.create`, omitting `tools` is still the default set (Cadmus tools allowed, coding tools opt-in) and `[]` is zero gated tools. The web editor sends the resulting list on edit, including `[]`, and does not send `null`.

---

## Phase 3 — WebSocket backend, heartbeat, generation CAS, daemon

**Ship:** one process on a laptop dials `GET /tools-env/ws?envId=` and lands on the existing `CadmusEnvDO`. The DO's backend for that row is `ws-remote`. `bash` / `read` / `write` / `edit` on any bot or chat that references that `envId` run through the same family proxy, which RPCs the env DO, which forwards over that one WebSocket to a daemon wrapping `NodeExecutionEnv`. A planning chat can stay on a just-bash env while the bot default is the daemon. Two families that reference the same daemon `envId` share the socket, the folder, and the connection row. The daemon reconnects on its own backoff. The cloud does not probe. Reconnect writes `connected` and bumps `generation`; reconnect means ready. A missed heartbeat or a socket failure CAS-marks `disconnected` and fails in-flight calls. A tool call that arrives while disconnected throws offline and does not start recovery.

Required in this phase:

1. Table `cadmus_env_connection` (`env_id` PK, `status` `connected` \| `disconnected`, `generation` INTEGER, `connected_at`, `disconnected_at`, `last_error`) on the env DO that phase 1 already migrated. The class and the `CADMUS_ENV` binding are not new.
2. Route `GET /tools-env/ws?envId=` to that DO, not to `cadmus:${accountId}:${familyId}`. The URL has no `familyId`, `botId`, or `chatKey`. Auth once at upgrade, before `authenticateRequest`: `GET` + `Upgrade: websocket` (`426`), bearer `cadmus_dt_` + 64 hex (`401`) before SHA-256 or D1, then `token_hash`, env row (`404` unknown env or a just-bash env, `403` secret mismatch). Strip inbound `X-Cadmus-*`. Copy `X-Cadmus-Env-Capabilities: confinement` only when the daemon listed that token. `409` before `acceptWebSocket` when the env requires confinement and the token is absent. A `409` does not disconnect a socket that is already `connected`. When none is connected, set `last_error = confinement_unavailable` without bumping `generation`. Add `/tools-env/ws` to `assets.run_worker_first`.
3. Tighten the family fetch so the generic websocket branch is `pathname === "/ws"` only. Family `broadcastEvent` stays untagged `getWebSockets()`. Do not tag protocol sockets `protocol-client` in order to hide daemon sockets: those sockets are not in the family DO. Accept on the env DO with tag `tools-env-daemon` only. A `ClientCommand` on that socket closes `1008` and does not run `executeCommand`. Inbound text over 6 MiB closes `1009` before `JSON.parse`. Schema checks live in `src/tools-env/wire.ts`.
4. On accept: bump `generation` and write `connected` in one statement, `serializeAttachment({ envId, generation })`, then close any older socket (`1000`, reason `Superseded`). The old close's CAS uses the old generation and must not flip the row.
5. Every disconnect write (missed heartbeat, `webSocketClose` / `webSocketError` for the current generation, a tool call that hit a transport error) is `UPDATE ... SET status = 'disconnected' ... WHERE env_id = ? AND generation = ?`. Zero rows means a newer connect already won. Do not rely on the single-threaded gate alone: a tool RPC can be awaiting a daemon reply while a reconnect runs.
6. Heartbeat every 30s only while `inFlight > 0` on the WebSocket backend, counted across all families. The env DO sends `{ id, method: "heartbeat" }`; the daemon replies `{ id, ok: true }`. Deadline is a missed reply within 30s. The timer is `setTimeout`, armed on 0→1 and cleared at 0, because those family RPCs pin the isolate. It is not `ctx.storage.setAlarm`. Idle sockets send nothing and set no alarm. A just-bash env never arms the timer. A miss closes the socket, fails every in-flight call with `tools-env transport: env disconnected`, and CAS-marks `disconnected` (`last_error = heartbeat_timeout`).
7. Family `env` callback stays the phase 1 proxy. Off or unbound returns `undefined` and does not close the env socket. `getConnection()` `disconnected` or a missing daemon row throws the offline error before any frame. Otherwise it returns the proxy. Mid-call disconnect is the transport-class error, not that throw. `ExecutionEnv.id` for the daemon is `daemon:<accountId>:<envId>`. just-bash ids stay as in [execution-env.md](./execution-env.md).
8. Decision 15's per-path queue already runs for just-bash. The WebSocket backend uses that same queue before it sends `writeFile` / `appendFile` / `truncateFile` / `renameFile` / `createDir` / `remove` and the write half of `edit`. `bash` / `exec` is not queued.
9. Secret delete now also calls `revoke` on each matching daemon `CadmusEnvDO` (`1008`, `Pairing secret revoked`, CAS `last_error = secret_missing`). Phase 2's D1 delete and default-clear stay. Families are not walked to flip per-bot rows. Deleting the env definition sends `cleanup` (`deleteEphemeral` when `persist` is false) and closes the socket. Unbinding one bot does not. Toggle-off does not close the shared socket and does not CAS the row. Deleting a just-bash env still only drops that DO's VFS and usage rows.
10. UI and `/status` show derived daemon status from `getConnection()`: `status`, `connectedAt`, `lastError`. No `nextProbeAt`. A `tools-env.reachability` push, and an env-DO notification to interested families, stay optional/later. Phase 3 does not give the env DO a family binding.

Depends on Phase 1's DO, proxy, and just-bash namespaces, and on Phase 2 env definitions and tokens.

| Work | Touches |
| :--- | :--- |
| `/tools-env/ws` before generic auth; hash check; route to `CadmusEnvDO` | `src/index.ts` |
| `pathname === "/ws"` only on the family | `src/index.ts`, `CadmusBotFamilyDO.fetch` |
| `/tools-env/ws` in `run_worker_first` | `wrangler.jsonc` (implementation change, not this plan edit). The `CADMUS_ENV` migration is phase 1 |
| Connection row, generation CAS, supersede close, heartbeat `setTimeout` on the existing in-flight registry | `CadmusEnvDO` `ws-remote` backend |
| Wire protocol mirroring `ExecutionEnv`, plus `heartbeat`. No `probe` method | **new** `src/tools-env/wire.ts` |
| Daemon package wrapping `NodeExecutionEnv`, proactive backoff (1s, double, cap 60s, ±20% jitter; reset after a successful accept; stop on `401`; stop on `409` until config changes), `confineToWorkspace` enforcement (realpath jail on the file surface; OS-level wrap for `bash`; refuse to start and omit the `confinement` upgrade token when the mechanism is missing), plus the one-line startup trust warning **only when confinement is off** | **new** `daemon/` package, out of the Worker bundle |
| On socket `close` or `error`, abort that socket's execs, readers, and watches. `cleanup` when the env definition is deleted or `persist` flips. A drop does not delete `.cadmus-ephemeral` | `daemon/` |
| Derived daemon connection on `bot.get` / `chat.get` / `account.toolsEnvs.list` / `/status` | family DO RPC `getConnection()` |
| Secret revoke and env-definition delete close the env socket | edge → `CadmusEnvDO` |

**Conformance:** `createEnvConformance` against the proxy in Node, with the WebSocket backend's peer on the other side of the wire (the env DO itself is not in this Node process). `withEnv` starts a scripted peer (or the real `daemon/` package) that wraps `NodeExecutionEnv` on a fresh temp directory, and passes a proxy that speaks the wire protocol. `symlinks: true`. `listFiles: false`. Watch is proxied. `shell` stays the default `["sh", "-c"]`. This is the check that streaming `onOutput`, readers, and `watch` round-trip the daemon wire. The suite does not run inside workerd. The phase 1 suite remains the check that the family proxy round-trips a just-bash env DO.

**E2E:** whole-flow in workerd. A scripted peer upgrades `/tools-env/ws?envId=` with the token and answers wire methods, including `heartbeat` while a call is in flight. The upgrade is the same in-memory path as `connectTestWs` in [`e2e/helpers.ts`](../../../e2e/helpers.ts): `SELF.fetch` with `Upgrade: websocket`, then `res.webSocket.accept()`. No egress and no second transport. Mock **only** that peer — not `FamilyStore`, not the tool gate, not alarms, not `CadmusEnvDO` storage. Drive the bot with `turn.submit` and `faux/echo`, one coding-tool directive per turn, as in phase 1. There is no probe test and no `runDurableObjectAlarm` recovery of a daemon. Family alarms still run schedules; a tools-env disconnect must not be what wakes them.

- Bot default daemon `envId`, one chat with a just-bash `envId`. `bash` on the planning chat does not need the daemon socket and does not see the daemon folder. `bash` on a chat with no override uses the scripted peer. The planning chat still runs while the daemon socket is dropped.
- One daemon, two families in the same account, same `envId`: both see `connected` after one accept. Dropping the socket fails in-flight calls in both families with `env disconnected` and the row is `disconnected` once. A family in another account cannot use that env. The token row has no family column.
- Missing or user-token auth on `/tools-env/ws` does not go through `authenticateRequest` success-then-`/ws`. A bearer that is not `cadmus_dt_` + 64 hex is `401` and does not need a D1 row. A non-WebSocket request is `426`. Unknown `envId`, and a just-bash `envId`, are `404`. A client header `X-Cadmus-Tools-Env-Secret-Id` naming a different secret does not select that binding.
- A daemon socket that sends a protocol `ClientCommand` (for example `bot.delete`) does not run it. While a chat turn streams, the daemon peer receives only tools-env wire frames. Family protocol clients still receive `turn.*` / `ServerFrame` on the family `/ws`. The daemon is not in that DO.
- `account.toolsEnvSecrets.delete` revokes each matching env DO: the live socket closes `1008`, in-flight calls fail, and the row is `disconnected` with `last_error = secret_missing` when the generation matches. The next coding-tool call throws the offline error. An env that uses a different secret stays up. `jb_default` stays up.
- A non-zero exit from the peer leaves the row `connected`. Dropping the socket, or never answering a heartbeat while a call is in flight, fails those calls with `tools-env transport: env disconnected` and marks `disconnected`. The just-bash chat stays `connected`. A later `turn.submit` while the daemon is still disconnected throws offline and sends no `exec` frame.
- Re-upgrade the peer: generation bumps, status is `connected`, and the next turn's `bash` on an inheriting chat succeeds. No family alarm is required.
- A stale disconnect (the old socket's `webSocketClose`, or a tool call that still holds the old generation) after that reconnect updates zero rows. Status stays `connected`. The next call succeeds.
- A second upgrade for the same `envId` closes the previous socket (`1000`, `Superseded`) and leaves the row `connected` at the new generation. After that superseded close, `bash` still succeeds.
- Heartbeat runs only while daemon calls are in flight. With the socket idle (connected, no pending RPC), no heartbeat frame is sent and the env DO sets no alarm. A `bash` that outlives 30s gets heartbeats until it returns; after the last call the timer is cleared. A just-bash `bash` on another env does not produce heartbeat frames on the daemon socket.
- A tool call when `getConnection()` is `disconnected` fails fast with the offline throw. Chat, memory, knowledge, and a schedule fork of that chat still run. The schedule fork's coding tool gets the same offline error and does not insert a harvest-style probe turn.
- Toggle a bot or chat off while the shared socket is open: an in-flight `bash` on that conversation finishes, later calls return `undefined`, the socket stays up, and the row stays `connected`. That close-that-does-not-happen is not a failure. A sibling family that still references the env keeps calling it.
- `chat.update` `{ toolsEnv: null }` on a daemon pin drops the reference only. It does not send `cleanup` and does not close the env socket.
- Deleting the env definition sends `cleanup` with `deleteEphemeral: true` when `persist` is false, then closes the socket. Flipping `persist` on the definition does the same class of cleanup. Unbinding one of two bots that share the env does not.
- Two families write the same path at once: the env DO's per-path queue orders the write/edit-style ops (decision 15). Two `bash` calls are not ordered by that queue. The same queue already covered just-bash in phase 1.
- A peer `exec` error `shell_unavailable` leaves the row `connected`, including when its message starts with `tools-env transport:` (the env DO strips that prefix on rebuild). The same for a peer `FileError` `unknown`. A DO-synthesized timeout or a missed heartbeat carries the prefix and, for the heartbeat or a dead socket, CAS-disconnects. `FileError` `not_found` and `ExecutionError` `timeout` from the peer leave `connected`. Chat without coding tools still echoes.
- Confinement (`confineToWorkspace: true` on the env definition): the upgrade request includes `X-Cadmus-Env-Capabilities: confinement` (the edge copies that token after stripping inbound `X-Cadmus-*`). `read` / `write` / `edit` (and `listDir` / `exists` / readers) of `../escape`, an absolute path outside `workspacePath`, and a symlink whose realpath is outside → `FileError` `permission_denied`, and the row stays `connected`. `bash` cwd is the workspace. An upgrade that omits the token is rejected with HTTP `409` before `acceptWebSocket`. No WebSocket frame is consulted. If a socket is already connected, that `409` leaves it connected. If none is, `last_error` is `confinement_unavailable` and generation is not bumped. The daemon backoff helper stops on `409` until config changes (no timer). A `daemon/` process with the flag set and no `bwrap` or `sandbox-exec` refuses to start and does not send the token. Startup warning is printed only when confinement is off. Validator: `confineToWorkspace: true` on a kind with `supportsConfinement: false` → `confinement_unsupported`; just-bash env create rejects `false` and accepts `true`.
- A `daemon/` test closes one socket while `bash` is in `sleep`. The child dies. The ephemeral directory is still there until an explicit `deleteEphemeral`. workerd e2e keeps using a scripted peer and does not assert host process trees.
- `account.toolsEnvs.list` in this phase includes daemon `connection` (`status`, `connectedAt`, `lastError`) from one RPC per env. `/status` nests the same fields and has no `nextProbeAt`.

**Done when:** cloud-hosted bots in more than one family can operate one folder on the owner machine through one env socket, a single chat can use a just-bash env DO instead of that folder, a closed laptop does not wake a probe alarm, a reconnect is one generation bump on `CadmusEnvDO`, and a missed heartbeat fails in-flight calls without heartbeats while the socket is idle.

**Implementation notes (phase 3):**

- Disconnect CAS is `UPDATE ... WHERE env_id = ? AND generation = ? AND status = 'connected'`. The extra predicate keeps `heartbeat_timeout` and `secret_missing` from being overwritten by the close those writes themselves trigger. Zero rows still means a newer generation already won, or the row is already disconnected.
- A `409` with no connection row inserts generation `0`, status `disconnected`, `last_error = confinement_unavailable`. Generation `0` means the socket was never accepted. The next successful accept updates generation to `1`. A `409` while a socket is already connected does not touch the row. A `409` when a row exists and is already disconnected updates `last_error` without bumping generation. The env DO produces the `409` (so it can write the row). The edge strips `X-Cadmus-*` and forwards when confinement is required and the token is absent.
- File RPCs on the WebSocket backend time out after 2 seconds and CAS-disconnect with `last_error = socket_closed` and the transport prefix. `exec` has no DO-side default timeout. The first heartbeat is sent 30 seconds after `inFlight` goes from 0 to 1. A miss is no reply before the next 30 second tick, about 60 seconds after the call starts. The conformance wire client uses a 30 second file-op deadline so Node ops are not cut off; the 2 second deadline stays in the DO backend.
- `getConnection(kind)` treats a missing row as `disconnected` for `local-daemon` and `connected` for `just-bash`. Kind is not inferred from "a row exists". The default kind is `just-bash`. `cadmus_env_connection` is created on the first daemon read or write, not in the just-bash schema init, so a just-bash env DO does not gain that table.
- An unknown but well-formed daemon token returns `401` after the hash lookup, so the route does not fall through to generic auth. A bearer that is not `cadmus_dt_` + 64 hex returns `401` before SHA-256 or D1.
- The family proxy forwards `..` and absolute host paths. It does not reject `../escape` before the wire. The daemon, or the scripted peer, returns `permission_denied`.
- Daemon per-path queue keys are `daemon\n${path}` with no family segment. just-bash keys stay `${storageFamilyId}\n${scope}\n${path}`.
- Heartbeat and idle e2e waits use the real 30 second interval. They are not shortened.
- Confinement detection looks for `bwrap` and `sandbox-exec` only. There is no landlock backend. The refuse-to-start reason names those two: "No confinement mechanism (bwrap or sandbox-exec). Refusing to start."
- Secret revoke writes `last_error = secret_missing` before close `1008`, so the close CAS sees a row that is already disconnected. If no row exists, the CAS matches zero rows. List and status still report `secret_missing` from the D1 flag.
- Env delete and a persist flip wait up to the 2 second file-call deadline for `cleanup`, then close `1000` "Env closed" and CAS `last_error = socket_closed`. `deleteEphemeral` is true only when the definition is deleted and `persist` is false, or when persist flips away from false.
- The Node conformance client is a local wire `ExecutionEnv` over Bun websockets (`createWireExecutionEnv`) against `daemon/` wrapping `NodeExecutionEnv`. It does not boot `CadmusEnvDO`. The phase 1 just-bash suite stays the workerd proxy check.
- Reader wire methods are `openBinaryReader`, `binaryRead`, `binaryInfo`, `binaryScan`, `closeReader`, `openDirReader`, `dirNext`, `readLine`, and `openTextLineReader`. The two-family queue e2e holds `writeFile` (the write half of edit) rather than a separate edit opcode.
- Accept order is: one statement that bumps generation and writes `connected`, `acceptWebSocket` with tag `tools-env-daemon`, `serializeAttachment({ envId, generation })`, then close older sockets `1000` "Superseded". The old close CAS uses the attachment generation.
- `ExecutionEnv.id` for a daemon session is `daemon:<accountId>:<envId>`. The conformance client uses `daemon:conformance:env`.
- pi-durable awaits `HarnessOptions.env` before every tool, including `memory_update` and `knowledge_update`, and it awaits the returned value. A throw from that callback, or a thenable env, fails those tools. When `getConnection()` is disconnected, the callback returns an env whose methods throw the offline error and do not send a frame. The object is not thenable. Coding tools still fail before any wire frame. Memory, knowledge, and chat turns keep running.
- Turning a bot's tools env off removes `bash` through the tool gate (`Tool bash is not available`). The env callback is not reached, the shared socket stays up, and the connection row stays `connected`.
- A dangling symlink is `permission_denied` when its target leaves the workspace. `realpath` returns `ENOENT` for that link, so the jail uses `lstat` and `readlink` and confines the resolved target. A symlink cycle is `permission_denied`. A missing segment whose parent is `/` keeps its full basename.
- A dial that rejects (`ECONNREFUSED`, DNS failure, reset, or the 10 second connect timeout) is status `0` and uses the same backoff. It does not exit the process.
- With `confineToWorkspace`, an `exec` `cwd` outside the workspace falls back to the workspace. `sandbox-exec` has no `--chdir` and starts in `options.cwd`.
- `bwrap` also `--ro-bind`s `/lib`, `/lib64`, and `/etc` when those directories exist.

---

## Dependency graph

```text
Phase 1  CadmusEnvDO + just-bash backend + family proxy
         + D1 just-bash env (jb_default) + accounting hook
         + tri-state bot/chat { envId }
         (no daemon socket, no connection row, no heartbeat, no probes)
   └─ Phase 2  daemon rows on cadmus_tools_envs + secrets + UI binds envId
               (socket acceptor still absent; a daemon turn throws offline;
                just-bash connection stays connected)
         └─ Phase 3  ws-remote backend + cadmus_env_connection
                     + heartbeat while in flight + generation CAS
                     + daemon package
```

Phase 1 can merge alone. Phase 2 can merge before any daemon is running: just-bash works, and the secret table plus daemon rows hold what Phase 3 dials. A Docker / microVM sandbox manager can plug in later as another backend on `CadmusEnvDO` ([issue #16](https://github.com/liorm/pi-bot/issues/16)). A manager that keeps a connection uses the same backoff and heartbeat. This plan does not specify that manager.

---

## Test strategy (all phases)

### ExecutionEnv conformance

- API: `createEnvConformance` / `registerEnvConformance` from `@earendil-works/pi-durable/testing` (`EnvConformanceOptions`: `assertions`, `withEnv`, optional `shell`, `symlinks`, `listFiles`).
- just-bash: the family proxy against `CadmusEnvDO` under `bun run test` (Vitest workerd), phase 1.
- remote wire: scripted peer or `daemon/` wrapping `NodeExecutionEnv` on a temp dir (phase 3, `bun test tests/conformance`, not workerd).
- `withEnv` provides a fresh empty writable cwd per case and awaits its callback once. For just-bash the cwd is `/workspace` and freshness is a new namespace.
- Phase 3 runner: `bun run test:conformance` (`bun test tests/conformance`), with root `bunfig.toml` `[test] pathIgnorePatterns = ["e2e/**"]`. `bun run test` stays Vitest for `e2e/`, including the just-bash proxy suite. Bare `bun test` is not a Cadmus entrypoint.

### Whole-flow e2e (default for the bot)

- Location: `e2e/tools-env-*.test.ts`.
- Runner: `bun run test` (Vitest + `@cloudflare/vitest-plugin` + `cloudflare:test`).
- Drive the bot: `bot.create` → `chat.create` → `turn.submit` with `faux/echo` `[tool:<name> <json>]` (see `e2e/turns-and-commands.test.ts`, `e2e/bots-and-files.test.ts`). Tool names are `bash`, `read`, `write`, `edit`. One directive per turn. The directive matcher accepts a balanced JSON object and still emits one tool call.
- Unique `accountId` / `familyId` per test. Two-family cases use two family ids on one account and one `envId`.
- `runDurableObjectAlarm(stub)` stays the way schedule and harvest tests wake the **family** DO. It is not a tools-env recovery step. Do not assert that an alarm probes an env.
- Mock **only egress**: in Phase 3, a scripted daemon peer (`SELF.fetch` + `webSocket.accept()`). Do not mock `SqliteFamilyStore`, `tool-gate`, `broadcastEvent`, `syncDurableObjectAlarm`, or the env DO's SQLite.
- just-bash e2e mocks nothing.
- Transport vs application, generation CAS, two-family daemon sharing, two-family just-bash isolation, accounting counters, and "daemon does not see protocol frames" are e2e assertions through the bot and the env DO, not mocked-DO unit tests.

### Unit tests (narrow)

Only pure helpers: the **daemon backoff** helper (1s, double, cap 60s, ±20% jitter; reset after a successful accept; `401` stops; `409` stops until config changes — there is no cloud probe ladder and no 300s × 3 table), **`resolveToolsEnv` resolution matrix** (chat off beats account on; chat on beats bot off; inherit walks to account; `enabled: true` with no binding anywhere → runtime off; binding source independent of enabled source; bot off with retained binding still supplies `envId` to a chat that is on with no binding), TypeBox-adjacent binding validation if extracted (`envId` required when `binding` is present; `secretId`, `workspacePath`, `persist`, `confineToWorkspace`, `sharedWorkspace`, and `kind` rejected on the binding; those fields allowed on the D1 env row as the kind permits; `enabled: true` with no resolvable binding rejected; `confineToWorkspace: true` rejected when `supportsConfinement` is false; `confineToWorkspace: false` rejected on just-bash create; `true` accepted; `sharedWorkspace: true` rejected on `local-daemon`), scope string formatting (`bot:` / `chat:` prefixes, chat keys that contain colons, `family_id` column, `''` when shared), `ExecutionEnv.id` string formatting (private `just-bash:<accountId>:<envId>:<familyId>:bot:<botId>` and the `chat:` form, shared `just-bash:<accountId>:<envId>:shared:bot:<botId>` and the `chat:` form, `daemon:<accountId>:<envId>`; SQLite columns do not include `accountId`), the identity section chooser (omitted when enabled is false or tools are not offered; `connected` body names the coding tools and says `code.execute` cannot see the workspace; `disconnected` body does not name the four tools, says the workspace env is unavailable, says the environment reconnects on its own, and says `code.execute`, if enabled, remains a sandbox with no workspace files; just-bash is passed as `connected`), and the transport classifier (the `tools-env transport:` prefix on a DO-synthesized `shell_unavailable` or `FileError` `unknown`, versus a wire `shell_unavailable` or wire `unknown` whose message copied that prefix and was stripped, `timeout`, `not_found`, and a non-zero exit). No mocked DO. If the helper is in a file that imports `cloudflare:workers`, keep the test in the Vitest/workerd run instead of forcing a separate `bun test`.

### Explicitly out of scope for tests

- Docker and microVM sandbox manager APIs, including fake manager endpoints in CI ([issue #16](https://github.com/liorm/pi-bot/issues/16)). Daemon `confineToWorkspace` path-escape tests are in phase 3, not here.
- Cloud-side probes, probe frames, probe alarms, and `next_probe_at`.
- The optional/later family notification when an env's status changes.
- Export of `cadmus_env_usage` to D1 or Analytics Engine. Phase 1 only checks that the env DO's own rows increment.
- A rejecting `checkOpLimits`. Phase 1's hook allows the op.
- LLM provider network (continue using `faux/echo`).
- Promoting workspace files into `cadmus_bot_knowledge`.
- Copying a bot namespace into a chat namespace.
- `createPowerShellTool` and a Workers image processor.

### Regression checklist per merge

- `bun run typecheck`
- `bun run test` and, once the phase 3 script exists, `bun run test:conformance`
- Existing harvest, schedules, tool-gate, and `/status` e2e still pass.
- `tui/` still type-only-imports `src/protocol.ts`.
- No `console.*`; logs through `getLogger()`.
- Coding tools are upstream registrations: do not mark them `replay: "safe"` and do not memo them in Cadmus.
- Env `kind` is `just-bash` or `local-daemon`. Bindings store `envId` only.
- `bot.tools === undefined` does not offer or allow `bash` / `read` / `write` / `edit`.
- Resolved env off does not offer coding tools, even when `bot.tools` lists them.
- A chat with `toolsEnv` null inherits. A chat with `{ enabled: false }` is off. A chat with its own just-bash `envId` uses `chat:<key>` inside that env DO. A daemon binding has no family namespace.

---

## Implementation constraints (carry into every phase)

1. Prefix new SQLite tables with `cadmus_`. The env DO class is `CadmusEnvDO`, binding `CADMUS_ENV`, instance `env:<accountId>:<envId>`. `cadmus_tools_env_fs` and `cadmus_env_usage` are env-DO tables. `cadmus_env_connection` is an env-DO table in phase 3. None of those three are family tables.
2. Do not store the tools-env workspace, the conversation→chat map, env definitions, connection state, or usage rollups in `pi-durable` `defineDoc`. The conversation→chat map stays family SQLite. The workspace stays env-DO SQLite or the daemon folder.
3. Do not add Worker cron.
4. Do not submit harvest through a new task type. Do not submit probe work at all. Family `alarm()` and `syncDurableObjectAlarm` stay schedules and harvest. The env DO does not use an alarm for heartbeats or for recovery.
5. Plans in this directory stay Markdown-only until a later change set implements them.
6. The model-facing shell and file tools are pi-durable's `bash`, `read`, `write`, and `edit`. The `env` callback is how a chat gets an environment. Off returns `undefined`. A disconnected daemon throws. A mid-call drop is a transport error. just-bash and the daemon share that callback.
7. Daemon sockets live on `CadmusEnvDO` (phase 3). The family `/ws` path stays untagged, and `broadcastEvent` stays the protocol sockets it already has. Phase 1 does not emit `tools-env.reachability`. A push of that frame is optional/later.
8. Authenticate the pairing token once at `/tools-env/ws` upgrade (`token_hash`). Do not decrypt D1 on each call. Per call, the family RPCs the env DO and does not look up a daemon socket.
9. The daemon reconnects on its own backoff. A successful accept on `CadmusEnvDO` sets `connected` and bumps `generation` in one statement. The cloud does not probe and does not sync a family alarm for that write.
10. One `ExecutionEnv.id` per workspace, and the id includes `accountId` because `withFileMutationQueue` is an isolate-global `Map`. Private just-bash: `just-bash:<accountId>:<envId>:<familyId>:bot:<botId>` and the `chat:` form. Shared just-bash: `just-bash:<accountId>:<envId>:shared:bot:<botId>` and the `chat:` form. Daemon: `daemon:<accountId>:<envId>`. Every bot and family that references a daemon `envId` shares that daemon id. just-bash SQLite keys are columns `family_id` and `scope` (`bot:<botId>` or `chat:<chatKey>`), not the id string.
11. The `env` callback resolves the chat from `cadmus_chat_conversations`. It does not call `harness.commit`. `conversationCreated` writes that table with synchronous family-store `sql.exec` only. Harvest deletes its child row after the fork settles. Other fork rows stay.
12. Connection state for a daemon is one row on the env DO, not per bot, not per chat, and not per family. A stale disconnect CAS must match the generation of the socket that observed the failure. just-bash does not write that row. Family alarms still resume the harness so a schedule in phase `run` is not stranded; they do not probe envs.
13. Per-bot or per-session connection rows are rejected: one reconnect would fan out writes and multiply races. Per-family connection rows, per-family daemon sockets, and a per-family just-bash VFS are rejected: the env is shared across families, and just-bash isolation is a namespace inside the env DO.
14. Toggle-off does not close the shared env socket, does not drop a just-bash namespace, and is not a connection failure. Secret revoke and env-definition delete do close a daemon socket. `409` confinement stops the daemon's backoff until config changes.
15. just-bash pays one extra DO RPC hop per op (same-colo, typically small) in exchange for the uniform model.
