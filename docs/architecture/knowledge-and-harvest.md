# Prompt, Knowledge, Memory & Idle Harvest

Part of the [architecture](../architecture.md). Bot folders and session documents are in [Bots, Chats & Storage](./bots-and-storage.md). Turn execution is in [Channels, Turn Lifecycle & Client API](./channels-and-turns.md).

## Prompt sections

When a conversation builds a model request, `pi-bot.identity` renders five sections from the conversation's working directory (`bots/<botId>`), ordered from stable to volatile so prompt caching stays effective:

1. `soul` (untagged) — `Your name is <name>.` above the contents of `SOUL.md`. An empty or missing file falls back to the built-in persona.
2. `system` — operating instructions for `MEMORY.md` (`memory_read` / `memory_update`) and `knowledge/<slug>.md` (`knowledge_read` / `knowledge_update` / `knowledge_delete`).
3. `knowledge` — a description index rebuilt by scanning `knowledge/*.md` at render time. Lists up to 80 valid files in path order, then a count of any remaining files. File bodies stay out of the prompt; the model reads a file on demand with `knowledge_read`.
4. `memory` — the body of `MEMORY.md` when non-empty, plus its current `version` for `memory_update`. Frontmatter stays on disk. Omitted when empty or missing.
5. `date` — `Today is YYYY-MM-DD (Weekday), time zone <PI_BOT_TZ>.` Changes once per day.

## File formats and compare-and-swap

Both the HTTP file routes and the model tools enforce the same structure and compare-and-swap (`version`) rules:

- **`SOUL.md`.** Plain markdown text. Edited via the HTTP API (`{ text }`) or when creating a bot; not modified by knowledge tools.
- **`MEMORY.md`.** Standing preferences, voice, and operating instructions. Frontmatter contains only `version` (non-negative integer; missing file is version 0). The body must not start with a `---` fence and is at most 8192 bytes. Writing an empty body removes the file.
- **`knowledge/<slug>.md`.** Named durable facts, one topic per file.
  - Slug matches `[a-z0-9][a-z0-9-]{0,63}`.
  - Frontmatter requires `description` (one line, 1–240 characters) and allows `version` (non-negative integer; missing means 0) and `category` (one line, 1–64 characters).
  - The body must not start with a `---` fence.
  - Any file that fails parsing or resolves outside the bot folder is excluded from the prompt index and noted in a warning line.

Tools and client endpoints compose canonical frontmatter on disk; callers supply structured fields (`description`, `body`, `version`, optional `category`) rather than raw frontmatter. A write whose `version` does not match the file on disk is rejected without modifying the file, and a successful write increments `version` by 1.

## Knowledge and memory tools

`pi-bot.knowledge` installs five tools:

- `knowledge_read` — reads `knowledge/<slug>.md`, returning `{ slug, exists, version, description, category?, body }` (or `exists: false, version: 0` when absent).
- `knowledge_update` — creates or updates `knowledge/<slug>.md` when `version` matches.
- `knowledge_delete` — deletes `knowledge/<slug>.md`.
- `memory_read` — reads `MEMORY.md`, returning `{ exists, version, body }`.
- `memory_update` — writes or clears `MEMORY.md` when `version` matches.

All five tools are replay `safe`. `knowledge_update`, `knowledge_delete`, and `memory_update` memoize their outcome on the tool task (`api.memo`) so a crash recovery after the file was written returns the recorded outcome instead of failing compare-and-swap against the incremented version.

## Idle harvest

After a user turn settles in a chat, the bot runtime arms a background `pi-bot.harvest` task (`HarvestTask`) on the bot's `rootConversationId` and records `{ taskId, at: entryId, seq }` in `pi-bot.harvest-notes.armed[chatKey]`. The default idle delay is 60 seconds (`PI_BOT_HARVEST_DELAY_MS`).

`HarvestTask` runs through five checkpointed phases:

1. `wait` — stamps `until = now + harvestDelayMs` and sleeps on the harness clock. If a new user message arrives on that chat before `until`, `cancelHarvest` deletes `armed[chatKey]` and aborts the task.
2. `snap` — checks whether any new user entry arrived after the watermark `pi-bot.harvest-notes.completed[chatKey]`. If not, it advances `completed[chatKey] = at`, clears `armed[chatKey]`, and finishes without forking. Otherwise it snapshots `SOUL.md`, `MEMORY.md`, and `knowledge/*.md` into the task checkpoint.
3. `fork` — forks the parent chat conversation at `at` into a task-owned child conversation (memoized on the task so crash recovery reuses the same child) and configures the child with only the knowledge tools (`knowledge_*` and `memory_*`) currently enabled on the bot.
4. `awaitChild` — submits the harvest prompt (including the `completed[chatKey]` watermark when present) into the child with `requestId = harvest:<chatKey>:<entryId>` and waits for the child to go idle. The prompt instructs the model to persist standing preferences to `MEMORY.md` and durable facts to `knowledge/<slug>.md` as a single source of truth, and to make no writes if nothing new qualifies.
5. `note` — snapshots the bot folder again and computes line diffs against the `snap` checkpoint. In one commit on `pi-bot.harvest-notes`, it sets `completed[chatKey] = at`, clears `armed[chatKey]`, and (when files changed) appends `{ chatKey, at, files: [{ path, diff }], when }` to `notes`.

If any phase after `wait` throws (and the task was not aborted), the task logs an error and returns to `wait` to retry after 5 seconds.

Harvest notes are out-of-band session state (`pi-bot.harvest-notes`): they are shown as collapsible timeline items in the web UI, are never included in model prompts, and are never sent to Telegram. On process restart, each chat is checked once idle and armed if its latest entry is not yet in `completed[chatKey]`.
