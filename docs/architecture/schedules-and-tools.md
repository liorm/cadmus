# Schedules, Extensions & Tool Policy

Part of the [architecture](../architecture.md). Bot and chat records are in [Bots, Chats & Storage](./bots-and-storage.md). Knowledge and harvest are in [Prompt, Knowledge, Memory & Idle Harvest](./knowledge-and-harvest.md).

## Schedule catalog and task lifecycle

User schedules live in the sidecar `schedules.sqlite` database in two tables: `schedules` and `fires`.

A row in `schedules` is either `kind = "cron"` (five-field cron expression evaluated in `PI_BOT_TZ`) or `kind = "when"` (single epoch-millisecond timestamp), along with:

| Column | Role |
|---|---|
| `id` | caller-assigned id (`u-<hex>` for user schedules) |
| `bot_id` | owning bot |
| `next_run` | epoch milliseconds of the next wake |
| `text` | message admitted when the schedule fires |
| `target_json` | `{ mode: "chat", chatId, at? }`, `{ mode: "new-chat" }`, or `{ mode: "fork", chatId, at? }` |
| `name` | optional display label |
| `enabled` | `1` when active; `0` keeps the row in the catalog without a running task |
| `task_id` | id of the live `pi-bot.schedule` task on the bot's `rootConversationId` (or `null` when disabled) |

There is no separate polling timer loop. Saving an enabled schedule ensures a background `pi-bot.schedule` task (`ScheduleTask`) on the bot's `rootConversationId`:

1. **`wait` phase.** Sleeps on the harness clock until `next_run`. If a schedule is disabled or removed, its task is aborted. If `reschedule` updates `next_run` while the task is in `wait`, the task is aborted and recreated at the new wake.
2. **`run` phase.** Claims the occurrence in `schedules.sqlite` inside a single transaction (`claimOccurrence`): inserts `sched:<id>:<nextRun>` into `fires`, and if the row's `next_run` is still the claimed wake, deletes a `when` row or advances a `cron` row's `next_run` from `max(now, nextRun)`. A duplicate claim is a no-op.
3. **Dispatch.**
   - `chat`: calls `runtime.submit(chatId, requestId, text)`.
   - `new-chat`: calls `runtime.createChat` to open a new web chat on the bot, then `runtime.submit`.
   - `fork`: forks the parent chat conversation at `at` (or its latest entry when omitted) into an ownerless child conversation and submits `text` into the child. The child is not added to the chat directory.
4. **Loop or finish.** After `run`, a `when` task completes; a `cron` task transitions back to `wait` and sleeps until the advanced `next_run`. On process restart, `harness.resume()` resumes existing `pi-bot.schedule` tasks.

## Self tools (`pi-bot.self`)

`schedule_create`, `schedule_list`, `schedule_update`, and `schedule_delete` allow a bot to manage its own schedules during a turn:

- Scope is derived from the conversation's working directory (`bots/<botId>`), never from tool arguments, so a bot can only see or modify its own rows.
- `chat` and `fork` targets default to the current chat and must reference an active chat on the same bot.
- Schedule IDs prefixed with `harvest:` are reserved and rejected.
- All four tools are replay `safe`. `schedule_create`, `schedule_update`, and `schedule_delete` memoize their generated id/plan and outcome on the tool task (`api.memo`) so recovery returns the same result without duplicating changes.

## Internal cross-bot tools (`pi-bot.internal`)

- `create_bot` (replay `safe`) — creates a new bot from an explicit `slug`, `name`, and `soul`, plus optional `model`, `effort` (thinking level), `memory`, and `knowledge` seeds at version 0 (copying the calling conversation's model and thinking level when omitted), then registers its runtime on the host. Memoized on the tool task.
- `search_bot` (replay `safe`) — freezes a catalog of existing bots (slug, name, model, short soul excerpt, knowledge index) and spawns a `pi-bot.search-bot` task (`SearchBotTask`). That task opens a task-owned conversation with no tools or extensions and asks the caller's model to return a matching catalog slug or `null` (retrying invalid responses up to 3 rounds).
- `message_bot` — registered stub for cross-bot messaging; throws until implemented.

## Web and provider server tools (`pi-bot.web`)

`web.search`, `web.fetch`, `x.search`, and `code.execute` are installed as catalog tools (replay `unsafe`):

- On **xAI**, `attachNativeTools` rewrites `web.search`, `x.search`, and `code.execute` in the outgoing Responses API payload into the native server tools `web_search`, `x_search`, and `code_interpreter`. Server-tool stream items (`web_search_call`, `x_search_call`, `code_interpreter_call`, etc.) are captured on the assistant message as `serverTool` content parts so the web transcript can display them without the harness re-executing them.
- On providers without a native server tool implementation (or when `web.fetch` is called directly as a local function), execution returns an unavailable tool error.

## Per-bot tool policy and tool gate (`pi-bot.tool-gate`)

Every tool installed in the registry is grouped by extension for the UI catalog (`Knowledge`, `Schedules`, `Internal`, `Web`):

- When `bot.tools` is omitted (or contains all catalog tools, which normalizes to omitted), every registered tool is enabled.
- When `bot.tools` is an array of tool names, only those tools are offered to the model on conversations belonging to that bot (`[]` disables all tools).
- Updating a bot's tool list via `PATCH /api/bots/:id` or `PUT /api/bots/:id/tools` immediately syncs all idle conversations of that bot; busy conversations sync on their next `submit`.
- As defense in depth, `pi-bot.tool-gate` installs a `beforeTool` hook on `ToolTask` that blocks any tool call if the conversation is outside a bot folder or the tool is not enabled on that bot.
