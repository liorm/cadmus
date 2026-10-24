# Protocol, Shims & Out-of-Band Commands

Cadmus is designed as a **headless, protocol-first runtime**. Any UI (the standalone TUI in `tui/`, E2E tests in `e2e/`, or a future web/mobile client) interacts with the Worker exclusively over "the protocol".

---

## TypeBox-Validated Protocol (`src/protocol.ts`)

All client-to-server commands and server-to-client responses/events are validated at runtime using **TypeBox** schemas in `src/protocol.ts`:

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
2. **`/api/*`**: REST translation of the same commands (see below). Does not replace `/rpc`.
3. **`GET /ws` (`Upgrade: websocket`)**: Full-duplex WebSocket inside `CadmusBotFamilyDO`. Accepts `ClientCommand` frames and pushes both `CommandResultFrame` responses and live `ServerEvent` broadcasts (`turn.delta`, `turn.tool_call`, etc.).
4. **`GET /events`**: Server-Sent Events (SSE) stream of live `ServerEvent` frames.

---

## REST Adapter (`/api/*`)

`/api/*` is a thin edge translation in [`src/api-adapter.ts`](../../src/api-adapter.ts). It builds a `ClientCommand` and runs the **same** dispatch function as `POST /rpc` (edge `family.create`, then the family Durable Object `/rpc`). There is no second command switch.

Path mapping lives in the pure module [`src/protocol/rest.ts`](../../src/protocol/rest.ts), re-exported from `src/protocol.ts` so the web client can import it the same way it imports protocol types (`import { isCommandReadOnly, apiRouteForCommand } from "../../src/protocol.js"`). Dots in the command name become slashes:

| Command | HTTP |
| --- | --- |
| `file.read` (`readOnly: true`) | `GET /api/file/read` |
| `file.write` | `POST /api/file/write` |
| `account.members.list` (`readOnly: true`) | `GET /api/account/members/list` |

`readOnly: true` on the command's TypeBox schema options is the only method table. `isCommandReadOnly` reads it from `ClientCommandSchema.anyOf`. Readonly commands require `GET` or `HEAD` (`Allow: GET, HEAD`). Every other command requires `POST` (`Allow: POST`). A mismatch is **405**. An unknown path is **404**. `HEAD` runs the readonly command and returns the same status with an empty body.

`GET` query parameters become the command `payload`. Values are coerced against the payload schema: booleans (`true`/`false`), integers, numbers, strings, repeated keys for arrays, and a JSON-encoded value for objects (and for arrays of objects). `token`, `accountId`, `userId`, and `familyId` are reserved for authentication and routing. `?token=` is accepted for parity with `/rpc`, `/ws`, and `/events`. Clients should prefer the `Authorization` header or the session cookie, because a query token leaks into access logs, browser history, and `Referer`. `familyId` is copied into the payload only when that command's schema has a `familyId` property, so family routing matches `/rpc` (payload `familyId` overrides the `X-Cadmus-Family-Id` header; otherwise the header wins over the query). Unknown query keys are rejected with **400**.

`POST` body is the payload object, or an envelope `{ id?, type?, payload }`. The adapter generates `id` (`api-` plus eight hex characters) when the envelope does not include one. The frame is validated with the same `JsonProtocolShim.decodeCommand` path `/rpc` uses.

Success responses are HTTP **200** and the unwrapped `result` (not the `command.result` envelope). Failures are `{ error: { code, message } }`:

| Protocol `code` | HTTP status |
| --- | --- |
| `unauthorized` | 401 |
| `forbidden` | 403 |
| `not_found`, `family_not_found`, any `*_not_found` | 404 |
| `cas_conflict`, `conflict` | 409 |
| `command_failed` | 500 |
| validation codes and anything else | 400 |

Unauthenticated `/api/*` requests never reach the adapter. They share `authenticateRequest` with `/rpc` and return the same **401** `protocol.error` body. `readOnly` is part of the TypeBox schema, so `GET /protocol/schema` includes it on each readonly command.

Every `/api/*` response (success, error, **401**, **404**, **405**, and `HEAD`) sends `Cache-Control: private, no-store` and `Vary: Authorization, Cookie, X-Cadmus-Family-Id` (merged with any `Vary` already on the response). These bodies are private per-tenant data. Cookie and `?token=` requests do not send `Authorization`, so a shared cache must not store them.

`/rpc` status codes are unchanged (the Durable Object still returns 400 for a failed command result). Only `/api/*` remaps error codes. `/rpc` responses do not send the `/api/*` cache headers.

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
