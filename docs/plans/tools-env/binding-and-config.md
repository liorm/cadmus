# Binding, Secrets, API, and UI

Implements decisions 4, 5, 8, 10, 13, 14, and 16. The account has a catalog of env definitions and one default **binding** (`{ envId }` or null). A bot and a chat each store a tri-state `toolsEnv` setting: inherit, on (with optional `envId` pin), or off. Auth material is encrypted in D1 and referenced by id from a daemon env definition. The resolved `envId` is input to the proxy ([execution-env.md](./execution-env.md)). It is not a tool list.

`bot.tools` is still the opt-in for whether `bash` / `read` / `write` / `edit` *may* be offered. A resolved env of **off** removes those four for that conversation even when they are listed. A resolved env of **on** still requires the existing `bot.tools` / extensions opt-in. Web tools and knowledge tools are unchanged. A planning chat that pins a just-bash `envId` while the bot pins a daemon still needs the bot to list the coding tools.

---

## Bot record field **(new)**

Today `cadmus_bots` ([`SqliteBotStore`](../../../src/store/sqlite-family.ts)) is:

```text
id, name, model, thinking, tools_json, timezone, root_conversation_id, created_at
```

`BotRecordSchema` in [`src/protocol/records.ts`](../../../src/protocol/records.ts) matches those columns (`id`, `name`, `model`, `thinking`, optional `tools`, `timezone`, `rootConversationId`, `createdAt`). Schema migrations in `SqliteFamilyStore.ensureSchema` already use `ALTER TABLE ... ADD COLUMN` guarded by `try/catch` (timezone on `cadmus_bots`, thinking on chats/schedules).

Add:

```text
ALTER TABLE cadmus_bots ADD COLUMN tools_env_json TEXT
```

`tools_env_json` is JSON (nullable). Mapped onto `BotRecord.toolsEnv` **(new, optional)** as `ToolsEnvSetting`. When null or omitted, the bot **inherits** the account default (enabled and binding). When set, this row is the first non-inherit level for every chat that itself inherits.

## Chat record field **(new)**

Today `cadmus_chats` is `key, bot_id, conversation_id, title, thinking, closed, created_at`. `ChatRecordSchema` matches that (`key`, `botId`, `conversationId`, optional `title` / `thinking` / `closed`, `createdAt`). There is no general chat update. `chat.rename` changes the title only. `chat.close` and `chat.reset` do not touch config. `ChatStore.deleteChat` exists and is not called from `CadmusBotFamilyDO`.

Add:

```text
ALTER TABLE cadmus_chats ADD COLUMN tools_env_json TEXT
```

Mapped onto `ChatRecord.toolsEnv` **(new, optional)** as `ToolsEnvSetting`.

- Field absent or JSON null: the chat **inherits** both enabled and binding from the bot (then the account).
- `{ enabled: false, binding? }`: this chat is **off**. `binding` may be kept so toggling back on restores it.
- `{ enabled: true, binding? }`: this chat is **on**. `binding` pins an `envId` for this chat; omitted inherits the env from bot then account.

### Field shape **(new)** (TypeBox)

The stored value at bot and chat is a wrapper. The inner `binding` is only an env id. Kind and config live on the account env definition (`cadmus_tools_envs`). The account default stores the same `{ envId }` or null (the account is the default, not an inherit/off toggle).

**Why this shape.** An `enabled` flag next to an optional `envId` keeps off from needing `{ kind: "none" }`, and keeps the pin when the operator toggles off so toggling on restores it. `null` stays inherit, matching today's "omit the column" meaning. Putting `persist` or `confineToWorkspace` on the bot would split one env's config across every reference. Those fields are edited once, on the env.

```ts
type ToolsEnvSetting = {
  enabled: boolean;
  binding?: ToolsEnvBinding; // omitted = inherit env id from the next level
} | null; // null / absent = inherit enabled and binding

type ToolsEnvBinding = { envId: string };
```

`persist`, `confineToWorkspace`, `sharedWorkspace`, `workspacePath`, and `secretId` are columns on `cadmus_tools_envs`, not fields on the binding. `secretId` on a daemon definition is the pairing token (`cadmus_tools_env_secrets.kind = daemon_token`). `confineToWorkspace` is decision 14 ([execution-env.md](./execution-env.md)). `sharedWorkspace` is the just-bash cross-family namespace flag ([workspace-persistence.md](./workspace-persistence.md)). just-bash is an account env with an `envId`, the same shape as the daemon.

Account column `default_tools_env_json` stores `ToolsEnvBinding | null`. `null` means inheriting bots with no pin are unbound. A set object is an **on** default. Account create writes `{ envId: "jb_default" }` after inserting that built-in row.

### Resolution (pure helper)

Walk **chat → bot → account**. First non-inherit **enabled** wins. First explicit **binding** wins, independently.

