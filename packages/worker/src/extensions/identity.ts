import { isWorkspaceTool } from "@cadmus/contract/tools";
import { defineExtension, section } from "@earendil-works/pi-durable";
import { requireCadmusServices } from "../context.js";
import type { CadmusExtensionDescriptor } from "./cadmus-tools.js";
import { MEMORY_VFS_PATH, SOUL_VFS_PATH, skillVfsPath } from "./vfs.js";

export const DEFAULT_SOUL = `You are a personal assistant.
Be direct, warm and concise. Plain text renders best; keep formatting light.
You run on a durable runtime: your conversation survives restarts. If you were interrupted, say so plainly rather than guessing what happened.`;

export const SYSTEM_PROMPT = `Your personal state lives in Cadmus virtual files under /.cadmus/, accessed directly with read, write, edit, and delete:

- ${SOUL_VFS_PATH}: Your core persona and instructions. Read-only for you (only humans can edit it).
- ${MEMORY_VFS_PATH}: Short standing memory for this bot (preferences, voice, how to work). Its body is already in this prompt when non-empty. Use edit for targeted updates or write to replace/clear it (no --- frontmatter fence; writing empty content clears it).
- /.cadmus/skills/<slug>/SKILL.md: Reusable skills and reference guides that belong to you. Each skill starts with YAML frontmatter:
  ---
  name: <slug>
  description: <one-line trigger/summary, <= 240 chars>
  category: <optional one-line tag, <= 64 chars>
  ---
  Read relevant skills with read before acting when a task matches a skill's description. Create new skills with write, update existing skills surgically with edit, and remove obsolete skills with delete. To seed a new peer bot with its own skills or memory, pass skills/memory on create_bot rather than writing your own /.cadmus/ files.

- Peer Bots & Bot Family Collaboration:
  - You belong to a Bot Family alongside other specialized peer bots, each maintaining its own persona (${SOUL_VFS_PATH}), memory (${MEMORY_VFS_PATH}), and skills (/.cadmus/skills/*).
  - Answer questions using your own context, memory, and skills first. If a question is outside your role or not found in your memory or skills, or if the user asks to check other bots:
    - Use search_bot with the topic or domain to identify which peer bot specializes in or holds skills about the subject. search_bot evaluates candidate bot personas, memories, and skill summaries to pinpoint the relevant bot.
    - Never call list_bots to search for information or decide which bot to contact. list_bots returns only names and slugs without domain context; only use list_bots when the user explicitly asks for an exhaustive roster or inventory of all bots in the family.
    - Never broadcast queries to multiple bots or call message_bot across multiple bots in parallel. Identify the single best-matching bot via search_bot and message only that bot.
    - When querying a peer bot for information or records, call message_bot with slug set to that bot and pass readOnly: true.
    - When you initiate a group chat with message_bot(wait: true), your session will receive the peer's reply. Once you receive the answer (or confirmation that the peer has no relevant record), call end_conversation immediately to return the response. Do NOT reply with conversational pleasantries or acknowledgments ("Understood", "Got it", "👍"), which cause unnecessary turn loops until the turn cap.`;

export function dayLine(timeZone: string, now = new Date()): string {
	const date = new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(now);
	const weekday = new Intl.DateTimeFormat("en-US", {
		timeZone,
		weekday: "long",
	}).format(now);
	return `Today is ${date} (${weekday}), time zone ${timeZone}.`;
}

export function soulWithName(soul: string, name?: string): string {
	const label = name?.trim();
	if (!label) return soul;
	return `Your name is ${label}.\n\n${soul}`;
}

export function identityExtension(options?: { now?: () => Date }) {
	const nowFn = options?.now ?? (() => new Date());

	return defineExtension({
		name: "cadmus.identity",
		sections: [
			section(
				"soul",
				(input, context) => {
					const services = requireCadmusServices(context);
					const botId = input.agent.cwd;
					const bot = botId
						? services.familyStore.bots.getBot(botId)
						: undefined;
					const storedSoul = botId
						? services.familyStore.files.getSoul(botId).trim()
						: "";
					return soulWithName(storedSoul || DEFAULT_SOUL, bot?.name);
				},
				{ tag: false },
			),
			section("system", () => SYSTEM_PROMPT),
			section("skills", (input, context) => {
				const botId = input.agent.cwd;
				if (!botId) return undefined;
				const services = requireCadmusServices(context);
				const docs = services.familyStore.files.listSkills(botId);
				if (docs.length === 0) return undefined;
				const lines = docs.map((doc) => {
					const cat = doc.category ? ` [${doc.category}]` : "";
					return `- ${skillVfsPath(doc.slug)}${cat}: ${doc.description}`;
				});
				return `Available skills (read /.cadmus/skills/<slug>/SKILL.md before acting when relevant):\n${lines.join("\n")}`;
			}),
			section("memory", (input, context) => {
				const botId = input.agent.cwd;
				if (!botId) return undefined;
				const services = requireCadmusServices(context);
				const mem = services.familyStore.files.getMemory(botId);
				const body = mem.content.trim();
				if (!body) return undefined;
				return `${MEMORY_VFS_PATH}:\n${body}`;
			}),
			section("tools-env-unavailable", async (input, context) => {
				const botId = input.agent.cwd;
				if (!botId) return undefined;
				const services = requireCadmusServices(context);
				const described = await services.describeToolsEnv({
					conversationId: input.conversationId as unknown as number,
					botId,
					toolNames: input.agent.tools
						.map((tool) => tool.name)
						.filter(isWorkspaceTool),
				});
				return described?.name === "tools-env-unavailable"
					? described.text
					: undefined;
			}),
			section("date", (_input, context) => {
				const services = requireCadmusServices(context);
				return dayLine(services.getTimezone(), nowFn());
			}),
			section("group-chat", (input, context) => {
				const services = requireCadmusServices(context);
				const chat = services.familyStore.chats.getChatByConversationId(
					input.conversationId as unknown as number,
				);
				if (!chat) return undefined;
				const member = services.familyStore.groups.findByMemberKey(chat.key);
				if (member?.role !== "member") return undefined;
				return `CRITICAL - YOU ARE IN AN AUTOMATED SUB-CONVERSATION WITH A PEER BOT:
- The human user is NOT in this conversation.
- A peer bot is asking you for information. Answer the question directly and concisely from your memory or skills in a single reply.
- Do NOT engage in chit-chat, do NOT suggest asking other bots, and do NOT ask follow-up questions.`;
			}),
		],
	});
}

export function identityExtensionDescriptor(options?: {
	now?: () => Date;
}): CadmusExtensionDescriptor {
	return {
		extension: identityExtension(options),
		defaultEnabled: true,
		allowlistPolicy: { mode: "always" },
		isActive: () => true,
	};
}
