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
| `cadmus_accounts` | Account records (`id`, `name`, `created_at`). |
| `cadmus_account_members` | Users associated with an account (`id`, `account_id`, `email`, `name`, `role`, `token_hash`, `created_at`). |
| `cadmus_bot_families` | Registry mapping `(account_id, id)` to `do_name` (`cadmus:<accountId>:<familyId>`), `timezone`, and `harvest_delay_ms`. |
| `cadmus_account_credentials` | AES-GCM encrypted provider credentials (`account_id`, `provider_id`, `cipher_hex`, `iv_hex`, `key_hint`, `updated_at`). |

### Encryption at Rest for Provider Credentials
Provider API keys (`anthropic`, `openai`, `google`, `xai`) set via `account.credentials.set` are encrypted using WebCrypto **AES-GCM (256-bit)** derived from `CADMUS_ENCRYPTION_KEY` before being written to `cadmus_account_credentials`. Raw keys are never returned by `account.credentials.list` (only a masked `keyHint` such as `...abcd` is exposed).

---

## Authentication Modes (`src/auth.ts`)

Every incoming HTTP/WebSocket request is authenticated by the Worker entrypoint (`src/index.ts`) before forwarding to `CadmusBotFamilyDO`:

1. **`CADMUS_AUTH_MODE="cf-access"`**: Verifies Cloudflare Access headers (`Cf-Access-Authenticated-User-Email` / JWT) and resolves the member's `accountId` in `D1AdminStore`.
2. **`CADMUS_AUTH_MODE="token"`**: Verifies `Authorization: Bearer <token>` (or `?token=<token>` on WebSocket upgrades) against either `CADMUS_DEV_TOKEN` or SHA-256 `token_hash` in `cadmus_account_members`.
3. **`CADMUS_AUTH_MODE="none"`**: Local development/test mode; accepts `X-Cadmus-Account` and `X-Cadmus-Family` headers (defaulting to `default-account` / `default`).
