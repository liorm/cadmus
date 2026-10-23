# Review 08: Phasing, Feasibility and Test Strategy

## Objective
Evaluate the implementation sequencing, phase independence, testing methodology, and regression safety outlined in [`docs/plans/tools-env/sequencing.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/sequencing.md).

> [!IMPORTANT]
> **Instructions for the Reviewer**:
> Do NOT implement any code. Audit the delivery sequence, phase dependencies, test runners, and test coverage strategies.
> Write all your findings, phasing bottlenecks, testability risks, and concrete improvements to `review-08-results.md` next to this file.

---

## Reference Code & Specifications
1. [`docs/plans/tools-env/sequencing.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/sequencing.md)
2. [`e2e/helpers.ts`](file:///home/developer/projects/pi-bot-hands/e2e/helpers.ts) (E2E test setup, `sendRpc`, `connectTestWs`)
3. [`e2e/turns-and-commands.test.ts`](file:///home/developer/projects/pi-bot-hands/e2e/turns-and-commands.test.ts)
4. [`e2e/schedules-and-harvest.test.ts`](file:///home/developer/projects/pi-bot-hands/e2e/schedules-and-harvest.test.ts)
5. `package.json` (Scripts: `test`, `typecheck`, `lint`)

---

## Specific Areas and Questions to Check

### 1. Phase Independence & Delivery Sequencing
The plan breaks implementation into 3 sequential phases:
- **Phase 1**: `just-bash` + Harness `env` callback + `CodingTools` + DO state machine + chat overrides.
- **Phase 2**: D1 secrets (`cadmus_tools_env_secrets`) + Account default + Protocol RPCs + Web/TUI UI.
- **Phase 3**: Remote `ExecutionEnv` + `/tools-env/ws` reverse WebSocket transport + `daemon/` Node package.
- *Audit*:
  - Can Phase 1 be deployed cleanly to production without breaking existing bots? (In Phase 1, `local-daemon` is explicitly rejected at validation; only `just-bash` is active).
  - Can Phase 2 merge before Phase 3? (In Phase 2, pairing tokens can be created in D1 even before the daemon package is deployed).
  - Are there any hidden forward dependencies where Phase 1 code expects tables, columns, or types that are only introduced in Phase 2 or 3?

### 2. Upstream Conformance Testing Feasibility
- The plan specifies running `createEnvConformance` from `@earendil-works/pi-durable/testing` against both `just-bash` (Phase 1) and the remote proxy (Phase 3).
- *Audit*:
  - Can `@earendil-works/pi-durable/testing` execute cleanly under Bun?
  - Conformance options require `symlinks: true` and `watch: true` (polling). Does `just-bash`'s VFS support symlinks and polling file watchers without host OS dependencies?
  - Does `registerEnvConformance` require any Node.js native bindings that would fail under Bun or in CI?

### 3. Whole-Flow E2E Testing in `workerd`
- E2E tests run via Vitest inside Cloudflare's `workerd` environment (`bun run test`).
- *Audit*:
  - How are coding-tool turns driven in E2E tests? The plan specifies using `faux/echo` with embedded tool commands:
    `[tool:bash {"command":"echo hi"}]`, `[tool:write ...]`, `[tool:read ...]`.
    Verify if `faux/echo` in [`src/models.ts`](file:///home/developer/projects/pi-bot-hands/src/models.ts) supports multiple parallel tool calls and complex JSON arguments.
  - In Phase 3, how is the daemon peer simulated inside `workerd`? Can a scripted WebSocket client connect to `SELF.fetch` over `/tools-env/ws` within the Cloudflare Vitest runner without real network egress?

### 4. Zero-Mock Storage Invariant in Tests
- Cadmus testing philosophy forbids mocking `FamilyStore`, SQLite tables, or alarms in E2E tests.
- *Audit*:
  - Does the test plan adhere to this rule? (Only external egress—i.e. the daemon peer over WebSocket—is scripted; all SQLite storage, alarm scheduling via `runDurableObjectAlarm(stub)`, and tool gates remain real).

### 5. Regression & Backward Compatibility Guardrails
- *Audit*:
  - How does the plan guarantee that existing bots (with `tools = undefined` or specific tool lists) never regress?
  - Are existing harvest tests ([`e2e/schedules-and-harvest.test.ts`](file:///home/developer/projects/pi-bot-hands/e2e/schedules-and-harvest.test.ts)) explicitly included in the regression test suite for every phase?

---

## Output Format
Save results to `review-08-results.md` next to this file, structured as follows:
```markdown
# Review 08 Results: Phasing, Feasibility and Test Strategy

## Executive Summary
[Assessment of delivery sequencing, test coverage, and execution feasibility]

## Phasing & Dependency Gaps
- **Issue**: [Description]
  - **Plan Reference**: [Citation]
  - **Bottleneck / Forward Dependency**: [Explanation]
  - **Remediation**: [How to decouple or re-order steps]

## Testability & Framework Evaluation
[Review of createEnvConformance under Bun and workerd e2e feasibility]

## Delivery Checklist
- [ ] Phase 1 production viability without Phase 2/3
- [ ] Safe rejection of local-daemon in Phase 1
- [ ] Bun compatibility for pi-durable conformance tests
- [ ] In-workerd WebSocket peer scripting for Phase 3 E2E
- [ ] Full preservation of existing test suite (harvest, schedules, RPC)
```
