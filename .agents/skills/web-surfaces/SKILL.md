---
name: web-surfaces
description: >-
  Dual-surface Web UI workflow for Cadmus (@cadmus/web-app). Enforces parity across Shared State
  (CadmusContext/lib), Mobile (390x844), and Persistent Desktop Command Cockpit (1440x900), plus
  mandatory Playwright E2E coverage in both tests/flows/ and tests/desktop/.
---

# Dual-Surface Web UI Workflow (`web-surfaces`)

`@cadmus/web-app` serves two first-class interactive surfaces powered by a single shared state and transport brain:
1. **Mobile Surface (`390×844` Pixel 7)**: Touch-first navigation (`MobileHome`, `AppShell`, bottom sheets, swipe rows, full-screen route drilldowns).
2. **Desktop Command Cockpit (`1440×900`)**: Keyboard-first persistent 3-column workspace (`CockpitFrame`: Left `FleetDeck`, Center **Stage**, Right `TelemetryDeck`, plus `CommandPalette` `⌘K`).

Every UI feature, route, or state change must be designed, implemented, and E2E-tested across **both** surfaces.

---

## 1. Core Principle — One Shared Brain, Two First-Class Surfaces

- **Strict Package Boundary**: Only import `@cadmus/contract/types`, `@cadmus/contract/routes`, `@cadmus/contract/tools`, and `@cadmus/contract/client`. Never import `@cadmus/worker`, `@cadmus/daemon`, or `@cadmus/contract/schemas`.
- **Single Source of State & Side Effects**:
  - Never duplicate `client.callRpc(...)` / `client.sendCommand(...)` calls, `/ws` event listeners, optimistic mutations, or domain sorting/filtering across Mobile and Desktop components.
  - Put shared RPC actions, reactive `CadmusContextValue` records (`bots`, `chats`, `chatStates`, `lastSeen`, `collapsed`, `lastBotId`, `teamLeaderBotId`, `familyId`, etc.), and synchronization in [`src/context/CadmusContext.tsx`](../../../packages/web-app/src/context/CadmusContext.tsx) or dedicated hooks in `src/hooks/*` (`useAutoScroll.ts`, `useScopedResource.ts`) and [`src/components/desktop/use-desktop-viewport.ts`](../../../packages/web-app/src/components/desktop/use-desktop-viewport.ts).
  - Put pure domain logic (grouping tool runs, task progress extraction, "needs you" ranking, search highlighting, time formatting) in `src/lib/*` with unit tests in `packages/web-app/src/lib/*.test.ts` and `packages/web-app/src/components/desktop/*.test.ts` (plus `packages/web-app/tests/unit/*.test.ts`), run via `bun run --cwd packages/web-app test`.

---

## 2. Persistent Desktop Command Cockpit Architecture (`1440×900`)

- **Persistent Shell (`CockpitFrame`)**:
  - On Desktop viewports (`useDesktopViewport()` in [`src/components/desktop/use-desktop-viewport.ts`](../../../packages/web-app/src/components/desktop/use-desktop-viewport.ts)), [`CockpitFrame.tsx`](../../../packages/web-app/src/components/desktop/CockpitFrame.tsx) renders the persistent 3-column Command Cockpit:
    - **Top Status Header**: Brand, active bot/chat breadcrumb, live runtime status, quick `⌘K` trigger, and new-thread/settings actions.
    - **Left Pane (`FleetDeck.tsx`)**: Filterable bot fleet & thread tree, status rings, unread indicators, keyboard shortcuts (`⌘1..9`), and per-bot actions.
    - **Center Pane (The Stage)**: Primary active work surface (`DesktopChatConsole` or the active Bot Profile, Docs, Schedule Editor, Harvest, Search, or Settings view).
    - **Right Pane (`TelemetryDeck.tsx`)**: Real-time inspector with `Tool stream`, `Task plan`, and `Memory harvest` tabs.
- **No Mobile Ejection ("Mobile Leak")**:
  - Navigating to a chat (`/chat/$chatKey`), Bot Profile (`/bot/$botId/$tab`), Docs (`/bot/$botId/doc`), Tools (`/bot/$botId/tools`), Harvest (`/bot/$botId/harvest`), Schedule Editor (`/bot/$botId/schedule/$id`), Search (`/search`), New Bot (`/bot/new`), or Settings (`/settings/*`) on a Desktop viewport **must render inside the Cockpit Stage** (or a desktop modal/drawer) while keeping `FleetDeck` and `TelemetryDeck` mounted and URL state synchronized.
  - Never kick a Desktop user out of `CockpitFrame` into a standalone mobile `AppShell` page with a mobile `‹ Back` top bar.

---

## 3. Surface Touchpoint Matrix

When touching any domain area below, inspect and update all three columns:

