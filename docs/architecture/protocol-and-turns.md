# Protocol, Shims & Out-of-Band Commands

Cadmus is designed as a **headless, protocol-first runtime**. Any UI (the standalone TUI in `tui/`, E2E tests in `e2e/`, or a future web/mobile client) interacts with the Worker exclusively over "the protocol".

---

## Zod-Validated Protocol (`src/protocol.ts`)

All client-to-server commands and server-to-client responses/events are validated at runtime using **Zod** schemas in `src/protocol.ts`:

### Client Commands (`ClientCommand`)
- **Account & Credentials**: `account.get`, `account.members.list`, `account.members.add`, `account.credentials.list`, `account.credentials.set`, `account.credentials.delete`
- **Bot Families**: `family.list`, `family.create`, `family.delete`, `family.get`, `family.update`
- **Bots**: `bot.list`, `bot.create`, `bot.get`, `bot.update`, `bot.delete`
- **Chats & Turns**: `chat.list`, `chat.create`, `chat.get`, `chat.close`, `turn.submit`, `turn.command`, `turn.abort`
- **Virtual Files & Knowledge**: `file.list`, `file.read`, `file.write`, `file.delete`, `knowledge.search`
- **Schedules**: `schedule.list`, `schedule.create`, `schedule.update`, `schedule.delete`

### Server Frames (`ServerFrame`)
- **Synchronous / Correlated RPC Reply (`CommandResultFrame`)**:
  `{ id, type: "command.result", command, ok, result?, error? }`
- **Streaming Server Events (`ServerEvent`)**:
  - `chat.state` (`busy: boolean`)
  - `turn.delta` (`kind: "text" | "thinking"`, `delta: string`)
  - `turn.tool_call` (`toolCallId`, `toolName`, `args`)
  - `turn.tool_result` (`toolCallId`, `toolName`, `content`, `isError`)
  - `turn.completed` (`chatKey`, `entryId`, `status`, `text`)
  - `schedule.fired` (`scheduleId`, `botId`, `target`, `when`)
  - `harvest.completed` (`chatKey`, `botId`, `note`)
  - `account.event` (`accountId`, `action`, `providerId`, `when`)
  - `protocol.error` (`code`, `message`)

---

## Pluggable `ProtocolShim` (`src/shim.ts`)

To keep the core runtime independent of wire serialization details (so future clients can use Protobuf, MsgPack, or UI-specific adapters), `CadmusBotFamilyDO` decodes and encodes frames through the `ProtocolShim` interface:

```ts
export interface ProtocolShim<TWire = string | Uint8Array> {
  readonly id: string;
  readonly contentType: string;
  decodeCommand(raw: TWire): ClientCommand;
  encodeFrame(frame: ServerFrame): string;
}
```

The default implementation (`JsonProtocolShim`) parses JSON and validates every frame against `ClientCommandSchema` / `ServerFrameSchema`.

---

## Transports

1. **`POST /rpc`**: Sends a single `ClientCommand` and returns a `CommandResultFrame`.
2. **`GET /ws` (`Upgrade: websocket`)**: Full-duplex WebSocket inside `CadmusBotFamilyDO`. Accepts `ClientCommand` frames and pushes both `CommandResultFrame` responses and live `ServerEvent` broadcasts (`turn.delta`, `turn.tool_call`, etc.).
3. **`GET /events`**: Server-Sent Events (SSE) stream of live `ServerEvent` frames.

---

## Out-of-Band Slash Commands (`/status`)

Control and inspection slash commands—specifically **`/status`**—do **not** belong in the LLM conversation transcript:
- Putting `/status` into `pi-durable` entries or session docs would either pollute the LLM prompt window or require special filtering.
- Instead, when `turn.submit` receives `text: "/status"` (or when `turn.command` is called with `command: "/status"`), `CadmusBotFamilyDO.handleOutOfBandStatus()` intercepts the request **before** `conv.submit()`.
- It queries `LiveDoc`, `UsageDoc`, `conv.context()`, `familyStore.harvest.getWatermark()`, and `familyStore.schedules` directly, returning `{ outOfBand: true, command: "/status", status, text }` with **zero** entries added to the conversation and **zero** LLM invocations.
- Unrecognized slash commands (e.g., `/clear`, `/reset`) are rejected with `400 unsupported_command`.

---

## Standalone TUI Boundary (`tui/`)

The terminal client in `tui/` is an independent package with its own `tui/package.json` and `tui/tsconfig.json`. It imports **zero** files from `src/` and communicates with the Worker exclusively via HTTP `/rpc` and WebSocket `/ws`.
