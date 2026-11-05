# `@cadmus/web-app`

Mobile redesign of the Cadmus web UI. Served by the Worker at `/app/` (hash history so deep links coexist with `packages/web` until #60).

```
bun run web-app:dev       # Vite on :5174, base /app/
bun run web-app:build     # Vite build, then copy into packages/web/dist/app
bun run test:ui           # Playwright against wrangler (default engine: Obscura)
bun run test:ui --engine=chrome
bun run coverage:web-app  # same flows, Istanbul on the Vite build; report in coverage/web-app
bun run web-app:screens   # themed PNGs in packages/web-app/.screens (Chrome; not CI)
```

`web-app:screens` reuses the flow-test worker, account fixture, and Pixel 7 viewport. It launches Playwright Chromium so the PNGs have pixels. Obscura stays the engine for `test:ui`. Output is gitignored. Attach the relevant files to the PR with `gh pr comment <N> --body-file <md> --attach <png>...` (or `gh pr create` / `gh pr edit --attach`). Do not commit the PNGs.

See `tests/support/README.md` for the CDP engine spike and workarounds.

## UI-flow coverage (#49)

Playwright journeys in `tests/flows/` against the real local worker (own account per test, egress mocked by `faux/echo`):

- Foundation: settings deep link, theme persist, composer grow/send, seeded bot list, composer `chat.create`.
- Main / task chat: create-and-stream, busy queue/steer/stop, unread Needs-you + divider, failed Retry, swipe-archive + collapse persist.
- Chat menu: harvest toggle persists, raw transcript role labels, archive then read-only reopen, rename save and cancel.
- Profile (#51): config model, thinking, and timezone; tool allowlist save and reset; tools env; delete bot; harvest note and per-chat toggle; memory write and knowledge delete; schedule toggle; group menu profile, archive-all, and colour.

Unit tests cover `needsYou`, `groupToolRuns`, `taskProgress`, `rawTranscriptLines`, `describeSchedule`, `allowlistCount`, and `toolsEnvLabel`. `bun run coverage:web-app` writes Istanbul to `coverage/web-app`.
