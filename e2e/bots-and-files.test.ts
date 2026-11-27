import { describe, expect, it } from "vitest";
import {
	adminScope,
	type ChatRecord,
	type HarvestNote,
	sendRpc,
	useWorkerFixture,
} from "./helpers.js";

describe("Bots, Virtual Files (/.cadmus/SOUL.md, /.cadmus/MEMORY.md, /.cadmus/skills/{bot,family}/<slug>/SKILL.md), CAS & Tool Gate", () => {
	useWorkerFixture();

	it("manages bot lifecycle and enforces CAS, size limits, and frontmatter rules on /.cadmus/MEMORY.md and /.cadmus/skills/{bot,family}/<slug>/SKILL.md", async () => {
		const scope = await adminScope("default");

		// 1. Create bot with initial soul, memory, and skills
		const createRes = await sendRpc<{ bot: { id: string } }>(
			"bot.create",
			{
				slug: "scribe",
				name: "Scribe",
				model: "faux/echo",
				thinking: "off",
				soul: "You are Scribe, keeper of records.",
				memory: "- Prefer concise bullet points.",
				skills: [
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

		// 2. Read /.cadmus/SOUL.md, /.cadmus/MEMORY.md, and /.cadmus/skills/bot/architecture/SKILL.md
		const soulRead = await sendRpc<{ content: string }>(
			"file.read",
			{ botId: "scribe", path: "/.cadmus/SOUL.md" },
			scope,
		);
		expect(soulRead.frame.result?.content).toContain("keeper of records");

		const memRead = await sendRpc<{ content: string; version: number }>(
			"file.read",
			{ botId: "scribe", path: "/.cadmus/MEMORY.md" },
			scope,
		);
		expect(memRead.frame.result?.version).toBe(1);
		expect(memRead.frame.result?.content).toBe(
			"- Prefer concise bullet points.",
		);

		const kRead = await sendRpc<{
			version: number;
			scope?: string;
			description: string;
			category?: string;
			body: string;
		}>(
			"file.read",
			{ botId: "scribe", path: "/.cadmus/skills/bot/architecture/SKILL.md" },
			scope,
		);
		expect(kRead.frame.result?.version).toBe(1);
		expect(kRead.frame.result?.scope).toBe("bot");
		expect(kRead.frame.result?.category).toBe("design");
		expect(kRead.frame.result?.body).toContain("# Cadmus V2");

		// Legacy flat path is rejected
		const legacyRead = await sendRpc(
			"file.read",
			{ botId: "scribe", path: "/.cadmus/skills/architecture/SKILL.md" },
			scope,
		);
		expect(legacyRead.status).toBe(400);
		expect(legacyRead.frame.error?.code).toBe("invalid_path");

		// 3. Enforce CAS on /.cadmus/MEMORY.md: stale expectedVersion (0 instead of 1) must fail with cas_conflict
		const staleMem = await sendRpc(
			"file.write",
			{
				botId: "scribe",
				path: "/.cadmus/MEMORY.md",
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
				path: "/.cadmus/MEMORY.md",
				content: "- Updated standing memory",
				expectedVersion: 1,
			},
			scope,
		);
		expect(goodMem.status).toBe(200);
		expect(goodMem.frame.result?.version).toBe(2);

		// 5. Reject /.cadmus/MEMORY.md > 8192 bytes or starting with ---
		const frontmatterMem = await sendRpc(
			"file.write",
			{
				botId: "scribe",
				path: "/.cadmus/MEMORY.md",
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
				path: "/.cadmus/MEMORY.md",
				content: "x".repeat(8200),
				expectedVersion: 2,
			},
			scope,
		);
		expect(hugeMem.status).toBe(400);

		// 6. Enforce CAS on /.cadmus/skills/bot/architecture/SKILL.md
		const staleKnow = await sendRpc(
			"file.write",
			{
				botId: "scribe",
				path: "/.cadmus/skills/bot/architecture/SKILL.md",
				description: "Updated desc",
				body: "New body",
				expectedVersion: 0,
			},
			scope,
		);
		expect(staleKnow.status).toBe(400);
		expect(staleKnow.frame.error?.code).toBe("cas_conflict");

		const goodKnow = await sendRpc<{ version: number; scope?: string }>(
			"file.write",
			{
				botId: "scribe",
				path: "/.cadmus/skills/bot/architecture/SKILL.md",
				description: "Updated architecture overview",
				category: "design",
				body: "# Cadmus V2\nUpdated body with Durable Objects.",
				expectedVersion: 1,
			},
			scope,
		);
		expect(goodKnow.status).toBe(200);
		expect(goodKnow.frame.result?.version).toBe(2);
		expect(goodKnow.frame.result?.scope).toBe("bot");

		// 7. Family skills: write/read/list/CAS/delete without botId, coexisting with same slug in bot scope
		const famWrite = await sendRpc<{ version: number; scope?: string }>(
			"file.write",
			{
				path: "/.cadmus/skills/family/architecture/SKILL.md",
				description: "Shared family architecture conventions",
				category: "design",
				body: "# Family Architecture\nShared across all bots.",
			},
			scope,
		);
		expect(famWrite.status).toBe(200);
		expect(famWrite.frame.result?.version).toBe(1);
		expect(famWrite.frame.result?.scope).toBe("family");

		const staleFam = await sendRpc(
			"file.write",
			{
				path: "/.cadmus/skills/family/architecture/SKILL.md",
				description: "Stale update",
				body: "stale",
				expectedVersion: 0,
			},
			scope,
		);
		expect(staleFam.status).toBe(400);
		expect(staleFam.frame.error?.code).toBe("cas_conflict");

		const famListOnly = await sendRpc<{
			files: Array<{ path: string; scope?: string }>;
		}>("file.list", {}, scope);
		expect(famListOnly.status).toBe(200);
		expect(famListOnly.frame.result?.files.map((f) => f.path)).toEqual([
			"/.cadmus/skills/family/architecture/SKILL.md",
		]);

		const botAndFamList = await sendRpc<{
			files: Array<{ path: string; scope?: string }>;
		}>("file.list", { botId: "scribe", category: "design" }, scope);
		expect(botAndFamList.frame.result?.files.map((f) => f.path)).toContain(
			"/.cadmus/skills/bot/architecture/SKILL.md",
		);
		expect(botAndFamList.frame.result?.files.map((f) => f.path)).toContain(
			"/.cadmus/skills/family/architecture/SKILL.md",
		);

		const famRead = await sendRpc<{ scope?: string; body?: string }>(
			"file.read",
			{ path: "/.cadmus/skills/family/architecture/SKILL.md" },
			scope,
		);
		expect(famRead.status).toBe(200);
		expect(famRead.frame.result?.scope).toBe("family");
		expect(famRead.frame.result?.body).toContain("Shared across all bots.");

		const famDel = await sendRpc<{ deleted: string }>(
			"file.delete",
			{ path: "/.cadmus/skills/family/architecture/SKILL.md" },
			scope,
		);
		expect(famDel.status).toBe(200);
		expect(famDel.frame.result?.deleted).toBe(
			"/.cadmus/skills/family/architecture/SKILL.md",
		);
	});

	it("executes VFS read/write/edit/delete on /.cadmus/* without tools-env, blocks SOUL.md writes, errors on workspace paths, and enforces bot.tools", async () => {
		const scope = await adminScope("default");

		// Create a bot restricted to ONLY `read` (disallowing `write`, `edit`, `delete`)
		await sendRpc(
			"bot.create",
			{
				slug: "reader-only",
				name: "Reader Only",
				model: "faux/echo",
				tools: ["read"],
				toolsEnv: { enabled: false },
			},
			scope,
		);

		// Attempt to call `write` via tool directive: tool-gate must block it!
		const blockedTurn = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "bot:reader-only",
				text: 'Try updating memory [tool:write {"path":"/.cadmus/MEMORY.md","content":"secret"}]',
			},
			scope,
		);
		expect(blockedTurn.status).toBe(200);
		expect(blockedTurn.frame.result?.reply).toContain(
			"Tool write is not available",
		);

		// Verify /.cadmus/MEMORY.md was not modified (still version 0)
		const memAfterBlocked = await sendRpc<{ version: number; content: string }>(
			"file.read",
			{ botId: "reader-only", path: "/.cadmus/MEMORY.md" },
			scope,
		);
		expect(memAfterBlocked.frame.result?.version).toBe(0);

		// Now enable `read`, `write`, `edit`, `delete` via `bot.update` (still NO tools-env!)
		await sendRpc(
			"bot.update",
			{
				botId: "reader-only",
				tools: ["read", "write", "edit", "delete"],
			},
			scope,
		);

		// 1. Write /.cadmus/MEMORY.md
		const writeMemTurn = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "bot:reader-only",
				text: 'Write memory [tool:write {"path":"/.cadmus/MEMORY.md","content":"Allowed memory line\\nSecond line"}]',
			},
			scope,
		);
		expect(writeMemTurn.status).toBe(200);
		expect(writeMemTurn.frame.result?.reply).toContain(
			"Successfully wrote to /.cadmus/MEMORY.md",
		);

		// 2. Surgically edit /.cadmus/MEMORY.md
		const editMemTurn = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "bot:reader-only",
				text: 'Edit memory [tool:edit {"path":"/.cadmus/MEMORY.md","edits":[{"oldText":"Second line","newText":"Edited second line"}]}]',
			},
			scope,
		);
		expect(editMemTurn.status).toBe(200);
		expect(editMemTurn.frame.result?.reply).toContain("Successfully replaced");

		const memAfterEdit = await sendRpc<{ version: number; content: string }>(
			"file.read",
			{ botId: "reader-only", path: "/.cadmus/MEMORY.md" },
			scope,
		);
		expect(memAfterEdit.frame.result?.version).toBe(2);
		expect(memAfterEdit.frame.result?.content).toBe(
			"Allowed memory line\nEdited second line",
		);

		// 3. Write, read, edit, and delete a skill at /.cadmus/skills/bot/deploy/SKILL.md
		const writeSkill = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "bot:reader-only",
				text: `Create skill [tool:write ${JSON.stringify({
					path: "/.cadmus/skills/bot/deploy/SKILL.md",
					content:
						"---\nname: deploy\ndescription: How to deploy\ncategory: ops\n---\n\nRun bun run deploy.\n",
				})}]`,
			},
			scope,
		);
		expect(writeSkill.frame.result?.reply).toContain(
			"Successfully wrote to /.cadmus/skills/bot/deploy/SKILL.md",
		);

		const readSkill = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "bot:reader-only",
				text: 'Read skill [tool:read {"path":"/.cadmus/skills/bot/deploy/SKILL.md"}]',
			},
			scope,
		);
		expect(readSkill.frame.result?.reply).toContain("Run bun run deploy.");

		const editSkill = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "bot:reader-only",
				text: `Edit skill [tool:edit ${JSON.stringify({
					path: "/.cadmus/skills/bot/deploy/SKILL.md",
					edits: [
						{
							oldText: "Run bun run deploy.",
							newText: "Run bun run check:all && bun run deploy.",
						},
					],
				})}]`,
			},
			scope,
		);
		expect(editSkill.frame.result?.reply).toContain("Successfully replaced");

		const deleteSkill = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "bot:reader-only",
				text: 'Delete skill [tool:delete {"path":"/.cadmus/skills/bot/deploy/SKILL.md"}]',
			},
			scope,
		);
		expect(deleteSkill.frame.result?.reply).toContain(
			"Successfully deleted /.cadmus/skills/bot/deploy/SKILL.md",
		);

		// 4. /.cadmus/SOUL.md is read-only for LLM tools
		const writeSoul = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "bot:reader-only",
				text: 'Write soul [tool:write {"path":"/.cadmus/SOUL.md","content":"hijacked"}]',
			},
			scope,
		);
		expect(writeSoul.frame.result?.reply).toContain("read-only");

		// 5. Non-/.cadmus/ workspace path errors cleanly when no tools-env is enabled
		const workspaceRead = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "bot:reader-only",
				text: 'Read workspace [tool:read {"path":"README.md"}]',
			},
			scope,
		);
		expect(workspaceRead.frame.result?.reply).toContain(
			"No workspace tools environment is enabled",
		);
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

		// 2. Submit a turn on scribe's primary chat that arms harvest + peer message
		const firstChatRes = await sendRpc<{ chat: ChatRecord }>(
			"chat.get",
			{ chatKey: "bot:scribe" },
			scope,
		);
		expect(firstChatRes.status).toBe(200);
		const oldConversationId = firstChatRes.frame.result?.chat.conversationId;

		await sendRpc(
			"turn.submit",
			{
				chatKey: "bot:scribe",
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
				target: { mode: "chat", chatKey: "bot:scribe" },
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
		expect(allChatsAfterDelete.frame.result?.chats.map((c) => c.key)).toEqual([
			"bot:helper",
		]);

		const deletedChatGet = await sendRpc(
			"chat.get",
			{ chatKey: "bot:scribe" },
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

		// Recreated bot has 1 fresh primary chat with new conversationId, empty transcript & 0 harvest watermark/notes
		const chatsAfterRecreate = await sendRpc<{ chats: ChatRecord[] }>(
			"chat.list",
			{ botId: "scribe" },
			scope,
		);
		expect(chatsAfterRecreate.frame.result?.chats).toHaveLength(1);
		expect(chatsAfterRecreate.frame.result?.chats[0]?.conversationId).not.toBe(
			oldConversationId,
		);
		expect(chatsAfterRecreate.frame.result?.chats[0]?.title).toBe("Scribe V2");

		const freshChatGet = await sendRpc<{
			chat: ChatRecord;
			messages: unknown[];
			entries?: unknown[];
			notes: HarvestNote[];
		}>("chat.get", { chatKey: "bot:scribe" }, scope);
		expect(freshChatGet.status).toBe(200);
		expect(freshChatGet.frame.result?.messages).toEqual([]);
		expect(freshChatGet.frame.result?.notes).toEqual([]);

		const statusRes = await sendRpc<{
			status: { harvestWatermark: number; entryCount: number };
		}>("chat.status", { chatKey: "bot:scribe" }, scope);
		expect(statusRes.status).toBe(200);
		expect(statusRes.frame.result?.status.harvestWatermark).toBe(0);
		expect(statusRes.frame.result?.status.entryCount).toBe(0);
	});

	it("enforces strict chat-to-bot ownership across schedule.create, schedule.update, schedule_create, and message_bot", async () => {
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

		// 1. Calling schedule.create for "beta" targeting "bot:alpha" (mode: "chat" and mode: "fork") must fail with conflict
		const crossSchedChat = await sendRpc(
			"schedule.create",
			{
				botId: "beta",
				kind: "relative",
				input: "10m",
				text: "Intrude",
				target: { mode: "chat", chatKey: "bot:alpha" },
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
				target: { mode: "fork", chatKey: "bot:alpha" },
			},
			scope,
		);
		expect(crossSchedFork.status).toBe(400);
		expect(crossSchedFork.frame.error?.code).toBe("conflict");

		// 2. Calling schedule.update to retarget a "beta" schedule onto "bot:alpha" must fail with conflict
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
				target: { mode: "chat", chatKey: "bot:alpha" },
			},
			scope,
		);
		expect(crossSchedUpdate.status).toBe(400);
		expect(crossSchedUpdate.frame.error?.code).toBe("conflict");

		// 3. Agent tools schedule_create and message_bot must reject cross-bot chat keys
		const badScheduleToolTurn = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "bot:beta",
				text: 'Schedule on alpha chat [tool:schedule_create {"kind":"relative","input":"5m","text":"hi","target":{"mode":"chat","chatKey":"bot:alpha"}}]',
			},
			scope,
		);
		expect(badScheduleToolTurn.status).toBe(200);
		expect(badScheduleToolTurn.frame.result?.reply).toContain(
			"Chat 'bot:alpha' belongs to bot 'alpha', not 'beta'",
		);

		const badMessageBotTurn = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "bot:alpha",
				text: 'Message beta using alpha-chat [tool:message_bot {"botId":"beta","topic":"cross","chatKey":"bot:alpha","text":"hello"}]',
			},
			scope,
		);
		expect(badMessageBotTurn.status).toBe(200);
		expect(badMessageBotTurn.frame.result?.reply).toContain(
			"chatKey is not used",
		);
	});
});
