# Built-in Coding Tools

The model uses pi-durable's coding tools. Cadmus installs them and gates them. Which `ExecutionEnv` they run against is the resolved tools env (chat → bot → account). A resolved **off** omits the tools for that conversation. See [execution-env.md](./execution-env.md) and [binding-and-config.md](./binding-and-config.md).

Replaced: an earlier Cadmus-specific shell and file tool API and provider interface.

`@earendil-works/pi-durable/tools` exports `createCodingTools` / `CodingTools` (`dist/tools/index.d.ts`): an extension named `coding-tools` with `read`, `write`, `edit`, and `bash`. Nothing installs it automatically. `createPowerShellTool` is a separate export. Cadmus does not install it.

`bash` runs `env.exec` of a shell string, streams to `api.output()`, and turns a non-zero exit into an error result that still carries the output (`dist/tools/bash.d.ts`). `read` / `write` / `edit` use the same `env`. `edit` and `write` take `withFileMutationQueue`. `requireEnv` throws `Error("No execution environment is configured")` when `api.env` is `undefined` (`dist/tools/env.js`).

---

## Install

In `CadmusBotFamilyDO.initHarness`, `registry.install(createCodingTools())` next to the existing extensions (`identityExtension`, `knowledgeExtension`, `schedulesToolsExtension`, `internalToolsExtension`, `toolGateExtension`, `webToolsExtension`, `scheduleExtension`).

Also pass an explicit `settings.extensions` list of those Cadmus extensions **without** `coding-tools`. When `settings.extensions` is absent, pi-durable selects every installed extension (`dist/harness/agent.js`: `settings.extensions?.map(...) ?? snapshot.installed()`). Leaving the field absent would offer `bash` / `read` / `write` / `edit` on every conversation whose agent tools are unset, including bots that exist today.

Per conversation, select the `coding-tools` extension only when **both** are true: this bot's `bot.tools` includes one of `bash`, `read`, `write`, `edit`, **and** this conversation's resolved tools env is **on**. `createBotInternal` and `createChatInternal` set that selection on the new agent. `bot.update`, `chat.update`, and `invalidateToolsEnvCatalog` do not sweep stored conversations. The next turn preparation compares resolved `enabled` (and whether those names are listed) to the agent's current extension selection and `configure`s only when they differ. A toggle during an in-flight call is specified in [binding-and-config.md](./binding-and-config.md). `toToolRegs` only sets `AgentChange.tools` ([`src/family-do.ts`](../../../src/family-do.ts)). In pi-durable, that field filters tools composed from the selected extensions (`resolveAgent` / `selectExtensions` in `dist/harness/agent.js`). A name in `tools` does not install an extension that `settings.extensions` omitted, so `bash` would never be offered. The same `createConversation` / turn-preparation `configure` also sets `extensions`:

- Names listed **and** resolved env on: `extensions: { add: [{ name: "coding-tools" }] }` and `tools: toToolRegs(bot.tools)`.
- `bot.tools` undefined, or none of the four listed, **or** resolved env off: `extensions: { remove: [{ name: "coding-tools" }] }`. Leave `tools` unset when `bot.tools` is undefined (today's "all Cadmus tools") unless a list must still be passed. When `bot.tools` is a list, still pass `toToolRegs`. `[]` is a list: `toToolRegs([])` offers no tools, including the four coding tools.

`{ add }` / `{ remove }` edit the host selection. An `extensions` array replaces it and would drop the Cadmus extensions. pi-durable stores `extension.name` only (`applyChange`), the same `{ name }` cast as `toToolRegs`. The extension contributes all four tools; the `tools` list is what the model is offered. Env **off** removes the four regardless of `bot.tools`, so the model never sees tools that cannot work (`api.env` would be `undefined`). Env **on** still requires the opt-in. Web tools and knowledge tools do not change. A chat that is on with no own binding still uses the bot workspace; it only gets the tools if `bot.tools` lists them.

---

## Default-on risk (`bot.tools === undefined`)

Today `BotRecord.tools` omitted means "all allowed":

- `createChatInternal` sets `cwd: bot.id` and spreads `tools` only when `bot.tools !== undefined`. Unset tools follow the host default (every selected extension).
- `toolGateExtension` returns immediately when `bot.tools === undefined` ([`src/extensions/tool-gate.ts`](../../../src/extensions/tool-gate.ts) lines 36–37), so the call proceeds.

After `CodingTools` is installed, that default would put a shell on every bot, including unbound ones. Change it as follows. `undefined` keeps meaning "all Cadmus tools". It does **not** include coding tools.

| Layer | Rule |
| :--- | :--- |
| Offer list | Host `settings.extensions` omits `coding-tools`. A conversation gains that extension only through `extensions: { add: [{ name: "coding-tools" }] }` when `bot.tools` lists `bash`, `read`, `write`, or `edit` **and** the resolved env for that conversation is on. `toToolRegs` is the filter on top of that, not the install. Resolved off or unbound → `{ remove }` even when the names are listed. |
| Gate | In `beforeTool`, if `call.name` is one of those four: (1) resolved env off or unbound → `{ block: "Tool '<name>' is disabled for bot '<id>'." }` regardless of `bot.tools`; (2) `bot.tools` is `undefined` or does not include the name → the same block. Other tools keep today's rule: `undefined` allows them, a list must include `call.name`. An empty list includes nothing, so every gated call is blocked and coding tools are not offered. |
| Binding | An on env does not by itself add coding tools. The operator (or `bot.tools`) opts in. Phase 2's bot UI can append the four names when the operator turns the tools env on. Off at chat or bot removes them for those conversations. |

Off or unbound with `bash` in `bot.tools`: the four names are **not** offered, the `env` callback returns `undefined` if somehow called, and the gate still blocks. On, `bash` not in `bot.tools`: the gate blocks before `execute`, so the callback does not run. On and `connected` for this chat's env, tool allowed: `execute` gets the proxy for that `envId`. A daemon already `disconnected`: the callback throws, and the model sees that message ([reachability.md](./reachability.md)). Another chat whose resolved env is a just-bash `envId` still runs. That env DO's `getConnection()` is always `connected`.

Idle harvest stays on `HARVEST_TOOLS` in [`src/schedules.ts`](../../../src/schedules.ts) (`knowledge_read`, `knowledge_update`, `knowledge_delete`, `memory_read`, `memory_update`). The fork `configure`s that list only. Do not add coding tools there. The gate is a backstop if a parent agent had them. The fork still resolves to the parent chat for identity text, but the tools are not offered, so the callback does not run.

---

## Images

`createCodingTools({ images })` teaches `read` to resize and convert images (`ReadToolOptions` in `dist/tools/read.d.ts`). Without a processor, `read` passes PNG, JPEG, GIF, and WebP through when they fit the default limits (2000×2000, 4.5 MB of base64) and refuses other formats and larger files (pi-durable README, Tools).

`createCloudflarePhotonImages()` exists (`@earendil-works/pi-durable/images/cloudflare`). The README says the Photon decoder runs on the calling thread in Workers, holds the image's full size in WebAssembly memory, and that memory does not shrink; leave the processor out on memory-constrained hosts unless images stay small.

Install `createCodingTools()` with **no** `images` option. Do not import `images/cloudflare` in the Worker for this work. The processor is a tool option in the DO. It is not something the daemon runs. A later change can pass a processor if product wants resized images and the memory cost is acceptable.

---

## Relation to `code.execute`

| | `code.execute` (existing) | `bash` / `read` / `write` / `edit` |
| :--- | :--- | :--- |
| Owner | Provider-native. `NATIVE_TOOLS.xai["code.execute"] = { type: "code_interpreter" }` in [`src/models.ts`](../../../src/models.ts). Stub in `webToolsExtension` returns `unavailableToolMessage` for other providers. | pi-durable `coding-tools`, installed by Cadmus, executed against the chat's effective `ExecutionEnv`. |
| Filesystem | xAI sandbox. No bot workspace. | The bound workspace (a namespace in the just-bash env DO, or the daemon folder owned by the env). |
| Durability | None. | just-bash: `persist` on the env definition. `true` is env-DO SQLite. `false` is a map in that env DO. Daemon folder: persistent by nature. |
| When offline | N/A (provider call). | The `env` callback throws when the daemon env is `disconnected`. The bot remains usable. A chat on a just-bash env can still be up. Resolved **off** is not offline: the callback returns `undefined` and the tools are not offered. |
| Gate | Same `bot.tools` list as any other Cadmus tool. `undefined` still allows it. | Opt-in names, even when `bot.tools` is `undefined`, **and** resolved env on. Off at a conversation removes the four for that conversation only. |

Both may be enabled at once. The connected identity section tells the model to use `bash` / `read` / `write` / `edit` for this chat's workspace and that `code.execute` is a separate provider sandbox with no workspace files. The unavailable section does not name the four coding tools. It still says that `code.execute`, if enabled, remains that sandbox and cannot see the workspace, so "unavailable" is not read as "all code execution is down" and the model does not use `code.execute` to reach workspace files. Do not implement the workspace by forwarding `bash` to `code.execute`.

---

## Limits

These are pi-durable's, not a Cadmus wrapper:

| Limit | Where it lives |
| :--- | :--- |
| `bash` timeout | Optional tool arg, in **seconds**, no default (`dist/tools/bash.js`). The just-bash backend applies a 5s ceiling when the arg is absent (decision 9). |
| `bash` output | Spill after `DEFAULT_MAX_BYTES` (50 KiB) or `DEFAULT_MAX_LINES` (2,000). The model sees the retained tail. |
| `read` | Upstream truncation and the image limits above. |
| `write` / `edit` | Whole-file contents the model sends. The just-bash backend enforces the 8 MiB cap per namespace on the env DO's SQLite and on its isolate map ([workspace-persistence.md](./workspace-persistence.md)). A cap error is a `FileError` (`invalid`). `getOrThrow` turns it into the tool error. just-bash stays `connected`. |
| Workers CPU | The just-bash interpreter spends CPU on the env DO. The family spends the RPC wait. A daemon command spends the env DO's wait on the socket. A command the env finishes with `ExecutionError` code `timeout` is an application result. No daemon reply is transport. just-bash pays one extra DO RPC hop per op (same-colo, typically small) in exchange for the uniform model. |

---

## Replay

Do not wrap these tools to add `replay: "safe"` or `api.memo`. They are upstream registrations. pi-durable reruns a tool after a crash only when it is declared `replay: "safe"` (README, Tools). These four are not. A crash mid-`bash` becomes an `interrupted` result instead of a second shell command. Cadmus mutating tools (`knowledge_update`, `web.fetch`, `create_bot`, …) keep their own memos. That rule does not move onto `bash` / `write` / `edit`.

---

## Identity sections

The tools env, and the coding tools that use it, are prompt text in [`identityExtension`](../../../src/extensions/identity.ts) (`cadmus.identity`). They are not part of `SYSTEM_PROMPT`. That string is static. It stays the memory and knowledge instructions. A static sentence that names `bash` / `read` / `write` / `edit` would still offer them on a turn whose env is down.

Today the extension renders five sections, in order: `soul` (`tag: false`), `system`, `knowledge`, `memory`, `date`. `section()` comes from `@earendil-works/pi-durable`. A render that returns `undefined` omits that section. The default wraps the body as `<key>...</key>` (`soul` opts out).

Add two sections after `memory` and before `date`. At most one of them returns text on a given request. Both read the effective binding the same way the `env` callback does (chat pin, else bot pin, else account default, including the fork map). They do **not** use `PromptInput.env` as the signal. Generation prepare calls `runtime.env()` and, on a throw, reports it and continues with `env` undefined (`dist/harness/generation.js`). The offline throw is that path, so a disconnected daemon and an unbound bot look the same on `input.env`. The section reads the binding rows and the cached env definition (kind, `persist`, `confineToWorkspace`, `sharedWorkspace`). For every kind it pulls `getConnection()` from `CadmusEnvDO`. It does not read a family reachability row. just-bash's pull returns `connected`.

Also require that this request's `input.agent.tools` includes at least one of `bash`, `read`, `write`, `edit`, that the conversation is not marked `tools_env_enabled = 0`, and that the resolved env is **on**. Harvest does both: `HARVEST_TOOLS` only, and the child flag cleared in `executeHarvestFork`. Both sections stay omitted on a harvest turn and on a conversation whose env is off. `code.execute` is not one of these four. It stays a normal Cadmus tool. When either section is showing, name it only as the provider sandbox with no workspace files. When neither section is showing, do not describe it here.

| Section key | When it renders | Body |
| :--- | :--- | :--- |
| `tools-env` | Resolved env on, derived status `connected` (just-bash always, from `getConnection()`), and at least one coding tool is offered on this request. | The env and the tools together. Enabled source and binding source (`chat`, `bot`, or `account`), kind, `envId`, `persist`, `confineToWorkspace` when set, `sharedWorkspace` when the just-bash env sets it, and the workspace root. For a daemon, say the folder is the account env and is shared by every bot that references it. For just-bash, say the namespace is this bot or this chat, and that another family does not see it unless `sharedWorkspace` is set. Name `bash`, `read`, `write`, and `edit` as the way to use this workspace. On a chat pin, name the bot default's kind so the model does not assume the other folder. Say that `code.execute`, when enabled, runs in an isolated provider sandbox with no access to workspace files. Say that durable notes go through `knowledge_*` and `memory_*`. |
| `tools-env-unavailable` | Resolved env on, derived status `disconnected`, and at least one coding tool is offered on this request. | A different section. Do not name `bash`, `read`, `write`, or `edit`. Do not tell the model how to run commands or read or write the workspace. State that the workspace tools env for this chat is unavailable, name the kind and the source (`chat`, `bot`, or `account`), and state that the environment reconnects on its own. State that `code.execute`, if enabled, remains an independent stateless sandbox with no workspace file access. Tell the model to keep chatting. Memory, knowledge, and schedules still work. |

Off, unbound, or coding tools not offered: both return `undefined`. No tools-env text. Off is not "unavailable"; the tools are absent.

Both sections are a snapshot at render. The `env` callback reads connection status again at the call. An env that becomes `disconnected` after the connected section returns the transport error if the call was already running, or throws offline if it had not started. An env that becomes `connected` after `tools-env-unavailable` runs the call. The next turn renders the matching section. Do not freeze the rendered status in `beforeTool`. The four names stay on the agent for every conversation whose resolved env is **on**, including one whose daemon is `disconnected`. A chat whose resolved env is **off** does not have them on the agent after the next turn preparation. A toggle does not change the selection mid-turn ([binding-and-config.md](./binding-and-config.md)).

The connected section is the only place those four tools are explained. The unavailable section removes that explanation instead of saying "try them and they will fail." The offline throw is still what a call receives if one is made while on and disconnected. Leave the names on the agent while `bot.tools` lists them **and** this conversation is on. Taking them off the bot-wide agent would hide them from a sibling chat that is on; configure per conversation instead. The gate still enforces the allowlist and env-off.

Examples:

- Ready, chat pin: `Tools env: just-bash, chat pin, persistent workspace at /workspace. The bot default is local-daemon. Use bash, read, write, and edit for this workspace. code.execute, when enabled, runs in an isolated provider sandbox with no access to workspace files. Durable facts go through knowledge_* and memory_*.`
- Unavailable, bot default: `The workspace tools env for this chat is unavailable (local-daemon, bot default). It cannot run commands or touch files. code.execute, if enabled, remains an independent stateless sandbox with no workspace file access. The environment reconnects on its own. Do not try to use the workspace. Keep chatting. Memory, knowledge, and schedules still work.`

Render the choice in a pure helper next to `identityExtension` (resolved enabled, binding, derived status, offered tool names → which body, or none) so a test can lock both texts without a Durable Object. The caller passes the `getConnection()` snapshot. just-bash's snapshot is `connected`. A daemon's snapshot is the env DO row.

## `/status` and events

`handleOutOfBandStatus` in `CadmusBotFamilyDO` already builds a status object (`tools`, `nextWakeAt`, harvest watermark) without `conv.submit()`. Add a nested `toolsEnv: { enabled, enabledSource, kind?, envId?, bindingSource?, status?, connectedAt?, lastError? }` **(new)** to that payload and the human `text` lines. `bot.get` and `chat.get` do not use this object. They return flattened `toolsEnvEnabled`, `toolsEnvEnabledSource`, `effectiveToolsEnv`, `toolsEnvBindingSource`, `toolsEnvStatus`, `toolsEnvConnectedAt`, and `toolsEnvLastError` beside the stored `toolsEnv` ([binding-and-config.md](./binding-and-config.md)). Still zero transcript entries. `enabledSource` / `bindingSource` are `ToolsEnvSource`: `chat`, `bot`, `account`, or `unbound` ([binding-and-config.md](./binding-and-config.md)). `kind` and `envId` are present when a binding resolved. `status` is `connected` or `disconnected` when enabled is true and a binding won. There is no `nextProbeAt`. Off shows `enabled: false` and the source that turned it off; no status line. Fields are camelCase, matching other protocol objects. The connection columns stay snake_case. `/status` is for the operator. It may name the coding tools. The identity sections above are what the model sees. Status for every kind is one `getConnection()` RPC to the env DO. just-bash reports `connected` with no timestamp.

Tool calls already stream as `turn.tool_call` / `turn.tool_result`. No new turn event for exec. A push `tools-env.reachability` event is optional and later ([reachability.md](./reachability.md)). Phase 1 does not emit it. Phase 3 UI reads the pull fields. Daemon sockets are not on the family DO, so `broadcastEvent` cannot deliver frames to them. The family reaches just-bash only by RPC to its env DO.
