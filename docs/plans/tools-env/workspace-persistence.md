# Workspace Persistence and Knowledge Boundary

Implements decisions 2, 3, 7, and 16, on top of per-scope namespaces (decision 5).

The scratch workspace is **not** a second knowledge store. Persistence is a flag on the **env definition**. Knowledge remains the existing `BotFileStore` tools and tables. just-bash files live in `CadmusEnvDO`, not in the family DO.

---

## Decision 2 — persistence is env-definition config

`cadmus_tools_envs.persist` **(new)** is the flag for both kinds. Bot and chat bindings do not carry `persist`. There is no separate workspace service or syncer. The flag chooses how the backend inside the env DO stores bytes ([execution-env.md](./execution-env.md)).

| Kind | `persist: true` | `persist: false` |
| :--- | :--- | :--- |
| `just-bash` | Virtual FS rows in **env DO** SQLite `cadmus_tools_env_fs` **(new)**, keyed by `(family_id, scope, path)`. Survives that DO's eviction and restart. | Map in the **env DO** isolate, keyed by that namespace's `ExecutionEnv.id`, shared by the per-call proxy objects. Empty after that DO's eviction or restart. `cleanup()` on a namespace, unbind of that namespace, `chat.delete`, and `bot.delete` drop that namespace's entry. |
| `local-daemon` | `NodeExecutionEnv` cwd is `workspacePath` on the env definition (ordinary files). This is the default. The folder belongs to the env and is persistent by nature. Cadmus does not copy it. | The daemon works in `${workspacePath}/.cadmus-ephemeral` for that env. A new process empties it the first time it constructs that cwd. Deleting the env, or flipping `persist`, deletes it when the daemon has no other live session there. Unbinding one bot does not. The parent folder stays. `ExecutionEnv.cleanup` only kills processes ([execution-env.md](./execution-env.md)). |

Both just-bash modes are inside the env DO. `persist: false` means the bytes do not survive that DO's restart. It does not mean the interpreter runs in the family.

Defaults: `just-bash` → `true` (the built-in `jb_default` is persistent). `local-daemon` → `true` on the env definition. `persist` does not change connection status: a disconnected daemon still becomes `connected` only when it reconnects, and just-bash stays `connected`.

Who shares a workspace:

| Effective bindings | Workspace |
| :--- | :--- |
| Two chats inherit the same bot just-bash `envId` | One namespace (`scope = bot:<botId>`, `family_id` set) inside that env DO. |
| A chat sets its own `binding.envId` (just-bash), whatever the bot uses | That chat has its own namespace (`scope = chat:<chatKey>`) in the env it named. Nothing is copied from the bot namespace at bind time. The same `envId` as the bot still uses the chat scope, because the binding source is the chat. |
| Two bots, in one family or two, inherit one just-bash env with `sharedWorkspace: false` (the default) | Separate namespaces. The second family's `bot:<botId>` does not see the first family's files, even when the bot ids are equal. Each namespace has its own 8 MiB cap. |
| `sharedWorkspace: true` on that just-bash env | The family qualifier is omitted (`family_id` stored as `''`). Equal scope strings share one VFS and one 8 MiB cap across families of the account. |
| Two bots, in one family or two, reference the same daemon `envId` | The same folder on the owner machine, one `ExecutionEnv.id` (`daemon:<accountId>:<envId>`), one socket. Connection status is that one env row. There is no per-family daemon namespace. `sharedWorkspace` is rejected on a daemon row. |
| A chat inherits a `local-daemon` binding | That chat uses the env's folder. It does not get a private folder or a private socket. |

`sharedWorkspace` is defined here, not deferred. It is a boolean on the just-bash env definition, default `false`. It is not a per-bot or per-chat field. Flipping it drops every namespace of that env (the key shape changes; scratch is not migrated).

