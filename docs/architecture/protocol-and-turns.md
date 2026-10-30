# Protocol, Shims & Out-of-Band Commands

Cadmus is designed as a **headless, protocol-first runtime**. Any client (the `cadmus` CLI in `packages/cli/`, the web UI, or E2E tests in `e2e/`) interacts with the Worker exclusively over the protocol.

---

## TypeBox-Validated Protocol (`packages/worker/src/protocol.ts`)

All client-to-server commands and server-to-client responses/events are validated at runtime using **TypeBox** schemas in `packages/worker/src/protocol.ts`:

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

## Pluggable `ProtocolShim` (`packages/worker/src/shim.ts`)

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

`/api/*` is a thin edge translation in [`packages/worker/src/api-adapter.ts`](../../packages/worker/src/api-adapter.ts). It builds a `ClientCommand` and runs the **same** dispatch function as `POST /rpc` (edge `family.create`, then the family Durable Object `/rpc`). There is no second command switch.

Path mapping lives in [`packages/worker/src/protocol/rest.ts`](../../packages/worker/src/protocol/rest.ts) (schema `readOnly`, query coercion) and [`packages/worker/src/protocol/rest-encode.ts`](../../packages/worker/src/protocol/rest-encode.ts) (path strings, no TypeBox). `encodePayloadQuery` is generated into `@cadmus/contract/routes` and re-exported from `packages/worker/src/protocol.ts`. Dots in the command name become slashes:

| Command | HTTP |
| --- | --- |
| `file.read` (`readOnly: true`) | `GET /api/file/read` |
| `file.write` | `POST /api/file/write` |
| `account.members.list` (`readOnly: true`) | `GET /api/account/members/list` |

`readOnly: true` on the command's TypeBox schema options is the only method table. `isCommandReadOnly` reads it from `ClientCommandSchema.anyOf`. Readonly commands require `GET` or `HEAD` (`Allow: GET, HEAD`). Every other command requires `POST` (`Allow: POST`). A mismatch is **405**. An unknown path is **404**. `HEAD` runs the readonly command and returns the same status with an empty body.

`GET` query parameters become the command `payload`. Values are coerced against the payload schema: booleans (`true`/`false`), integers, numbers, strings, repeated keys for arrays, and a JSON-encoded value for objects (and for arrays of objects). `accountId`, `userId`, and `familyId` are reserved for routing. `token` is not reserved: `/api` rejects a `token` query parameter before coercion (**401** `{ error: { code: "query_token_not_allowed" } }`), even when `Authorization: Bearer` is also present, and the value is not logged. A leftover `token` key that reached coercion would be an unknown parameter. `familyId` is copied into the payload only when that command's schema has a `familyId` property, so family routing matches `/rpc` (payload `familyId` overrides the `X-Cadmus-Family-Id` header; otherwise the header wins over the query). Unknown query keys are rejected with **400**.

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

Unauthenticated `/api/*` requests never reach the adapter. They use `authenticateRequest` with `{ allowQueryToken: false, allowCookie: false }`. The only accepted credential is `Authorization: Bearer`. Missing or invalid tokens return the same **401** `protocol.error` body as `/rpc`. A `token` query parameter returns **401** `{ error: { code: "query_token_not_allowed" } }`. A `cadmus_session` cookie without the header returns **401** `{ error: { code: "header_required" } }`. `/rpc`, `/ws`, and `/events` still accept `?token=` and the session cookie. `readOnly` is part of the TypeBox schema, so `GET /protocol/schema` includes it on each readonly command.

Every `/api/*` response (success, error, **401**, **404**, **405**, and `HEAD`) sends `Cache-Control: private, no-store` and `Vary: Authorization, Cookie, X-Cadmus-Family-Id` (merged with any `Vary` already on the response). These bodies are private per-tenant data, so a shared cache must not store them.

`/rpc` status codes are unchanged (the Durable Object still returns 400 for a failed command result). Only `/api/*` remaps error codes. `/rpc` responses do not send the `/api/*` cache headers.

