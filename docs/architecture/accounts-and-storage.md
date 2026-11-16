# Accounts, Multi-Tenancy & Storage Split

Cadmus separates **global account/tenant administration** from **per-family conversational state** across two distinct storage tiers:

1. **Global Admin Store (`AdminStore` -> `D1AdminStore` in `packages/worker/src/store/d1-admin.ts`)**: Backed by Cloudflare D1 (`CADMUS_ADMIN_DB`).
2. **Per-Family Store (`FamilyStore` -> `SqliteFamilyStore` in `packages/worker/src/store/sqlite-family.ts`)**: Backed by the embedded SQLite database inside each `CadmusBotFamilyDO` instance.

---

## Rule of Thumb for State Placement

- **Does it belong to account administration, user membership, provider API keys, or locating which Durable Object owns a Bot Family?**
  -> Store it in **`D1AdminStore` (`CADMUS_ADMIN_DB`)**.
- **Is it read or mutated during a conversation turn, tool call, prompt render, schedule firing, or idle harvest inside a Bot Family?**
  -> Store it in **`FamilyStore` (`CadmusBotFamilyDO` SQLite)** behind the `FamilyStore` interface (`packages/worker/src/store/family-interface.ts`).

---

## Shared Cloudflare Account Prefixing

Because the Cloudflare account may host multiple Workers and Durable Object classes, all Cadmus resources use explicit `cadmus` prefixes:
- **Worker Name**: `cadmus`
- **Durable Object Class & Binding**: `CadmusBotFamilyDO` / `CADMUS_BOT_FAMILY`
- **Durable Object Instance Name**: `cadmus:<accountId>:<familyId>`
- **D1 Database Tables**: `cadmus_accounts`, `cadmus_account_members`, `cadmus_bot_families`, `cadmus_account_credentials`
- **DO SQLite Tables**:
  - `pi-durable` tables prefixed with `cadmus_pi_*` (`openDurableObjectSqliteStorage(ctx.storage, { prefix: "cadmus_pi_" })`)
  - Cadmus family tables prefixed with `cadmus_*` (`cadmus_family_meta`, `cadmus_bots`, `cadmus_bot_souls`, `cadmus_bot_memories`, `cadmus_bot_knowledge`, `cadmus_chats`, `cadmus_harvest_watermarks`, `cadmus_harvest_notes`, `cadmus_schedules`, `cadmus_schedule_fires`)

---

## Global D1 Admin Schema (`D1AdminStore`)

