---
name: debug-session
description: >-
  Inspect, debug, and query local and cloud bot sessions (production and preview environments),
  virtual files, and conversations. Use when asked to inspect a bot, chat session, MEMORY.md,
  knowledge files, SOUL.md, or transcript tool calls from the local DO database or remote
  cloud environments (cadmus.purelogicstudios.com, *-cadmus.pure-logic-studios.workers.dev).
---

# Debug Session Skill

This skill provides procedures and a dedicated executable helper to inspect and debug local and remote cloud bot sessions in Cadmus (`cadmus`).

## Architecture & Storage Context

- **Local Storage**:
  - **Durable Object SQLite** (`.wrangler/state/v3/do/cadmus-CadmusBotFamilyDO/*.sqlite`): Holds all bot domain entities—bots, souls (`SOUL.md`), memories (`MEMORY.md`), knowledge (`knowledge/*.md`), chats (`cadmus_chats`), and pi-durable conversation transcripts (`cadmus_pi_entries`).
  - **D1** (`.wrangler/state/v3/d1/...`): Holds global admin accounts, auth tokens, and encrypted credentials only. Never look in D1 for bot files or conversation entries.
- **Cloud Storage & Endpoints**:
  - **Production Endpoint**: `https://cadmus.purelogicstudios.com`
  - **Preview Endpoints**: `https://<branch>-cadmus.pure-logic-studios.workers.dev` (e.g. `https://feat-chat-cadmus.pure-logic-studios.workers.dev`)
  - **Cloudflare Worker Name**: When running Wrangler CLI commands, the worker is named **`cadmus`** (e.g. `wrangler tail cadmus`).
  - **Remote DO Inspection**: Cloud DO SQLite files are not accessed directly by raw file read; remote inspection operates over the authenticated JSON-RPC protocol (`POST /rpc` with `bot.list`, `chat.list`, `file.read`, `chat.entries`).
- **Bot Scoping**: Memory (`MEMORY.md`) is scoped strictly per `bot_id`, not shared family-wide.
- **WAL Mode**: Local DO SQLite uses Write-Ahead Logging (`.sqlite-wal`). Direct database queries must open the database file allowing SQLite to read the active WAL.

---

## Executable Helper Script

The skill includes a pre-built TypeScript helper running with Bun:
[`scripts/debug-session.ts`](./scripts/debug-session.ts)

It automatically switches between **Local SQLite DO** mode (when local `.wrangler` state exists) and **Remote Cloud** mode (when `--prod`, `--preview`, or `--url` is specified).

### 1. Cloud Session Commands

#### Production (`https://cadmus.purelogicstudios.com`)
```bash
# List all bots and chats in cloud production:
bun .agents/skills/debug-session/scripts/debug-session.ts list --prod

# General bot/chat summary:
bun .agents/skills/debug-session/scripts/debug-session.ts <botId|chatKey> --prod

# Read MEMORY.md:
bun .agents/skills/debug-session/scripts/debug-session.ts <botId> memory --prod

# Read knowledge files:
bun .agents/skills/debug-session/scripts/debug-session.ts <botId> knowledge --prod
bun .agents/skills/debug-session/scripts/debug-session.ts <botId> knowledge <slug> --prod

# Read SOUL.md:
bun .agents/skills/debug-session/scripts/debug-session.ts <botId> soul --prod

# Read conversation transcript:
bun .agents/skills/debug-session/scripts/debug-session.ts <chatKey|botId> conversation --prod

# Search transcript:
bun .agents/skills/debug-session/scripts/debug-session.ts <chatKey|botId> --search "memory_update" --prod
```

#### Branch Previews (`https://<branch>-cadmus.pure-logic-studios.workers.dev`)
```bash
# List bots and chats in a branch preview:
bun .agents/skills/debug-session/scripts/debug-session.ts list --preview <branch>
# (or short flag -p):
bun .agents/skills/debug-session/scripts/debug-session.ts list -p <branch>

# Inspect bot/chat on a preview:
bun .agents/skills/debug-session/scripts/debug-session.ts <botId|chatKey> -p <branch>

# Transcript on a preview:
bun .agents/skills/debug-session/scripts/debug-session.ts <chatKey|botId> conversation -p <branch>
```

#### Explicit Custom URL
```bash
bun .agents/skills/debug-session/scripts/debug-session.ts list --url https://cadmus.purelogicstudios.com
```

#### Authentication & Access Flags
- `--token <token>`: Bearer token (default: `CADMUS_TOKEN`). There is no default secret.
- `--account <id>`: Account ID header (default: `CADMUS_ACCOUNT_ID` or `default-account`).
- `--family <id>`: Family ID header (default: `CADMUS_FAMILY_ID` or `default`).
- **Cloudflare Access**: If the remote domain is behind Cloudflare Access:
  - Service token: `--cf-client-id <id> --cf-client-secret <secret>` (or `CF_ACCESS_CLIENT_ID` / `CF_ACCESS_CLIENT_SECRET` env).
  - Session cookie: `--cookie "CF_Authorization=..."` (or `CF_AUTHORIZATION` env).

