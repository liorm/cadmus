# AGENTS.md — pi-bot

Personal Hermes-style agent on `@earendil-works/pi-durable` (pinned 1.1.0), talking over Telegram (grammY) and a local web page. Default model: Grok via pi-ai (`xai/…`, API key or SuperGrok/X Premium OAuth). Several bots share one harness. Each has a folder, a knowledge index, and optional own Telegram token. User schedules live in a sidecar SQLite file. Idle harvest notes stay out of the model. Memory, skills, the learning loop, and delegation are still later (README "Not yet").

The running shape — components, data model, data flow, and the HTTP client — is [docs/architecture.md](docs/architecture.md).

## Toolchain: Bun only

Never use node/npm/npx/vitest here.

| Task | Command |
|---|---|
| install | `bun install` (commit `bun.lock`) |
| run | `bun start` (loads `.env`; see `.env.example`) |
| test | `bun test` · one file: `bun test test/flows/chat.test.ts` |
| coverage | `bun run coverage` |
| typecheck | `bun check` (or `bun run typecheck`) |
| lint / format | `bun run lint` (`biome check`) · `bun run format` (`biome check --write`) |
| all checks | `bun run check:all` — Biome, typecheck, tests; must pass before every commit |
| Grok OAuth | `bun run login grok` · `bun run auth:status` · `bun run logout grok` |

TypeScript runs unbuilt: imports use `.ts` extensions; only erasable syntax (no enums, namespaces, parameter properties).

Dependency ranges in `package.json` use `^` (compatible updates). Do not pin an exact version there. `bun.lock` still records the version that was installed.

## Layout

```
src/main.ts                 main(env): config → credentials/models → optional GrammyTransport → startApp
src/app.ts                  storage + Harness + startup + deliverer + pollers + schedules + web; stop()/quiesce()
src/runtime.ts              BotRuntime: submit, listChats, createChat; arms idle harvest
src/schedules/              schedules.sqlite sidecar · cron.ts · harvest.ts (pi-bot.harvest-notes)
src/harness/                storage.ts (SQLite + owner.lock) · models.ts · credentials.ts (auth.json) · login.ts · registry.ts · startup.ts · bot-env.ts
src/channels/telegram/      transport.ts · poller.ts · chats.ts · deliver.ts · commands.ts
src/channels/web/           Bun.serve API + SSE; ui/ is Preact, built at listen (no node:fs in the bundle)
src/extensions/             prompt sections (identity.ts) and knowledge parsers; new features go here as pi-durable extensions
scripts/auth.ts             login/logout/status CLI
test/flows/                 feature-flow tests (the main suite)
test/egress/                fake egress HTTP server + fetch routing (+ preload for child processes)
test/units.test.ts          pure helpers only
test/storage-bun.test.ts    pi-durable storage conformance under Bun
```

## Durability rules (do not break)

- **One storage owner.** `owner.lock` in `PI_BOT_HOME`; never open `durable.sqlite` from a second process. Don't write foreign tables into it. Schedules live in `schedules.sqlite`.
- **Inbound exactly once.** Every Telegram message is submitted with `requestId = tg:<chatId>:<messageId>`; the update offset advances only after admission. A web message uses `<chatKey>:<clientMsgId>`. A schedule occurrence uses `sched:<id>:<nextRun>` (harvest ids look like `sched:harvest:<chatKey>:<nextRun>`), claimed in the sidecar `fires` table before the fork or submit. Commands are deduped in `CommandsDoc` (claim before effect). Harvest notes are `pi-bot.harvest-notes` and are not conversation messages.
- **Outbound at most once.** Every send goes through `Deliverer`: commit `sending` → send → commit `sent`/`unknown`. A `sending` found at startup becomes `unknown` and is **never resent**. Never add automatic retries of Telegram sends (no idempotency key).
- **Tool replay classes** (pi-durable `replay`): pure reads → `safe`; idempotent internal writes (memory, skills, schedules) → `safe`, keyed by `taskId:callId` or content hash, doc writes in the same commit; external side effects (sends, HTTP POST) → `unsafe` + receipt; shell/exec → `unsafe`.
- Hooks are read-only (HookApi); trigger work by committing tasks from host code. Keep prompt sections stable (they are cached); volatile data at most daily.
- Every async pi-durable call takes a Chord context (`BACKGROUND_CONTEXT`). Verify APIs against `node_modules/@earendil-works/pi-durable` types, not memory.

## Testing policy

- **Every feature ships with flow-level tests through the public interface**: Telegram update in → agent → Telegram message out; commands; restarts; login CLI. Assert on what the user sees (messages sent) and on durable outcomes; peeking at docs is fine for assertions, not for driving.
- **Mock only egress, at the HTTP boundary.** `test/egress/fake-egress.ts` serves the Telegram Bot API, the xAI Responses API (SSE) and xAI OAuth; `routeEgress()` (in-process) or `--preload test/egress/preload.ts` (child processes) rewrites the real hosts to it. Unrouted egress throws. Don't fake internal interfaces (transport, deliverer, harness) in tests; extend the fake server instead.
- **Real everything else**: production `main()`, real pi-durable on SQLite in temp dirs, real `bun` processes and `kill -9` for crash/restart tests, real login CLI.
- **Unit tests only for small pure helpers** (parsers, validators, splitters) in `test/units.test.ts`.
- **Deterministic**: no sleeps as synchronization — wait on observable conditions (`until`, `settle()` = every update confirmed + harness idle + deliveries done). Fixed waits only to prove something does *not* happen (e.g. no resend across delivery sweeps), sized from config (sweep 200 ms in tests). No real network, no real keys.
- New egress (another provider or API) → add a route + fake endpoint first, then the flow test.