| Table | Purpose |
| :--- | :--- |
| `cadmus_schema_meta` | Schema metadata and version marker (`key = 'version'`, `value = '<version>'`). |
| `cadmus_accounts` | Account records (`id`, `name`, `timezone`, `default_tools_env_json`, `created_at`, `parent_account_id`, `status`, `suspended_at`). A tenant's parent is the system account. Only the system account has a NULL parent. |
| `cadmus_users` | User records (`id`, `name`, `email`, `primary_email`, `created_at`, `disabled_at`, `passkey_handle`). |
| `cadmus_account_members` | Users associated with an account (`account_id`, `user_id`, `role`, `created_at`, `last_used_at`). |
| `cadmus_auth_tokens` | Hashed API and legacy tokens (`token_hash`, `user_id`, `account_id`, `label`, `created_at`, `id`, `kind` (`pat` or `service`), `grants`, `created_by`, `elevated`, `expires_at`, `last_used_at`, `revoked_at`). Migration backfills `id` and sets the label `legacy` (including old `member-token` rows). New tokens are minted by `auth.tokens.create`. |
| `cadmus_sessions` | Cadmus-issued sessions: `session_family_id`, `login_method_id` or `token_id`, hashed refresh and access tokens, the previous refresh hash (reuse detection), `elevated_until`, `elevated_account_id` (the account admin mode was enabled in; NULL means the session's own account), `fresh_google_at`, idle and absolute expiry, `revoked_at`. |
| `cadmus_tickets` | Single-use, hashed `/ws` and `/events` tickets bound to a session (or `legacy` for a master-secret or legacy-member-token caller, with `user_id` and the minting `credential`), a target and the account selected when the ticket was minted (`account_id`; NULL means the session's own account). |
| `cadmus_login_methods`, `cadmus_passkeys`, `cadmus_passkey_challenges` | Login methods (`UNIQUE (provider, subject)`, revocable), typed passkey data and short-lived ceremony challenges. |
| `cadmus_invites`, `cadmus_bootstrap` | Email invites (expiring, acceptable once, revocable) and the one-row bootstrap super-admin claim (`CHECK (id = 1)`). |
| `cadmus_audit` | Audit rows (`account_id`, `actor_user_id`, `actor_kind`, `action`, `target_account_id`, `target`, `data`, `at`). |
| `cadmus_families` | Registry mapping `(account_id, family_id)` to `do_name` (`cadmus:<accountId>:<familyId>`), `timezone`, and `harvest_delay_ms`. |
| `cadmus_account_credentials` | AES-GCM encrypted provider credentials (`account_id`, `provider_id`, `cred_type`, `iv_hex`, `cipher_hex`, `updated_at`). |
| `cadmus_tools_envs` | Execution environments (`account_id`, `env_id`, `kind`, `label`, `workspace_path`, `persist`, `confine_to_workspace`, `shared_workspace`, `daemon_token_hash`, `updated_at`). A paired local daemon stores only the SHA-256 of its session bearer. |

### Schema Versioning & Cold-Path Decoupling
To avoid running 6-8 D1 round-trips (`CREATE TABLE IF NOT EXISTS`, `PRAGMA table_info`, `ALTER TABLE`) on every edge request:
- **Isolate Cache**: D1 initialization status is cached in memory per Worker isolate (`ensureAdminStoreInitialized`). Warm requests bypass schema initialization completely (0 queries).
- **Schema Version Marker (`cadmus_schema_meta`)**: On a cold isolate boot, a single fast SELECT checks `cadmus_schema_meta`. If the stored version matches `CADMUS_SCHEMA_VERSION`, full table migrations are skipped.
- **Narrow Missing-Schema Fallback**: If a query encounters a "no such table" or "no such column" error at runtime, the store automatically runs schema migration and retries once.

### Encryption at Rest for Provider Credentials
Provider API keys (`anthropic`, `openai`, `google`, `xai`) set via `account.credentials.set` are encrypted using WebCrypto **AES-GCM (256-bit)** derived from `CADMUS_ENCRYPTION_KEY` before being written to `cadmus_account_credentials`. Raw keys are never returned by `account.credentials.list` (only a masked `keyHint` such as `...abcd` is exposed).

---

## Sessions, grants, elevation and audit

Sessions, API tokens, grants, and admin mode are checked on every command. Limits of the current design are listed under "Limits".

### Credentials
- **Session access token** `cad_at_...`: sent as `Authorization: Bearer`, stored hashed in `cadmus_sessions`, valid 15 minutes. It is checked against D1 on every request (no edge cache), including session, user and account status. Open `/ws` and `/events` streams are re-checked by a sweep in the Durable Object (`STREAM_SWEEP_MS`, 60 seconds), so a revoked or suspended session's open stream can stay up for up to about that long.
- **Refresh token** `cad_rt_...`: in the `__Secure-cadmus_refresh` cookie (`HttpOnly; Secure; SameSite=Strict; Path=/auth/refresh`). The issue names `__Host-cadmus_refresh`, but a `__Host-` cookie must have `Path=/`, so `__Secure-` is used to keep the narrow path. `POST /auth/refresh` rotates it on every use, requires an `Origin` that matches the app and the `X-Cadmus-Refresh: 1` header, and reuse of a rotated token revokes the whole session family (audited). Idle expiry is 7 days, absolute expiry 30 days. The Google sign-in transaction cookie (`__Secure-cadmus_txn`, `Path` = the callback path) is the only other cookie the `/auth/*` routes read.
- **WS/SSE ticket**: `auth.ticket` returns a single-use ticket valid 60 seconds, bound to a session and to `ws` or `events`. `/ws` and `/events` do not accept a `cad_at_` token in a header, cookie or `?token=`. The ticket carries the account selected with `x-account-id` when it was minted. Consuming it re-checks that account's live membership and status, and open sockets and streams keep re-resolving authority for that same account (role, grants, suspension, removal, admin mode), not the session's own account.
- **Account selection**: a `cad_at_` session bearer may send `x-account-id` to act in any account where the user is a live member, with that membership's role. A foreign, unknown, suspended or removed account is refused with the same 401 as a bad token. Without the header a request acts in the session's own account (the account the session was opened in); there is no per-session mutable default, so tabs do not retarget each other. Token sessions are bound to their own account and refuse another. A verified explicit selection also records `cadmus_account_members.last_used_at` (at most once per 5 minutes), and sign-in opens the session in the account with the latest of that value and the user's session `last_used_at`. That default applies to the next sign-in only.
- **API tokens**: `cad_pat_` (personal) and `cad_svc_` (service), server-generated, hashed, shown once. Grants are a subset of the creator's grants at creation time. An elevated grant (one marked `elevation: true` in `grants.ts`) is accepted only when the token is created from a live admin-mode user session of the same account (checked inside the insert). Such a token is flagged `elevated` in `auth.tokens.list`, is capped at 30 days (an elevated personal token that omits an expiry gets that 30-day cap; a service token that omits an expiry keeps the 7-day default), and every command a token session runs with an elevated grant is audited like an elevated command (`elevated.command` and `elevated.command.result` rows keyed by the token's session). Revoking another member's token from a token session is audited the same way. A demotion or removal of the token's owner removes the grant at use time, because token grants are clamped to the owner's current role. Service tokens default to 7 days and are capped at 30 days. A personal token with no elevated grant must name an expiry (max 365 days). `cad_pat_` and `cad_svc_` are accepted as `Authorization: Bearer` on `/api` and `/rpc`, with about 60 seconds of edge cache, and every service-token use is audited. `/ws` and `/events` refuse them and open with a ticket. `POST /auth/token-login` exchanges one for a session clamped to the token's grants. Revoking the token revokes its sessions. API token rows are stored under a domain-separated hash (`sha256("cadmus-api-token-v1:" + raw)`), not `sha256(raw)`. The Worker from before token login resolves every bearer as `sha256(raw)` and returns the member's full role without reading `revoked_at`, `expires_at` or grants, so a plain hash would let a rolled-back Worker accept a revoked, expired or narrowed API token. A regression test runs that old lookup against new rows. Token-backed sessions (`cad_at_` access and refresh tokens) are stored under their own domain-separated hash (`sha256("cadmus-token-session-v1:" + raw)`), so the old Worker's plain-hash session lookups cannot match them; the new code looks up both forms, so a token session issued before this change keeps working and moves to the separated form on its first refresh. Until that first refresh such a pre-existing session still matches the old Worker's lookup (access token for at most 15 minutes, refresh token until rotated), and the old Worker honors its revocation and expiry but ignores its grant clamp. Rolling back past this change should first revoke token-backed sessions (`cadmus_sessions` rows with `token_id` set). The migration is one schema version (12): a database already at version 11 gets the added columns (`cadmus_sessions.elevated_account_id`, `cadmus_account_members.last_used_at`, `cadmus_tickets.account_id`, `user_id`, `credential`) because `ensureD1Schema` skips migrations only when the stored version is at least the code's. The Worker from before (`CADMUS_SCHEMA_VERSION = 7`, same check) leaves a version 12 database untouched. A test upgrades a database with those five columns removed and the version set to 11 and compares every table's columns and every index with a fresh one; it is not a real old snapshot.
- **Legacy credentials**: the master secret (`CADMUS_AUTH_SECRET`, plain or `<accountId>:<userId>:<secret>`) keeps working until the phase 9 cutover. Legacy member tokens (caller-chosen strings without a `cad_` prefix, migrated to `kind=pat`, `label=legacy`, no expiry) also still resolve as bearer credentials; the issue does not say when the tokens themselves stop. Transport (issue phases 3 and 8): the `cadmus_session` cookie and `?token=` are not credentials for anything, the master secret included. Every credential is header-only. Streams open with a single-use 60 s ticket from `auth.ticket`, minted over the header-authenticated call. A master-secret or legacy-member-token caller has no session, so its ticket is stored with `session_id = 'legacy'` plus the caller's account and user, and consuming it re-reads the live membership, user and account status (it carries no session; a legacy member token's ticket carries the `user` grant set, the master's carries the account-admin role). The edge records which credential minted it (`master`, or `member-token:` plus the token's plain sha256, set from the authenticated credential and carried in the server-built principal header, never from client input); a legacy-member-token ticket is also refused at consume unless that token row is still live (not revoked, not expired), and a ticket with no recorded credential is refused. The master secret has no row to re-check. An open legacy or master socket or event stream is re-checked: before each message (`liveCaller`, master and legacy-token sockets) and in the stream sweep it re-reads the live membership, user disabled state and account status, and for a legacy member token also its row (not revoked, not expired); a failed check closes it with 4401. A sessionless socket whose attachment names no credential or no user/account is ended with 4401 (every principal the edge builds names its credential and client identity headers are stripped, so only a socket attached before this check existed can lack one). Close codes follow sessions: 4403 when the user is disabled or the account suspended, else 4401. A master caller is account-admin on `/rpc` and on a socket whatever its membership row says (issue phase 2); the row must exist and be active. Whether open sockets survive a deploy is not established from this repository. The CLI and the web app's no-session fallback use that path. `/api/*` accepts the header only. A `cad_at_` session token is accepted on `/rpc` only in the header, and on `/ws` and `/events` only as a ticket. `cad_pat_` and `cad_svc_` tokens are accepted as a bearer on `/api` and `/rpc` and refused on `/ws` and `/events`.

