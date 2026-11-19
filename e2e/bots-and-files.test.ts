import { describe, expect, it } from "vitest";
import {
	adminScope,
	type ChatRecord,
	type HarvestNote,
	sendRpc,
	useWorkerFixture,
} from "./helpers.js";

describe("Bots, Virtual Files (SOUL.md, MEMORY.md, knowledge/<slug>.md), CAS & Tool Gate", () => {
	useWorkerFixture();

	it("manages bot lifecycle and enforces CAS, size limits, and frontmatter rules on MEMORY.md and knowledge/<slug>.md", async () => {
		const scope = await adminScope("default");

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
		const scope = await adminScope("default");

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

	it("cascade-deletes chats and schedules on bot.delete so a recreated bot with the same slug starts clean", async () => {
		const scope = await adminScope("default");

		await sendRpc("family.update", { harvestDelayMs: 5000 }, scope);

		// 1. Create bot "scribe" and a peer bot "helper"
		await sendRpc(
			"bot.create",
			{
				slug: "scribe",
				name: "Scribe V1",
				model: "faux/echo",
			},
			scope,
		);
		await sendRpc(
			"bot.create",
			{
				slug: "helper",
				name: "Helper",
				model: "faux/echo",
			},
			scope,
		);

		// 2. Create chats for "scribe" and submit a turn that arms harvest + peer message
		const firstChatRes = await sendRpc<{ chat: ChatRecord }>(
			"chat.create",
			{ botId: "scribe", key: "scribe-chat-1", title: "Old Scribe Chat" },
			scope,
		);
		expect(firstChatRes.status).toBe(200);
		const oldConversationId = firstChatRes.frame.result?.chat.conversationId;

		await sendRpc(
			"chat.create",
			{ botId: "scribe", key: "scribe-chat-2" },
			scope,
		);

		await sendRpc(
			"turn.submit",
			{
				chatKey: "scribe-chat-1",
				text: `Hello V1 [remember: Scribe V1 secret fact] [tool:message_bot ${JSON.stringify(
					{
						botId: "helper",
						topic: "ping",
						text: '[[group-reply]][tool:end_conversation {"response":"pong"}][[/group-reply]]',
					},
				)}]`,
			},
			scope,
		);

		// Create a recurring schedule for "scribe"
		await sendRpc(
			"schedule.create",
			{
				id: "scribe-cron",
				botId: "scribe",
				kind: "cron",
				input: "0 9 * * *",
				text: "Morning check",
				target: { mode: "chat", chatKey: "scribe-chat-1" },
			},
			scope,
		);

		// 3. Delete bot "scribe"
		const delRes = await sendRpc("bot.delete", { botId: "scribe" }, scope);
		expect(delRes.status).toBe(200);

		// Verify all chats of "scribe" (and peer chats initiated by "scribe") are deleted
		const chatsAfterDelete = await sendRpc<{ chats: ChatRecord[] }>(
			"chat.list",
			{ botId: "scribe" },
			scope,
		);
		expect(chatsAfterDelete.frame.result?.chats).toEqual([]);

		const allChatsAfterDelete = await sendRpc<{ chats: ChatRecord[] }>(
			"chat.list",
			{},
			scope,
		);
		expect(allChatsAfterDelete.frame.result?.chats).toEqual([]);

		const deletedChatGet = await sendRpc(
			"chat.get",
			{ chatKey: "scribe-chat-1" },
			scope,
		);
		expect(deletedChatGet.status).toBe(400);
		expect(deletedChatGet.frame.error?.code).toBe("not_found");

		// 4. Recreate bot with the exact same slug "scribe"
		const recreateRes = await sendRpc(
			"bot.create",
			{
				slug: "scribe",
				name: "Scribe V2",
				model: "faux/echo",
			},
			scope,
		);
		expect(recreateRes.status).toBe(200);

		// Recreated bot must have 0 chats
		const chatsAfterRecreate = await sendRpc<{ chats: ChatRecord[] }>(
			"chat.list",
			{ botId: "scribe" },
			scope,
		);
		expect(chatsAfterRecreate.frame.result?.chats).toEqual([]);

		// Creating a chat with the same key "scribe-chat-1" must create a brand new chat with empty transcript & 0 harvest watermark/notes
		const recreatedChatRes = await sendRpc<{ chat: ChatRecord }>(
			"chat.create",
			{ botId: "scribe", key: "scribe-chat-1", title: "New Scribe Chat" },
			scope,
		);
		expect(recreatedChatRes.status).toBe(200);
		expect(recreatedChatRes.frame.result?.chat.conversationId).not.toBe(
			oldConversationId,
		);
		expect(recreatedChatRes.frame.result?.chat.title).toBe("New Scribe Chat");

		const freshChatGet = await sendRpc<{
			chat: ChatRecord;
			messages: unknown[];
			entries: unknown[];
			notes: HarvestNote[];
		}>("chat.get", { chatKey: "scribe-chat-1" }, scope);
		expect(freshChatGet.status).toBe(200);
		expect(freshChatGet.frame.result?.messages).toEqual([]);
		expect(freshChatGet.frame.result?.notes).toEqual([]);

		const statusRes = await sendRpc<{
			status: { harvestWatermark: number; entryCount: number };
		}>("chat.status", { chatKey: "scribe-chat-1" }, scope);
		expect(statusRes.status).toBe(200);
		expect(statusRes.frame.result?.status.harvestWatermark).toBe(0);
		expect(statusRes.frame.result?.status.entryCount).toBe(0);
	});

	it("enforces strict chat-to-bot ownership across chat.create, schedule.create, schedule.update, schedule_create, and message_bot", async () => {
		const scope = await adminScope("default");

		await sendRpc(
			"bot.create",
			{ slug: "alpha", name: "Alpha", model: "faux/echo" },
			scope,
		);
		await sendRpc(
			"bot.create",
			{ slug: "beta", name: "Beta", model: "faux/echo" },
			scope,
		);

		// Create "alpha-chat" owned by "alpha"
		const alphaChat = await sendRpc<{ chat: ChatRecord }>(
			"chat.create",
			{ botId: "alpha", key: "alpha-chat" },
			scope,
		);
		expect(alphaChat.status).toBe(200);
		expect(alphaChat.frame.result?.chat.botId).toBe("alpha");

		// 1. Calling chat.create for "beta" with key "alpha-chat" must fail with conflict
		const crossChatCreate = await sendRpc(
			"chat.create",
			{ botId: "beta", key: "alpha-chat" },
			scope,
		);
		expect(crossChatCreate.status).toBe(400);
		expect(crossChatCreate.frame.ok).toBe(false);
		expect(crossChatCreate.frame.error?.code).toBe("conflict");

		// 2. Calling schedule.create for "beta" targeting "alpha-chat" (mode: "chat" and mode: "fork") must fail with conflict
		const crossSchedChat = await sendRpc(
			"schedule.create",
			{
				botId: "beta",
				kind: "relative",
				input: "10m",
				text: "Intrude",
				target: { mode: "chat", chatKey: "alpha-chat" },
			},
			scope,
		);
		expect(crossSchedChat.status).toBe(400);
		expect(crossSchedChat.frame.error?.code).toBe("conflict");

		const crossSchedFork = await sendRpc(
			"schedule.create",
			{
				botId: "beta",
				kind: "relative",
				input: "10m",
				text: "Intrude fork",
				target: { mode: "fork", chatKey: "alpha-chat" },
			},
			scope,
		);
		expect(crossSchedFork.status).toBe(400);
		expect(crossSchedFork.frame.error?.code).toBe("conflict");

		// 3. Calling schedule.update to retarget a "beta" schedule onto "alpha-chat" must fail with conflict
		const validBetaSched = await sendRpc<{ schedule: { id: string } }>(
			"schedule.create",
			{
				id: "beta-sched",
				botId: "beta",
				kind: "relative",
				input: "10m",
				text: "Valid",
				target: { mode: "new-chat" },
			},
			scope,
		);
		expect(validBetaSched.status).toBe(200);

		const crossSchedUpdate = await sendRpc(
			"schedule.update",
			{
				id: "beta-sched",
				target: { mode: "chat", chatKey: "alpha-chat" },
			},
			scope,
		);
		expect(crossSchedUpdate.status).toBe(400);
		expect(crossSchedUpdate.frame.error?.code).toBe("conflict");

		// 4. Agent tools schedule_create and message_bot must reject cross-bot chat keys
		await sendRpc("chat.create", { botId: "beta", key: "beta-chat" }, scope);

		const badScheduleToolTurn = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "beta-chat",
				text: 'Schedule on alpha chat [tool:schedule_create {"kind":"relative","input":"5m","text":"hi","target":{"mode":"chat","chatKey":"alpha-chat"}}]',
			},
			scope,
		);
		expect(badScheduleToolTurn.status).toBe(200);
		expect(badScheduleToolTurn.frame.result?.reply).toContain(
			"Chat 'alpha-chat' belongs to bot 'alpha', not 'beta'",
		);

		const badMessageBotTurn = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "alpha-chat",
				text: 'Message beta using alpha-chat [tool:message_bot {"botId":"beta","topic":"cross","chatKey":"alpha-chat","text":"hello"}]',
			},
			scope,
		);
		expect(badMessageBotTurn.status).toBe(200);
		expect(badMessageBotTurn.frame.result?.reply).toContain(
			"chatKey is not used",
		);
	});
});
