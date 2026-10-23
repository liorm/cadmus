# Review 06 Results: Security Considerations and Reverse WebSocket Transport

## Executive Summary

This security review evaluates the architecture, transport protocols, cryptographic controls, and process boundaries specified in [`docs/plans/tools-env/execution-env.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/execution-env.md) and [`docs/plans/tools-env/binding-and-config.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/binding-and-config.md), alongside existing Worker edge routing ([`src/index.ts`](file:///home/developer/projects/pi-bot-hands/src/index.ts)), request authentication ([`src/auth.ts`](file:///home/developer/projects/pi-bot-hands/src/auth.ts)), D1 credential storage ([`src/store/d1-admin.ts`](file:///home/developer/projects/pi-bot-hands/src/store/d1-admin.ts)), and Durable Object connection management ([`src/family-do.ts`](file:///home/developer/projects/pi-bot-hands/src/family-do.ts)).

The proposed reverse WebSocket transport (`/tools-env/ws`) is an elegant solution to a fundamental edge-to-host connectivity challenge: it enables bidirectional communication between Cloudflare Durable Objects and arbitrary user host environments without requiring open inbound ports, port forwarding, or public IPs on the user's local network. The cryptographic design properly enforces domain separation for AES-GCM-256 secrets in Cloudflare D1 and avoids expensive or insecure token decryptions during the tool execution path inside the Durable Object.

However, bridging an edge cloud environment with a local host process introduces critical security surfaces that must be addressed prior to implementation:
1. **Socket Cross-Talk & Privilege Escalation**: Today, `CadmusBotFamilyDO` accepts all WebSockets without tags and assumes any message received is an authenticated protocol `ClientCommand`. Introducing daemon sockets to the same DO without ironclad tag checks in `webSocketMessage` creates a critical privilege escalation path where an unprivileged pairing token can execute administrative DO commands.
2. **Transcript and Secret Leakage**: `broadcastEvent` currently delivers frames to every open WebSocket. Failing to strictly constrain `broadcastEvent` exclusively to sockets tagged `"protocol-client"` would leak real-time turn tokens, private conversation transcripts, system prompts, and memory to external daemon sockets.
3. **Edge-to-DO Authentication Trust Contract**: The plan correctly notes that DOs must verify that the connecting daemon possesses the `secretId` bound to the target bot/chat. However, the plan lacks a secure internal header specification for passing the authenticated `secretId` from Edge to DO and fails to mandate stripping client-supplied `X-Cadmus-*` headers at the edge boundary.
4. **Denial of Service via Unauthenticated D1 Exhaustion**: Intercepting `/tools-env/ws` prior to standard authentication allows unauthenticated clients to flood the edge with invalid tokens, triggering cryptographic hashing and D1 database queries that can starve system connection pools.
5. **Distributed Invalidation Gaps**: When a pairing secret is deleted, the plan does not specify an invalidation push to active family DOs, leaving established daemon WebSocket sessions active and able to execute host commands indefinitely until the DO reboots.

Detailed findings, attack scenarios, cryptographic assessments, and concrete remediations are documented below.

---

## Security Findings & Vulnerabilities

### Finding 1: Socket Privilege Escalation via Missing Tag Checks in `webSocketMessage`
- **Severity**: **Critical**
- **Plan Reference**: [`docs/plans/tools-env/execution-env.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/execution-env.md) lines 171–174; [`src/family-do.ts`](file:///home/developer/projects/pi-bot-hands/src/family-do.ts) lines 500–526.
- **Attack Scenario**:
  1. An operator creates a daemon pairing token with restricted scope (e.g., intended for automated CI or a limited local folder).
  2. The daemon dials `wss://<cadmus>/tools-env/ws?familyId=f1&botId=b1` with `Authorization: Bearer <daemon_token>`.
  3. The Edge authenticates the token hash and forwards the WebSocket upgrade to `CadmusBotFamilyDO`.
  4. The DO accepts the WebSocket and tags it `["tools-env-daemon", "bot:b1"]`.
  5. The daemon sends a standard protocol `ClientCommand` frame over the WebSocket instead of a wire protocol frame (e.g., `{ id: "1", type: "bot.delete", payload: { botId: "victim-bot" } }` or `{ id: "2", type: "account.credentials.set", payload: { providerId: "openai", credential: { type: "api_key", apiKey: "stolen" } } }`).
  6. In [`src/family-do.ts`](file:///home/developer/projects/pi-bot-hands/src/family-do.ts) line 500, `webSocketMessage` invokes `this.shim.decodeCommand(raw)` and passes it to `this.executeCommand(command)`.
  7. Because `executeCommand` assumes any client connected over WebSocket was pre-authenticated as an account member/owner during initial upgrade, the command executes with full administrative privileges. The holder of a daemon pairing token achieves complete administrative compromise of the Bot Family DO.
- **Remediation**:
  The plan must mandate strict tag enforcement at the very top of `webSocketMessage` in `CadmusBotFamilyDO`:
  ```ts
  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const tags = this.ctx.getTags(ws);
    const isDaemon = tags.includes("tools-env-daemon");
    const isClient = tags.includes("protocol-client");

    if (isDaemon && !isClient) {
      return this.handleDaemonWireMessage(ws, message);
    }
    if (isClient && !isDaemon) {
      return this.handleProtocolClientMessage(ws, message);
    }
    // Ambiguous, untagged, or conflicting socket tags: reject and disconnect
    this.log().warn("websocket rejected: invalid or conflicting socket tags", { tags });
    ws.close(1008, "Policy Violation: Invalid socket role");
  }
  ```
  Under no circumstances may a socket bearing tag `"tools-env-daemon"` reach `this.executeCommand()`.

---

### Finding 2: Confidentiality Breach via Broadcast Frame Leakage to Daemon Sockets
- **Severity**: **Critical**
- **Plan Reference**: [`docs/plans/tools-env/execution-env.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/execution-env.md) lines 171–173; [`src/family-do.ts`](file:///home/developer/projects/pi-bot-hands/src/family-do.ts) lines 677–686.
- **Attack Scenario**:
  1. A user connects a daemon for Bot A.
  2. In the same Bot Family, another user initiates a sensitive LLM turn on Bot B or a private planning chat.
  3. As the turn progresses, `CadmusBotFamilyDO` emits streaming turn tokens (`turn.start`, `turn.token`, `turn.tool_call`, `turn.end`) and updates via `this.broadcastEvent(event)`.
  4. Today, [`src/family-do.ts`](file:///home/developer/projects/pi-bot-hands/src/family-do.ts) line 680 queries `this.ctx.getWebSockets()` without any tag argument:
     ```ts
     for (const ws of this.ctx.getWebSockets()) {
       try { ws.send(text); } catch {}
     }
     ```
  5. The daemon WebSocket receives every streaming token, system prompt leakage, tool argument, transcript entry, and harvest note from all bots and chats in the family.
- **Remediation**:
  1. The plan must specify that `broadcastEvent` in `CadmusBotFamilyDO` queries `this.ctx.getWebSockets("protocol-client")` exclusively:
     ```ts
     broadcastEvent(event: ServerFrame): void {
       const text = this.shim.encodeFrame(event);
       for (const ws of this.ctx.getWebSockets("protocol-client")) {
         try { ws.send(text); } catch {}
       }
       // SSE broadcast logic remains unchanged
     }
     ```
  2. Add an explicit invariant test in `e2e/tools-env-daemon.test.ts` asserting that daemon sockets receive zero `ServerFrame` events while concurrent protocol turns execute.

---

### Finding 3: Underspecified Edge-to-DO Secret Authentication Header & Header Spoofing Risk
- **Severity**: **High**
- **Plan Reference**: [`docs/plans/tools-env/execution-env.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/execution-env.md) lines 167–176; [`docs/plans/tools-env/binding-and-config.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/binding-and-config.md) line 215; [`src/index.ts`](file:///home/developer/projects/pi-bot-hands/src/index.ts) lines 273–285.
- **Attack Scenario**:
  1. The plan states: *"Inside the DO, botId and optional chatKey are checked against the effective binding's secretId. Auth has already succeeded at upgrade; this is an id compare, not a decrypt."*
  2. Because the DO does not have access to D1 (`CADMUS_ADMIN_DB`), it cannot hash the bearer token to look up `secretId`. It relies on the Edge to forward the identity of the authenticated secret.
  3. However, `forwardToFamilyDO` in [`src/index.ts`](file:///home/developer/projects/pi-bot-hands/src/index.ts) constructs forwarded headers by copying all inbound client headers:
     ```ts
     const headers = new Headers(originalRequest.headers);
     headers.set("X-Cadmus-Account-Id", family.accountId);
     headers.set("X-Cadmus-Family-Id", family.familyId);
     ```
  4. If an attacker knows or guesses a `secretId` (which is visible in `account.toolsEnvs.list`), they send an external request with:
     `GET /tools-env/ws?familyId=f1&botId=b1`
     `Authorization: Bearer <valid_token_for_unrelated_secret_S2>`
     `X-Cadmus-Tools-Env-Secret-Id: S1`
  5. If the Edge does not explicitly strip client `X-Cadmus-*` headers and override `X-Cadmus-Tools-Env-Secret-Id` with the resolved `secret_id` from D1, the attacker can hijack daemon connections for bots bound to `S1`.
- **Remediation**:
  1. Explicitly define the internal header contract between Edge and DO in `execution-env.md` and `binding-and-config.md`:
     - Header: `X-Cadmus-Tools-Env-Secret-Id: <secretId>`
     - Header: `X-Cadmus-Tools-Env-Account-Id: <accountId>`
  2. In `src/index.ts`, sanitize all inbound headers before forwarding:
     ```ts
     // Strip any client-supplied internal headers to prevent spoofing
     for (const [key] of headers.entries()) {
       if (key.toLowerCase().startsWith("x-cadmus-")) {
         headers.delete(key);
       }
     }
     headers.set("X-Cadmus-Account-Id", family.accountId);
     headers.set("X-Cadmus-Family-Id", family.familyId);
     headers.set("X-Cadmus-Tools-Env-Secret-Id", resolvedSecret.secretId);
     ```
  3. The DO must verify `request.headers.get("X-Cadmus-Tools-Env-Secret-Id") === effectiveBinding.secretId`.

---

### Finding 4: Race Condition & Undefined Routing on Multiple Concurrent Daemon Connections per Scope
- **Severity**: **High**
- **Plan Reference**: [`docs/plans/tools-env/execution-env.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/execution-env.md) lines 127, 166, 171–174.
- **Attack Scenario**:
  1. A user starts the daemon on Laptop A (`workspacePath: "/home/user/project"`). It connects to `bot:b1`. Tagged `["tools-env-daemon", "bot:b1"]`.
  2. Later, Laptop A's network connection drops abruptly (e.g., laptop lid closes). In Cloudflare DO, WebSocket connections may not be immediately closed until TCP keepalive or hibernation pings time out.
  3. The user re-runs the daemon on Laptop B or Laptop A reconnects on a new IP. A second socket is accepted and tagged `["tools-env-daemon", "bot:b1"]`.
  4. Now `this.ctx.getWebSockets("bot:b1")` returns an array of two WebSockets: `[wsA_stale, wsB_active]`.
  5. When a tool call (`bash` or `write`) runs, `createExecutionEnv` resolves `getWebSockets("bot:b1")`. If it picks `sockets[0]`, it sends the wire frame to the dead socket `wsA_stale`.
  6. The command hangs until timeout (5–30 seconds), falsely triggering a transport failure, marking the scope `unreachable`, and arming backoff alarms, even though a healthy daemon socket exists.
  7. Alternatively, if frames are sent to multiple sockets, commands would execute twice on different physical machines.
- **Remediation**:
  Enforce **Single Active Daemon Socket Per Scope**:
  When accepting a new WebSocket for `/tools-env/ws` in `CadmusBotFamilyDO.fetch`:
  ```ts
  const scopeTag = chatKey ? `chat:${chatKey}` : `bot:${botId}`;
  const existingSockets = this.ctx.getWebSockets(scopeTag);
  for (const oldWs of existingSockets) {
    try {
      oldWs.close(1008, "Superseded by new daemon connection for this scope");
    } catch {}
  }
  this.ctx.acceptWebSocket(server, ["tools-env-daemon", scopeTag]);
  ```
  This ensures deterministic 1:1 socket routing, immediate eviction of zombie sockets, and clean handoffs during reconnects.

---

### Finding 5: Unauthenticated D1 Resource Exhaustion / Denial of Service on `/tools-env/ws`
- **Severity**: **High**
- **Plan Reference**: [`docs/plans/tools-env/execution-env.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/execution-env.md) line 167; [`src/index.ts`](file:///home/developer/projects/pi-bot-hands/src/index.ts) line 50.
- **Attack Scenario**:
  1. The plan specifies handling `/tools-env/ws` before `authenticateRequest` in `src/index.ts`.
  2. An unauthenticated attacker sends thousands of rapid requests to `GET /tools-env/ws` with arbitrary random bearer tokens or malformed payloads.
  3. For every request, the Worker edge:
     - Parses the URL and headers.
     - Computes WebCrypto `crypto.subtle.digest("SHA-256", ...)`.
     - Executes a D1 query: `SELECT account_id, secret_id FROM cadmus_tools_env_secrets WHERE token_hash = ?`.
  4. Cloudflare D1 has strict concurrency limits and read quotas. A flood of unauthenticated requests will exhaust D1 database connection pools and hit worker CPU limits.
  5. Legitimate users attempting to log in, execute RPC commands, or run bot conversations are blocked with 500/503 errors.
- **Remediation**:
  1. **Strict Handshake Guardrails**: Before invoking WebCrypto or D1 queries, validate request preconditions:
     ```ts
     if (url.pathname === "/tools-env/ws") {
       if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
         return new Response("Expected WebSocket Upgrade", { status: 426 });
       }
       const authHeader = request.headers.get("authorization");
       const match = /^Bearer\s+([A-Za-z0-9_-]{32,256})$/.exec(authHeader?.trim() ?? "");
       if (!match?.[1]) {
         return new Response("Unauthorized", { status: 401 });
       }
       const rawToken = match[1];
       // Proceed to SHA-256 and D1 lookup
     }
     ```
  2. Mandate token format constraints: enforce that daemon tokens must have a known prefix and high entropy (e.g. `cadmus_dt_` + 64 hex characters) and reject non-conforming tokens with 401 before querying D1.
  3. Recommend Cloudflare WAF rate limiting rules on `/tools-env/ws`.

---

### Finding 6: Revocation Gap: Deleted Pairing Secrets Do Not Invalidate Active Daemon Connections
- **Severity**: **High**
- **Plan Reference**: [`docs/plans/tools-env/binding-and-config.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/binding-and-config.md) lines 159, 198–200.
- **Attack Scenario**:
  1. An operator suspects a daemon token has been compromised and executes `account.toolsEnvSecrets.delete(secretId)`.
  2. The secret row is deleted from `cadmus_tools_env_secrets` in D1.
  3. However, an attacker or compromised host already holds an open WebSocket to `CadmusBotFamilyDO` that was authenticated hours earlier.
  4. `CadmusBotFamilyDO` does NOT query D1 on tool calls.
  5. The compromised daemon remains connected and continues to receive `exec` and file operations from LLM turns, maintaining unauthorized access to host file execution.
- **Remediation**:
  1. When `account.toolsEnvSecrets.delete` is executed on D1, the edge/admin handler must query `cadmus_families` for that account and dispatch an internal invalidation request to all family DOs:
     `POST /__internal/tools-env/invalidate-secret` with `{ secretId }`.
  2. In `CadmusBotFamilyDO`, handling `invalidate-secret` must:
     - Scan all bot and chat bindings matching `secretId`.
     - Close all active WebSockets associated with those scopes (`ws.close(1008, "Pairing secret revoked")`).
     - Update `cadmus_tools_env_state` for those scopes: `status = "unreachable"`, `last_error = "secret_missing"`, `next_probe_at = NULL`.
     - Sync alarms via `this.syncAlarmInternal()`.

---

### Finding 7: String Prefix Matching for Transport Error Classification is Brittle and Spoofable
- **Severity**: **Medium**
- **Plan Reference**: [`docs/plans/tools-env/execution-env.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/execution-env.md) line 198; [`docs/plans/tools-env/reachability.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/reachability.md) line 82.
- **Attack Scenario**:
  1. The plan specifies: *"No reply within the exec budget... becomes FileError code unknown with message prefix 'tools-env transport:'. That prefix is how the wrapper tells transport unknown from any other unknown."*
  2. A script executed inside the daemon or a normal filesystem error returns a `FileError` whose message happens to include `"tools-env transport: ..."` (or a malicious script intentionally outputs this error).
  3. The DO wrapper inspects `error.message.startsWith("tools-env transport:")`, mistakes the application error for a broken network transport, transitions the scope to `unreachable`, and triggers backoff alarms.
- **Remediation**:
  Do not rely on parsing error message strings. Use a dedicated boolean property or a private class/symbol on synthetic errors instantiated in the DO proxy:
  ```ts
  export class ToolsEnvTransportError extends FileError {
    readonly isTransportError = true;
    constructor(message: string) {
      super("unknown", message);
    }
  }
  ```
  The reachability classifier can then reliably test `error instanceof ToolsEnvTransportError || (error as any).isTransportError === true`.

---

### Finding 8: Wire Protocol Lacks Strict Schema Validation and Frame Size Ceilings (DO OOM Risk)
- **Severity**: **Medium**
- **Plan Reference**: [`docs/plans/tools-env/execution-env.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/execution-env.md) lines 182–198.
- **Attack Scenario**:
  1. The daemon wire protocol receives arbitrary JSON text frames from the host over WebSocket.
  2. A rogue daemon or a malfunctioning command outputs a 100MB string in `{ id, event: "output", text: "..." }`, or sends deeply nested objects containing `__proto__`.
  3. `JSON.parse` in the DO consumes isolate memory. Cloudflare DO isolates enforce strict RAM limits (128MB default).
  4. The DO crashes with an uncatchable Out-Of-Memory (OOM) error, terminating all concurrent bot conversations, schedules, and active turns in that Bot Family.
- **Remediation**:
  1. Enforce a strict frame size limit (e.g. 1 MiB) on raw WebSocket messages before calling `JSON.parse`:
     ```ts
     if (typeof message === "string" && message.length > 1_048_576) {
       ws.close(1009, "Frame exceeds maximum allowed size (1 MiB)");
       return;
     }
     ```
  2. Validate inbound daemon frames against strict TypeBox schemas in `src/tools-env/wire.ts`.
  3. Validate that `error.code` strictly adheres to the `FileErrorCode` and `ExecutionErrorCode` unions before passing them to `pi-durable`.

---

### Finding 9: Query Parameter Tag Injection via Unsanitized `botId` and `chatKey`
- **Severity**: **Medium**
- **Plan Reference**: [`docs/plans/tools-env/execution-env.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/execution-env.md) line 166; [`docs/plans/tools-env/binding-and-config.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/binding-and-config.md) line 84.
- **Attack Scenario**:
  1. An attacker dials `/tools-env/ws?familyId=f1&botId=protocol-client`.
  2. If the DO constructs tags using string concatenation without validation:
     `tags: ["tools-env-daemon", "bot:" + botId]`
     The tag array becomes `["tools-env-daemon", "bot:protocol-client"]`.
  3. What if an attacker passes control characters, commas, colons, or quotes (e.g. `botId="protocol-client,admin"` or `botId="../other"` or null bytes)?
  4. In addition, unvalidated `chatKey` values could collide with internal tag namespaces.
- **Remediation**:
  1. Validate all query parameters at the Edge and DO against canonical regexes before routing:
     - `familyId`: must match `SLUG_REGEX` (`/^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/`).
     - `botId`: must match `SLUG_REGEX`.
     - `chatKey`: must match `CHAT_KEY_REGEX` (`/^[a-z0-9-]+:[a-zA-Z0-9_-]+$/`).
  2. Reject any request with query parameters failing validation immediately with 400 Bad Request.

---

### Finding 10: Host Security Boundary & Missing Operator Warnings in Daemon CLI
- **Severity**: **Low / Informational**
- **Plan Reference**: [`docs/plans/tools-env/execution-env.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/execution-env.md) line 200; [`docs/plans/tools-env/workspace-persistence.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/workspace-persistence.md) line 54.
- **Attack Scenario**:
  1. An operator binds a daemon to their workstation with `workspacePath: "/home/user/project"`, assuming the bot is sandboxed to that directory.
  2. The bot encounters a prompt injection (e.g. via an untrusted website fetched with `web.fetch` or an incoming message).
  3. The prompt injection instructs the bot to execute: `bash "cat ~/.ssh/id_rsa"` or `bash "rm -rf ~"`.
  4. Because `NodeExecutionEnv` runs with the full privileges of the OS user running the daemon, the host is compromised outside of `workspacePath`.
- **Remediation**:
  1. Add an explicit security notice in the daemon CLI startup banner:
     `[SECURITY WARNING] Cadmus daemon executes shell commands with the full privileges of user '${process.env.USER}'. There is no sandbox boundary around workspacePath. Run only in dedicated directories, unprivileged accounts, or containers.`
  2. For `FileSystem` operations (`read`, `write`, `edit`), enforce path normalization and verify that `fs.realpath` resolves within `workspacePath` to prevent symlink traversal outside the intended folder for standard file tools.

---

## Cryptographic & Authentication Audit

### 1. Token Hashing & Upgrade Authentication
- **Lookup Mechanism**:
  The plan stores `token_hash` in `cadmus_tools_env_secrets` with a unique index `idx_cadmus_tools_env_secrets_token_hash`.
  On upgrade, the Edge calculates `SHA-256(rawToken)` and queries D1:
  `SELECT account_id, secret_id FROM cadmus_tools_env_secrets WHERE token_hash = ? AND kind = 'daemon_token'`.
- **Timing Attack Resistance**:
  - The lookup uses a database B-Tree index on `token_hash`. Because SHA-256 exhibits the avalanche effect, timing variations in database index searches cannot leak individual characters of the plaintext token.
  - Unlike master secrets in [`src/auth.ts`](file:///home/developer/projects/pi-bot-hands/src/auth.ts) lines 79–102 (which use non-constant-time V8 string equality), daemon tokens are purely hash-indexed in SQL.
- **Entropy & Salt Considerations**:
  - `token_hash` is unsalted. Unsalted SHA-256 is susceptible to rainbow tables if users provide weak tokens (e.g., dictionary words).
  - **Audit Requirement**: Pairing tokens must be **system-generated** cryptographically secure random values (e.g., `cadmus_dt_` followed by 32 cryptographically random bytes / 64 hex characters from `crypto.getRandomValues()`). User-chosen plaintext tokens must be prohibited in `account.toolsEnvSecrets.set`.

### 2. Secret Storage & AES-GCM-256 Encryption
- **Domain Separation**:
  - Existing BYOK LLM credentials derive keys via `SHA-256("cadmus-byok-v1:" + CADMUS_ENCRYPTION_KEY + ":" + accountId)` ([`src/store/d1-admin.ts`](file:///home/developer/projects/pi-bot-hands/src/store/d1-admin.ts) line 45).
  - The plan specifies a distinct KDF prefix: `SHA-256("cadmus-tools-env-v1:" + CADMUS_ENCRYPTION_KEY + ":" + accountId)` ([`docs/plans/tools-env/binding-and-config.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/binding-and-config.md) line 153).
  - This guarantees domain separation: compromise of an encryption key in one domain cannot decrypt credentials in the other.
- **Initialization Vector (IV) Freshness**:
  - WebCrypto AES-GCM uses a fresh 12-byte (96-bit) IV generated via `crypto.getRandomValues(new Uint8Array(12))` for each encryption. Nonce reuse is completely prevented.
- **Secret Visibility**:
  - In `account.toolsEnvs.list` and `account.toolsEnvSecrets.list`, only metadata (`secretId`, `label`, `kind`, `updatedAt`) is returned. Plaintext tokens, `iv_hex`, and `cipher_hex` are strictly withheld.
  - The Durable Object never decrypts the pairing token; it only holds `secretId`.

---

## Transport & Socket Isolation Checklist

| Audit Item | Status | Evaluation & Required Patch |
| :--- | :---: | :--- |
| **Edge pre-auth route security and timing-attack resistance** | **[!] Requires Hardening** | SHA-256 B-Tree lookup is timing-attack resistant, but unauthenticated `/tools-env/ws` requires input length ceilings (max 256 bytes), strict `Upgrade: websocket` preconditions, and server-generated token format validation to prevent D1 resource exhaustion. |
| **Strict account <-> family DO ownership verification** | **[x] Satisfied in Plan** | Edge validates `cadmus_families` row using `accountId` from the token row and `familyId` from the URL, preventing cross-account DO routing. Forwarding DO name is deterministically `cadmus:${accountId}:${familyId}`. |
| **Strict socket tagging on acceptWebSocket** | **[!] Requires Hardening** | The plan defines tags `["protocol-client"]` and `["tools-env-daemon", "bot:" + botId]`, but must add single-active-socket-per-scope enforcement to evict stale sockets on reconnect. |
| **Complete isolation of broadcastEvent to "protocol-client"** | **[!] Action Required** | Codebase currently broadcasts to all sockets. The plan correctly mandates filtering by `getWebSockets("protocol-client")`. Must be verified by automated E2E tests before shipping. |
| **Tag verification in webSocketMessage (no command cross-talk)** | **[!] Action Required** | The plan must explicitly mandate branch validation using `this.ctx.getTags(ws)` to reject any protocol `ClientCommand` received on a daemon socket with code 1008. |
| **Strict wire protocol validation of daemon frames** | **[!] Requires Hardening** | Inbound daemon frames must be validated against strict TypeBox schemas with a 1 MiB frame ceiling to prevent DO isolate memory exhaustion (OOM). Replace `"tools-env transport:"` error prefix matching with a dedicated error type. |
| **Safe deletion lifecycle for pairing secrets** | **[!] Action Required** | The plan must specify an active DO invalidation push (`/__internal/tools-env/invalidate-secret`) when secrets are deleted, terminating active daemon sockets immediately. |

---

## Conclusion & Recommendations

The reverse WebSocket design and two-tier cryptographic model provide a solid architectural foundation. However, implementation must not proceed until the following 5 critical patches are incorporated into the plan specifications:

1. **Mandate Socket Tag Verification in `webSocketMessage`**: Explicitly specify that `webSocketMessage` checks `this.ctx.getTags(ws)` and immediately terminates any daemon socket attempting to submit a `ClientCommand`.
2. **Specify Trusted Edge-to-DO Header Contract**: Define `X-Cadmus-Tools-Env-Secret-Id`, mandate that Edge strips any client-provided `X-Cadmus-*` headers, and have DO verify that the header matches the scope's effective `secretId`.
3. **Enforce Single Active Daemon Socket Per Scope**: Close existing sockets tagged for that scope when a new socket connects to avoid split-brain execution and dead-socket hangs.
4. **Implement Distributed Secret Revocation**: Specify an internal invalidation endpoint (`POST /__internal/tools-env/invalidate-secret`) called when secrets are deleted to disconnect live daemon sessions.
5. **Secure Pre-Auth Edge Handshake**: Validate `Upgrade: websocket`, token format, and length before performing SHA-256 or querying D1.

## Disposition (applied by Grok Build)

1. **Socket privilege escalation via `webSocketMessage`** — Applied. Today's `webSocketMessage` always runs `decodeCommand` (`src/family-do.ts`). The plan already split tags; it now says a `tools-env-daemon` socket never reaches `executeCommand`, and an untagged or dual-tagged socket closes `1008`. `execution-env.md`, `sequencing.md`.
2. **Broadcast leakage to daemon sockets** — Already resolved. `broadcastEvent` is already specified as `getWebSockets("protocol-client")` only, and the phase 3 e2e already asserts the daemon sees no `ServerFrame`. Today's untagged `getWebSockets()` is what the plan replaces. No doc change.
3. **Edge-to-DO secret header spoofing** — Applied. `forwardToFamilyDO` copies client headers (`src/index.ts`) and only overwrites the four headers it sets. The plan now deletes inbound `X-Cadmus-*` before those sets, then sets `X-Cadmus-Tools-Env-Secret-Id` from the token row. The DO compares that header to the scope binding. No second account header: `X-Cadmus-Account-Id` is already the family row. `execution-env.md`, `binding-and-config.md`, `sequencing.md`.
4. **Two daemon sockets for one scope** — Already resolved. Review 04 and the plan already accept one socket and close the previous one (`1000`, `Superseded`), and the proxy sends only on an `OPEN` socket. Kept `1000` (the finding's `1008` is the revoke code). Noted that accept and those closes run with no await between them. `execution-env.md`, `sequencing.md`.
5. **Unauthenticated D1 exhaustion on `/tools-env/ws`** — Applied in part. `GET` plus `Upgrade: websocket` (`426`) and a `cadmus_dt_` + 64 hex bearer (`401`) are required before SHA-256 or D1. `set` mints that token with `crypto.getRandomValues` and returns it once; it does not take a caller token (list still returns no secret material). Declined a Cloudflare WAF rule: that is operator config, outside this plan. `execution-env.md`, `binding-and-config.md`, `sequencing.md`, `README.md`.
6. **Deleted secret leaves the daemon socket up** — Applied on the existing fan-out. `invalidateToolsEnvSecret` writes `secret_missing` and `next_probe_at = NULL`, then closes that scope's sockets (`1008`, `Pairing secret revoked`). The later `webSocketClose` does not arm the disconnected ladder. Declined a new `POST /__internal/tools-env/invalidate-secret`: review 01 already routes this through `listFamilies` like `bustAccountCredentialCaches`. The offline throw already stopped new exec; the hole was the lingering `OPEN` peer and in-flight frames. `binding-and-config.md`, `reachability.md`, `sequencing.md`. — **Superseded (2026-10-21, Lior):** cloud-side probing removed; env reconnects proactively, heartbeat only while calls are in flight, connection state per env with generation CAS (reachability.md).
7. **`tools-env transport:` prefix is spoofable** — Applied narrowly. A peer `message` that starts with the prefix is stripped on rebuild, so it stays an application result. Declined `ToolsEnvTransportError`: review 04 kept the prefix because a brand does not survive rebuilding the wire error, and decision 9 stays (a missing reply is transport; a peer reply is application). A script's stdout is not `FileError.message`. `execution-env.md`, `reachability.md`, `sequencing.md`.
8. **Wire frames have no size ceiling or schema** — Applied with a corrected ceiling. 1 MiB is too small: `read` calls `reader.read` for an image up to `DEFAULT_IMAGE_LIMITS` (4.5 MB of base64). The ceiling is 6 MiB of text before `JSON.parse`, payloads are base64, and a bad frame closes that daemon socket only (`1009`). Schema checks live in `src/tools-env/wire.ts`. `error.code` must be a pi-durable `FileErrorCode` or `ExecutionErrorCode`. An unknown `id` or `readerId` is ignored and is not transport. `execution-env.md`, `sequencing.md`.
9. **`botId` / `chatKey` tag injection** — Applied with the tree's rules. `botId` must match `SLUG_REGEX` (`/^[a-z0-9][a-z0-9-]{0,63}$/` in `src/store/sqlite-family.ts`). `chatKey` is length-capped and must not contain NUL, CR, or LF. Declined the finding's slug and `CHAT_KEY_REGEX`: the slug there does not match the tree, and `createChatInternal` keeps a caller key or `${bot.id}:${uuid}`, which may contain colons. `botId=protocol-client` becomes the tag `bot:protocol-client`, not `protocol-client` (tags are a string array). `familyId` is a `cadmus_families` lookup, not a filesystem path. `execution-env.md`, `binding-and-config.md`, `sequencing.md`.
10. **Host boundary and daemon warning** — Applied the startup line only. The plan already states the trust boundary: the daemon is the OS user, and the cloud does not dial the host. Declined a `realpath` jail inside `workspacePath`. `bash` would still leave the directory, and confinement is issue #16. `execution-env.md`, `workspace-persistence.md`, `sequencing.md`. — **Overridden by Lior (2026-10-21):** confinement is now a per-provider env config option (`confineToWorkspace`), rejected at validation on providers that do not support it; daemon enforcement in execution-env.md.
