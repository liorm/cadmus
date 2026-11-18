# `@cadmus/web-app`

Cadmus web UI. The Worker serves the Vite build at `/`. Browser history plus the SPA fallback resolve deep links such as `/bot/$botId/config`.

```
bun run web-app:dev       # Vite on :5174
bun run web-app:build     # Vite build into packages/web-app/dist
bun run --cwd packages/web-app test  # unit tests
bun run web-app:screens   # themed PNGs in packages/web-app/.screens (Chrome; not CI)
```

`web-app:screens` starts the local worker, uses a per-run account fixture and the Pixel 7 viewport, and launches Playwright Chromium so the PNGs have pixels. Output is gitignored. Attach the relevant files to the PR with `gh pr comment <N> --body-file <md> --attach <png>...` (or `gh pr create` / `gh pr edit --attach`). Do not commit the PNGs.

See `tests/support/README.md` for the Playwright helpers the screens use.

## UI-flow tests

The Playwright UI-flow suites (`tests/flows`, `tests/desktop`, `bun run test:ui`) are parked and excluded from CI and `check:all`. Do not maintain them. They may be revived later. `bun run test:ui` still runs them locally.

Unit tests cover `needsYou`, `groupToolRuns`, `taskProgress`, `rawTranscriptLines`, `describeSchedule`, `allowlistCount`, `toolsEnvLabel`, `matchRanges`, `derivedBotColor`, and `botInitials`.
