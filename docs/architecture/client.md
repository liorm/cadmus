# Client surface

Part of the [architecture](../architecture.md). The records behind these resources are in the [data model](./model.md). Admission, delivery, and harvest are in [data flow](./flow.md).

The HTTP channel is how another UI plugs in. It listens only when a web credential is configured (bearer header, or a cookie set by opening `/?token=`). Requests without that credential are rejected. Telegram doors open from the process token and from tokens stored on bots. Either channel can run without the other.

Resources, scoped by bot id or chat key:

- **Bots.** List, create, and patch name, model, thinking, and enabled tools. Create and a model change fail with 422 when the model is unknown or its provider has no credentials. Reads include whether a per-bot Telegram token is set, and omit the token. The row is the [bot record](./model.md#bot). `GET /api/tools` lists every tool. `GET` and `PUT /api/bots/<id>/tools` read and replace the enabled set. Omitting `tools` on the bot row means every tool is on. An empty list is a fresh home. The page then opens the create dialog.
- **Telegram door.** Set or clear the per-bot token. That starts or stops that bot's poller.
- **Chats.** List and create web chats. Rename. Close. Keys and closing are on the [chat record](./model.md#chat).
- **Messages.** Read the transcript. Harvest notes are separate timeline items. Post `{ clientMsgId, text }`. The same post accepts a slash command. The request id is `<chatKey>:<clientMsgId>` ([inbound](./flow.md#inbound)).
- **Entries.** Read the raw conversation log: every stored entry in order, including system, reset, and tool-result rows the chat transcript omits. `GET /api/chats/<key>/entries`.
- **Events.** A server-sent stream for one chat: `state`, `delta`, `tool`, `done`, `error`, `harvest`. Connecting again sends stored harvest notes, then `state`.
- **Files.** List and read `SOUL.md`, `MEMORY.md`, and `knowledge/*`. Knowledge entries include the parsed description and whether it is valid. `SOUL.md` reads and writes `{ text }`. `MEMORY.md` reads and writes `{ body, version }` like `memory_read` / `memory_update` (missing file is version 0). Knowledge reads and writes the same structured fields as `knowledge_update` (`description`, `body`, `version`, optional `category`). Frontmatter stays on disk. The index rules are in [what a conversation receives](./model.md#what-a-conversation-receives).
- **Schedules.** List, create, replace, delete, and fire user schedules for a bot. Internal harvest rows are left out of this surface. The model's schedule tools write the same rows; a schedule created in a chat shows up here. Fire behavior is in [a schedule fire](./flow.md#a-schedule-fire).
- **Status.** Whether the general Telegram door is configured. No secrets.

The bundled client is a workspace on that API: one bot at a time, then its chats, knowledge files, or schedules, with the live transcript in the main pane. It keeps no second copy of bots, transcripts, or files. Another page, a small CLI, or a later native client uses the same resources and the same chat keys. Delivery receipts, poll offsets, and the storage lock stay in the host.