### Roles and grants
Roles are `user`, `account-admin` and `super-admin`. Every command declares a grant (`packages/contract/src/grants.ts`) and `authorize()` checks the principal's grants and elevation. Account suspension and user disablement are enforced when a `cad_at_` session is resolved on each request (`resolveAccessToken`, `sessionRefusalReason`). A super-admin manages accounts and memberships but gets 403 on tenant data. Grants marked `elevation: true` need an active elevation.

### Elevation (admin mode)
`auth.elevate` starts a 15 minute elevation on the session. Elevation is only available to user sessions: `startElevation` only updates sessions with no `token_id`, so token sessions never elevate. A user with an active passkey cannot use that start path and elevates only through a passkey assertion (`finishElevation`); a user without a passkey elevates through `startElevation` itself, only in the session's own account: with another account selected the plain toggle is refused (`forbidden`, a passkey proof message), so another account needs a passkey assertion, and a user with no passkey enrolls one first (first enrollment needs a fresh Google sign-in, not admin mode). Admin mode is one account-tagged state per session: it applies only to requests that select the account it was enabled in (`elevated_account_id`, or the session's own account when NULL), enabling it in another account replaces the tag, and ending it clears it. Elevation state is read when a request starts, and the start audit row names the account it was enabled in. Elevation start and end are audited (`auth.elevate`, `auth.elevation.end`), and every elevated command writes `elevated.command` and `elevated.command.result`. Listing all tokens and managing another member's tokens use `tokens.manage`, so they need admin mode. A token session cannot start admin mode (`auth.elevate`) or run the passkey ceremony commands `auth.passkeys.begin` and `auth.passkeys.finish`: each calls `requireSession`, which refuses token sessions. Other passkey routes were not individually checked for this. A token can only carry elevated grants that were present when the token was created in admin mode.

