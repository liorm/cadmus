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
