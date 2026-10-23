import { defineExtension, section } from "@earendil-works/pi-durable";
import { requireCadmusServices } from "../context.js";
import { isCodingTool } from "../tools-env/pure.js";

export const DEFAULT_SOUL = `You are a personal assistant.
Be direct, warm and concise. Plain text renders best; keep formatting light.
You run on a durable runtime: your conversation survives restarts. If you were interrupted, say so plainly rather than guessing what happened.`;

export const SYSTEM_PROMPT = `MEMORY.md is short standing memory for this bot: preferences, voice, and how to work. Its body is already in the prompt when non-empty. Use memory_read then memory_update with that version and the full new body (no --- fence). Empty body clears it.

Knowledge lives in knowledge/<slug>.md. Use knowledge_read, knowledge_update, and knowledge_delete. knowledge_read returns a version (0 when the file does not exist). knowledge_update takes that version, a one-line description (at most 240 characters), an optional category, and the full body without a --- frontmatter fence; it creates the file when version is 0. Do not put standing preferences in knowledge when they belong in MEMORY.md. Do not edit SOUL.md unless the user asks.`;

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
