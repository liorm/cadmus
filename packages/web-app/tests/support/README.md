# Playwright test support

Helpers used by `bun run web-app:screens` (`tests/screens`) and by the parked UI-flow suites (`tests/flows`, `tests/desktop`, `bun run test:ui`). Those suites are excluded from CI and `check:all`. Do not maintain them. They may be revived later.

Tests select by **role and accessible name**, never by CSS class or test-id-only selectors.

## Engines

| Engine | How | Notes |
|---|---|---|
| Obscura | `packages/web-app/.engine/obscura` or `CADMUS_TEST_OBSCURA`, CDP on 9222 | Apache-2.0. Fast CDP. Was the flow-test default. |
| Lightpanda | `packages/web-app/.engine/lightpanda` or `CADMUS_TEST_LIGHTPANDA` | AGPL-3.0, test-only. Needs `--load-resources`. One context per connection. |
| Chrome | `CADMUS_TEST_ENGINE=chrome` | Playwright Chromium headless shell. `bun run web-app:screens` always uses this engine and writes gitignored PNGs to `.screens/`. |

`CADMUS_TEST_CDP_URL` skips launching and connects with `chromium.connectOverCDP`.

### Spike (2026-11-03)

Ran the foundation flows (routes, theme, sheet, composer) against Obscura and Lightpanda when binaries were present, and against Chrome as the control.

- **Default: Obscura** when the binary is installed (speed; both engines need the evaluate fallbacks in `actions.ts`).
- If Obscura is missing, use `--engine=chrome`.
- Lightpanda remains selectable: `--engine=lightpanda`.

## Workarounds

| Helper | Gap | Link |
|---|---|---|
| `clickByRole` / `fillByLabel` | Playwright locator `click`/`fill` time out on Obscura | [obscura#45](https://github.com/h4ckf0r0day/obscura/issues/45) |
| `installSocketGate` / `dropWebSocket` / `restoreWebSocket` | Obscura has no `routeWebSocket`. Chrome's proxy can stick in CLOSING. The helper wraps `WebSocket` and closes the tracked sockets | — |
| `chooseOption` | Obscura `selectOption` breaks | [benchmark](https://jacar.es/en/lightpanda-vs-obscura-headless-browser-benchmark/) |
| Lightpanda spawn `--load-resources` | iframes, workers, external CSS | Lightpanda 0.4.1 notes |

Tests never import engine-specific APIs. They go through `actions.ts`.