### Web UI client

[`packages/web/src/client.ts`](../../packages/web/src/client.ts) (`CadmusClient`) is the browser caller. `callRpc` and `sendCommand` keep their signatures and return a `CommandResultFrame`. The HTTP request uses `@cadmus/contract/routes` (`API_ROUTES` from each command's `readOnly` flag → GET, otherwise POST) and `encodePayloadQuery`:

- Readonly commands are `GET /api/...`. The payload is `encodePayloadQuery` (the inverse of `coerceSearchParamsToPayload`). `undefined` fields are omitted. GET and HEAD do not send `Content-Type`.
- Mutating commands are `POST /api/...` with the payload object as the JSON body and `Content-Type: application/json`.
- `Authorization: Bearer`, `x-user-id`, `x-account-id`, and `X-Cadmus-Family-Id` are sent on every `/api` call. The bearer token is never copied into the `/api` URL. The WebSocket URL still carries `token` for `GET /ws`.
- A `fetch` throw rejects with that error. A non-JSON body rejects from `response.json()`, same as the previous `/rpc` client. HTTP error JSON and `protocol.error` frames resolve as `{ ok: false, error }`.
- The web bundle imports `@cadmus/contract/routes`, `@cadmus/contract/types`, and `@cadmus/contract/tools`. It does not import command schemas, OpenAPI, or AsyncAPI.
- `GET /ws` is unchanged and carries `ServerEvent` frames only. Commands do not go over the socket.

A successful `/api` body is the unwrapped `result`. The client adds `id`, `type: "command.result"`, `command`, and `ok: true`. Only REST `{ error }` bodies and auth `protocol.error` frames resolve as `{ ok: false, error }`.

The Vite dev server proxies the `assets.run_worker_first` paths from `wrangler.jsonc` (`/health`, `/protocol/schema`, `/ws`, `/events`, `/rpc`, `/api/*`, `/tools-env/*`) to the Worker. The TUI still speaks `/rpc`.

### OpenAPI and AsyncAPI (internal artifacts)

`bun run contract:gen` writes OpenAPI 3.1 (`packages/contract/generated/openapi.json`) and AsyncAPI 3 (`packages/contract/generated/asyncapi.json`). `bun run contract:check` regenerates them in memory and fails if the committed copies differ. `check:all` also runs `$ref` resolution tests, swagger-parser OpenAPI validity, and an AsyncAPI validity check. These files are internal contract snapshots for review and CI. The Worker does not import or serve them; `/api/openapi.json` and `/api/asyncapi.json` fall through to normal `/api` handling (header auth first, then **404** as unknown command paths). Clients must not import `@cadmus/contract/openapi.json` or `@cadmus/contract/asyncapi.json`.

---

## Out-of-Band Slash Commands (`/status`)

Control and inspection slash commands—specifically **`/status`**—do **not** belong in the LLM conversation transcript:
- Putting `/status` into `pi-durable` entries or session docs would either pollute the LLM prompt window or require special filtering.
- Instead, when `turn.submit` receives `text: "/status"` (or when `turn.command` is called with `command: "/status"`), `CadmusBotFamilyDO.handleOutOfBandStatus()` intercepts the request **before** `conv.submit()`.
- It queries `LiveDoc`, `UsageDoc`, `conv.context()`, `familyStore.harvest.getWatermark()`, and `familyStore.schedules` directly, returning `{ outOfBand: true, command: "/status", status, text }` with **zero** entries added to the conversation and **zero** LLM invocations.
- Unrecognized slash commands (e.g., `/clear`, `/reset`) are rejected with `400 unsupported_command`.

---

## CLI Boundary (`packages/cli/`)

The `cadmus` CLI is an independent package with its own `packages/cli/package.json` and `packages/cli/tsconfig.json`. It imports **zero** files from `packages/worker/src/`. REST commands use `/api`. `send` and `events` use `/ws`. Help text is generated from `@cadmus/contract` schemas and `API_ROUTES`.