| Domain Area | Shared Layer (`src/context/` & `src/lib/`) | Mobile Surface (`390×844`) | Desktop Cockpit Surface (`1440×900`) |
| :--- | :--- | :--- | :--- |
| **Home, Fleet & Directory** | `CadmusContext.tsx`, `lib/needs-you.ts`, `lib/bot-color.ts` | `MobileHome` in `routes/home.tsx`, `GroupMenuSheet.tsx`, `SwipeRow.tsx`, `UnreadDot.tsx` | `CommandCockpit.tsx`, `CockpitFrame.tsx`, `FleetDeck.tsx` (bot cards, unread dots, status rings, `⌘1..9` switching, bot actions) |
| **Chat Thread & Composer** | `ChatSession` (`routes/chat.tsx`), `Composer.tsx`, `lib/group-tool-runs.ts` | `/chat/$chatKey` route, `ChatMenuSheet.tsx`, `ChatStatusPage` (`routes/chat-status.tsx` -> `ChatStatusView.tsx`) | `DesktopChatConsole.tsx` (`<ChatSession embedded />`), starter prompts, Team Leader (`teamLeaderBotId` from `useCadmus()`, backed by `family.update`) routing |
| **Live Telemetry, Tools & Tasks** | `lib/group-tool-runs.ts`, `lib/task-progress.ts`, `LiveCard.tsx`, `ToolCallCard.tsx` | Inline `LiveCard` & `ToolCallCard`, `/chat/$chatKey/status` (`routes/chat-status.tsx` -> `ChatStatusView.tsx`) | `TelemetryDeck.tsx` (`Tool stream`, `Task plan`, `Memory harvest` tabs) + inline transcript cards |
| **Bot Profile, Memory, Knowledge, Soul, Config & Tools** | `ConfigPanel.tsx`, `MarkdownFileView.tsx`, `ScheduleList.tsx`, `ScheduleEdit.tsx`, `ToolAllowlist.tsx`, `HarvestView.tsx` | `/bot/$botId/$tab`, `/bot/$botId/doc`, `/bot/$botId/tools`, `/bot/$botId/harvest`, `/bot/$botId/schedule/$id` | Cockpit Stage view for bot profile/config/docs/schedules + `CommandPalette.tsx` (`⌘K`) + `FleetDeck.tsx` bot actions |
| **Search & Quick Switch** | `lib/match-ranges.ts`, `lib/highlight.ts` (`knowledge.search`) | `/search` (`routes/search.tsx`) | `CommandPalette.tsx` (`⌘K`) + Cockpit Stage deep search (`knowledge.search`) |
| **Settings, Credentials & Archive** | `SettingsRows.tsx`, `lib/theme.ts` | `/settings/*`, `/settings/archive` (`routes/settings.tsx`, `routes/settings-*.tsx`, `routes/archive.tsx`) | Cockpit Stage settings/archive views + `CommandPalette.tsx` quick actions |

---

## 4. Known Desktop Parity Gaps (Backlog Checklist)

When working in related areas, watch for and close these known Desktop vs. Mobile parity gaps:
- [ ] **Persistent Cockpit Stage Across Sub-Routes**: Keep `CockpitFrame` mounted across `/chat/$chatKey`, `/bot/*`, `/settings/*`, and `/search` on Desktop viewports (syncing URL state with `selectedChatKey` / `selectedBotId` instead of ejecting to mobile `AppShell`).
- [ ] **Team Leader Routing on Desktop**: Expose the Team Leader (`teamLeaderBotId` from `useCadmus()`, backed by `family.update` / "Let TL route") option when starting a new thread in `DesktopChatConsole.tsx`.
- [ ] **Bot Card Actions in `FleetDeck.tsx`**: Provide desktop actions to open Bot Profile/Config, change bot accent color, and archive all bot chats (parity with mobile `GroupMenuSheet.tsx`).
- [ ] **Unread Thread Indicators in `FleetDeck.tsx`**: Render `UnreadDot` on unread threads in the Desktop fleet tree.
- [ ] **Deep Content Search (`knowledge.search`) on Desktop**: Connect `CommandPalette.tsx` / Cockpit Stage search to `knowledge.search` across bot memories, knowledge docs, and transcripts (parity with mobile `/search`).

---

## 5. Mandatory Dual-Viewport Playwright E2E Gate

1. **Prerequisite**: Any `@cadmus/contract` or `@cadmus/worker` changes must already be implemented and verified via `bun run test` before running Playwright (Playwright tests run against the real local Worker).
2. **Dual E2E Test Requirement**:
   Every UI feature or bugfix must add or update black-box Playwright tests in **both** suites:
   - **Mobile Suite (`390×844` Pixel 7)**: [`packages/web-app/tests/flows/*.spec.ts`](../../../packages/web-app/tests/flows/)
   - **Desktop Cockpit Suite (`1440×900`)**: [`packages/web-app/tests/desktop/*.spec.ts`](../../../packages/web-app/tests/desktop/)
3. **Verification Commands**:
   ```bash
   bun run boundaries
   bun run typecheck
   bun run test:ui
   ```
   *(Reminder: Never run `bun run web-app:screens` unless explicitly requested by the user.)*
