# Data model

Part of the [architecture](../architecture.md). How a turn uses these records is in [data flow](./flow.md). The HTTP resources are in the [client surface](./client.md).

```
PI_BOT_HOME/
  durable.sqlite          session documents and conversations
  schedules.sqlite        schedule rows and fire claims
  bots/<botId>/
    SOUL.md               persona
    SYSTEM.md             standing instructions
    knowledge/<slug>.md   one topic per file
    users/<userId>/disk/  private files for one user of this bot
```

Persona and knowledge are files. The session stores identity, chat directories, receipts, and notes. Schedule rows live in the sidecar so a later out-of-process clock can own that file while this process keeps the lock on `durable.sqlite`.

## Bot

`pi-bot.bots`, one row per bot:

| Field | Role |
|---|---|
| `id` | slug, stable for the life of the bot |
| `name` | display name |
| `model` | provider and model id |
| `thinking` | thinking level |
| `tools` | extra tool names stored for the bot |
| `telegramToken` | optional second Telegram door; omitted from client reads |
| `createdAt` | unix milliseconds |

`default` is created on first start. On later starts its model and thinking follow the process environment, and every existing `default` chat is set to that model, thinking level, and `bots/default`. Its display name stays, and the API refuses a rename. For a missing `bots/default/`, a home-root `SOUL.md` is copied into `SOUL.md` when that file is present, and a home-root `AGENTS.md` is copied into `SYSTEM.md` when that file is present. Whichever of the two is absent gets the built-in seed. An existing directory is left as it is. `knowledge/` is created either way.

Creating any other bot allocates a slug from the name, writes the folder, then commits the row. A failed commit removes the new folder. A failed folder write does not commit the row. Slug rules are in [current policy](../architecture.md#current-policy).

The agent working directory of a new conversation is `bots/<botId>`.

## Chat

`pi-bot.telegram.chats` maps a chat key to an ownerless pi-durable conversation.

| Field | Role |
|---|---|
| `key` | address of the chat, below |
| `botId` | owning bot; which runtime admits the chat |
| `conversationId` | the durable conversation |
| `userId` | Telegram user id, when the door has one; selects `disk/` |
| `title` | optional display name |
| `chatId`, `threadId` | Telegram address, when the chat has one |

Keys:

```
<botId>:tg:general:<telegramChatId>[:<threadId>]
<botId>:tg:bot:<telegramChatId>[:<threadId>]
<botId>:web:<chatId>
```

A chat stays on one bot. The general door, the process token, opens chats only on `default` (`default:tg:general:…`). A token stored on a bot opens `<botId>:tg:bot:…` and nothing on the general door. Forum topics are their own conversations. A key from before this layout is rewritten once, onto `default` and the general door, and keeps its conversation.

Closing a chat drops it from the live directory and refuses further admission. The conversation log remains.

## What a conversation receives

Sections, stable toward volatile, from that bot's folder. Identity renders them when a request is built.

1. `soul` — `SOUL.md`. An empty file falls back to a built-in persona.
2. `system` — `SYSTEM.md`.
3. `knowledge` — a description index, rebuilt by scanning `knowledge/` when the prompt is rendered. Bodies stay out of the prompt. The model opens a file with `read` when the index matches.
4. `date` — a daily line.

A knowledge file is markdown with a single `description` frontmatter line. A file the parser cannot read, or whose real path leaves the bot folder, is left out of the index and named in a warning line. There is no separate index file.

Client writes of knowledge files are checked first (legal slug, readable description). A failed check leaves the file unchanged. Model writes go through the file tools, which accept any text. A file that then fails the parser drops out of the index.

## Shared and private

Everyone who reaches a bot shares that bot's `SOUL.md`, `SYSTEM.md`, `knowledge/`, model, thinking level, and stored tool list.

Each person has their own chats. Schedule rows name one chat, or create one new chat. Harvest notes attach to the chat that was forked. `users/<userId>/disk/` is visible to the file tools as `disk/` for the conversation's user. A path that leaves the bot folder, or that reaches another user's tree, is refused. A conversation with no user id cannot use `disk/`.

A harvest from one chat writes the shared knowledge folder. Other chats see the new description on their next prompt. They do not receive that chat's transcript or its harvest note. How the note is produced is in [idle harvest](./flow.md#idle-harvest).

There is no owner role. Doors are gates: a shared web credential, a Telegram allowlist, and an optional token stored on a bot. The same person on two doors of one bot has two chats. The web credential is not a user id, and the chat list for a bot is every live chat of that bot. Per-person hiding of transcripts is not applied on this door. A later admin mode needs a real user identity; the web credential is not that role. Group chats are outside this model.

## Other session documents

| Document | Role |
|---|---|
| `pi-bot.telegram.deliveries` | outbound Telegram receipts, per conversation |
| `pi-bot.telegram.commands` | command request keys already claimed |
| `pi-bot.telegram.cursor` | `getUpdates` offset for the general door |
| `pi-bot.telegram.bot-cursors` | offsets for per-bot doors |
| `pi-bot.harvest-notes` | out-of-band notes on parent chats |

Receipts and command claims are applied in [data flow](./flow.md).

## Schedules

Sidecar tables `schedules` and `fires`. A row is either `cron` (an expression) or `when` (a timestamp), plus:

- `id`, chosen by the caller
- `botId`
- `text`, the message admitted when it fires
- `target`: `chat` (one existing chat), `new-chat` (create a web chat, then admit), or `fork` (fork the conversation at an entry and admit into the child)
- `at` on `chat` and `fork`, an optional entry id. A `chat` fire ignores it and submits into the live chat. A `fork` fire uses it as the fork point, or the latest entry when it is absent.

`put` writes the row and its next wake. The default leaves an existing id unchanged. Replace overwrites the row and its wake in one transaction. `reschedule` moves only the next wake. `remove` deletes the row. `list` reads rows. `start` runs the in-process clock. `fire` loads the row and dispatches. The in-process clock and the HTTP fire route both call it. An external clock uses that route and does not open `durable.sqlite`.

What each target does when it fires is in [a schedule fire](./flow.md#a-schedule-fire). Internal jobs use the same table. Client listings skip ids reserved for those jobs. Today that prefix is `harvest:`.
