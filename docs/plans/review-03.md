# Review 03: Upstream Integration with pi-durable and Coding Tools

## Objective
Evaluate the integration with `@earendil-works/pi-durable` 1.3.0 and its built-in `CodingTools` extension (`bash`, `read`, `write`, `edit`) as detailed in [`docs/plans/tools-env/builtin-tools.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/builtin-tools.md) and [`docs/plans/tools-env/execution-env.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/execution-env.md).

> [!IMPORTANT]
> **Instructions for the Reviewer**:
> Do NOT implement any code. Audit the plan's assumptions about pi-durable 1.3.0 internals, contracts, hooks, and tool execution behavior.
> Write all your findings, contract risks, upstream incompatibilities, and concrete mitigation recommendations to `review-03-results.md` next to this file.

---

## Reference Code & Specifications
1. [`docs/plans/tools-env/builtin-tools.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/builtin-tools.md)
2. [`docs/plans/tools-env/execution-env.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/execution-env.md)
3. [`src/family-do.ts`](file:///home/developer/projects/pi-bot-hands/src/family-do.ts) (`initHarness`, `toToolRegs`)
4. [`src/extensions/tool-gate.ts`](file:///home/developer/projects/pi-bot-hands/src/extensions/tool-gate.ts) (`toolGateExtension`, `beforeTool`)
5. [`src/models.ts`](file:///home/developer/projects/pi-bot-hands/src/models.ts) (`NATIVE_TOOLS.xai["code.execute"]`)
6. `@earendil-works/pi-durable` 1.3.0 typings and exports (`ExecutionEnv`, `FileSystem`, `Shell`, `createCodingTools`, `HarnessOptions.env`)

---

## Specific Upstream Touchpoints to Verify

### 1. The `Harness.open` `env` Callback Contract
- **Callback Signature**:
  ```ts
  env?: (target: EnvTarget, context: Context) =>
    ExecutionEnv | undefined | Promise<ExecutionEnv | undefined>;
  ```
- **Dual Meaning of `cwd`**:
  - In Cadmus, `AgentDoc.cwd` / `EnvTarget.cwd` is set to the **bot id** (slug), which is used by `toolGateExtension` and knowledge tools to identify the bot.
  - In pi-durable, `ExecutionEnv.cwd` represents the **actual filesystem root** (`/workspace` or the daemon directory).
  - *Audit*: Does `pi-durable` ever join `EnvTarget.cwd` onto relative file paths before calling `env.read*` or `env.exec`? Does keeping `EnvTarget.cwd = botId` leak into shell commands or file operations?
- **Error Propagation on Throw vs Return `undefined`**:
  - In pi-durable, returning `undefined` causes `requireEnv` to throw `"No execution environment is configured"`.
  - Throwing from the `env` callback is caught during `runtime.env()` in `dist/harness/tool.js` and recorded as an error tool result.
  - *Audit*: What happens during turn generation prepare (`generation.js`) when `runtime.env()` throws? The plan notes that generation catches this throw, reports it, and continues with `env = undefined`. Confirm whether this behavior is safe or if it could trigger unexpected crash loops.

### 2. Concurrency & File Mutation Ordering (`withFileMutationQueue`)
- `pi-durable` serializes file writes across parallel tool executions using `withFileMutationQueue` keyed on `(env.id, canonicalPath)`.
- *Audit*:
  - Are the proposed `ExecutionEnv.id` patterns (`just-bash:<familyId>:bot:<botId>`, `just-bash:<familyId>:chat:<chatKey>`, `daemon:<secretId>:<workspacePath>`) guaranteed to be stable and distinct across scopes?
  - Does parallel execution in pi-durable cause deadlocks if a tool call blocks on a remote daemon WebSocket?

### 3. Extension Registration & Default-On Security Gate
- In Cadmus today, `bot.tools === undefined` means "all allowed" for existing Cadmus tools.
- If `CodingTools` is installed in `Harness.open`, an unconfigured bot might automatically receive shell access.
- *Audit the two-layer mitigation proposed in [`builtin-tools.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/builtin-tools.md)*:
  1. `settings.extensions` in `Harness.open` explicitly omits `coding-tools`.
  2. A conversation gains `coding-tools` only if `bot.tools` explicitly includes `bash`, `read`, `write`, or `edit`.
  3. `toolGateExtension` blocks coding tools if `bot.tools` is `undefined` or omits them.
  - Is this logic airtight? Can a newly created bot or an existing legacy bot ever accidentally invoke `bash` without explicit opt-in?

### 4. Image Processor & Memory Constraints
- `createCodingTools({ images })` can accept an image processor (e.g. `createCloudflarePhotonImages`).
- The plan explicitly decides **NOT** to install `createCloudflarePhotonImages` due to WebAssembly memory retention in Cloudflare Workers isolates.
- *Audit*:
  - When `images` is omitted, how does `read` behave when a model requests an image file (PNG, JPEG, GIF, WebP)?
  - Are the upstream default limits (2000x2000, 4.5 MB base64) respected, and what happens if a larger image is read?

### 5. Separation from Provider-Native `code.execute`
- xAI models rewrite `code.execute` to provider-native `code_interpreter` in [`src/models.ts`](file:///home/developer/projects/pi-bot-hands/src/models.ts).
- *Audit*:
  - How does the prompt instruct the LLM when both `code.execute` and `bash` are enabled?
  - Does the prompt clearly distinguish between the scratch tools-env workspace and the provider's stateless execution sandbox?

---

## Output Format
Save results to `review-03-results.md` next to this file, structured as follows:
```markdown
# Review 03 Results: Upstream Integration with pi-durable and Coding Tools

## Executive Summary
[Assessment of pi-durable integration feasibility and risks]

## Upstream Integration & Contract Risks
- **Issue**: [Description]
  - **pi-durable Component / API**: [Citation]
  - **Plan Reference**: [Citation]
  - **Risk / Gap**: [Explanation]
  - **Remediation**: [Concrete recommendation]

## Security & Default-On Analysis
[Review of bot.tools opt-in and tool-gate enforcement]

## Upstream Contract Checklist
- [ ] Harness env callback signature & return handling
- [ ] EnvTarget.cwd (botId) vs ExecutionEnv.cwd (workspace root)
- [ ] withFileMutationQueue interaction with ExecutionEnv.id
- [ ] CodingTools registration without host default-on exposure
- [ ] Image processor omission and memory impact
- [ ] code.execute vs bash segregation
```
