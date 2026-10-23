# Review 06: Security Considerations and Reverse WebSocket Transport

## Objective
Evaluate the security architecture, authentication flow, reverse WebSocket transport (`/tools-env/ws`), secret encryption, and isolation mechanisms described in [`docs/plans/tools-env/execution-env.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/execution-env.md) and [`docs/plans/tools-env/binding-and-config.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/binding-and-config.md).

> [!IMPORTANT]
> **Instructions for the Reviewer**:
> Do NOT implement any code. Perform a dedicated security audit of the proposed network transport, authentication mechanisms, cryptographic operations, and process boundaries.
> Write all your findings, security vulnerabilities, threat model oversights, and concrete mitigation recommendations to `review-06-results.md` next to this file.

---

## Reference Code & Specifications
1. [`docs/plans/tools-env/execution-env.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/execution-env.md) (Reverse WebSocket, socket tagging, wire protocol)
2. [`docs/plans/tools-env/binding-and-config.md`](file:///home/developer/projects/pi-bot-hands/docs/plans/tools-env/binding-and-config.md) (Secrets table, pairing, upgrade auth)
3. [`src/index.ts`](file:///home/developer/projects/pi-bot-hands/src/index.ts) (Worker edge routing, WebSocket upgrade dispatch)
4. [`src/auth.ts`](file:///home/developer/projects/pi-bot-hands/src/auth.ts) (`authenticateRequest`)
5. [`src/store/d1-admin.ts`](file:///home/developer/projects/pi-bot-hands/src/store/d1-admin.ts) (WebCrypto AES-GCM encryption, BYOK credential storage)
6. [`src/family-do.ts`](file:///home/developer/projects/pi-bot-hands/src/family-do.ts) (`broadcastEvent`, `webSocketMessage`, `webSocketClose`)

---

## Specific Security Touchpoints to Verify

### 1. Edge Pre-Authentication Routing (`/tools-env/ws`)
- In `src/index.ts`, requests to `/tools-env/ws` are handled **before** standard `authenticateRequest`.
- *Audit*:
  - How is the bearer token extracted and validated?
  - Does the edge compute `SHA-256(token)` and query `cadmus_tools_env_secrets.token_hash` securely?
  - Can an unauthenticated or invalid token bypass checks or trigger unhandled exceptions at the edge?
  - Is `forwardToFamilyDO` protected against path traversal or malicious query parameter injection (`familyId`, `botId`, `chatKey`)?

### 2. Family & Account Isolation
- The token hash lookup yields `accountId` and `secretId`.
- The query string supplies `familyId`.
- *Audit*:
  - Does the edge verify that `(accountId, familyId)` exists in `cadmus_families` before routing to the DO?
  - Can an attacker presenting a valid token from Account A connect to a Family DO belonging to Account B?
  - Inside the DO, how is `botId` and `chatKey` verified against the effective binding? Can a daemon connect to a bot or chat that does not use its `secretId`?

### 3. WebSocket Tagging & Cross-Contamination
- Today, `acceptWebSocket(server)` in [`src/family-do.ts`](file:///home/developer/projects/pi-bot-hands/src/family-do.ts) applies no tags.
- The plan introduces tags:
  - Protocol clients: `["protocol-client"]`
  - Bot daemon: `["tools-env-daemon", "bot:" + botId]`
  - Chat daemon: `["tools-env-daemon", "chat:" + chatKey]`
- *Audit*:
  - **Broadcast Leakage**: Does `broadcastEvent` strictly query `this.ctx.getWebSockets("protocol-client")`? Could turn tokens, chat transcripts, or `tools-env.reachability` events ever be broadcast to daemon sockets?
  - **Message Hijacking**: In `webSocketMessage`, does the DO check socket tags to prevent a daemon socket from sending protocol `ClientCommand`s, or a protocol client from injecting daemon wire frames?

### 4. Wire Protocol Validation & Injection Risks
- The DO speaks a custom wire protocol with the daemon over WebSocket.
- *Audit*:
  - Are inbound JSON messages from the daemon validated with strict schemas before being processed?
  - Could a compromised daemon exploit deserialization or inject malicious payloads into `FileError` or `ExecutionError`?
  - How are reader streams (`readerId`) protected against cross-scope hijacking?

### 5. Secret Storage & Cryptographic Hygiene in D1
- Secrets stored in `cadmus_tools_env_secrets`:
  - `token_hash` (indexed, for fast upgrade auth).
  - `iv_hex`, `cipher_hex` (AES-GCM-256 encrypted using account-derived key).
- *Audit*:
  - Are pairing tokens ever stored in plaintext or logged?
  - Does `account.toolsEnvs.list` or `account.toolsEnvSecrets.list` ever return raw tokens or ciphertext?
  - When a secret is deleted via `account.toolsEnvSecrets.delete`, are associated bindings immediately invalidated and marked unreachable (`secret_missing`)?

### 6. Host Execution Boundary & Threat Model
- The daemon runs on the user's host machine as an arbitrary OS process.
- *Audit*:
  - Does the plan clearly define the trust boundary? (The daemon is an outbound-only connection from the user's machine; Cadmus cloud never initiates inbound network traffic).
  - Does the plan address symlink traversal outside `workspacePath` in `NodeExecutionEnv`?
  - Is it clear that `NodeExecutionEnv` has the full permissions of the OS user running the daemon?

---

## Output Format
Save results to `review-06-results.md` next to this file, structured as follows:
```markdown
# Review 06 Results: Security Considerations and Reverse WebSocket Transport

## Executive Summary
[Assessment of the security posture, transport architecture, and credential protection]

## Security Findings & Vulnerabilities
- **Vulnerability**: [Description]
  - **Severity**: [Critical / High / Medium / Low]
  - **Plan Reference**: [Citation]
  - **Attack Scenario**: [Step-by-step exploit vector]
  - **Remediation**: [Exact required security patch in the plan]

## Cryptographic & Authentication Audit
[Evaluation of token hashing, AES-GCM encryption, and upgrade auth]

## Transport & Socket Isolation Checklist
- [ ] Edge pre-auth route security and timing-attack resistance
- [ ] Strict account <-> family DO ownership verification
- [ ] Strict socket tagging on acceptWebSocket
- [ ] Complete isolation of broadcastEvent to "protocol-client"
- [ ] Tag verification in webSocketMessage (no command cross-talk)
- [ ] Strict wire protocol validation of daemon frames
- [ ] Safe deletion lifecycle for pairing secrets
```
