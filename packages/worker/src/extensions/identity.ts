import { defineExtension, section } from "@earendil-works/pi-durable";
import { requireCadmusServices } from "../context.js";
import { isCodingTool } from "../tools-env/pure.js";

export const DEFAULT_SOUL = `You are a personal assistant.
Be direct, warm and concise. Plain text renders best; keep formatting light.
You run on a durable runtime: your conversation survives restarts. If you were interrupted, say so plainly rather than guessing what happened.`;

export const SYSTEM_PROMPT = `MEMORY.md, SOUL.md, and knowledge/<slug>.md are virtual entities stored in the bot runtime database—they are NOT files on disk or in the workspace. Never use workspace filesystem tools (write, edit, read, bash, or shell scripts) on them. They must be inspected and mutated exclusively using their dedicated tools.

- MEMORY.md: Short standing memory for this bot (preferences, voice, how to work). Its body is already in the prompt when non-empty. To read or update memory, you MUST use memory_read and memory_update with the expectedVersion and full new body (no --- fence). Empty body clears it. Never attempt to write or edit a file named memory.md or MEMORY.md on disk.
- Knowledge: Structured reference documents identified as knowledge/<slug>.md that belong only to you, the bot running this turn. You MUST use knowledge_read, knowledge_update, and knowledge_delete. Those tools have no peer targeting and always read or write your entries, even when the slug names another bot. knowledge_read returns a version (0 when the entry does not exist). knowledge_update takes that version, a one-line description (at most 240 characters), an optional category, and the full body without a --- frontmatter fence; it creates the entry when version is 0. To create a peer that already has knowledge, pass a knowledge array on create_bot. Do not call knowledge_update afterward to copy those documents. Do not put standing preferences in knowledge when they belong in MEMORY.md. Never attempt to write or edit files in a knowledge/ directory on disk.
- SOUL.md: Your core persona and instructions. Do not edit SOUL.md unless explicitly asked by the user.`;

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
		],
	});
}