---

### 2. Local Session Commands

When no `--prod`, `--preview`, or `--url` is specified, the helper automatically defaults to inspecting local DO SQLite state:

```bash
# 1. List all bots and chats in the local family
bun .agents/skills/debug-session/scripts/debug-session.ts list

# 2. General summary of a bot or chat (memory preview, knowledge files, chats)
bun .agents/skills/debug-session/scripts/debug-session.ts <botId|chatKey>
# Examples:
bun .agents/skills/debug-session/scripts/debug-session.ts xai3
bun .agents/skills/debug-session/scripts/debug-session.ts xai3:43e02030

# 3. Query MEMORY.md
bun .agents/skills/debug-session/scripts/debug-session.ts <botId|chatKey> memory
# Output as JSON:
bun .agents/skills/debug-session/scripts/debug-session.ts <botId|chatKey> memory --json

# 4. Query Knowledge Files
# List all knowledge files:
bun .agents/skills/debug-session/scripts/debug-session.ts <botId|chatKey> knowledge
# Read a specific knowledge file:
bun .agents/skills/debug-session/scripts/debug-session.ts <botId|chatKey> knowledge <slug>

# 5. Query SOUL.md
bun .agents/skills/debug-session/scripts/debug-session.ts <botId|chatKey> soul

# 6. Read Conversation Transcript
bun .agents/skills/debug-session/scripts/debug-session.ts <chatKey|botId> conversation

# 7. Search / Filter Conversation turns
bun .agents/skills/debug-session/scripts/debug-session.ts <chatKey|botId> --search "israel"
bun .agents/skills/debug-session/scripts/debug-session.ts <chatKey|botId> --search "memory_update"
```

---

## Wrangler CLI Inspection (Worker: `cadmus`)

When debugging live Cloudflare Worker runtime behavior, note that the worker is named **`cadmus`**:

```bash
# 1. Stream real-time Worker logs from Cloudflare:
wrangler tail cadmus

# 2. Stream logs from a specific Preview branch:
wrangler tail cadmus --preview <branch>

# 3. List deployments:
wrangler deployments list cadmus

# 4. Query remote D1 databases:
# Production D1:
wrangler d1 execute cadmus-admin --remote --command "SELECT id, name, created_at FROM cadmus_accounts;"
# Preview D1:
wrangler d1 execute cadmus-admin-staging --remote --command "SELECT id, name, created_at FROM cadmus_accounts;"
```

---

## Direct SQLite Inspection (Local Only)

If low-level manual inspection using `bun:sqlite` is desired for local DO SQLite:

```typescript
import { Database } from "bun:sqlite";

// Automatically pick the primary family DO database:
const db = new Database("./.wrangler/state/v3/do/cadmus-CadmusBotFamilyDO/0616a7cc0ebf600c3b3bffef1392bb206406c24fa73a83a7fed1051691d1a0fa.sqlite");

// Check MEMORY.md for a bot
console.log(db.query("SELECT * FROM cadmus_bot_memories WHERE bot_id = ?").get("xai3"));

// Check knowledge files
console.log(db.query("SELECT slug, description, category, version FROM cadmus_bot_knowledge WHERE bot_id = ?").all("xai3"));

// Check chat metadata
console.log(db.query("SELECT * FROM cadmus_chats WHERE key = ?").get("xai3:43e02030"));

// Check pi-durable conversation entries
console.log(db.query("SELECT id, record FROM cadmus_pi_entries WHERE conversation_id = ? ORDER BY id ASC").all(247));
```

---

## Verifying Memory & Knowledge Tool Execution

When debugging why a tool like `memory_update` or `knowledge_update` did or did not update a file:

1. **Verify Tool Call & Result in Transcript**:
   Check if the assistant actually invoked the tool and inspect the return value:
   `bun .agents/skills/debug-session/scripts/debug-session.ts <chatKey> --search "memory_update" [--prod | -p <branch>]`
   - A success result looks like: `{"version": 1, "bytes": 21}`.
   - An error result contains an error message (e.g. CAS conflict or size violation).
2. **Check CAS Versioning**:
   If `expectedVersion` does not match the current version in `cadmus_bot_memories` or `cadmus_bot_knowledge`, the CAS update fails with `CasConflictError`.
3. **Check Injected System Prompt**:
   In the turn immediately following an update, pi-durable injects updated system prompt sections:
   `bun .agents/skills/debug-session/scripts/debug-session.ts <chatKey> --search "SYSTEM INJECT" [--prod | -p <branch>]`
