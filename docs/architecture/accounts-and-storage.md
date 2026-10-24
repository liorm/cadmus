# Accounts, Multi-Tenancy & Storage Split

Cadmus separates **global account/tenant administration** from **per-family conversational state** across two distinct storage tiers:

1. **Global Admin Store (`AdminStore` -> `D1AdminStore` in `src/store/d1-admin.ts`)**: Backed by Cloudflare D1 (`CADMUS_ADMIN_DB`).
2. **Per-Family Store (`FamilyStore` -> `SqliteFamilyStore` in `src/store/sqlite-family.ts`)**: Backed by the embedded SQLite database inside each `CadmusBotFamilyDO` instance.

---

## Rule of Thumb for State Placement

- **Does it belong to account administration, user membership, provider API keys, or locating which Durable Object owns a Bot Family?**
  -> Store it in **`D1AdminStore` (`CADMUS_ADMIN_DB`)**.
- **Is it read or mutated during a conversation turn, tool call, prompt render, schedule firing, or idle harvest inside a Bot Family?**
  -> Store it in **`FamilyStore` (`CadmusBotFamilyDO` SQLite)** behind the `FamilyStore` interface (`src/store/family-interface.ts`).

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
| `cadmus_accounts` | Account records (`id`, `name`, `timezone`, `default_tools_env_json`, `created_at`). |
| `cadmus_users` | User records (`id`, `name`, `email`, `created_at`). |
| `cadmus_account_members` | Users associated with an account (`account_id`, `user_id`, `role`, `created_at`). |
| `cadmus_auth_tokens` | Authentication token hashes (`token_hash`, `user_id`, `account_id`, `label`, `created_at`). |
| `cadmus_families` | Registry mapping `(account_id, family_id)` to `do_name` (`cadmus:<accountId>:<familyId>`), `timezone`, and `harvest_delay_ms`. |
| `cadmus_account_credentials` | AES-GCM encrypted provider credentials (`account_id`, `provider_id`, `cred_type`, `iv_hex`, `cipher_hex`, `updated_at`). |
| `cadmus_tools_envs` | Execution environments (`account_id`, `env_id`, `kind`, `label`, `workspace_path`, `persist`, `confine_to_workspace`, `shared_workspace`, `secret_id`, `secret_missing`, `updated_at`). |
| `cadmus_tools_env_secrets` | Local daemon pairing secrets (`account_id`, `secret_id`, `label`, `kind`, `token_hash`, `iv_hex`, `cipher_hex`, `updated_at`). |

### Schema Versioning & Cold-Path Decoupling
To avoid running 6-8 D1 round-trips (`CREATE TABLE IF NOT EXISTS`, `PRAGMA table_info`, `ALTER TABLE`) on every edge request:
- **Isolate Cache**: D1 initialization status is cached in memory per Worker isolate (`ensureAdminStoreInitialized`). Warm requests bypass schema initialization completely (0 queries).
- **Schema Version Marker (`cadmus_schema_meta`)**: On a cold isolate boot, a single fast SELECT checks `cadmus_schema_meta`. If the stored version matches `CADMUS_SCHEMA_VERSION`, full table migrations are skipped.
- **Narrow Missing-Schema Fallback**: If a query encounters a "no such table" or "no such column" error at runtime, the store automatically runs schema migration and retries once.

### Encryption at Rest for Provider Credentials
Provider API keys (`anthropic`, `openai`, `google`, `xai`) set via `account.credentials.set` are encrypted using WebCrypto **AES-GCM (256-bit)** derived from `CADMUS_ENCRYPTION_KEY` before being written to `cadmus_account_credentials`. Raw keys are never returned by `account.credentials.list` (only a masked `keyHint` such as `...abcd` is exposed).

---

## Authentication Modes & Edge Caching (`src/auth.ts`, `src/edge-cache.ts`)

Every incoming HTTP/WebSocket request is authenticated by the Worker entrypoint (`src/index.ts`) before forwarding to `CadmusBotFamilyDO`:

1. **`CADMUS_AUTH_MODE="cf-access"`**: Verifies Cloudflare Access headers (`Cf-Access-Authenticated-User-Email` / JWT) and resolves the member's `accountId` in `D1AdminStore`.
2. **`CADMUS_AUTH_MODE="token"`**: Verifies `Authorization: Bearer <token>` (or `?token=<token>` on WebSocket upgrades) against either `CADMUS_DEV_TOKEN` or SHA-256 `token_hash` in `cadmus_auth_tokens` / `cadmus_account_members`.
3. **`CADMUS_AUTH_MODE="none"`**: Local development/test mode; accepts `X-Cadmus-Account` and `X-Cadmus-Family` headers (defaulting to `default-account` / `default`).

---

## Two-Tier Edge Cache (`EdgeCache` in `src/edge-cache.ts`)

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
- **RPC (`/rpc`)**: Each HTTP POST frame authenticates via cache lookup (zero D1 queries after warming).
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