Docker volumes and throwaway microVMs are deferred to [issue #16](https://github.com/liorm/pi-bot/issues/16). A later backend can map `persist` to a named volume versus a throwaway root. This plan does not specify that. Workspace confinement for just-bash and the local daemon is `confineToWorkspace` on the env definition ([execution-env.md](./execution-env.md)).

### just-bash VFS sketch **(new)**

Table on `CadmusEnvDO` SQLite, not on `CadmusBotFamilyDO`:

```text
cadmus_tools_env_fs (
  family_id TEXT NOT NULL,  -- the family, or '' when this env's sharedWorkspace is true
  scope TEXT NOT NULL,      -- bot:<botId> | chat:<chatKey>
  bot_id TEXT NOT NULL,     -- denormalized; chat-scope rows store that chat's bot
  path TEXT NOT NULL,       -- normalized POSIX path under /workspace
  is_dir INTEGER NOT NULL,
  content BLOB,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (family_id, scope, path)
)
-- INDEX idx_cadmus_tools_env_fs_bot (family_id, bot_id)
```

`bot_id` is not part of the primary key. `deleteNamespacesForBot(familyId, botId)` deletes private rows with `WHERE family_id = ? AND bot_id = ?` and, when this env has `sharedWorkspace`, also `WHERE family_id = '' AND bot_id = ?`. It does not parse `scope` (chat keys contain colons, and one bot id can be a prefix of another). The just-bash backend reads and writes rows inside the env DO. The family store has no `toolsEnvFs` facet. Callers do not issue this SQL themselves.

`deleteNamespace(familyId, scope)` is what `deleteChat` and clearing a chat pin call, via RPC to each env the pin named. `deleteNamespacesForBot` is what `bot.delete` calls. When `sharedWorkspace` is true, deleting a bot removes the shared namespace for that `bot_id`, so other families lose those files. That is the meaning of the flag. Operators who want isolation leave it false.

The cap is 8 MiB sum of `content` per namespace (decision 7), on `cadmus_tools_env_fs` and on the in-memory map. A namespace is `(family_id, scope)` with `family_id` equal to `''` in the shared case, so a shared scope has one cap for every family and a private scope has one cap per family. Writes, appends, and edits that would exceed fail with `FileError` code `invalid` (an application result; just-bash stays `connected` and has no connection row to flip). `write` and `edit` pass that `Result` through `getOrThrow`, so the tool result is the `FileError` and the env stays `connected`. This is scratch, not R2. A chat namespace has its own cap. It does not count against the bot namespace. Two bots that inherit `jb_default` each have their own 8 MiB. Directory rows (`content` null) and empty files add nothing. Row overhead is outside the sum. There is no per-file cap inside the 8 MiB.

The check is part of the same synchronous write as the bytes it counts, inside the env DO. Replacing a path counts the new blob and not the old one. The env DO's per-path queue orders one path (decision 15), including just-bash. Two coding-tool calls can still write different paths in the same turn (`toolExecution` `"parallel"`). An awaited `SUM(LENGTH(content))` and a later `INSERT` let both pass. One write statement is the check. The in-memory path uses the same replacement rule: the size check and the map update run with no await between them. There is no `vfs_bytes` column. A namespace of that size is a local SQLite read on the env DO.

`ExecutionEnv.id` stays on the namespace across a `persist` flip. Private ids are `just-bash:<accountId>:<envId>:<familyId>:bot:<botId>` and `just-bash:<accountId>:<envId>:<familyId>:chat:<chatKey>`. Shared ids drop the family segment: `just-bash:<accountId>:<envId>:shared:bot:<botId>` and the matching `chat:` form. The id is an opaque equality key. It is not parsed by splitting on `:`. On a `persist` flip, the env DO deletes the store the new mode does not use (SQLite rows for every namespace when switching to memory, the map entries when switching to SQLite) so the two stores never alias one id. `account.toolsEnvs.update` RPCs that apply onto the env DO. The DO runs the SQLite delete in one synchronous `storage.transaction` with the config write it keeps locally if it caches `persist`. Inside it, `sql.exec` joins the transaction and does not issue `BEGIN`. The map is cleared in that same turn before the handler awaits. Do not await `withFileMutationQueue` from the family `bot.update` or `chat.update`. Those commands do not flip `persist`. The queue is per path, it does not cover `bash`, and a tool call awaiting that queue cannot release it while an RPC waits on it. Each just-bash mutation, including a write from the interpreter during `bash`, reads `persist` and the map at write time. A write aimed at the store the flip is dropping does not insert into that store after the flip. `accountId` is in the id because the family file-mutation queue is an isolate-global `Map` ([execution-env.md](./execution-env.md)). SQLite `scope` stays `bot:<botId>` or `chat:<chatKey>`. Family qualification is the `family_id` column.

`SqliteBotStore.deleteBot` already deletes souls, memories, knowledge, and schedules for the bot. It does not delete chats, and it cannot see env-DO SQLite. The family command handler, in that same turn, RPCs `deleteNamespacesForBot(familyId, botId)` to every env id referenced by the bot binding, by each of that bot's chat bindings, and by the account default when the bot or a chat inherits it. `chat.delete` RPCs `deleteNamespace` for `chat:<key>` and deletes that chat's `cadmus_chat_conversations` rows. Clearing an override to **inherit** (`toolsEnv: null`) RPCs `deleteNamespace` for the chat scope and leaves the conversation map, because the chat still inherits. It does not delete a daemon folder. Toggling **off** (`{ enabled: false }`) does **not** delete namespaces or the daemon workspace. The family DO does not keep an in-memory just-bash map. It does not send daemon `cleanup` and does not close the env socket on inherit, off, or bot delete ([binding-and-config.md](./binding-and-config.md)). Toggle off does not close that socket and does not send `deleteEphemeral`.

Changing the resolved `envId` for a scope (bot pin, chat pin, or an account-default fan-out for inheriting bots) RPCs `deleteNamespace` on the **previous** env for that scope and starts empty on the new env. The fan-out carries the previous default `envId` so a family with a cold cache still deletes the right namespace. A bot or chat that is **off** keeps its namespace until a later delete or a later inherit-clear. Chat pins that name their own `envId` are left in place when the account default changes.

### Daemon folder

Cadmus does not snapshot the daemon folder into D1 or DO SQLite. If the owner machine is wiped, the workspace is gone. That is expected. Durable bot knowledge was never supposed to live there.

The folder is the env's, shared by every bot and every family that references that `envId`. `.cadmus-ephemeral` is one directory per env, not per bot. A per-bot subdirectory would split `ExecutionEnv.id` (`daemon:<accountId>:<envId>`, decision 8).

A daemon process empties the ephemeral directory the first time it constructs `NodeExecutionEnv` with that cwd. A later socket from the same process reuses the directory, including a reconnect after a dropped connection. That drop aborts the commands, readers, and watches of the socket that closed, and leaves the directory in place ([execution-env.md](./execution-env.md)). A crash starts a new process, so the next construct empties it again. That is what removes a directory when the crashed process never ran `cleanup`.

`deleteEphemeral: true` is sent only when the env definition is deleted or its `persist` flag changes. The daemon removes the directory when that flag is set and this process has no other live session on that cwd. Unbinding a bot, toggling a chat off, or deleting one family does not. The old per-family "last binding" read is not used. See [README.md](./README.md).

just-bash cannot see the host: its VFS is the whole world, so confinement is implied (`confineToWorkspace` stored true; `false` is rejected on create and update). The daemon, with `confineToWorkspace: true`, realpath-jails the file surface and wraps `bash` in an OS-level mechanism, or refuses to start if that mechanism is missing ([execution-env.md](./execution-env.md)). With confinement **off**, the daemon is the OS user the operator started; `bash` can reach paths outside `workspacePath`. That is the operator's trust boundary. The daemon prints that warning at startup only when confinement is off. Full isolation (containers / microVM) is [issue #16](https://github.com/liorm/pi-bot/issues/16).

A chat that pins a different `envId` uses that env. The planning-chat case in this plan is a just-bash env, which never touches the daemon folder. Two bots that share a daemon `envId` can overwrite each other's files; that is the shared workspace, and the env DO orders write/edit-style ops on one path (decision 15). `bash` is not ordered. Two families that share a just-bash env with `sharedWorkspace: false` do not overwrite each other. With `sharedWorkspace: true` they can, and the same per-path queue orders those writes.

---

## Decision 3 — no promotion to knowledge

Existing knowledge path (do not duplicate):

| Virtual file | Table | Access |
| :--- | :--- | :--- |
| `SOUL.md` | `cadmus_bot_souls` | `getSoul` / `setSoul`; identity section `soul` |
| `MEMORY.md` | `cadmus_bot_memories` | `memory_read` / `memory_update`; CAS `expectedVersion`; max `MAX_MEMORY_BYTES` (8192 in [`src/store/sqlite-family.ts`](../../../src/store/sqlite-family.ts)) |
| `knowledge/<slug>.md` | `cadmus_bot_knowledge` | `knowledge_read` / `knowledge_update` / `knowledge_delete` / `knowledge_search`; CAS; slug `SLUG_REGEX` |

Idle harvest (`executeHarvestFork` in [`src/schedules.ts`](../../../src/schedules.ts)) snapshots those files, runs a forked turn with `HARVEST_TOOLS` only, diffs with `diffSnapshots`, stores `HarvestNote` in `cadmus_harvest_notes`.

A tools env must not:

- Appear in `HARVEST_TOOLS` (`bash` / `read` / `write` / `edit` stay off that list).
- Write `cadmus_bot_knowledge` / `MEMORY.md` as a side effect of `write` or `edit` on the workspace.
- Mount `knowledge/` into the workspace or bind-mount the VFS the other way.
- Copy the bot-default workspace into a chat override, or the reverse, on bind or on clear.
- Add a promote or workspace-sync tool.

If a fact should outlive the scratch space, the model uses `knowledge_update` or `memory_update` as it does today. The connected identity section (`tools-env`) says this explicitly. The unavailable section does not describe the workspace. Knowledge stays per bot. A planning chat's just-bash scratch is not a private knowledge store. A daemon scratch is not private to one bot when several bots reference the env.

Protocol `file.read` / `file.write` / `file.list` stay bound to soul/memory/knowledge. They never list a tools-env workspace.

`read` on the workspace follows pi-durable: text as text, and PNG / JPEG / GIF / WebP within the default limits as an image block. There is no Cadmus base64 fallback. See [builtin-tools.md](./builtin-tools.md).

---

## Interaction with schedules

A cron, relative, or absolute schedule that asks the bot to run a shell command still fires an LLM turn (`ScheduleTask` `run` → `submitChatTurnInternal` or a fork). The turn uses the **target chat's** effective tools env. A schedule into a planning chat uses that chat's resolved env. A schedule into a chat that inherits uses the bot (then account). `new-chat` creates a chat with no setting, so it inherits.

If that resolved env is **off**, the turn happens and coding tools are not offered; the `env` callback returns `undefined`. If it is on and the daemon env is `disconnected`, the turn happens and `bash` (and the other coding tools) get the offline error from the `env` callback. The schedule is not skipped. That is "bot stays usable." Harvest forks set `tools_env_enabled = 0` and do not offer coding tools, so they do not build an env and do not touch either workspace.
