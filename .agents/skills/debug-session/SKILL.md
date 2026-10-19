---
name: debug-session
description: >-
  Inspect, debug, and query local bot sessions, virtual files, and conversations.
  Use when asked to inspect a bot, chat session, MEMORY.md, knowledge files,
  SOUL.md, or transcript tool calls from the local Durable Object database.
---

# Debug Session Skill

This skill provides procedures and a dedicated executable helper to inspect and debug local bot sessions in Cadmus (`cadmus`).

## Architecture & Storage Context

- **Two-Tier Storage**:
  - **Durable Object SQLite** (`.wrangler/state/v3/do/cadmus-CadmusBotFamilyDO/*.sqlite`): Holds all bot domain entities—bots, souls (`SOUL.md`), memories (`MEMORY.md`), knowledge (`knowledge/*.md`), chats (`cadmus_chats`), and pi-durable conversation transcripts (`cadmus_pi_entries`).
  - **D1** (`.wrangler/state/v3/d1/...`): Holds global admin accounts, auth tokens, and encrypted credentials only. Never look in D1 for bot files or conversation entries.
- **Bot Scoping**: Memory (`MEMORY.md`) is scoped strictly per `bot_id`, not shared family-wide.
- **WAL Mode**: DO SQLite uses Write-Ahead Logging (`.sqlite-wal`). Direct database queries must open the database file allowing SQLite to read the active WAL.

---

## Executable Helper Script

The skill includes a pre-built TypeScript helper running with Bun:
[`scripts/debug-session.ts`](./scripts/debug-session.ts)

### Common Commands

```bash
# 1. List all bots and chats in the family
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
# Dumps formatted conversation turns with user messages, assistant responses,
# tool calls (arguments), tool results, and system prompt injections:
bun .agents/skills/debug-session/scripts/debug-session.ts <chatKey|botId> conversation

# 7. Search / Ask about Conversation turns
# Filters conversation entries matching a keyword or phrase:
bun .agents/skills/debug-session/scripts/debug-session.ts <chatKey|botId> --search "israel"
bun .agents/skills/debug-session/scripts/debug-session.ts <chatKey|botId> --search "memory_update"
```

---

## Direct SQLite Inspection (Alternative / Low-Level)

If manual inspection using `bun:sqlite` is desired:

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
   `bun .agents/skills/debug-session/scripts/debug-session.ts <chatKey> --search "memory_update"`
   - A success result looks like: `{"version": 1, "bytes": 21}`.
   - An error result contains an error message (e.g. CAS conflict or size violation).
2. **Check CAS Versioning**:
   If `expectedVersion` does not match the current version in `cadmus_bot_memories` or `cadmus_bot_knowledge`, the CAS update fails with `CasConflictError`.
3. **Check Injected System Prompt**:
   In the turn immediately following an update, pi-durable injects updated system prompt sections:
   `bun .agents/skills/debug-session/scripts/debug-session.ts <chatKey> --search "SYSTEM INJECT"`
