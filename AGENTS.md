# AGENTS.md — pi-bot

Personal Hermes-style agent on `@earendil-works/pi-durable` (`^1.3.0`), talking over Telegram (grammY) and a local web page. Default model: Grok via pi-ai (`xai/…`, API key or SuperGrok/X Premium OAuth). Several bots share one harness. Each has a folder (`SOUL.md`, `MEMORY.md`, `knowledge/*.md`), configurable tools, and optional own Telegram token. User schedules live in a sidecar SQLite file (`schedules.sqlite`). Idle harvest notes stay out of the model (`pi-bot.harvest-notes`).

Architecture documentation lives in `docs/`, with [docs/architecture.md](docs/architecture.md) as the index:
- [docs/architecture.md](docs/architecture.md) — system overview, component diagram, bot runtime seam, and durability guarantees
- [docs/architecture/bots-and-storage.md](docs/architecture/bots-and-storage.md) — home directory layout, bot records, chat keys, session documents, and shared vs. per-chat state
- [docs/architecture/channels-and-turns.md](docs/architecture/channels-and-turns.md) — inbound admission, turns, slash commands, Telegram doors and delivery receipts, and the HTTP/SSE client surface
- [docs/architecture/knowledge-and-harvest.md](docs/architecture/knowledge-and-harvest.md) — prompt sections, `SOUL.md`, `MEMORY.md`, `knowledge/*.md`, compare-and-swap tools, and background harvest forks
- [docs/architecture/schedules-and-tools.md](docs/architecture/schedules-and-tools.md) — sidecar schedule catalog, schedule tasks and targets, self tools, cross-bot tools, provider server tools, and per-bot tool gating

## Toolchain: Bun only

Never use node/npm/npx/vitest here.

| Task | Command |
|---|---|
| install | `bun install` (commit `bun.lock`) |
| run | `bun start` (loads `.env`; see `.env.example`) |
| test | `bun test` · one file: `bun test test/flows/chat.test.ts` |
| coverage | `bun run coverage` |
| typecheck | `bun check` (or `bun run typecheck`) |
| lint / format | `bun run lint` (`biome check`) · `bun run format` (`biome check --write`) · `bun run format:check` (`biome format`) |
| all checks | `bun run check:all` — format, Biome, typecheck, tests; must pass before every commit |
| Grok OAuth | `bun run login grok` · `bun run auth:status` · `bun run logout grok` |

TypeScript runs unbuilt: imports use `.ts` extensions; only erasable syntax (no enums, namespaces, parameter properties).

Dependency ranges in `package.json` use `^` (compatible updates). Do not pin an exact version there. `bun.lock` still records the version that was installed.

## High-level layout

```
src/harness/                storage + owner.lock, models, OAuth credentials, extension registry, startup, tool policy
src/channels/               bot catalog/records, Telegram poller/deliverer/commands, and Bun.serve web API + Preact UI
src/extensions/             pi-durable extensions: identity sections, knowledge/memory, self tools, internal bot tools, web, tool gate
src/schedules/              sidecar schedules.sqlite store, ScheduleService, pi-bot.schedule task, cron, and dispatch
src/harvest/                idle harvest task (pi-bot.harvest) and HarvestNotesDoc (pi-bot.harvest-notes)
scripts/                    CLI utilities (OAuth login/logout/status, binary build)
test/                       flows/ (end-to-end feature tests), egress/ (fake Telegram + xAI HTTP server), units.test.ts
docs/                       architecture documentation (indexed at docs/architecture.md)
```

## Logging

Default `LOG_LEVEL` is `info`. **Use `debug` for operational traces.** Turns, harvest arm/resume, schedule fires, duplicate input, and other per-event lifecycle belong at `debug`. Operators turn that on when they need it.

Use `info` sparsely: process lifecycle (started, stopped, listening URL, shutdown), one-shot configuration at boot (model auth, a door that is off). Not once per chat, schedule, harvest, or request.

`warn` is for degraded but continuing states (unknown delivery, unanswered turn, ignored Telegram user). `error` is for failures that drop work (poll crash, harvest fire that will retry, shutdown failure).

## Durability rules (do not break)

- **One storage owner.** `owner.lock` in `PI_BOT_HOME`; never open `durable.sqlite` from a second process. Don't write foreign tables into it. Schedules live in `schedules.sqlite`.
- **Inbound exactly once.** Every Telegram message is submitted with `requestId = tg:<chatId>:<messageId>`; the update offset advances only after admission. A web message uses `<chatKey>:<clientMsgId>`. A schedule occurrence uses `sched:<id>:<nextRun>`, claimed in the sidecar `fires` table before the fork or submit. An idle harvest child uses `harvest:<chatKey>:<entryId>`, armed in `pi-bot.harvest-notes`. Commands are deduped in `CommandsDoc` (claim before effect). Harvest notes are `pi-bot.harvest-notes` and are not conversation messages.
- **Outbound at most once.** Every send goes through `Deliverer`: commit `sending` → send → commit `sent`/`unknown`. A `sending` found at startup becomes `unknown` and is **never resent**. Never add automatic retries of Telegram sends (no idempotency key).
- **Tool replay classes** (pi-durable `replay`): pure reads → `safe`; idempotent internal writes (memory, skills, schedules, knowledge, bot creation/search) → `safe`, keyed by task memo (`api.memo`) or content hash, doc writes in the same commit; external side effects (sends, HTTP POST, web/code) → `unsafe` + receipt; shell/exec → `unsafe`.
- Hooks are read-only (HookApi); trigger work by committing tasks from host code. Keep prompt sections stable (they are cached); volatile data at most daily.
- Every async pi-durable call takes a Chord context (`BACKGROUND_CONTEXT`). Verify APIs against `node_modules/@earendil-works/pi-durable` types, not memory.

## Testing policy

- **Every feature ships with flow-level tests through the public interface**: Telegram update in → agent → Telegram message out; commands; restarts; login CLI. Assert on what the user sees (messages sent) and on durable outcomes; peeking at docs is fine for assertions, not for driving.
- **Mock only egress, at the HTTP boundary.** `test/egress/fake-egress.ts` serves the Telegram Bot API, the xAI Responses API (SSE) and xAI OAuth; `routeEgress()` (in-process) or `--preload test/egress/preload.ts` (child processes) rewrites the real hosts to it. Unrouted egress throws. Don't fake internal interfaces (transport, deliverer, harness) in tests; extend the fake server instead.
- **Real everything else**: production `main()`, real pi-durable on SQLite in temp dirs, real `bun` processes and `kill -9` for crash/restart tests, real login CLI.
- **Unit tests only for small pure helpers** (parsers, validators, splitters) in `test/units.test.ts`.
- **Deterministic**: no sleeps as synchronization — wait on observable conditions (`until`, `settle()` = every update confirmed + harness idle + deliveries done). Fixed waits only to prove something does *not* happen (e.g. no resend across delivery sweeps), sized from config (sweep 200 ms in tests). No real network, no real keys.
- New egress (another provider or API) → add a route + fake endpoint first, then the flow test.
