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

1. **`list_bots`**: Lists all bots in the family, returning the `slug` and `name` of each bot.
2. **`search_bot`**: Runs a durable `SearchBotTask` (`"cadmus.search_bot"`). It builds candidate summaries from each sibling bot's `SOUL.md` and knowledge descriptions, runs a judge turn in a task-owned conversation (`[SEARCH_BOT_JUDGE]`), and falls back to deterministic keyword scoring.
3. **`create_bot`**: Dynamically provisions a new sibling bot in the family with its own `slug`, `name`, `model`, `soul`, `memory`, and initial `knowledge` notes.
4. **`message_bot`**: Opens a new group chat (`topic` required) in the caller's family. `botId` or `slug` names one target. `to: [slug, ...]` names several; the members are the caller plus those targets, in that order, and the call still spends one peer action. Same family only. Each target is appended with `admitHop`, so a fresh call can name at most three targets before depth 3 is exceeded, and a target already on the chain is a cycle. The default (`wait: true`) blocks, memoized, until the caller ends it with `end_conversation`, the 10-turn cap, or the watchdog (120s per reply, 10 minutes overall). With exactly two members, the other member replies to every post. With more than two, only bots @mentioned by slug reply, in order of first mention, one at a time through the same turn loop. A bot mentioning itself is ignored. If the caller's opening message mentions nobody, every target is treated as mentioned for that opening post only. A later message that mentions nobody gets no replies. `wait: false` is fire-and-forget: the tool returns the group chat id and topic immediately, the caller's turn finishes, and the same group-chat loop runs in the background task `cadmus.group_drive`. The caller does not take turns in that mode. A two-member chat ends on the target's first non-empty reply. A larger chat ends when every bot mentioned in the opening message has posted once (or every target, when the opening mentions nobody). Cap and watchdog still end it. When the chat finishes (`ended`, `capped`, or `timed_out`), the result is admitted once into the caller's originating chat as a queued input (`whenBusy: queue`), which starts a new turn:

   `[group "<topic>" · reply from @<slug> · chat <id>] <text>`

   `capped` and `timed_out` put the status on that line. With more than two members the wake text lists each target reply. Delivery uses the stable request id `group-wake:<groupId>` plus a `wake_admitted` flag, so a Durable Object restart between the reply and the wake neither drops nor duplicates the turn. A wake turn gets a fresh 5-action peer budget (new root request id) and inherits the group's hop chain, so depth and cycle checks still stop ping-pong. Each member has its own pi chat with harvest off. The group chat is listed with every member and is read-only for the user. Legacy `peer:<from>:<to>` chats stay readable and read-only. `readOnly: true` (default false) keeps that same chat, the same limits, and the same hop, depth, cycle, and peer-action accounting, with cost still charged to the caller. The flag is stored on the group chat (`tools_read_only`) and listed as `toolsReadOnly: true`. Each target session is offered only `knowledge_read` and `memory_read` (`readOnlyGroupToolNames` in `@cadmus/contract/tools`). The tool gate refuses any other call, including a forged one, and changes nothing. The caller's own session in that chat keeps its tools, including `end_conversation`. Harvest stays off.

---

## Per-Bot Tool Gate (`packages/worker/src/extensions/tool-gate.ts`)

When a bot specifies a `tools: string[]` allowlist (on `bot.create` or `bot.update`):
1. `CadmusBotFamilyDO` configures the bot's conversations (`AgentDoc.tools`) with only those allowed tool names so the LLM is only offered permitted tools. `[]` offers none.
2. As defense-in-depth, `toolGateExtension` (`cadmus.tool-gate`) hooks `ToolTask.beforeTool` and blocks any tool call not present in `bot.tools`. An empty allowlist blocks every gated tool. Coding tools (`bash`, `read`, `write`, `edit`) are not offered unless they are listed and the resolved tools env is on.
3. A target session of a `message_bot` `readOnly` group chat is offered only `knowledge_read` and `memory_read`, and `beforeTool` refuses every other tool before it runs. The caller session is not narrowed.

On `bot.update`, an omitted `tools` field leaves the stored allowlist unchanged. `null` clears it back to the default set. An array replaces it. On `bot.create`, omitting `tools` keeps the default set (Cadmus tools allowed, coding tools opt-in). `[]` on create or update is an empty allowlist.
