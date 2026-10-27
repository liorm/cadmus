# Virtual Files, Knowledge Store & Idle Harvest

Cadmus manages each bot's persona, long-term memory, and reference notes **out-of-band** from the `pi-durable` conversation log using the `BotFileStore` interface (`packages/worker/src/store/family-interface.ts`), backed by SQLite tables inside `CadmusBotFamilyDO` (`packages/worker/src/store/sqlite-family.ts`).

---

## Why Out-of-Band Storage (`BotFileStore`) Instead of Session Docs?

1. **Per-Bot Isolation**: In `pi-durable`, session-scoped documents are global to the entire session, whereas conversation-scoped documents are tied to a single chat. Bot files (`SOUL.md`, `MEMORY.md`, `knowledge/<slug>.md`) must be scoped **per bot** across all of that bot's chats.
2. **Indexed Search**: Storing `knowledge/<slug>.md` in dedicated SQLite tables (`cadmus_bot_knowledge`) allows fast SQL keyword/category filtering (`searchKnowledge`) without loading every document into memory.
3. **Storage Abstraction**: Hiding file persistence behind `BotFileStore` makes it trivial to swap or tier large knowledge bases to Cloudflare R2 or Vectorize in the future without touching extensions or tools.

---

## Virtual File Types & Constraints

| Virtual Path | Backing Table | Limits & Concurrency Rules |
| :--- | :--- | :--- |
| `SOUL.md` | `cadmus_bot_souls` | Persona markdown injected into every prompt. |
| `MEMORY.md` | `cadmus_bot_memories` | Max **32 KiB** (`32,768` bytes). Enforces Compare-And-Swap (`expectedVersion`); increments `version` on every write. |
| `knowledge/<slug>.md` | `cadmus_bot_knowledge` | Max **64 KiB** (`65,536` bytes) per file, max **200** files per bot. Slug must match `/^[a-z0-9][a-z0-9-]{0,63}$/`. Requires non-empty `description` (frontmatter when accessed via `file.write` / `file.read`). Enforces Compare-And-Swap (`expectedVersion`). |

---

## Prompt Assembly (`cadmus.identity` in `packages/worker/src/extensions/identity.ts`)

Before each model turn, `identityExtension` renders three positional system prompt sections:
1. **`cadmus.soul`**: The bot's `SOUL.md` instructions.
2. **`cadmus.memory`**: The bot's `MEMORY.md` content (with its current `version` so the model can call `memory_update` with the right `expectedVersion`).
3. **`cadmus.knowledgeIndex`**: A compact index of the bot's `knowledge/<slug>.md` files (`slug`, `category`, `version`, and `description`)—never the full bodies, keeping the prompt token footprint small until the model calls `knowledge_read` or `knowledge_search`.

---

## Forked Idle Harvest (`executeHarvestFork` in `packages/worker/src/schedules.ts`)

When a user turn completes on `chatKey` and the family's `harvestDelayMs > 0`:
1. **Debounce via Unified Schedule**: `CadmusBotFamilyDO` upserts an internal one-shot schedule `harvest:<chatKey>` (`internal: true`, `kind: "when"`, `when: Date.now() + harvestDelayMs`, `target: { mode: "fork", chatKey, at: latestEntryId, harvest: true }`). Any new user turn on `chatKey` before `when` deletes/replaces the pending schedule.
2. **Fork without Polluting Parent Chat**: When the alarm fires and `harvest:<chatKey>` runs:
   - It checks `cadmus_harvest_watermarks` to ensure there is at least one unharvested user turn after `watermark`.
   - It snapshots the bot's `MEMORY.md` and `knowledge/*` files (`snapshotFiles(botId)`).
   - It forks the parent conversation at `at` (`parent.fork(at)`), restricts the forked child conversation's tools to `HARVEST_TOOLS` (`knowledge_read`, `knowledge_update`, `knowledge_delete`, `memory_read`, `memory_update`), and submits `DEFAULT_HARVEST_PROMPT`.
3. **Unified Diffs & Watermark Advancement**:
   - After the forked turn settles, `diffSnapshots(before, after)` computes unified line diffs for any modified/created/deleted files.
   - If files changed, a `HarvestNote` (`at`, `when`, `files: [{ path, diff }]`) is persisted in `cadmus_harvest_notes` and broadcast as a `harvest.completed` event.
   - Finally, the chat's harvest watermark is advanced to `at`, and the one-shot internal schedule `harvest:<chatKey>` is cleaned up.
