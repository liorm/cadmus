# AGENTS.md — `@cadmus/web-app` Rules

Whenever reading, modifying, or adding code under `packages/web-app/**`, you MUST follow these non-negotiable invariants:

1. **Read the Web Surfaces Skill First**:
   - Always read [`.agents/skills/web-surfaces/SKILL.md`](../../.agents/skills/web-surfaces/SKILL.md) before implementing or modifying any UI feature, route, or component.

2. **Strict Contract Import Boundary**:
   - Import only `@cadmus/contract/types`, `@cadmus/contract/routes`, `@cadmus/contract/tools`, and `@cadmus/contract/client`.
   - Never import `@cadmus/worker`, `@cadmus/daemon`, `@cadmus/contract/schemas`, or generated OpenAPI/AsyncAPI JSON files.

3. **Shared Logic Once (One Brain, Two Surfaces)**:
   - Place all RPC calls (`callRpc` / `sendCommand`), `/ws` event subscriptions, and shared state inside [`src/context/CadmusContext.tsx`](src/context/CadmusContext.tsx) or `src/hooks/*`.
   - Place pure domain transforms in `src/lib/*` (with unit tests in `src/lib/*.test.ts`, `src/components/desktop/*.test.ts`, and `tests/unit/*.test.ts`, run via `bun run --cwd packages/web-app test`).
   - Never duplicate fetching, caching, or domain transformation logic between Mobile and Desktop components.

4. **Dual-Surface Parity (Mobile `390×844` + Persistent Desktop Cockpit `1440×900`)**:
   - Every feature must work as a first-class experience on both **Mobile (`390×844`)** and **Desktop Command Cockpit (`1440×900`)**.
   - On Desktop viewports (`useDesktopViewport()` in [`src/components/desktop/use-desktop-viewport.ts`](src/components/desktop/use-desktop-viewport.ts)), [`CockpitFrame.tsx`](src/components/desktop/CockpitFrame.tsx) (`FleetDeck` + center **Stage** + `TelemetryDeck` + `CommandPalette`) is the persistent workspace shell.
   - **No Mobile Ejection**: Never introduce Desktop navigation flows that kick the user out of `CockpitFrame` into a standalone full-screen mobile `AppShell` page with a mobile `‹ Back` header. Render sub-views inside the Cockpit Stage or a desktop modal/drawer and keep URL state synced.

5. **Verification**:
   - The Playwright UI-flow suites (`tests/flows`, `tests/desktop`, `bun run test:ui`) are parked and excluded from CI and `check:all`. Do not maintain them. They may be revived later. Until then, verify UI changes with `bun run test` (unit tests in this package) and `bun run typecheck`.
   - Do not run `bun run web-app:screens` unless explicitly requested by the user.