### Audit
`cadmus_audit` receives rows for the following events. Where the code writes the audit row in the same D1 batch as the change it says so in the source; this document does not claim that for every path: token create, revoke, login and transfer; session create, revoke and refresh reuse; method link and revoke; passkey register and remove; invites, membership and role changes; account create, suspend and resume; the bootstrap claim; elevation start and end; and elevated commands.

### Limits
- Elevated API tokens: implemented as described above. Limits: a token created during a no-passkey admin mode stays valid (up to 30 days) after its creator later enrolls a passkey; the audit rows carry the token session id, not the token id; any elevated grant the creator held may be carried, because the issue text names no narrower rule.
- Linking a further login method (`auth.methods.link.start`, audited as `method.link` in the initiating session's account) is implemented against a mocked Google only. The link ticket is valid 120 s to start the browser step; the signed transaction cookie then lasts 600 s to finish the Google callback, so a link can take up to about 12 minutes from start to completion. The initiating session must still be live (a user session, not a token, not revoked, idle and absolute limits not passed) at the callback and again inside the write. Limits: the ticket is not single-use, the bind cookie is not HttpOnly, there is no UI button for linking, and a membership removed after the link started does not stop it from completing. Google sign-in and linking are tested with Google mocked at egress.
- The web account switcher is covered by Playwright against the Worker on mobile and desktop, including a reload after the switch. Legacy unscoped storage keys remain.
- The issue's end state of no `?token=` and no cookie reads outside `/auth/refresh` is met for every credential, the master secret included. Tests cover each refused transport with the same credential's header or ticket as control. The OAuth transaction and link-bind cookies are on their own auth paths and are not credentials.
- Legacy member tokens (every non-`cad_` bearer row, label `legacy` or `member-token`) are clamped to the `user` grant set (issue data model L102) on `/api`, `/rpc`, the edge cache entry, and the ticket and socket path, whatever the member's live role. The role is still the live role. Migration note: a legacy token that was used as an admin credential now gets forbidden on account-admin grants (for example `members.manage`, `bot.delete`); clients needing admin use a session, token-login, or the master secret. A search of `packages/web-app/src` at c56a0de plus this change finds one writer of the stored dev config (`cadmus.dev.config`), `switchFamily`, which keeps the record's token as it was, and no field or setter for a token. A legacy member token can still reach the browser through a stored dev config that someone edited by hand or that an older build wrote. With no session the web app treats the caller as the master secret and still shows account-admin controls, and the worker then refuses the admin commands with forbidden, so the refusal is on the server and the controls are only a display limitation. The exact message shown for that refusal was not checked. The master secret is not clamped (it stays account-admin until phase 9). An edge-cache entry written before this change keeps its old, wider grants until it expires (the cache TTL: a KV entry carries its write time `cachedAt`, and every KV read trusts it only while it is younger than the 60 s L2 TTL, whatever KV still holds, so lagging KV deletes or expiry cannot extend it; an L2 hit gives L1 only the rest of that life; an entry with no `cachedAt` is a miss. This is an absolute bound of 60 s from the cache write, not from the revoke. Isolate clocks are assumed to agree to within seconds).
- Revoking a legacy token by id (`revokeTokenById`) sets `revoked_at`, revokes its sessions and drops that token's cache entry in the isolate that handled the revoke, so that isolate stops accepting it at once (revoking by raw token and member removal, role change, user disable and account suspend or resume do the same for the affected user's or account's tokens for every one of that user's or account's tokens, with no row cap. If that lookup or an invalidation fails after the authority change is committed, the change still stands and the isolate floors its token cache instead: L1 is cleared, KV entries written at or before that moment are refused, and a D1 resolve that began before it is not cached, so the next request here still re-resolves from D1). Another isolate can keep serving a cached scope for at most the 60 s cache TTL from the cache write (an L2 hit does not extend it). The guarantee is: immediate in the isolate that ran the change, at most 60 s from the cache write elsewhere (isolate clocks assumed to agree within seconds). The authority mutators (member removal, role change, user disable, account suspend or resume, revoke by id) run in the family Durable Object, so they are immediate in that Durable Object's isolate; edge Worker isolates, which authenticate requests from their own cache, are always the 60 s case after such a change. Revoking by raw token at the edge is immediate in the edge isolate. Every invalidation and floor also bumps a cache generation, so a D1 resolve that began before the change is not written back to the cache. Open sockets and streams are not served from the cache: they re-read the token row on every message and in the sweep, so they end at the next message or alarm sweep (the per-event delivery sweep does not check sessionless sockets, so a revoked legacy socket can still receive events for up to 60 s). Tokens added by `account.members.add` have no `id` until a migration run backfills one, so they cannot be revoked by id before that.
- Phase 9 (remove the master secret, `CADMUS_AUTH_SECRET` and Cloudflare Access) has not happened. Production auth configuration is outside this document.
- The edge cache below covers legacy member-token and `cad_pat_` / `cad_svc_` resolution. The 60 second TTL bound does not apply to `cad_at_` sessions, which are read from D1 on every request.

---

## Authentication (`packages/worker/src/auth.ts`)

Every `/api`, `/rpc`, `/ws`, and `/events` request is authenticated by `authenticateRequest` before it reaches `CadmusBotFamilyDO`. There is no `CADMUS_AUTH_MODE` switch.

The credential is `Authorization: Bearer`. It may be the master secret (`CADMUS_AUTH_SECRET`, until the phase 9 cutover), a session access token (`cad_at_`), a personal or service API token (`cad_pat_`, `cad_svc_`), or a legacy member token. `?token=` and the `cadmus_session` cookie are refused for every credential, the master secret included. `/api` rejects those forms up front (`query_token_not_allowed`, `header_required`). `/ws` and `/events` open with a single-use ticket from `auth.ticket`, not with the bearer in the URL. The only cookie read is the refresh cookie on `POST /auth/refresh`.

---

## Two-Tier Edge Cache (`EdgeCache` in `packages/worker/src/edge-cache.ts`)

To avoid querying D1 on every single `/rpc` request, Cadmus implements a two-tier edge cache for token resolution and Bot Family DO routing info:

1. **L1: In-Memory Isolate LRU Cache (Always On)**:
   - High-performance, zero-latency per-isolate cache (`LruCache<T>`).
   - Default TTL: **60 seconds**.
   - Bounded capacity (1,000 items) with LRU eviction.
2. **L2: Cloudflare Workers KV Cache (Optional Binding `CADMUS_CACHE_KV`)**:
   - Cross-isolate distributed cache.
   - When configured, L1 misses read through to L2 KV and warm L1.
   - Default TTL: **60 seconds** (Cloudflare KV minimum expiration TTL).

### Cache Keys & Security Invariants
- **No Raw Tokens**: Raw tokens and secrets are **never** stored in cache keys, cache values, or logs. All token cache keys are derived using **SHA-256** via Web Crypto:
  - Token key format: `cadmus:v1:${envTag}:token:${tokenHash}`
  - Family routing key format: `cadmus:v1:${envTag}:family:${accountId}:${familyId}`
- **Environment Isolation (`envTag`)**:
  - Production uses `prod` (`cadmus:v1:prod:...`).
  - Preview deployments (`IS_PREVIEW="true"`) use `preview` (`cadmus:v1:preview:...`).
  - Ensures preview environments and production never collide, even if sharing a KV namespace.
- **No Negative Caching for Tokens**: Missing or invalid tokens are never cached, ensuring newly minted tokens take effect immediately without lockouts.

### Master Secret Fast-Path
- The master secret check (`rawToken === CADMUS_AUTH_SECRET` or scoped `<accountId>:<userId>:<CADMUS_AUTH_SECRET>`) runs **before** D1 queries using constant-time comparison (`timingSafeEqualSha256` / `matchMasterSecret`) to prevent timing side-channels.
- Initial requests perform `ensureAccountAndUser` (batch upsert into `cadmus_accounts`, `cadmus_users`, `cadmus_account_members`).
- Subsequent requests for the same `(accountId, userId)` in that isolate are memoized in an in-memory isolate set (TTL 300s), skipping D1 upserts entirely.

### Verification Per Access Layer
- **RPC (`/rpc`) and REST (`/api/*`)**: Each request authenticates via the same `authenticateRequest` path and cache lookup (zero D1 queries after warming). `/api/*` does not have a separate auth stack. `/api` rejects query-token and cookie transports up front; `/rpc` refuses the cookie and `?token=` for every credential, and its only accepted transport is the header. A rejected `/api` query token is not written to logs.
- **WebSocket (`/ws`)**: Authenticated once during HTTP upgrade / handshake. Individual frames over the open WebSocket bypass edge verification and stream directly to the DO.
- **SSE (`/events`)**: Authenticated once upon stream establishment.

### Invalidation Paths & Cross-Isolate Staleness Bounds
- **Token Revocation (`adminStore.revokeToken` / `revokeTokenByHash`)**: Invalidates L1 in the executing isolate and deletes from L2 KV (when bound).
- **Member Updates (`account.members.add`)**: Invalidates previous cached token on token rotation after committing to D1.
- **Family Settings Updates (`family.update` / `updateAccount`)**: Invalidates cached family DO routing info (`doName`, `timezone`, `harvestDelayMs`).
- **Family Deletions (`family.delete`)**: Deletes cached family routing info.

#### Isolate Boundaries & Consistency Model
- **Local L1 Scope**: Edge requests and Durable Object mutations execute within distinct Cloudflare isolates. An in-memory L1 cache invalidation (e.g. from an RPC or WebSocket mutation running inside `CadmusBotFamilyDO`) clears L1 memory *only* within that executing isolate.
- **With L2 Workers KV (`CADMUS_CACHE_KV`)**: Invalidation deletes the key from L2 KV immediately. Any isolate experiencing a subsequent cache miss fetches fresh data from D1. However, existing warmed L1 cache entries across other Worker isolates bypass L2 until their local 60-second L1 TTL expires.
- **Without L2 Workers KV (L1 Only)**: Without KV, isolates do not share memory. Other Edge Worker isolates continue serving their local L1 entries until their 60-second TTL expires.
- **Convergence Guarantee**: Cadmus does not provide instantaneous global edge revocation without Workers KV, but guarantees convergence across all edge isolates within the bounded 60-second TTL window.

---

## Provisioning KV Cache in Production / Previews

The `CADMUS_CACHE_KV` binding is completely optional. If absent, Cadmus falls back seamlessly to the in-memory L1 LRU cache.

To provision distributed Workers KV caching on your Cloudflare account:

```bash
# 1. Create the production KV namespace
wrangler kv namespace create cadmus-cache

# 2. Create the preview KV namespace
wrangler kv namespace create cadmus-cache-preview
```

Then add the `kv_namespaces` configuration to `wrangler.jsonc`:

```jsonc
  "kv_namespaces": [
    {
      "binding": "CADMUS_CACHE_KV",
      "id": "<PRODUCTION_KV_NAMESPACE_ID>"
    }
  ],
  "previews": {
    "kv_namespaces": [
      {
        "binding": "CADMUS_CACHE_KV",
        "id": "<PREVIEW_KV_NAMESPACE_ID>"
      }
    ]
  }
```
