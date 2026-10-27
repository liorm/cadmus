# PiHarness and `@cloudflare/computer`

Research note, 20 Oct 2026. This is not a plan and it does not change [tools-env](../plans/tools-env/README.md). It records what Cloudflare's `PiHarness` and `@cloudflare/computer` are, how they relate to Cadmus, and why they were not adopted for issue #9. Re-read it before replacing `Harness` or the tools-env design.

## Sources

Checked 20 Oct 2026:

- Matt Carey, [20 Oct 2026](https://x.com/mattzcarey/status/2112598032550371687): Computer is the default workspace in Think and in the new `PiHarness` (based on pi-durable). Upgrade from `@cloudflare/shell` using the changelog, docs, or migration skill in the repo.
- [`@cloudflare/computer` README](https://github.com/cloudflare/computer/blob/main/packages/computer/README.md) and [repo README](https://github.com/cloudflare/computer/blob/main/README.md).
- [Pi harness docs](https://developers.cloudflare.com/agents/harnesses/pi/) (page updated 12 Oct 2026) and the Agents SDK source doc [`docs/agents/harnesses/pi.md`](https://github.com/cloudflare/agents/blob/main/docs/agents/harnesses/pi.md).
- [Changelog, 2 Oct 2026](https://developers.cloudflare.com/changelog/post/2026-10-02-pi-harness/): first-class Pi Durable support via `PiHarness`.
- Pi example: [`agents/examples/next/harnesses/pi`](https://github.com/cloudflare/agents/tree/main/examples/next/harnesses/pi), including `packages/worker/src/workspace.ts`.
- [`@cloudflare/shell` README](https://github.com/cloudflare/agents/blob/main/packages/shell/README.md): deprecated in favor of `@cloudflare/computer`.
- Think workspace tools: [`agents/docs/think/tools.md`](https://github.com/cloudflare/agents/blob/main/docs/think/tools.md).
- Cadmus: `CadmusBotFamilyDO.initHarness` in [`packages/worker/src/family-do.ts`](../../packages/worker/src/family-do.ts), [`packages/worker/src/alarms.ts`](../../packages/worker/src/alarms.ts), [tools-env plan](../plans/tools-env/README.md).

The tweet is a migration note for people already on `@cloudflare/shell`. Think used to depend on that package. Cadmus never did. The changelog and migration skill move shell users onto Computer. They do not describe a pi-durable `ExecutionEnv`.

## What `PiHarness` is

`PiHarness` (`agents/harness/pi`) is a beta lifecycle wrapper around the same `Harness.open` Cadmus already calls. Pi Durable still owns the transcript, the inbox of steers and follow-ups, model calls, tools, retries, and crash recovery. `PiHarness` adds two things:

- **Storage.** Pi's tables in the Durable Object's SQLite. The Agents SDK doc says those names start with `pi_`. Cadmus already opens pi-durable with the prefix `cadmus_pi_` via `openDurableObjectSqliteStorage`.
- **Wake.** Pi's scheduler is in memory. When a session has work, `PiHarness` schedules one Lifecycle job. The job heartbeats about every 30 seconds and completes when the session is idle. After eviction, crash, or a deploy, the job's alarm restarts the object, Pi reopens storage, and the run continues from the last commit. A `replay: "safe"` tool runs again. Any other tool comes back as an interrupted result.

It does not choose how clients reach a session. WebSockets, HTTP, and RPC stay in the application. The factory receives `{ storage, context }` and returns a `Harness`. `models`, `registry`, `settings`, `env`, and `onReport` are still yours. The factory runs once per isolate, during startup.

`PiHarness` can sit on an `Agent` (`this.lifecycle.use(this.harness)`) or on a plain `DurableObject` (`Lifecycle.install(this).use(this.harness)`). Install peers are `agents`, `@earendil-works/pi-durable`, and `@earendil-works/pi-ai`. Both Pi packages are optional peers of `agents`. The SDK doc pins them around `~1.3.0` and says `agents` supports one Pi minor at a time. The public docs page says 1.0 or later. Treat the peer range as likely to move.

Session ids are Pi's conversation ids. You cannot choose them. The docs say that to give each user or chat its own agent, use one Durable Object per conversation and the root session in each. `harness.prompt`, `submit`, `wait`, `steer`, `sessions.create`, and `sessions.fork` are the session API. `await harness.pi()` returns the opened Pi `Harness` for anything the wrapper does not cover.

Limits called out in the docs: no tool-call approval step, event streams always start from a snapshot, `abort()` waits until the session is idle, one model stream longer than 15 minutes can be cut off (the harness hands off alarms every 10 minutes), background tasks are noticed up to 30 seconds late, a running session prevents drain, and Pi Durable cannot delete a conversation yet. The API is beta.

The Pi example's tools do not come from `PiHarness`. They come from a `Workspace`. See below.

## What `@cloudflare/computer` is

Computer is a virtual filesystem whose authoritative state is SQLite in a Durable Object, plus one execution entry point, `workspace.runtime.exec`. A workspace can also be filesystem-only.

Backends, from the package status table:

| Backend | Status | What runs |
| :--- | :--- | :--- |
| `workspace.fs`, `withWorkspace`, `getWorkspace` | Stable | Durable files. `node:fs/promises`-shaped, absolute paths. |
| `WorkerJavaScriptBackend` | Stable | An ECMAScript module in a fresh Dynamic Worker. Needs a Worker Loader binding. |
| Agent tools (`@cloudflare/computer/tools`, including `tools/pi-ai`) | Stable | `read`, `ls`, `find`, `grep`, `write`, `edit`, `delete`, plus `exec` when a backend exists. |
| Git, assets, artifacts, R2 and `WorkerBundle` mounts | Stable | On the SQLite tree. Git does not need a shell. |
| `WorkerShellBackend` | Experimental | Shell commands via [just-bash](https://github.com/vercel-labs/just-bash) in a Dynamic Worker. Needs `just-bash`, a Worker Loader binding, and the `experimental` compatibility flag. |
| `ContainerBackend`, `computerd`, push/pull sync | Experimental | Full Linux in a Cloudflare Container. The DO schedules it (`scheduling_policy: "durable_object"`). FUSE mount syncs back over capnweb. |
| `LegacyContainerBackend` | Deprecated | Container scheduled from the `containers` block. |

A stable tool that runs on a backend is only as stable as that backend. The production-ready `exec` is JavaScript, not bash. The package README says the package is suitable for production and that experimental pieces, including the container backend, are not.

Limits from the package README: about 10 GB per workspace because it shares the Durable Object's storage. The container-side filesystem is in memory, sized for agent workspaces. FUSE trails a real disk on large sequential I/O.

The host tree is one absolute namespace rooted at `/`. `/workspace` is a convention, not a configured root. There is no scope key, no per-binding size cap, and no `persist: false` mode. Read-only mounts (R2, files shipped with the Worker) land inside that one tree.

`createPiTools` (`@cloudflare/computer/tools/pi-ai`) returns pi-ai declarations and one `execute` function, for a loop the caller writes. pi-durable runs the loop itself, so the Pi example (`createWorkspaceTools` in `packages/worker/src/workspace.ts`) turns each declaration into a `ToolRegistration`. It marks `read`, `ls`, `find`, `grep`, `write`, and `delete` replay-safe. `edit` and `exec` are not: after eviction the model gets an interrupted result. That example uses `WorkerJavaScriptBackend` only, rewrites the `exec` description so the model knows it is an ES module (imports `node:fs/promises` and `ws:git`, no shell, no npm, no network), and does not pass `HarnessOptions.env`.

Think does the same product move on the AI SDK side. Every Think agent gets `this.workspace`, and Computer's tools join every turn. That is the "default workspace" in the tweet.

## How Cadmus hosts Pi today

`CadmusBotFamilyDO.initHarness` opens pi-durable directly:

- Storage prefix `cadmus_pi_`.
- Registry of Cadmus extensions: identity, knowledge, schedules, internal tools, tool gate, web tools, `scheduleExtension`.
- `settings.contextRetentionMs` and `documentRetentionMs` are `0` (same reason the `PiHarness` docs give: idle cache timers keep the object billed and awake).
- Chord `CadmusServices` on the context (`familyStore`, bot and chat creators, `syncAlarm`, `broadcast`).
- `harness.root`, then `harness.resume()`, then schedule tasks, then `syncDurableObjectAlarm`.

One family object holds every bot, chat, fork, and harvest child. `AgentDoc.cwd` is the bot id. The tool gate and knowledge tools resolve the bot from it. The single Durable Object alarm is owned by `syncDurableObjectAlarm`: it inspects `cadmus.schedule` tasks and enabled rows in `cadmus_schedules`, then `setAlarm` or `deleteAlarm`. A Durable Object has one alarm.

There is no `env` callback and no `CodingTools`. Scratch shell and workspace are specified in the tools-env plan and are not implemented. `SOUL.md`, `MEMORY.md`, and `knowledge/<slug>.md` are family-store rows, not files in a workspace.

## What the tools-env plan already decided

Issue #9, decisions of 20 Oct 2026, in [docs/plans/tools-env](../plans/tools-env/README.md):

- The model reaches a scratch environment through pi-durable `createCodingTools` (`bash`, `read`, `write`, `edit`). Cadmus does not add a second shell or file tool API.
- `Harness.open`'s `env` callback returns one `ExecutionEnv` per effective binding: chat override, else bot pin, else account default. Unbound returns `undefined`. Harvest children return `undefined` and do not get coding tools.
- Phase 1 is in-isolate just-bash. The VFS is keyed by scope (`bot:<botId>` or `chat:<chatKey>`) in `cadmus_tools_env_fs`. `persist: false` is memory. Cap is 8 MiB per scope. Two chats that inherit share the bot VFS. An override does not.
- Phase 3 is a process on the owner's machine that dials out to `/tools-env/ws` and wraps `NodeExecutionEnv`. The cloud never opens a port on the LAN. Reachability is per scope, probed by the existing alarm multiplexer, without an LLM turn.
- Workspace files are not promoted into knowledge. `AgentDoc.cwd` stays the bot id.
- `bash`, `write`, and `edit` stay replay-unsafe. A crash mid-call is an interrupted result, not a second mutation.
- Docker and microVM sandboxes are issue #16. They would supply another `ExecutionEnv` to the same callback.

## Fit

| | Tools-env plan | `PiHarness` | `@cloudflare/computer` |
| :--- | :--- | :--- | :--- |
| Agent loop | Existing `Harness` | Same `Harness`, plus Lifecycle wake | None. Tools and a filesystem |
| DO alarm | `syncDurableObjectAlarm` (schedules, harvest, later probes) | Lifecycle jobs call `setAlarm` on a ~30s heartbeat | None |
| Sessions | Many conversations in one family DO | Supported, but the documented shape is one DO per conversation | One workspace per DO storage |
| Model tools | pi-durable `bash` / `read` / `write` / `edit`, gated by `bot.tools` | Whatever the registry installs | Its own `read`, `ls`, `find`, `grep`, `write`, `edit`, `delete`, `exec` |
| Filesystem contract | `ExecutionEnv` (`FileSystem` + `Shell`), conformance suite | None | `workspace.fs` and `runtime.exec`. Not an `ExecutionEnv` |
| Many workspaces in one DO | Scope key on `cadmus_tools_env_fs` | Not its job | One absolute tree per `Workspace` |
| Persistence | `persist` flag, SQLite or memory, 8 MiB per scope | — | Always SQLite, shared with the DO, up to ~10 GB |
| Shell on Cloudflare | just-bash implemented as `ExecutionEnv` | — | just-bash backend is experimental. Stable `exec` is JavaScript |
| Owner's machine | Daemon dials out, proxies to `NodeExecutionEnv` | — | No laptop agent. The container is a Cloudflare Container, experimental |
| Offline | Per-scope `unreachable`, alarm probes, chat still works | Restarts a crashed turn | In-isolate shell does not go offline. Container sync can sit at `pending` |
| Knowledge | Not the workspace. No mount, no promote | — | Skills, git, and files share `/workspace` |
| Table names | `cadmus_*` | `pi_*` (Cadmus uses `cadmus_pi_`) | Computer's own VFS tables |

## Why this was not adopted

**Do not replace `Harness` with `PiHarness`.** The wrapper re-homes a loop Cadmus already runs. The family object would then have two writers of the one alarm. A Lifecycle heartbeat can clobber a harvest or schedule wake, and `syncDurableObjectAlarm` can delete the heartbeat when it sees no schedule. Cadmus also depends on harness surface the wrapper does not own: `conversationCreated`, fork parent records, `cadmus.schedule` tasks, Chord services, the `cadmus_pi_` prefix, and `cwd` as the bot id. `PiHarness` is beta and tracks one pi-durable minor as a peer. Cadmus already depends on pi-durable directly.

**Do not replace the tools env with a Computer workspace.** The part that looks like the missing piece is a durable scratch directory plus a shell. The Pi example implements that as a second tool list, not as `HarnessOptions.env`. A second shell and file API is the first non-goal of the tools-env plan. `createPiTools` is that API. It also marks `write` replay-safe, which the plan refuses for `write` and `edit`.

Computer has no chat override, account default, harvest exclusion, or `bot.tools` gate. `WorkerShellBackend` is the closest thing to phase 1, and it is experimental. The stable `exec` is an ES module, which sits nearer the existing xAI `code.execute` stub than `bash`. `ContainerBackend` is a Cloudflare Container, experimental, and matches issue #16 more than the outbound laptop daemon.

One `Workspace` is one tree. Think and the Pi example assume one agent object and one workspace. Cadmus needs many scopes in one family object. Adopting Computer would still require a scope layer, an `ExecutionEnv` adapter if `createCodingTools` and `createEnvConformance` stay, and a mapping from POSIX errnos onto `FileError` and `ExecutionError`. Computer's tables are not `cadmus_`-prefixed. The handbook requires that prefix on DO SQLite tables in this shared account.

`AgentDoc.cwd` must stay the bot id. Pointing it at `/workspace` would make the tool gate miss the bot. Computer's tools do not read that field. pi-durable coding tools resolve paths against `ExecutionEnv.cwd`, which is why the plan keeps the two cwds apart.

## Worth rereading later

**Eviction wake.** `harness.resume()` runs on the next request that opens the harness. A turn with no open socket stays paused until something else hits the object. `PiHarness` exists to close that gap. If it shows up in Cadmus, add a heartbeat to the existing alarm multiplexer while a pi-durable task is running, so there is still one `setAlarm` owner. Installing Lifecycle beside `syncDurableObjectAlarm` does not.

**Issue #16 sandboxes.** `ContainerBackend` is a plausible `ExecutionEnv` behind the same callback once it leaves experimental. It does not replace just-bash or the daemon. Check the status table again before depending on it. Sync (`push` / `pull`, `sync.status: "pending"`) is part of that experimental surface.

**Computer extras on top of a scratch env.** Git, R2 mounts, and skill bundles are useful once a bot already has a scratch workspace. They are not a reason to move `SOUL.md`, `MEMORY.md`, or `knowledge/*.md` into that tree. The tools-env plan forbids that mount.

**If Computer grows an `ExecutionEnv`.** Reconsider phase 1's hand-written just-bash VFS only if upstream (pi-durable or Computer) implements `ExecutionEnv` with symlinks, watch, `Result` errors, per-call `cwd`, and a way to have many roots in one Durable Object. Until then, wrapping `workspace.fs` is a new Cadmus type with the same job as `cadmus_tools_env_fs`.
