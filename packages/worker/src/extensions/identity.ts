import { defineExtension, section } from "@earendil-works/pi-durable";
import { requireCadmusServices } from "../context.js";
import { isCodingTool } from "../tools-env/pure.js";

export const DEFAULT_SOUL = `You are a personal assistant.
Be direct, warm and concise. Plain text renders best; keep formatting light.
You run on a durable runtime: your conversation survives restarts. If you were interrupted, say so plainly rather than guessing what happened.`;

export const SYSTEM_PROMPT = `MEMORY.md, SOUL.md, and knowledge/<slug>.md are virtual entities stored in the bot runtime database—they are NOT files on disk or in the workspace. Never use workspace filesystem tools (write, edit, read, bash, or shell scripts) on them. They must be inspected and mutated exclusively using their dedicated tools.

- MEMORY.md: Short standing memory for this bot (preferences, voice, how to work). Its body is already in the prompt when non-empty. To read or update memory, you MUST use memory_read and memory_update with the expectedVersion and full new body (no --- fence). Empty body clears it. Never attempt to write or edit a file named memory.md or MEMORY.md on disk.
- Knowledge: Structured reference documents identified as knowledge/<slug>.md that belong only to you, the bot running this turn. You MUST use knowledge_read, knowledge_update, and knowledge_delete. Those tools have no peer targeting and always read or write your entries, even when the slug names another bot. knowledge_read returns a version (0 when the entry does not exist). knowledge_update takes that version, a one-line description (at most 240 characters), an optional category, and the full body without a --- frontmatter fence; it creates the entry when version is 0. To create a peer that already has knowledge, pass a knowledge array on create_bot. Do not call knowledge_update afterward to copy those documents. Do not put standing preferences in knowledge when they belong in MEMORY.md. Never attempt to write or edit files in a knowledge/ directory on disk.
- SOUL.md: Your core persona and instructions. Do not edit SOUL.md unless explicitly asked by the user.

- Peer Bots & Bot Family Collaboration:
  - You belong to a Bot Family alongside other specialized peer bots, each maintaining its own persona (SOUL.md), memory (MEMORY.md), and knowledge base.
  - Answer questions using your own context, memory, and knowledge first. If a question is outside your role or not found in your memory or knowledge, or if the user asks to check other bots:
    - Use search_bot with the topic or domain to identify which peer bot specializes in or holds knowledge about the subject. search_bot evaluates candidate bot personas, memories, and knowledge summaries to pinpoint the relevant bot.
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
			section("knowledge", (input, context) => {
				const botId = input.agent.cwd;
				if (!botId) return undefined;
				const services = requireCadmusServices(context);
				const docs = services.familyStore.files.listKnowledge(botId);
				if (docs.length === 0) return undefined;
				const lines = docs.map((doc) => {
					const cat = doc.category ? ` [${doc.category}]` : "";
					return `- ${doc.slug}${cat} (v${doc.version}): ${doc.description}`;
				});
				return `Available knowledge entries (use knowledge_read to view body):\n${lines.join("\n")}`;
			}),
			section("memory", (input, context) => {
				const botId = input.agent.cwd;
				if (!botId) return undefined;
				const services = requireCadmusServices(context);
				const mem = services.familyStore.files.getMemory(botId);
				const body = mem.content.trim();
				if (!body) return undefined;
				return `MEMORY.md (version ${mem.version}):\n${body}`;
			}),
			section("tools-env", async (input, context) => {
				const botId = input.agent.cwd;
				if (!botId) return undefined;
				const services = requireCadmusServices(context);
				const described = await services.describeToolsEnv({
					conversationId: input.conversationId as unknown as number,
					botId,
					toolNames: input.agent.tools
						.map((tool) => tool.name)
						.filter(isCodingTool),
				});
				return described?.name === "tools-env" ? described.text : undefined;
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
						.filter(isCodingTool),
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
				if (!member) return undefined;
				if (member.role === "caller") {
					return `CRITICAL - YOU ARE IN AN AUTOMATED SUB-CONVERSATION WITH PEER BOTS:
- The human user is NOT in this conversation. All incoming messages are from peer bots.
- You initiated this group chat using message_bot to query peer bot(s).
- Never ask questions to the user here, never send conversational pleasantries ('Understood', 'Got it', '👍'), and do not attempt to start another group chat.
- Your SOLE objective is to evaluate the peer's reply and call the end_conversation({ response: "..." }) tool immediately.
- As soon as the peer bot answers your question, or confirms it has no records/knowledge, you MUST call end_conversation immediately with the summary response so your main conversation with the user can resume.`;
				}
				return `CRITICAL - YOU ARE IN AN AUTOMATED SUB-CONVERSATION WITH A PEER BOT:
- The human user is NOT in this conversation.
- A peer bot is asking you for information. Answer the question directly and concisely from your memory or knowledge base in a single reply.
- Do NOT engage in chit-chat, do NOT suggest asking other bots, and do NOT ask follow-up questions.`;
			}),
		],
	});
}
