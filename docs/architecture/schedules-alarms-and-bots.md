# Schedules, Alarms & Inter-Bot Collaboration

---

## Unified Schedule Mechanism (`ScheduleTask` in `packages/worker/src/schedules.ts`)

All timed work inside a Bot Family—recurring cron jobs, one-shot wakeups, and idle conversation harvests—runs through a **single unified mechanism**:
- **Persistence**: `cadmus_schedules` and `cadmus_schedule_fires` in `SqliteFamilyStore`.
- **Durable Execution**: `ScheduleTask` (`name: "cadmus.schedule"`), a background `pi-durable` task attached to the root conversation.
- **Hardware Wakeup**: `syncDurableObjectAlarm` (`packages/worker/src/alarms.ts`) inspects all active `cadmus.schedule` tasks and enabled rows in `cadmus_schedules`, programming `ctx.storage.setAlarm(earliest)` to the earliest `nextRun` timestamp.

### Schedule Kinds & Targets
- **Kinds**:
  - `cron`: 5-field cron expression (`minute hour day-of-month month day-of-week`) evaluated in the Bot Family's IANA timezone (`packages/worker/src/cron.ts`).
  - `when`: One-shot epoch millisecond timestamp. User-created `when` schedules transition to `enabled: false` after firing; `internal: true` schedules (such as `harvest:<chatKey>`) are automatically deleted after firing.
- **Targets (`ScheduleTarget`)**:
  - `{ mode: "chat", chatKey }`: Submits `schedule.text` into an existing chat.
  - `{ mode: "new-chat" }`: Creates a fresh chat for the bot and submits `schedule.text`.
  - `{ mode: "fork", chatKey, at?, harvest? }`: Forks `chatKey` at `at` (or the latest entry) and runs `schedule.text` in the forked conversation (with harvest diff tracking when `harvest: true`).
- **Idempotency**: `cadmus_schedule_fires (schedule_id, fire_time)` guarantees at-most-once execution per `(scheduleId, fireTime)` across Durable Object restarts.

---

## Inter-Bot Collaboration (`packages/worker/src/extensions/internal-tools.ts`)

Bots within the same `CadmusBotFamilyDO` can discover and collaborate with sibling bots using four built-in tools:

1. **`list_bots`**: Lists all bots in the family (`id`, `name`, `model`, `thinking`).
2. **`search_bot`**: Runs a durable `SearchBotTask` (`"cadmus.search_bot"`). It builds candidate summaries from each sibling bot's `SOUL.md` and knowledge descriptions, runs a judge turn in a task-owned conversation (`[SEARCH_BOT_JUDGE]`), and falls back to deterministic keyword scoring.
3. **`create_bot`**: Dynamically provisions a new sibling bot in the family with its own `slug`, `name`, `model`, `soul`, `memory`, and initial `knowledge` notes.
4. **`chat_with_bot`**: Runs a durable `ChatWithBotTask` (`"cadmus.chat_with_bot"`), creating or continuing a chat with a target sibling bot and returning its reply and `chatKey`.

---

## Per-Bot Tool Gate (`packages/worker/src/extensions/tool-gate.ts`)

When a bot specifies a `tools: string[]` allowlist (on `bot.create` or `bot.update`):
1. `CadmusBotFamilyDO` configures the bot's conversations (`AgentDoc.tools`) with only those allowed tool names so the LLM is only offered permitted tools. `[]` offers none.
2. As defense-in-depth, `toolGateExtension` (`cadmus.tool-gate`) hooks `ToolTask.beforeTool` and blocks any tool call not present in `bot.tools`. An empty allowlist blocks every gated tool. Coding tools (`bash`, `read`, `write`, `edit`) are not offered unless they are listed and the resolved tools env is on.

On `bot.update`, an omitted `tools` field leaves the stored allowlist unchanged. `null` clears it back to the default set. An array replaces it. On `bot.create`, omitting `tools` keeps the default set (Cadmus tools allowed, coding tools opt-in). `[]` on create or update is an empty allowlist.