```ts
type ToolsEnvResolution = {
  enabled: boolean;
  enabledSource: "chat" | "bot" | "account" | "unbound";
  binding: ToolsEnvBinding | null;
  bindingSource: "chat" | "bot" | "account" | "unbound";
};

// 1. enabled: first of chat.toolsEnv / bot.toolsEnv that is non-null supplies .enabled
//    (chat off beats bot on; chat on beats bot off). If both inherit, account default
//    present → enabled true, source "account"; else enabled false, source "unbound".
// 2. binding: first of chat.toolsEnv.binding / bot.toolsEnv.binding / account default
//    that is set. A level with enabled:false may still hold a binding for restore.
// 3. Runtime: enabled true and binding null → treat as off (callback returns undefined,
//    coding tools not offered). This is a safety net after a parent binding was deleted.
//    Writes of enabled:true that cannot resolve a binding are rejected (below).
```

Off at a more specific level beats on above it. On below beats off above. just-bash scope follows **binding source**, not enabled source: a chat that is on with no own `binding` uses `bot:<botId>` inside the inherited env, even when that env id came from the account default. A chat with its own `binding` uses `chat:<chatKey>` inside the env it named, even when enabled is false (namespace retained). A daemon binding has no family namespace. The workspace and the socket belong to `envId`.

`resolveToolsEnv(chatSetting, botSetting, accountBinding)` is a pure function next to the protocol types. Unit tests own the matrix ([sequencing.md](./sequencing.md)). Kind, `persist`, and `sharedWorkspace` are loaded from the env row after this function returns. They are not part of the pure resolution.

### Validation

On `bot.create` / `bot.update`, `chat.create` / `chat.update`, `account.update` (`defaultToolsEnv`), and `createBotInternal`:

- `toolsEnv` object requires `enabled` (boolean). Reject unknown keys. Reject `token` / `password` / `apiKey` anywhere.
- `binding`, when present, is `{ envId }` only. Reject `kind`, `secretId`, `workspacePath`, `persist`, `confineToWorkspace`, and `sharedWorkspace` on the binding.
- `envId` must be a `cadmus_tools_envs` row on this account. Family does not matter. The same env may be named by any bot or chat in any family of the account.
- Phase 1 accepts rows whose `kind` is `just-bash` and rejects `local-daemon` with `unsupported_kind` (the row cannot exist yet). Phase 2 accepts both kinds.
- The chat's bot must be the request bot. A chat override cannot name another bot.
- **`enabled: true` must resolve to a binding.** If this level omits `binding`, a parent must supply one (bot → account for a chat; account for a bot). If none exists, reject (`tools_env_on_without_config`). Account `defaultToolsEnv` is `{ envId }` when set. After account create the default is set, so an inheriting `{ enabled: true }` resolves. After the operator clears the default, it does not.
- **`confineToWorkspace` and `sharedWorkspace`** are validated on `account.toolsEnvs.create` / `update`, not on the bot. Each provider declares `supportsConfinement`. `true` on a provider that does not support it is rejected (`confinement_unsupported`). just-bash supports confinement trivially (the VFS is the whole world) and is always confined: omitted or `true` is stored as true; `false` is rejected with error code `confinement_required`. `local-daemon` supports the option on the env definition; `true` is stored there and enforced at the daemon ([execution-env.md](./execution-env.md)). `sharedWorkspace: true` is allowed on just-bash (default false) and rejected on `local-daemon`. A later [issue #16](https://github.com/liorm/pi-bot/issues/16) manager kind whose `supportsConfinement` is false is rejected the same way.

The wrapper plus `{ envId }` is the phase 1 schema, so `/protocol/schema` does not gain a binding variant later. Kind is a column on the env row, not a binding discriminant. Phase 1 handlers reject an `envId` whose kind is `local-daemon`. Phase 2 stores daemon definitions and `{ envId }` bindings that name them. It does not open a socket. A turn that resolves to a daemon env throws the offline error until phase 3 accepts the daemon. See [sequencing.md](./sequencing.md).

### Clearing vs toggling off

These are different writes.

**Inherit** (`toolsEnv: null`): drop this level's setting. Bot then uses the account default. Chat then uses the bot (then account). If a **chat** had its own `binding` and that env's kind is just-bash, RPC `deleteNamespace` for `chat:<chatKey>` on that env DO. Do not delete `cadmus_chat_conversations`. If the chat had a daemon `envId`, drop the reference only. Do not close `CadmusEnvDO`'s socket and do not send `cleanup`. Other bots may still use that env. If the **bot** pin is cleared and the account default is a different `envId`, RPC `deleteNamespace` for `bot:<botId>` on the previous just-bash env. Chat overrides are left in place.

**Off** (`{ enabled: false, binding? }`): this level is off. **Retain** just-bash namespaces and the daemon workspace. Do not `deleteNamespace` and do not send `deleteEphemeral`. Do not close the shared env socket, and do not CAS `cadmus_env_connection`. One daemon socket serves every family that references the env. If a tool call is already running, it finishes on the proxy it already holds. The tool gate blocks a coding-tool call that has not started. Adding or removing `coding-tools` waits until the next turn preparation. Toggle-off is not a transport failure and is not `env disconnected` ([reachability.md](./reachability.md)). No connection badge for an off env. The `env` callback returns `undefined` for a call that starts after the toggle.

**On** (from inherit or from off): a just-bash namespace that was retained is reused when the `envId` and scope match, and the env is `connected`. A daemon reference uses the env's existing connection row. It does not create a family reachability row.

`chat.delete` and `bot.delete` RPC namespace deletes for the scopes they remove ([workspace-persistence.md](./workspace-persistence.md)). They do not close a daemon socket and do not send `cleanup`. The family store methods do not see env-DO SQLite. Env delete is the path that cleans the daemon folder and the just-bash DO storage ([execution-env.md](./execution-env.md)).

`upsertBot` / `upsertChat` must persist `tools_env_json`. `mapRow` parses it as `ToolsEnvSetting`. `listBots` / `bot.get` / `chat.get` / `chat.list` return the stored setting **without** secrets (a binding is `envId` only, like `account.credentials.list` returning `providerId` + `type` and never the key — [`D1AdminStore.listCredentials`](../../../src/store/d1-admin.ts)). `chat.toolsEnv` / `bot.toolsEnv` on those results is the stored setting only.

`chat.get` and `bot.get` also return the resolution so the UI can show Inherit / On / Off at this level, plus the effective value and where it came from:

```ts
type ToolsEnvSource = "chat" | "bot" | "account" | "unbound";

type EffectiveToolsEnv = {
  envId: string;
  kind: "just-bash" | "local-daemon";
  persist: boolean;
  confineToWorkspace: boolean;
  sharedWorkspace?: boolean; // just-bash
  workspacePath?: string;    // local-daemon
};

// on chat.get / bot.get (flattened). /status nests a different toolsEnv object; see below.
{
  toolsEnv: ToolsEnvSetting | null;          // stored at this level
  toolsEnvEnabled: boolean;                  // resolved
  toolsEnvEnabledSource: ToolsEnvSource;     // which level decided on/off
  effectiveToolsEnv: EffectiveToolsEnv | null;
  toolsEnvBindingSource: ToolsEnvSource;     // which level supplied the envId
  toolsEnvStatus?: "connected" | "disconnected";  // omitted when enabled is false
  toolsEnvConnectedAt?: number;
  toolsEnvLastError?: string;
}
```

`effectiveToolsEnv` is null when `toolsEnvEnabled` is false or `toolsEnvBindingSource` is `"unbound"`. It is filled from the env definition, not from a copy stored on the bot. `bot.get` and `chat.get` return these flattened fields next to the stored `toolsEnv`. `/status` does not. It nests operator status as `toolsEnv: { enabled, enabledSource, kind?, envId?, bindingSource?, status?, connectedAt?, lastError? }` ([builtin-tools.md](./builtin-tools.md), [reachability.md](./reachability.md)). `kind` and `envId` are present when a binding resolved. `status`, `connectedAt`, and `lastError` are present when enabled is true and a binding won. just-bash is `connected` and omits the timestamps. A daemon's fields are the env DO row, read by RPC. There is no `nextProbeAt`. Off is `enabled: false` plus `enabledSource`, with no status fields. `/status` has no `effectiveToolsEnv`.

Connection status is **not** stored in `tools_env_json`. The family DO does not keep a fingerprint table. `persist` and `sharedWorkspace` live on the env definition. Flipping `enabled` does not change them. Editing a definition does not rewrite bot rows; the next pull sees the new definition. Family updates do not call `syncAlarmInternal()` for tools-env. There is no probe column to sync (see [reachability.md](./reachability.md)).

### Scopes

These are namespaces inside a just-bash env DO. They are not family tables.

| Binding that won | Scope id | Who uses it |
| :--- | :--- | :--- |
| just-bash env on the bot, or the account just-bash default when the bot has no `binding` | `bot:<botId>` plus `family_id`, unless that env has `sharedWorkspace` | Every conversation whose resolved binding source is this bot, including a chat that is on (or off, for retention) with no own `binding`, and the bot root conversation. Two bots that both inherit `jb_default` do not share a namespace. Two families with the same bot id do not share one unless `sharedWorkspace` is true. |
| `binding` set on the chat, and that env's kind is just-bash | `chat:<chatKey>` plus `family_id`, unless `sharedWorkspace` | That chat and forks whose conversation maps to that chat key. |
| `local-daemon` | none | The account env. Workspace and socket are `envId` on `CadmusEnvDO`. |

`chat:<chatKey>` keeps the raw key after the prefix. Chat keys may contain colons (`createChatInternal` uses `${bot.id}:${uuid}`). The env DO stores `scope` and `family_id` as columns. It does not parse a combined string.

A chat that inherits **both** enabled and binding has **no** chat namespace. A chat that only pins `enabled` (on or off) and omits `binding` also uses the bot scope when the resolved kind is just-bash. A bot that inherits the account just-bash default **does** have `bot:<botId>`, because that namespace is that bot's. A daemon reference never gets a family socket. Off does not change the env connection and does not drop the namespace.

---

## Account catalog and default

Env definitions belong to the account. They are not a family setting. `cadmus_families` stays the catalog of family DOs (`account_id`, `family_id`, `do_name` in [`D1AdminStore`](../../../src/store/d1-admin.ts)). The operator points a bot at an env with `toolsEnv.binding = { envId }`. The same `envId` can be on many bots, in more than one family. A daemon env shares one socket and one folder. A just-bash env shares one DO and isolates namespaces unless `sharedWorkspace` is set.

**(new)** D1 table:

```text
cadmus_tools_envs (
  account_id TEXT NOT NULL,
  env_id TEXT NOT NULL,
  kind TEXT NOT NULL,                  -- just-bash | local-daemon
  label TEXT,
  workspace_path TEXT,                 -- required for local-daemon, null for just-bash
  persist INTEGER NOT NULL DEFAULT 1,
  confine_to_workspace INTEGER NOT NULL DEFAULT 0,  -- just-bash stored as 1
  shared_workspace INTEGER NOT NULL DEFAULT 0,      -- just-bash only; daemon must be 0
  secret_id TEXT,                      -- required for local-daemon, null for just-bash
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, env_id)
)
```

Account create inserts the built-in row and sets the default:

```text
env_id = jb_default
kind = just-bash
label = Default just-bash
persist = 1
confine_to_workspace = 1
shared_workspace = 0
secret_id = NULL
workspace_path = NULL
default_tools_env_json = {"envId":"jb_default"}
```

The operator may create other just-bash envs (`jb_` plus a uuid). Deleting `jb_default` does not recreate it. Clearing the default to `null` stays `null`.

**(new)** `account.toolsEnvs.list` returns the catalog and the current default, with no token bytes. Every row is a real env, including `jb_default`. There is no synthetic `{ envId: "just-bash" }` entry. Phase 1 includes `connection` for just-bash (`connected`, no timestamps) by RPC. Phase 3 adds `connection` for daemon rows the same way. Phase 2 omits daemon `connection` (the socket acceptor is not up; the UI does not show a badge).

```ts
{
  default: ToolsEnvBinding | null; // { envId } | null
  envs: Array<{
    envId: string;
    kind: "just-bash" | "local-daemon";
    label?: string;
    secretId?: string;             // daemon
    workspacePath?: string;        // daemon
    persist: boolean;
    confineToWorkspace: boolean;
    sharedWorkspace?: boolean;     // just-bash
    updatedAt: number;
    connection?: {
      status: "connected" | "disconnected";
      connectedAt?: number;
      disconnectedAt?: number;
      lastError?: string;
    };
  }>;
}
```

`envId` is the row's id, not the `secretId` (several daemon envs may share a pairing token and still be different folders and different sockets).

**(new)** `account.toolsEnvs.create` / `account.toolsEnvs.update` / `account.toolsEnvs.delete` write that table.

- Create `just-bash` (phase 1): optional `label`, `persist` (default true), `sharedWorkspace` (default false). `confineToWorkspace` omitted or true. Reject `false`, `secretId`, and `workspacePath`. The new id is `jb_` plus a uuid. `jb_default` is reserved for the built-in.
- Create `local-daemon` (phase 2): requires `secretId` (existing `daemon_token`), a non-empty `workspacePath`, and the confinement flag. Reject `sharedWorkspace: true`. Phase 1 create of this kind is `unsupported_kind`.
- Update may change `label`, `persist`, `confineToWorkspace`, and, for just-bash, `sharedWorkspace`. Kind is immutable. `persist` or `sharedWorkspace` changes RPC `applyConfig` on that env DO ([workspace-persistence.md](./workspace-persistence.md)). A daemon `persist` change is the `cleanup` / `deleteEphemeral` path in phase 3; phase 2 only stores the column.
- Delete tells the env DO to drop just-bash storage, or, in phase 3, to `cleanup` and close a daemon socket, then removes the row. If the default names that `envId`, clear the default. Phase 2 daemon delete has no socket yet; it removes the row and clears a default that names it.

**(new)** account default on [`AccountRecord`](../../../src/protocol/records.ts):

```text
ALTER TABLE cadmus_accounts ADD COLUMN default_tools_env_json TEXT
```

Nullable JSON of `ToolsEnvBinding`. `D1AdminStore.initialize` adds it the same way it adds `timezone` (PRAGMA `table_info`, then `ALTER`). The `jb_default` backfill runs only in that newly-added branch: for each account, insert the built-in row when it is missing, and if `default_tools_env_json` is null, set `{ envId: "jb_default" }`. Later initializes see the column and do not recreate a deleted `jb_default` or refill an explicit `null`. `account.get` returns it. `account.update` accepts `defaultToolsEnv: ToolsEnvBinding | null` next to `name` and `timezone` ([`AccountUpdateCommandSchema`](../../../src/protocol/commands.ts)). [`AdminStore.updateAccount`](../../../src/store/admin-interface.ts) today takes `patch: { name?: string; timezone?: string }`. Extend that patch with `defaultToolsEnv?: ToolsEnvBinding | null` and write the column. `null` clears it.

- `null` means bots that inherit (no bot pin) are unbound: resolved `enabled` is false, `enabledSource` is `"unbound"`.
- A set object is the account default **on**. Bots and chats that inherit take `enabled: true` from `"account"` and this `envId` unless a more specific level sets `enabled` or `binding`.
- The built-in default is just-bash `jb_default`. Inheriting bots each get their own `bot:<botId>` namespace in that env DO. They do not share a VFS.
- A daemon default names an existing `envId`. Every bot that inherits this default shares that env's folder and its one socket. A bot that needs its own folder gets its own env definition, then pins that `envId`.
- A later env manager from [issue #16](https://github.com/liorm/pi-bot/issues/16) is another `kind` on this same catalog and another backend on `CadmusEnvDO`. This plan does not add that kind.

The family DO does not decrypt D1 on the tool path. `CadmusServices` gains `getAccountDefaultToolsEnv(): ToolsEnvBinding | null` **(new)** in phase 1. The DO caches the binding JSON and the env-definition catalog the way [`AccountCredentialStore`](../../../src/models.ts) caches provider keys. The cache holds `envId` and non-secret columns, never the token. A miss loads `default_tools_env_json` and `cadmus_tools_envs` from D1 (no decrypt). That load is one catalog read, not a per-call decrypt.

`account.update` and `account.toolsEnvs.create` / `update` / `delete` write through one family, the RPC handler. Sibling families are other Durable Objects (`cadmus:${accountId}:${familyId}`), and a cache drop on the handler does not reach them. Fan out the way [`bustAccountCredentialCaches`](../../../src/family-do.ts) does: `adminStore.listFamilies(accountId)`, then `stub.invalidateToolsEnvCatalog()` on every family, including the handler (internal fetch to the DO when the RPC method is not on the stub). The payload includes the previous default `envId` when the default changed, so inheriting bot namespaces can be deleted on the old just-bash env even if that family's cache was cold. Each DO drops its cache and reloads. It does not sync an alarm for tools-env.

Changing the account default rebinds every bot whose pin has no `binding`, and every chat that inherits those bots' binding. When the previous and next `envId` differ, delete the inheriting bot namespace on the previous just-bash env. Chat settings that pin their own `binding` keep their namespace. A bot or chat that is **off** keeps its retained namespace until a later on with the same `envId` reuses it, or until inherit-clear or delete. A daemon default does not delete a folder. When the new default flips resolved `enabled` for an inheriting bot or chat (account binding added or cleared), do not sweep stored conversations. Reconfigure lazily on that conversation's next turn preparation: compare resolved `enabled`, and whether `bot.tools` lists a coding-tool name, to the agent's current extension selection, and apply `AgentChange.extensions` `{ add: [{ name: "coding-tools" }] }` or `{ remove: [{ name: "coding-tools" }] }` only when they differ. `bot.update` and `chat.update` toggles use this same path. They do not `configure` every conversation in the update turn. See [builtin-tools.md](./builtin-tools.md).

---

## Secret storage

Existing BYOK path:

- Table `cadmus_account_credentials` `(account_id, provider_id, cred_type, iv_hex, cipher_hex, updated_at)`.
- `encryptJson` / `decryptJson` with WebCrypto AES-GCM-256; key from `SHA-256("cadmus-byok-v1:" + CADMUS_ENCRYPTION_KEY + ":" + accountId)` in [`src/store/d1-admin.ts`](../../../src/store/d1-admin.ts).
- `CADMUS_ENCRYPTION_KEY` on `Env` ([`src/types.ts`](../../../src/types.ts)).
- List APIs never return plaintext. `AccountCredentialStore` in [`src/models.ts`](../../../src/models.ts) caches decrypted LLM keys in the DO and is busted via `/__internal/credentials/invalidate`.

Do **not** reuse `provider_id` (those ids are `anthropic` / `openai` / `google` / `xai` and feed `createCadmusModels`). Tools-env secrets are a sibling table **(new)**. They are daemon pairing tokens. just-bash has none.

```text
cadmus_tools_env_secrets (
  account_id TEXT NOT NULL,
  secret_id TEXT NOT NULL,     -- opaque id, e.g. hs_<uuid>
  label TEXT,
  kind TEXT NOT NULL,          -- daemon_token
  token_hash TEXT,
  iv_hex TEXT NOT NULL,
  cipher_hex TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, secret_id)
)

CREATE UNIQUE INDEX idx_cadmus_tools_env_secrets_token_hash
  ON cadmus_tools_env_secrets (token_hash);
```

There is no `family_id` on this table. Which bots use a pairing is the `secret_id` on a daemon `cadmus_tools_envs` row, and which bots use an env is `envId` on their `tools_env_json`. The edge learns the account from `token_hash`, then loads the env row. The DO name is `env:<accountId>:<envId>`. Bots are still not in D1.

Reuse the same AES-GCM helpers (extract or duplicate with a distinct KDF prefix `cadmus-tools-env-v1:`). `AdminStore` **(new methods)**: `listToolsEnvSecrets`, `setToolsEnvSecret`, `getToolsEnvSecret`, `deleteToolsEnvSecret`, `resolveToolsEnvDaemonToken` (by `token_hash` → `{ accountId, secretId }`, no plaintext, no family). `getToolsEnvSecret` (decrypt) is not on the daemon path and never a client RPC result.

Plaintext payload: `{ token: string }` for `daemon_token`.

**Authenticate the daemon once, at WebSocket upgrade**, by indexed `token_hash` lookup (SHA-256 of the bearer, then `WHERE token_hash = ?`, the same shape as `resolveToken` on `cadmus_auth_tokens` in [`src/store/d1-admin.ts`](../../../src/store/d1-admin.ts)). Do not decrypt the pairing token on upgrade, on reconnect, or inside `createExecutionEnv`. Per call the family RPCs the env DO. It does not call `getWebSockets` for the daemon.

`account.toolsEnvSecrets.set` mints the token. It does not take a caller-supplied `token`. The value is `cadmus_dt_` plus 64 hex characters from `crypto.getRandomValues` (32 bytes). The row stores `token_hash` and the AES-GCM payload. The set result returns that plaintext once, next to the metadata, and the handler does not log it. List results stay metadata only (`secretId`, `label`, `kind`, `updatedAt`): no token, `iv_hex`, or `cipher_hex`. Upgrade rejects any other bearer shape with `401` before the hash and before D1 ([execution-env.md](./execution-env.md)).

If a `secretId` is deleted, every daemon env whose `secret_id` matches is revoked. The edge calls `revoke` on each of those `CadmusEnvDO`s (phase 3): close the socket (`1008`, reason `Pairing secret revoked`) and CAS-disconnect with `last_error = "secret_missing"` when the generation still matches. In-flight calls, in every family, fail with `env disconnected`. The next tool call throws the offline error until the env is given a new secret or the binding changes. An env that uses a different secret stays up. A just-bash env is unaffected. Clear `defaultToolsEnv` when it names one of the revoked envs. Families are not walked to flip per-bot rows. There is no probe ladder to arm ([reachability.md](./reachability.md)).

The delete runs on the edge against D1. After the D1 delete, the edge still fans `invalidateToolsEnvCatalog` to every family so a cached default that named a revoked env is dropped. It does not add a second internal route beyond the env-DO `revoke` and that existing family cache bust. Phase 2 has no socket acceptor; delete then removes the secret, flags the daemon env rows, and clears the default.

### Future ([issue #16](https://github.com/liorm/pi-bot/issues/16))

A Docker / microVM sandbox manager may need extra secrets (for example registry credentials). Store those as separate `kind` values on `cadmus_tools_env_secrets`, not in the daemon `secretId`. `secretId` stays the daemon pairing token. Decrypt such a secret once, cache it on the env DO, and drop it on secret delete (same idea as `AccountCredentialStore`). This plan does not add those kinds. Workspace confinement for just-bash and the local daemon is `confineToWorkspace` on the env definition, not this issue.

---

## Protocol **(new commands / fields)**

Protocol is TypeBox in [`src/protocol/`](../../../src/protocol/) (commands, records, results, frames), served at `GET /protocol/schema`.

### Extend existing bot RPCs

- `bot.create` payload ([`BotCreateCommandSchema`](../../../src/protocol/commands.ts)): optional `toolsEnv: ToolsEnvSetting` (`Type.Optional(Type.Union([ToolsEnvSettingSchema, Type.Null()]))`). Omitted and `null` both store inherit. The web modal sends `null` for Inherit (account default) on create as well as on update, `{ enabled: false, binding? }` for Off, and `{ enabled: true, binding: { envId } }` for On with a pin.
- `bot.update` payload: optional `toolsEnv: ToolsEnvSetting | null`. Optional `tools`: missing or `null` leaves the stored allowlist unchanged. A string array replaces it. `[]` is an explicit allowlist of zero tools (no gated Cadmus tools, and coding tools are not offered). It does not clear the list back to omitted (`undefined`), which remains the default set. `bot.create` treats omitted `tools` as that default and `[]` as zero gated tools. `bot.update` applies a provided array with `toToolRegs` on the bot's existing conversations and does not pass `tools: null` (pi-durable deletes the agent filter on null, which offers every selected tool).
- `bot.get` / `bot.list` results: include `bot.toolsEnv` (stored setting, no secret material). **(new)** `bot.get` also includes `toolsEnvEnabled`, `toolsEnvEnabledSource`, `effectiveToolsEnv`, `toolsEnvBindingSource`, `toolsEnvStatus`, `toolsEnvConnectedAt`, and `toolsEnvLastError`. Status is omitted when the bot's resolved env is off. For just-bash, status is `connected`. For a daemon, status is the env DO row for the resolved `envId`, not a per-bot copy. It does not roll up a chat that pins a different binding.

`bot.tools` still lists `bash` / `read` / `write` / `edit`. Resolved env **off** removes those four from that conversation regardless of this list. Resolved env **on** still requires the names (or a later per-conversation configure that sees both).

`createBotInternal` and the `bot.update` branch in `executeCommand` apply validation and upsert. A just-bash bind stores `{ envId }` and does not write a family VFS. A daemon bind stores `{ envId }` and does not touch family alarms. Switching the bot to off does not close `CadmusEnvDO`. `createBotInternal` and `createChatInternal` set `AgentChange.extensions` on the new conversation: `{ add: [{ name: "coding-tools" }] }` when `bot.tools` lists a coding-tool name and resolved env is on, otherwise `{ remove: [{ name: "coding-tools" }] }`, together with `toToolRegs` when `bot.tools` is a list. `bot.update` and `chat.update` do not walk stored conversations. They use the same lazy path as `invalidateToolsEnvCatalog` (above): the next turn preparation compares resolved `enabled` and the coding-tool names to that agent's current extension selection and applies `{ add }` or `{ remove }` only when they differ ([builtin-tools.md](./builtin-tools.md)). `toToolRegs` alone does not compose the tools. An inheriting chat follows the bot. A chat with `enabled: false` is `{ remove }` even when `bot.tools` lists the names. A chat with `enabled: true` is `{ add }` when the names are listed. A toggle during an in-flight call does not abort that call (Off, above).

### Chat RPCs

- `chat.create` payload ([`ChatCreateCommandSchema`](../../../src/protocol/commands.ts)): optional `toolsEnv: ToolsEnvSetting`. Omitted means inherit.
- `chat.update` **(new)**: `{ chatKey, toolsEnv: ToolsEnvSetting | null }`. This command sets inherit (`null`), on, or off. Title stays on `chat.rename`. Close stays on `chat.close`.
- `chat.get` / `chat.list`: include `chat.toolsEnv` when a setting is stored. **(new)** `chat.get` also includes `toolsEnvEnabled`, `toolsEnvEnabledSource`, `effectiveToolsEnv` (`EffectiveToolsEnv | null`, no secrets), `toolsEnvBindingSource`, and `toolsEnvStatus` of the env that resolved (omitted when enabled is false). `chat.list` does not repeat the resolved fields.

`createChatInternal` accepts the same optional binding, writes the chat row, and inserts `cadmus_chat_conversations` for the new conversation id. Schedules that call `services.createChat` ([`src/schedules.ts`](../../../src/schedules.ts) `new-chat`) pass no override, so the new chat inherits the bot default.

`ChatStore.deleteChat` deletes `cadmus_chat_conversations` for that key. The family command handler also RPCs `deleteNamespace` for `chat:<key>` when the chat's resolved env is just-bash. `SqliteBotStore.deleteBot` does not delete chats today and does not delete env-DO rows. The family command handler RPCs `deleteNamespacesForBot` as [workspace-persistence.md](./workspace-persistence.md) describes, and deletes conversation-map rows for that `bot_id`. It does not close a daemon socket.

### Account-level RPCs **(new)**

| Command | Result |
| :--- | :--- |
| `account.toolsEnvs.list` | Catalog plus `default`. Every row, including `jb_default`. No token. Phase 1 includes just-bash `connection`. Phase 3 includes daemon `connection`. |
| `account.toolsEnvs.create` / `.update` / `.delete` | Write `cadmus_tools_envs`. just-bash in phase 1. Daemon rows in phase 2. Delete drops env-DO storage. Phase 3 delete also revokes a daemon socket. |
| `account.toolsEnvSecrets.list` | `{ secrets: { secretId, label, kind, updatedAt }[] }` (phase 2) |
| `account.toolsEnvSecrets.set` | `{ secret: { secretId, label, kind, updatedAt }, token }` — mints `cadmus_dt_` + 64 hex, returns `token` once, stores hash and ciphertext on the account. No caller-supplied `token`. |
| `account.toolsEnvSecrets.delete` | `{ deleted: secretId }` |

`account.toolsEnvs.list` is the query surface for the UI and for anything that needs to offer an env id. `account.toolsEnvSecrets.*` is the write path for daemon pairing material. A future Docker / microVM manager kind is another entry on `account.toolsEnvs.list` ([issue #16](https://github.com/liorm/pi-bot/issues/16)). This plan's list has `just-bash` and `local-daemon` rows only.

Owner role only, same as `account.credentials.set` (membership `role` on `cadmus_account_members`). Do not reuse `AccountEventSchema`: it requires `providerId`, and its `action` union is only `credential.set`, `credential.deleted`, and `credential.refreshed` ([`src/protocol/frames.ts`](../../../src/protocol/frames.ts)). Add a `ServerFrame` variant:

```ts
{ type: "account.tools_env_secret", payload: { accountId, secretId, action: "set" | "deleted", when } }
```

No token in the event.

### Daemon pairing

The daemon does not use `ClientCommand` and does not pass `authenticateRequest`. It presents the raw pairing token on:

`GET /tools-env/ws?envId=<envId>`

`Authorization: Bearer <token>`.

Edge checks the bearer shape, then hashes the token and loads `account_id` and `secret_id` from `cadmus_tools_env_secrets` (`token_hash`, `kind = daemon_token`). The account comes from that row, not from a client header. `envId` must be a `cadmus_tools_envs` row for that account whose `kind` is `local-daemon` and whose `secret_id` matches (`404` / `403`). A just-bash `envId` is `404` on this route. The forward deletes inbound `X-Cadmus-*` headers and sets `X-Cadmus-Tools-Env-Secret-Id` from the token row. It then copies `X-Cadmus-Env-Capabilities: confinement` only when the daemon's upgrade request listed that token. The env DO compares the header to the env definition before `acceptWebSocket`. `409` when `confineToWorkspace` is true and the copied capability header lacks `confinement` (`last_error = "confinement_unavailable"` only when no socket is connected). A missing, malformed, or unknown token is `401`. A request that is not a WebSocket upgrade is `426`. There is no per-bot URL and no per-chat URL. The same token may be used by every daemon env that names that `secretId`. Details of the route are in [execution-env.md](./execution-env.md).

The UI shows that URL once, on the daemon env, not on each bot. The token is shown as an account pairing, reusable across daemon envs that share it. The daemon's backoff on `409` stops until config changes.

---

## UI

### Web

`BotModal` in [`web/src/components/BotDirectory.tsx`](../../../web/src/components/BotDirectory.tsx) today submits `name`, `slug`, `model`, `thinking`, comma-separated `tools`, `soul` via `bot.create` / `bot.update`. Add the **bot tools env**:

- Tri-state toggle: **Inherit** / **On** / **Off**. Inherit sends `toolsEnv: null`. Off sends `{ enabled: false }` and keeps any existing `binding` so On restores it. On sends `{ enabled: true, binding? }` (`binding` omitted uses the account default `envId`).
- Env select when On (or shown read-only when Off with a retained `envId`): an existing catalog row, just-bash or local-daemon. Hidden on Inherit. The select lists `account.toolsEnvs.list` (account-wide, not this family). It does not offer an inline just-bash with `persist` on the bot.
- `persist`, `confineToWorkspace`, and `sharedWorkspace` are edited on the env definition ("Create env" / env settings), not on the bot. just-bash confinement is shown read-only on. Daemon confinement is the env's flag.
- A checkbox that adds `bash`, `read`, `write`, and `edit` to the existing tools field. Default off. On create, a blank field with the box off omits `tools` (the default set; coding tools stay opt-in). On edit, the modal sends the resulting name list. Unchecking the box with no other names sends `[]`, an explicit empty allowlist, never `null`. The checkbox is bot-level. Env Off still hides the four tools on inheriting chats even when this box is checked. Env On still requires the box (or an explicit `tools` list).
- "Create env" for just-bash collects `label`, `persist`, and `sharedWorkspace`. "Create env" for a daemon collects `workspacePath`, `persist`, `confineToWorkspace`, and a pairing token (`account.toolsEnvSecrets.set`, token shown **once**). The dial URL is a property of the daemon env (`?envId=`), not of the bot.
- Read-only line: effective On/Off and where it came from (`toolsEnvEnabledSource`), effective kind, `envId`, and `toolsEnvBindingSource`, and the derived connection (`connected` / `disconnected`, `connectedAt`, `lastError`) from `bot.get`. just-bash shows `connected` with no timestamp from phase 1. Daemon connection is phase 3. No badge when effective Off. No next-probe field.

`NewChatModal` in [`web/src/components/ChatWorkspace.tsx`](../../../web/src/components/ChatWorkspace.tsx) today submits `botId`, `title`, `key`, `thinking` via `chat.create`. Add the same **Inherit / On / Off** toggle. Inherit omits `toolsEnv`. On with a pin selects an existing `envId`. On with no pin inherits the bot/account config. The open chat header shows the stored toggle, the effective On/Off and source, the effective kind, `envId`, and binding source, and the derived connection, hidden when Off. Changing it later calls `chat.update`.

Account settings (the same surface as `account.update` for name and timezone) edit `defaultToolsEnv` and list `account.toolsEnvs.list`. The choices are any catalog env, or none. The built-in `jb_default` is the initial selection. None is `null` (inheriting bots unbound). A Docker / microVM manager that spawns an env per bot or per tool call is a later choice on this same control ([issue #16](https://github.com/liorm/pi-bot/issues/16)). Account has no Inherit/Off toggle of its own.

### TUI (`tui/src/index.ts`)

`:bot new <slug> <name> [model]` has no tools or tools-env flags. Add a later `:bot tools-env` command for Inherit / On / Off plus an `envId`, and `:chat tools-env` for the same at chat level, or extend `bot new` / chat create. TUI must keep importing only `import type` from `src/protocol.ts` (standalone package rule). New protocol types flow through that type-only import.

`/status` text from the DO already prints tools and next wake. Include the nested `/status` `toolsEnv` object (enabled, enabledSource, kind, envId, bindingSource, status, connectedAt, lastError) so the TUI gets it without a dedicated parser if needed. That text is not the flattened `bot.get` / `chat.get` fields. There is no next-probe time.

---

## `create_bot` tool

[`internalToolsExtension`](../../../src/extensions/internal-tools.ts) `create_bot` passes `slug`, `name`, `model`, `thinking`, `tools`, `soul`, `memory`. Add an optional `toolsEnv` argument of `ToolsEnvSetting`. The tool stays `replay: "safe"` and still memos the created record. `tools` follows `bot.create`: omitted is the default set, and `[]` is zero gated tools. The tool has no `bot.update` path.

- Omitted: store `toolsEnv` null. The new bot inherits the account default at call time. It does not copy that default onto the row, so a later account change applies to it. After account create, that default is `jb_default`.
- `{ enabled: false, binding? }`: pin off. `binding` may name an existing `envId` for later On.
- `{ enabled: true, binding: { envId } }`: pin on. `{ enabled: true }` with no `binding` is valid only when the account default is set; otherwise `tools_env_on_without_config`.
- `envId` must already be on the account. The tool does not mint a token, does not create an env, and rejects `token` / `password` / `apiKey` / `kind` / `workspacePath` / `secretId` / `persist` / `confineToWorkspace` / `sharedWorkspace` on the binding.
- Validation runs in `createBotInternal`. That function already reads `AdminStore` for the account timezone (`getAccount` in [`src/family-do.ts`](../../../src/family-do.ts)), on `bot.create` and on the `create_bot` tool. Confirming `envId` is that same catalog read: the row exists on this account, nothing is decrypted, and the tool result does not contain the token. The `env` callback does not take this path ([execution-env.md](./execution-env.md)). A pin is stored only after the id checks out. A deleted env fails later calls with the offline error; create does not accept an unknown id.

`message_bot` creates the peer chat through `services.createChat` with no tools env. That chat inherits the peer bot, then the account default.
