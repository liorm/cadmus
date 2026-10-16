---
name: debug-session
description: >-
  Debug a pi-bot conversation from the local session. Read-only inspection of
  chats, transcript entries, stuck tasks, submissions, Telegram deliveries,
  schedules, and harvest forks. Use when the user says debug this chat, debug
  this conversation, why did the bot do that, stuck turn, missing reply, harvest
  did not write, or runs /debug-session. Optional data path; default is ./data.
  A conversation id or chat key is enough; a bot id narrows the list and the
  persona files.
---

# Debug a pi-bot session

Inspect one home read-only. Do not start the bot, do not take `owner.lock`, and do not write `durable.sqlite` or `schedules.sqlite`. A running process may hold the lock; `sqlite3 -readonly` and `bun:sqlite` `{ readonly: true }` still work.

## Inputs

- **Home.** Optional. Default `./data` at the repo root (the `PI_BOT_HOME` default). If the user names another directory, pass `--home`.
- **Selector.** A conversation id, a chat key, a key substring, or a bot id. One session holds every bot. The chat directory maps keys to `conversationId`. A conversation id is enough to read that transcript. A bot id is the first segment of a chat key (`<botId>:tg:…` or `<botId>:web:…`) and selects `bots/<botId>/` on disk.

Ask for a selector when the user does not give one. List chats first so they can pick.

## Dump

From the repo root:

```bash
bun .agents/skills/debug-session/scripts/inspect.ts
bun .agents/skills/debug-session/scripts/inspect.ts <selector>
bun .agents/skills/debug-session/scripts/inspect.ts --home <dir> <selector>
bun .agents/skills/debug-session/scripts/harvest.ts [--home <dir>] <selector>
```

No selector prints live chats as `conversationId`, key, title. A selector prints the last 40 parent entries, open tasks/submissions, deliveries, schedule rows, and a harvest section (notes, pending/completed, fires, each fork's submission, tools, assistant text). `harvest.ts` prints only that harvest section.

## How to read a failure

Work from the newest entry backward.

- **No reply.** Find the submission by request id (`tg:…`, `<chatKey>:<clientMsgId>`, or `sched:<id>:<nextRun>`). `queued` or `placed` means the turn was admitted and did not finish. `unanswered` means it was not admitted. `done` points at the user `entry` and the assistant `answer` entry id.
- **Stuck turn.** A task whose status is not `terminal` (`pending`, `running`, `waiting`, `completing`) is the live work. `abort_requested=1` means a stop was asked and has not finished. `pi.generation` `terminal` with `outcome.status` other than `completed` is a failed model turn; read `outcome` from `tasks.record`.
- **Tool failure.** An entry whose role is `toolResult` holds the error the model saw. The assistant entry before it is the call.
- **Telegram send.** `pi-bot.telegram.deliveries` on that conversation. `sending` left at startup becomes `unknown` and is not resent. There is no automatic retry.
- **Duplicate or dropped command.** `pi-bot.telegram.commands` is the claim set. A repeated request id does not run again.
- **Schedule did not fire.** `schedules.sqlite` columns `id`, `bot_id`, `kind`, `cron` or `when_ms`, `next_run`, `enabled`, `text`, `target_json`. `fires.request_id` is the occurrence already claimed. Ids starting with `harvest:` are internal. A consumed `when` harvest leaves no schedule row; look at fires and forks.
- **Wrong persona or knowledge.** Read `bots/<botId>/SOUL.md`, `SYSTEM.md`, and `knowledge/*.md`. Those files are not in the transcript. Harvest notes (`pi-bot.harvest-notes`) are timeline-only and are not model context.
- **Closed chat.** A key listed in the chats document `closed` array refuses new admission. The entries remain.

## Harvest

Idle harvest forks the parent at the rested entry, submits `HARVEST_TEXT` on a knowledge-tool-only child (`requestId` `sched:harvest:<chatKey>:<entryId>`), then diffs `SOUL.md` and `knowledge/*.md`. A file change appends `{ chatKey, at, files, when }` on `pi-bot.harvest-notes`. No change still marks `completed[chatKey] = at`. A `when` row is dropped after the fire; `schedules 0` is not "harvest never ran".

Read the harvest section newest fork last:

- **Never ran.** No fork, no `fires` row, no `completed` mark. Check whether idle arm ran (`harvest:<chatKey>` still in `schedules`) or the chat never went idle.
- **Skipped as already done.** `completed at` equals the fork `at`. Host will not harvest that entry again.
- **Pending / stuck.** `pending at=… child=…` with a child task not `terminal`, or a harvest submission `queued`/`placed`.
- **Ran, wrote nothing.** Fork `done`, assistant text says no writes (or similar), `tools called (none)`, `knowledge notes 0`. Host did its job; the model declined. Quote the assistant entry and the parent lines that should have been knowledge (preferences, standing instructions).
- **Tool failed.** `tools called` includes `knowledge_read` / `knowledge_update` and a `toolResult` error. That error is what the model saw.
- **Wrote files.** A `note at=` line lists paths and a diff. Those files are on disk under `bots/<botId>/`. The note is not sent to the model on later turns.

Quote entry ids, request ids, and task outcomes in the answer. Say what the next check is when the dump does not show the cause. Do not mutate the session to "fix" it unless the user asks for a code change.
