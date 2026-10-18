# pi-bot

A Hermes-style personal agent on [`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable), talking over Telegram, a local web page, or both. Runs on **Bun**.

Several bots share one harness. Each bot has a folder, a streaming chat page, a persona and knowledge editor (`SOUL.md`, `MEMORY.md`, `knowledge/*.md`), configurable tools, and user schedules. Idle chats harvest standing notes into `MEMORY.md` and `knowledge/`.

The architecture is documented in [docs/architecture.md](docs/architecture.md) (index):
- [Bots, Chats & Storage](docs/architecture/bots-and-storage.md) — home directory layout, bot records, chat keys, session documents, and shared vs. per-chat state
- [Channels, Turn Lifecycle & Client API](docs/architecture/channels-and-turns.md) — inbound admission, turns, slash commands, Telegram doors and delivery receipts, and the HTTP/SSE client surface
- [Prompt, Knowledge, Memory & Idle Harvest](docs/architecture/knowledge-and-harvest.md) — prompt sections, `SOUL.md`, `MEMORY.md`, `knowledge/*.md`, compare-and-swap tools, and background harvest forks
- [Schedules, Extensions & Tool Policy](docs/architecture/schedules-and-tools.md) — sidecar schedule catalog, schedule tasks and targets, self tools, cross-bot tools, provider server tools, and per-bot tool gating

## Setup

```bash
curl -fsSL https://bun.sh/install | bash   # user-level, installs to ~/.bun (Bun >= 1.4.3)
bun install
cp .env.example .env                       # then fill it in
bun run check:all                          # format, Biome, typecheck, tests
bun start                                  # Bun loads .env automatically
```

A fresh home has no bots. Create the first one on the web page and choose its model there. Each bot keeps `SOUL.md` (persona; the create dialog starts from a built-in one), `MEMORY.md`, and `knowledge/*.md` in `PI_BOT_HOME/bots/<id>/`. They are read at render time; edits apply to the next request.

## Environment

| Variable | Required | Meaning |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | one door | Token from @BotFather. Unset: the general Telegram door stays off. Set this or `WEB_TOKEN` (or both) |
| `TELEGRAM_ALLOWED_USERS` | with Telegram | Comma-separated numeric Telegram user IDs. Empty = every message on a configured door is ignored (logged) |
| provider auth | when a bot uses that provider | Either an OAuth login (`bun run login <provider>`, stored in `PI_BOT_HOME/auth.json`, preferred when present) or the provider's API key env var (below). Each bot stores its own `<provider>/<modelId>`. `faux/echo` is an offline echo model and needs no key |
| provider key | alt. | The provider's standard env var, read by pi-ai: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`, … Creating a bot, or starting with a stored bot, fails when that model is unknown or the provider has no credentials |
| `PI_BOT_HOME` | no | Data dir (default `./data`): `durable.sqlite`, `owner.lock`, `schedules.sqlite`, `auth.json`, `bots/<id>/` |
| `PI_BOT_TZ` | no | IANA zone for the daily date line and cron (default: system zone) |
| `PI_BOT_HARVEST_DELAY_MS` | no | Idle time before a chat is forked to update knowledge (default 60000) |
| `TELEGRAM_POLL_TIMEOUT_SEC` | no | Long-poll timeout (default 30) |
| `PI_BOT_DELIVERY_SWEEP_MS` | no | Safety-net sweep for undelivered answers (default 15000; 0 disables) |
| `WEB_TOKEN` | one door | Shared secret for the local page. Unset: the page does not listen. Set this or `TELEGRAM_BOT_TOKEN` (or both) |
| `WEB_HOST`, `WEB_PORT` | no | Page bind address (default `127.0.0.1:8787`) |
| `LOG_LEVEL` | no | `debug`/`info`/`warn`/`error` |

A bot's model and thinking level are chosen when it is created, and can be changed on that bot. Chats that already exist keep the model they were given. The general Telegram door (`TELEGRAM_BOT_TOKEN`) polls only when a stored bot has id `default`. A new home has no such bot; set a token on the bot instead. A bot named so its slug is `default` picks up the env token on the next start.

## Grok via SuperGrok / X Premium (OAuth, no API key)

pi-ai ships xAI's device-code OAuth ("Sign in with SuperGrok or X Premium"). On the server:

```bash
bun run login grok        # alias of xai; prints a URL + code, open it in any browser (phone is fine), approve
bun run auth:status       # shows stored credentials (types only) and whether they resolve
# Create a bot on the page and choose xai/grok-4.7 (catalog: grok-4.3, grok-4.5, grok-4.6, grok-4.7); no XAI_API_KEY needed
bun run logout grok       # remove the token
```

Tokens live in `data/auth.json` (0600, gitignored) and are refreshed automatically by pi-ai, under a file lock shared by the bot and the login script. A stored OAuth credential takes precedence over `XAI_API_KEY`. xAI decides which subscription tiers get API access; if login succeeds but answers fail with HTTP 402/403, use `XAI_API_KEY` instead (`bun run logout grok`).

## Web page

Set `WEB_TOKEN`, then open `http://127.0.0.1:8787/?token=<WEB_TOKEN>` once. The browser keeps an HttpOnly cookie. The page lists each bot's chats, streams replies, and edits that bot's `SOUL.md`, `MEMORY.md`, and `knowledge/*.md`. Knowledge is edited as description, optional category, version (read-only), and body — the same fields as `knowledge_update`. `MEMORY.md` is body and version. Frontmatter stays on disk. A bad save is HTTP 422 and does not change the file.

Schedules are cron (five fields, in `PI_BOT_TZ`) or a single `when`. A target is an existing chat, a new web chat, or a silent fork. Rows live in `schedules.sqlite`, not in `durable.sqlite`, and each enabled schedule runs a `pi-bot.schedule` task on the bot's root conversation. A fire is admitted once per occurrence (`sched:<id>:<nextRun>`). Rows and their next wake survive a process restart. Harvest is at-least-once per idle entry (`pi-bot.harvest` task) until it completes. Listings omit reserved `harvest:` ids. The model can create, list, update, and delete schedules for the bot it is talking to (`schedule_create`, `schedule_list`, `schedule_update`, `schedule_delete`). An update can change the message, name, enabled flag, cron or single time, and target. It cannot see or change another bot's rows or harvest tasks.

The bot dialog switches tools on and off. The choice is stored on the bot. A missing list means every tool is on. A tool that is off is not offered to the model and is blocked by `pi-bot.tool-gate`. `GET /api/tools` lists them. `GET` and `PUT /api/bots/<id>/tools` read and replace one bot's set.

The gear tab stores a Telegram token on that bot. It is not returned by `GET /api/bots` and is not put in the prompt. That token polls separately. When the general env token is also polling for a bot whose id is `default`, the same person on both doors gets `default:tg:general:<id>` and `default:tg:bot:<id>`.

A web message uses request id `<chatKey>:<clientMsgId>`. Posting into a Telegram chat delivers the assistant reply only.

## Telegram commands

`/new` (alias `/reset`) start a fresh context (old entries stay stored) · `/stop` abort the current answer · `/status` model, conversation, receipts · `/help`. The page composer offers `/status` and `/help`. Stop is the button that replaces Send while an answer is running. `/status` is also the header button next to the context readout.

## Guarantees and how they are tested

- **Input exactly once.** Each Telegram message is submitted with `requestId = tg:<chatId>:<messageId>`; the update offset advances only after admission. A web message uses `<chatKey>:<clientMsgId>`. A schedule fire uses `sched:<id>:<nextRun>` and a repeat of that occurrence does nothing.
- **Replies at most once** (pi-imessage ADR 0003). A final answer is claimed `sending` in a commit, sent, then recorded `sent` (with Telegram message ids) or `unknown` on error. On startup every `sending` becomes `unknown`, is logged, shown in `/status`, and is **never resent**.
- **Crash mid-turn resumes.** `kill -9` while the model is answering → restart → `harness.resume()` continues the run → exactly one reply.
- **One owner.** `owner.lock` refuses a second process while the owner is alive. `bun run dev` (`bun --watch --no-clear-screen`) takes over a lock that still names this process after an in-process watch restart; it waits, then signals a leftover other same-host owner.
- `/new` = `conversation.reset()`: the model's visible context restarts; a redelivered `/new` does not reset again.

## Tests

```bash
bun test              # all suites
bun run coverage      # with coverage (in-process code only)
bun check             # typecheck
```

Policy (see [AGENTS.md](AGENTS.md)): flow tests through the public interface; only egress is faked, at the HTTP level (`test/egress/`): Telegram Bot API, xAI Responses API, xAI OAuth. Real pi-durable SQLite in temp dirs, real `bun` processes for crash and login tests.

## Runtime notes

- Bun ≥ 1.4.3 provides `node:sqlite`, which pi-durable's `openNodeSqliteStorage` uses. pi-durable's own storage conformance suite passes under Bun.
- One process owns the storage. Don't run two bots on the same `PI_BOT_HOME`, or the same bot token anywhere else (Telegram returns 409).
- `owner.lock` is removed on clean shutdown; after a crash, a lock whose pid is dead on the same host is taken over automatically. `bun run dev` takes over a lock that still names this process (in-process `--watch` restart), otherwise waits for a leftover same-host owner, then signals it.
- Harvest notes stay on `pi-bot.harvest-notes`, are not sent to the model, and send no Telegram message. Telegram sends are never retried automatically.

