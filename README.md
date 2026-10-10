# pi-bot

A Hermes-style personal agent on [`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable), talking over Telegram, a local web page, or both. Runs on **Bun**.

**Status: L1 workspace.** Several bots share one harness. Each bot has a folder, a streaming chat page, a knowledge editor, and user schedules. Idle chats can harvest notes into `knowledge/`. Memory, skills, the learning loop, and delegation are still later.

The running shape — components, data model, data flow, and the HTTP client — is [docs/architecture.md](docs/architecture.md).

## Setup

```bash
curl -fsSL https://bun.sh/install | bash   # user-level, installs to ~/.bun (Bun >= 1.4.2)
bun install
cp .env.example .env                       # then fill it in
bun run check                              # typecheck + tests
bun start                                  # Bun loads .env automatically
```

Optional: put `SOUL.md` (persona; a default is used when absent) and `SYSTEM.md` (standing context) in `PI_BOT_HOME/bots/default/`. They are read at render time; edits apply to the next request. On first start, a home that still has `SOUL.md` and `AGENTS.md` at its root is copied into that folder (`AGENTS.md` becomes `SYSTEM.md`).

## Environment

| Variable | Required | Meaning |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | one door | Token from @BotFather. Unset: the general Telegram door stays off. Set this or `WEB_TOKEN` (or both) |
| `TELEGRAM_ALLOWED_USERS` | with Telegram | Comma-separated numeric Telegram user IDs. Empty = every message on a configured door is ignored (logged) |
| `PI_MODEL` | yes | `<provider>/<modelId>` from any pi-ai built-in provider (e.g. `anthropic/…`, `openai/…`, `xai/…`, `openrouter/<vendor>/<model>`). `faux/echo` is an offline echo model for smoke tests |
| provider auth | yes (real models) | Either an OAuth login (`bun run login <provider>`, stored in `PI_BOT_HOME/auth.json`, preferred when present) or the provider's API key env var (below) |
| provider key | alt. | The provider's standard env var, read by pi-ai: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, … Startup fails fast if the model is unknown or the key is missing |
| `PI_THINKING_LEVEL` | no | `off`/`minimal`/`low`/`medium`/`high`/`xhigh` |
| `PI_REVIEW_MODEL`, `PI_GATE_MODEL` | no | Reserved for Phase 4 (review fork, memory-capture gate); parsed, unused |
| `PI_BOT_HOME` | no | Data dir (default `./data`): `durable.sqlite`, `owner.lock`, `schedules.sqlite`, `bots/<id>/` |
| `PI_BOT_TZ` | no | IANA zone for the daily date line and cron (default: system zone) |
| `PI_BOT_HARVEST_DELAY_MS` | no | Idle time before a chat is forked to update knowledge (default 60000) |
| `TELEGRAM_POLL_TIMEOUT_SEC` | no | Long-poll timeout (default 30) |
| `PI_BOT_DELIVERY_SWEEP_MS` | no | Safety-net sweep for undelivered answers (default 15000; 0 disables) |
| `WEB_TOKEN` | one door | Shared secret for the local page. Unset: the page does not listen. Set this or `TELEGRAM_BOT_TOKEN` (or both) |
| `WEB_HOST`, `WEB_PORT` | no | Page bind address (default `127.0.0.1:8787`) |
| `LOG_LEVEL` | no | `debug`/`info`/`warn`/`error` |

Changing `PI_MODEL` applies to existing chats at the next start.

## Grok via SuperGrok / X Premium (OAuth, no API key)

pi-ai ships xAI's device-code OAuth ("Sign in with SuperGrok or X Premium"). On the server:

```bash
bun run login grok        # alias of xai; prints a URL + code, open it in any browser (phone is fine), approve
bun run auth:status       # shows stored credentials (types only) and whether they resolve
# .env: PI_MODEL=xai/grok-4.7   (catalog: grok-4.3, grok-4.5, grok-4.6, grok-4.7); no XAI_API_KEY needed
bun run logout grok       # remove the token
```

Tokens live in `data/auth.json` (0600, gitignored) and are refreshed automatically by pi-ai, under a file lock shared by the bot and the login script. A stored OAuth credential takes precedence over `XAI_API_KEY`. xAI decides which subscription tiers get API access; if login succeeds but answers fail with HTTP 402/403, use `XAI_API_KEY` instead (`bun run logout grok`).

## Web page

Set `WEB_TOKEN`, then open `http://127.0.0.1:8787/?token=<WEB_TOKEN>` once. The browser keeps an HttpOnly cookie. The page lists each bot's chats, streams replies, and edits that bot's `SOUL.md`, `SYSTEM.md`, and `knowledge/*.md`. Knowledge saves need a legal slug and a one-line description of at most 240 characters. A bad save is HTTP 422 and does not change the file.

Schedules are cron (five fields, in `PI_BOT_TZ`) or a single `when`. A target is an existing chat, a new web chat, or a silent fork. Rows live in `schedules.sqlite`, not in `durable.sqlite`. A fire is admitted once per occurrence (`sched:<id>:<nextRun>`). Listings omit internal `harvest:` rows.

The gear tab stores a second Telegram token on that bot. It is not returned by `GET /api/bots` and is not put in the prompt. That token polls separately. The same person on both doors of `default` gets `default:tg:general:<id>` and `default:tg:bot:<id>`.

A web message uses request id `<chatKey>:<clientMsgId>`. Posting into a Telegram chat delivers the assistant reply only.

## Telegram commands

`/new` (alias `/reset`) start a fresh context (old entries stay stored) · `/stop` abort the current answer · `/status` model, conversation, receipts · `/help`. The page composer sends the same commands. `/status` is also the header button next to the context readout.

## Layout

Source tree. The architecture notes start at [docs/architecture.md](docs/architecture.md).

```
src/
  main.ts                       entry: env config, optional grammY transport, model check, signals
  app.ts                        wires storage, Harness, startup, deliverer, pollers, schedules, web
  config.ts, log.ts, runtime.ts
  schedules/                    sidecar schedules.sqlite, cron, idle harvest
  harness/
    storage.ts                  owner.lock (O_EXCL, pid+host; only a dead same-host pid is taken over) + openNodeSqliteStorage
    registry.ts                 extensions installed in prompt order
    models.ts                   env-driven model config; pi-ai builtin providers + offline faux/echo
    credentials.ts              FileCredentialStore: auth.json for OAuth tokens (pi-ai CredentialStore)
    login.ts                    OAuth login helper (device code) used by scripts/auth.ts
    startup.ts                  restart policy: 'sending' → 'unknown', sync chat models, harness.resume()
  channels/telegram/
    transport.ts                TelegramTransport interface + GrammyTransport (raw getUpdates long polling)
    poller.ts                   TelegramCursorDoc offset; admits plain text through BotRuntime
    chats.ts                    ChatsDoc: default:tg:general:<chat>[:topic] → ownerless conversation
    deliver.ts                  DeliveriesDoc receipts: sending → sent | unknown; never resent
    commands.ts                 /new /stop /status /help, deduped via CommandsDoc
  channels/web/                 Bun.serve API, SSE, Preact page (built in memory at listen)
  extensions/identity.ts        sections: bots/<id>/SOUL.md, SYSTEM.md, knowledge index, daily date line
test/
  flows/chat.test.ts            Telegram in → Grok → Telegram out: dedupe, /new /stop /status, steer, topics, errors, receipts, restart, guards
  flows/web.test.ts             token-gated page, streams, bots, knowledge, schedules, harvest, second Telegram door
  flows/crash.test.ts           real `bun src/main.ts` processes, kill -9 mid-turn and mid-send
  flows/auth.test.ts            `bun run login grok` CLI, OAuth token use + refresh in the bot
  egress/                       fake Telegram Bot API + xAI (Responses SSE, OAuth) HTTP server; fetch routing / preload
  units.test.ts                 pure helpers only
  storage-bun.test.ts           pi-durable's storage conformance suite under Bun
```

## Guarantees and how they are tested

- **Input exactly once.** Each Telegram message is submitted with `requestId = tg:<chatId>:<messageId>`; the update offset advances only after admission. A web message uses `<chatKey>:<clientMsgId>`. A schedule fire uses `sched:<id>:<nextRun>` and a repeat of that occurrence does nothing. *Tests:* `flows/chat.test.ts`, `flows/web.test.ts`, `flows/crash.test.ts`.
- **Replies at most once** (pi-imessage ADR 0003). A final answer is claimed `sending` in a commit, sent, then recorded `sent` (with Telegram message ids) or `unknown` on error. On startup every `sending` becomes `unknown`, is logged, shown in `/status`, and is **never resent**. *Tests:* kill -9 while `sendMessage` is in flight → restart → receipt `unknown`, no second send, and the next message is answered normally.
- **Crash mid-turn resumes.** kill -9 while the model is answering → restart → `harness.resume()` continues the run → exactly one reply.
- **One owner.** `owner.lock` refuses a second process while the owner is alive (`flows/chat.test.ts`, `flows/crash.test.ts`).
- `/new` = `conversation.reset()`: the model's visible context restarts; a redelivered `/new` does not reset again.

## Tests

```bash
bun test              # all suites (~11 s)
bun run coverage      # with coverage (in-process code only)
bunx tsc --noEmit     # typecheck
```

Policy (see AGENTS.md): flow tests through the public interface; only egress is faked, at the HTTP level (`test/egress/`): Telegram Bot API, xAI Responses API, xAI OAuth. Real pi-durable SQLite in temp dirs, real `bun` processes for crash and login tests.

## Runtime notes

- Bun ≥ 1.4.2 provides `node:sqlite`, which pi-durable's `openNodeSqliteStorage` uses. pi-durable's own storage conformance suite passes under Bun (`test/storage-bun.test.ts`).
- One process owns the storage. Don't run two bots on the same `PI_BOT_HOME`, or the same bot token anywhere else (Telegram returns 409).
- `owner.lock` is removed on clean shutdown; after a crash, a lock whose pid is dead on the same host is taken over automatically.

## Not yet (later phases)

Memory (`USER.md`/`MEMORY.md`), FTS session search, skills, learning loop, delegation; media and captions (non-text messages are ignored); shell. Harvest notes stay on `pi-bot.harvest-notes` and are not sent to the model. A harvest sends no Telegram message. Telegram sends are never retried automatically.
