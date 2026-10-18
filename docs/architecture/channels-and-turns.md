# Channels, Turn Lifecycle & Client API

Part of the [architecture](../architecture.md). Bot and chat records are in [Bots, Chats & Storage](./bots-and-storage.md). Prompt sections and harvest are in [Prompt, Knowledge, Memory & Idle Harvest](./knowledge-and-harvest.md).

## Inbound and turn flow

```mermaid
sequenceDiagram
  participant Client as Web Client / Schedule
  participant RT as Bot runtime
  participant H as Harness
  Client->>RT: createChat / find chat
  Client->>RT: submit(chatKey, requestId, text)
  RT->>H: cancel pending harvest, sync tools, admit input once
  RT-->>Client: admission durable
  H->>H: turn, tool calls, assistant reply
  RT->>H: arm idle harvest on rested entry
  H-->>Client: stream via SSE
```

Every inbound message carries a deterministic `requestId` so retries or redeliveries are ignored:

| Source | Request id |
|---|---|
| Web message | `<chatKey>:<clientMsgId>` |
| Schedule occurrence | `sched:<id>:<nextRun>` |
| Idle harvest child | `harvest:<chatKey>:<entryId>` |

When `submit` admits a new user message:
1. Any armed idle-harvest task for that chat is cancelled.
2. The conversation's offered tool list is synced to match the bot's current `tools` setting.
3. The input is submitted to the conversation with `whenBusy: "steer"` (`steeringMode: "all"`), so messages arriving mid-turn steer the active run at the next boundary. Native context compaction is enabled on the harness.
4. A background watcher waits for the submission to settle, warns if no text or tool call starts within 10 seconds, arms a new idle-harvest wake on the rested entry, and appends an `unanswered:<submissionId>` notice if the turn settled as unanswered (unless aborted/withdrawn).

A duplicate `requestId` neither cancels nor re-arms harvest and does not re-run the turn.

## Slash commands

`/new` (alias `/reset`), `/stop`, `/status`, `/help`, and `/start` share one command handler:

- The command claims its `requestKey` in `pi-bot.commands` inside a commit before taking effect; redelivered commands are ignored.
- `/new` / `/reset` resets the conversation's visible model context while keeping prior entries stored.
- `/stop` aborts the in-progress conversation run.
- `/status` reports the bot's model and conversation id.
- The command response is appended as a notice in the transcript. Commands do not arm idle harvest.

## Web channel and client API

The HTTP server listens when `WEB_TOKEN` is set. Requests authenticate via `Authorization: Bearer <WEB_TOKEN>` or the `HttpOnly` cookie set by opening `/?token=<WEB_TOKEN>`.

Resources are scoped by bot id or chat key:

- **Status and catalogs (`GET /api/status`, `GET /api/models`, `GET /api/tools`).** Status (`{ status: "ok" }`), offered model providers (`xai`, `faux`), and the installed tool catalog grouped by extension (`Knowledge`, `Schedules`, `Internal`, `Web`). No secrets are returned.
- **Bots (`GET /api/bots`, `POST /api/bots`, `PATCH /api/bots/:id`).** List, create, and update `name`, `model`, `thinking`, and enabled `tools`. Create and model changes fail with `422` when the model is unknown or its provider has no credentials.
- **Bot tools (`GET /api/bots/:id/tools`, `PUT /api/bots/:id/tools`).** Read and replace the enabled tool set (`{ enabled: string[] }`) for one bot, immediately syncing idle chats of that bot.
- **Chats (`GET /api/bots/:id/chats`, `POST /api/bots/:id/chats`, `PATCH /api/chats/:key`, `DELETE /api/chats/:key`).** List a bot's live chats (with `opening` and `preview` snippets), create a web chat (`{ chatId? }`), rename (`{ title }`), or close (`DELETE`).
- **Messages (`GET /api/chats/:key/messages`, `POST /api/chats/:key/messages`).** Read the projected chat transcript merged with harvest notes (`type: "harvest"`). Post `{ clientMsgId, text }` to submit a user message or slash command with request id `<chatKey>:<clientMsgId>`.
- **Entries (`GET /api/chats/:key/entries`).** Read the raw conversation log: every stored entry in ascending order, including system, reset, and tool-result rows omitted from the projected transcript.
- **Events (`GET /api/chats/:key/events`).** Server-Sent Events stream for one chat: `harvest`, `state`, `delta`, `tool`, `done`, `error`. On connect, stored harvest notes for that chat are sent first, followed by a `state` snapshot (including context token usage and model window).
- **Files (`GET /api/bots/:id/files`, `GET /api/bots/:id/files/:rel`, `PUT /api/bots/:id/files/:rel`).** List, read, and write `SOUL.md`, `MEMORY.md`, and `knowledge/*.md` (see [Prompt, Knowledge, Memory & Idle Harvest](./knowledge-and-harvest.md)).
- **Schedules (`GET /api/bots/:id/schedules`, `POST /api/bots/:id/schedules`, `PUT /api/schedules/:id`, `DELETE /api/schedules/:id`).** List, create, replace, and delete user schedules for a bot (see [Schedules, Extensions & Tool Policy](./schedules-and-tools.md)).

The bundled Preact web client is a stateless workspace over this API; it keeps no second copy of bots, transcripts, or files.
