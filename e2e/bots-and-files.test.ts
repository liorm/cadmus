import { describe, expect, it } from "vitest";
import type { ChatRecord } from "../src/protocol.js";
import { sendRpc } from "./helpers.js";

describe("Bots, Virtual Files (SOUL.md, MEMORY.md, knowledge/<slug>.md), CAS & Tool Gate", () => {
	it("manages bot lifecycle and enforces CAS, size limits, and frontmatter rules on MEMORY.md and knowledge/<slug>.md", async () => {
		const scope = { accountId: "acct-files", familyId: "default" };

		// 1. Create bot with initial soul, memory, and knowledge
		const createRes = await sendRpc(
			"bot.create",
			{
				slug: "scribe",
				name: "Scribe",
				model: "faux/echo",
				thinking: "off",
				soul: "You are Scribe, keeper of records.",
				memory: "- Prefer concise bullet points.",
				knowledge: [
					{
						slug: "architecture",
						description: "Cloudflare DO + D1 architecture overview",
						category: "design",
						body: "# Cadmus V2\nRuns on Cloudflare Workers and Durable Objects.",
					},
				],
			},
			scope,
		);
		expect(createRes.status).toBe(200);
		expect(createRes.frame.result?.bot.id).toBe("scribe");

		// 2. Read SOUL.md, MEMORY.md, and knowledge/architecture.md
		const soulRead = await sendRpc<{ content: string }>(
			"file.read",
			{ botId: "scribe", path: "SOUL.md" },
			scope,
		);
		expect(soulRead.frame.result?.content).toContain("keeper of records");

		const memRead = await sendRpc<{ content: string; version: number }>(
			"file.read",
			{ botId: "scribe", path: "MEMORY.md" },
			scope,
		);
		expect(memRead.frame.result?.version).toBe(1);
		expect(memRead.frame.result?.content).toBe(
			"- Prefer concise bullet points.",
		);

		const kRead = await sendRpc<{
			version: number;
			description: string;
			category?: string;
			body: string;
		}>(
			"file.read",
			{ botId: "scribe", path: "knowledge/architecture.md" },
			scope,
		);
		expect(kRead.frame.result?.version).toBe(1);
		expect(kRead.frame.result?.category).toBe("design");
		expect(kRead.frame.result?.body).toContain("# Cadmus V2");

		// 3. Enforce CAS on MEMORY.md: stale expectedVersion (0 instead of 1) must fail with cas_conflict
		const staleMem = await sendRpc(
			"file.write",
			{
				botId: "scribe",
				path: "MEMORY.md",
				content: "Stale write",
				expectedVersion: 0,
			},
			scope,
		);
		expect(staleMem.status).toBe(400);
		expect(staleMem.frame.ok).toBe(false);
		expect(staleMem.frame.error?.code).toBe("cas_conflict");

		// 4. Correct expectedVersion (1) succeeds and increments version to 2
		const goodMem = await sendRpc<{ version: number }>(
			"file.write",
			{
				botId: "scribe",
				path: "MEMORY.md",
				content: "- Updated standing memory",
				expectedVersion: 1,
			},
			scope,
		);
		expect(goodMem.status).toBe(200);
		expect(goodMem.frame.result?.version).toBe(2);

		// 5. Reject MEMORY.md > 8192 bytes or starting with ---
		const frontmatterMem = await sendRpc(
			"file.write",
			{
				botId: "scribe",
				path: "MEMORY.md",
				content: "---\ntitle: bad\n---\nbody",
				expectedVersion: 2,
			},
			scope,
		);
		expect(frontmatterMem.status).toBe(400);

		const hugeMem = await sendRpc(
			"file.write",
			{
				botId: "scribe",
				path: "MEMORY.md",
				content: "x".repeat(8200),
				expectedVersion: 2,
			},
			scope,
		);
		expect(hugeMem.status).toBe(400);

		// 6. Enforce CAS on knowledge/architecture.md
		const staleKnow = await sendRpc(
			"file.write",
			{
				botId: "scribe",
				path: "knowledge/architecture.md",
				description: "Updated desc",
				body: "New body",
				expectedVersion: 0,
			},
			scope,
		);
		expect(staleKnow.status).toBe(400);
		expect(staleKnow.frame.error?.code).toBe("cas_conflict");

		const goodKnow = await sendRpc<{ version: number }>(
			"file.write",
			{
				botId: "scribe",
				path: "knowledge/architecture.md",
				description: "Updated architecture overview",
				category: "design",
				body: "# Cadmus V2\nUpdated body with Durable Objects.",
				expectedVersion: 1,
			},
			scope,
		);
		expect(goodKnow.status).toBe(200);
		expect(goodKnow.frame.result?.version).toBe(2);

		// 7. Search knowledge
		const searchRes = await sendRpc<{
			results: { slug: string; version: number; snippet: string }[];
		}>(
			"knowledge.search",
			{ botId: "scribe", query: "Durable Objects", category: "design" },
			scope,
		);
		expect(searchRes.status).toBe(200);
		expect(searchRes.frame.result?.results).toHaveLength(1);
		expect(searchRes.frame.result?.results[0]?.slug).toBe("architecture");
	});

	it("executes knowledge and memory tools during a turn and enforces per-bot tool-gate policy", async () => {
		const scope = { accountId: "acct-toolgate", familyId: "default" };

		// Create a bot restricted to ONLY `memory_read` (disallowing `memory_update`)
		await sendRpc(
			"bot.create",
			{
				slug: "reader-only",
				name: "Reader Only",
				model: "faux/echo",
				tools: ["memory_read"],
			},
			scope,
		);

		const chatRes = await sendRpc<{ chat: ChatRecord }>(
			"chat.create",
			{ botId: "reader-only", key: "reader-chat" },
			scope,
		);
		expect(chatRes.status).toBe(200);

		// Attempt to call `memory_update` via tool directive: tool-gate must block it!
		const blockedTurn = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "reader-chat",
				text: 'Try updating memory [tool:memory_update {"content":"secret","expectedVersion":0}]',
			},
			scope,
		);
		expect(blockedTurn.status).toBe(200);
		expect(blockedTurn.frame.result?.reply).toContain(
			"Tool memory_update is not available",
		);

		// Verify MEMORY.md was not modified (still version 0)
		const memAfterBlocked = await sendRpc<{ version: number; content: string }>(
			"file.read",
			{ botId: "reader-only", path: "MEMORY.md" },
			scope,
		);
		expect(memAfterBlocked.frame.result?.version).toBe(0);

		// Now enable `memory_update` via `bot.update` and re-run
		await sendRpc(
			"bot.update",
			{
				botId: "reader-only",
				tools: ["memory_read", "memory_update"],
			},
			scope,
		);

		const allowedTurn = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "reader-chat",
				text: 'Now update memory [tool:memory_update {"content":"Allowed memory line","expectedVersion":0}]',
			},
			scope,
		);
		expect(allowedTurn.status).toBe(200);
		expect(allowedTurn.frame.result?.reply).toContain('"version":1');

		const memAfterAllowed = await sendRpc<{ version: number; content: string }>(
			"file.read",
			{ botId: "reader-only", path: "MEMORY.md" },
			scope,
		);
		expect(memAfterAllowed.frame.result?.version).toBe(1);
		expect(memAfterAllowed.frame.result?.content).toBe("Allowed memory line");
	});
});
