# Bots, Chats & Storage

Part of the [architecture](../architecture.md). Turn execution and channels are in [Channels, Turn Lifecycle & Client API](./channels-and-turns.md). Prompt and knowledge files are in [Prompt, Knowledge, Memory & Idle Harvest](./knowledge-and-harvest.md).

## Home directory

```
PI_BOT_HOME/
  owner.lock              single-process storage lock (pid + host)
  durable.sqlite          session documents, conversations, and tasks
  schedules.sqlite        schedule rows and fire claims
  auth.json               OAuth credentials (0600)
  bots/<botId>/
    SOUL.md               persona
    MEMORY.md             standing preferences (in the prompt when non-empty)
    knowledge/<slug>.md   one topic per file
```

Persona, standing memory, and knowledge are markdown files under `bots/<botId>/`. The durable session (`durable.sqlite`) stores bot records, chat directories, command claims, and harvest state. Schedule rows live in the sidecar `schedules.sqlite`.

## Bot record

`pi-bot.bots` (`BotsDoc`), one row per bot:

| Field | Role |
|---|---|
| `id` | slug (`[a-z0-9][a-z0-9-]{0,31}`), stable for the life of the bot |
| `name` | display name |
| `model` | `provider/modelId` |
| `thinking` | thinking level (`""` when unset) |
| `tools` | enabled tool names; omitted means every tool is on, `[]` means every tool is off |
| `rootConversationId` | ownerless conversation that owns this bot's background schedule and harvest tasks; not a chat |
| `createdAt` | unix milliseconds |

A fresh home has no bots. Creating a bot from the HTTP API derives a slug from the display name (adding `-2`, `-3`, … if the id or `bots/<id>/` folder already exists), writes the folder (`SOUL.md` and `knowledge/`), then commits the bot row and its `rootConversationId` in one transaction. The `create_bot` model tool instead takes an explicit `slug` (refusing it if already taken) and can also seed `MEMORY.md` and `knowledge/*.md` at version 0. A failed commit removes any newly created folder; a failed folder write commits nothing.

An existing bot keeps its stored model and thinking level across restarts. Its display name, model, thinking level, and enabled tool list can be updated; its `id` never changes. The host does not delete bots.

The agent working directory (`cwd`) of every chat conversation for a bot is `bots/<botId>`.

## Chat record

`pi-bot.chats` (`ChatsDoc`) maps a chat key to an ownerless pi-durable conversation and tracks closed chat keys in `closed`.

| Field | Role |
|---|---|
| `key` | address of the chat: `<botId>:web:<chatId>` |
| `botId` | owning bot; selects which runtime admits the chat |
| `conversationId` | the durable conversation |
| `title` | optional display name |

Chat key format:

```
<botId>:web:<chatId>
```

A chat belongs to one bot.

Closing a chat removes it from `items`, records its key in `closed`, and refuses further admission. The underlying conversation log remains in `durable.sqlite`.

## Session documents

All session documents live in `durable.sqlite`:

| Document | Role |
|---|---|
| `pi-bot.bots` | bot catalog and per-bot settings |
| `pi-bot.chats` | active and closed chat directory |
| `pi-bot.commands` | slash-command request keys already claimed |
| `pi-bot.harvest-notes` | `notes` (file diffs per parent chat), `completed` (`chatKey → entryId` watermark), and `armed` (`chatKey → { taskId, at, seq }` live harvest wakes) |

## Shared vs. per-chat state

Everyone who reaches a bot shares that bot's `SOUL.md`, `MEMORY.md`, `knowledge/`, model, thinking level, and tool list.

Each chat has its own conversation transcript. Schedule rows target one existing chat, open a new web chat, or fork a chat silently. Harvest notes attach to the parent chat that was forked. When an idle harvest updates `knowledge/` or `MEMORY.md`, other chats on the same bot see the updated knowledge descriptions or memory body on their next turn, without receiving that chat's transcript or harvest note.

Access is authenticated via a shared web credential (`WEB_TOKEN`).
