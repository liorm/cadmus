* summarize arcitecture from the current plan docs. focus on the backend, data model, data flow and components. Consider adding a diagram if needed. Done: [architecture.md](./architecture.md).
* Communication hub between bots


First use-case - try to convert the knowledge bots.

## Later

From the architecture. Not built.

* A bot in its own process, behind the same runtime. Doors and chat fires stay on that handle. A fork stays with the storage owner.
* A schedule clock outside the process. It calls `fire` and can own `schedules.sqlite`.
* A real user identity, and an admin mode on top of it. The web credential stays a door.
* Per-user MCP sessions keyed by bot and user. Server configuration stays shared.
* A model tool that creates schedules.
* Undo for a harvest.
* Watching the bot folder for edits made outside the process.
