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

## Authentication Modes (`src/auth.ts`)

Every incoming HTTP/WebSocket request is authenticated by the Worker entrypoint (`src/index.ts`) before forwarding to `CadmusBotFamilyDO`:

1. **`CADMUS_AUTH_MODE="cf-access"`**: Verifies Cloudflare Access headers (`Cf-Access-Authenticated-User-Email` / JWT) and resolves the member's `accountId` in `D1AdminStore`.
2. **`CADMUS_AUTH_MODE="token"`**: Verifies `Authorization: Bearer <token>` (or `?token=<token>` on WebSocket upgrades) against either `CADMUS_DEV_TOKEN` or SHA-256 `token_hash` in `cadmus_account_members`.
3. **`CADMUS_AUTH_MODE="none"`**: Local development/test mode; accepts `X-Cadmus-Account` and `X-Cadmus-Family` headers (defaulting to `default-account` / `default`).
