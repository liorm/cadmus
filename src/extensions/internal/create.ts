import type { Context, JsonValue } from "@earendil-works/chord";
import {
	AgentDoc,
	defineTool,
	type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import {
	type BotKnowledgeSeed,
	type BotRecord,
	createBot as createBotRecord,
	listBots,
	publicBot,
} from "../../channels/bots.ts";
import {
	checkModel,
	modelRefString,
	parseModelRef,
	THINKING_LEVELS,
} from "../../harness/models.ts";
import { parseSlug } from "../knowledge.ts";
import { type SelfHost, toolError, toolText } from "../self-tools/host.ts";

const knowledgeSeed = Type.Object({
	slug: Type.String({ description: "Knowledge file slug." }),
	description: Type.String({
		description: "One-line description, 1–240 characters.",
	}),
	body: Type.String({
		description: "Markdown body. Must not start with ---.",
	}),
	category: Type.Optional(
		Type.String({
			description: "Optional one-line category, at most 64 characters.",
		}),
	),
});

const createSchema = Type.Object({
	name: Type.String({ description: "Display name." }),
	slug: Type.String({
		description:
			"Bot id. Lowercase letters, digits, and hyphens, at most 32 characters. Must be free. It is not derived from the name.",
	}),
	soul: Type.String({ description: "Full SOUL.md text." }),
	model: Type.Optional(
		Type.String({
			description: "provider/modelId. Omit to copy this conversation's model.",
		}),
	),
	effort: Type.Optional(
		Type.String({
			description:
				"Thinking level: off, minimal, low, medium, high, or xhigh. Omit to copy this conversation's level. Empty string leaves it unset.",
		}),
	),
	memory: Type.Optional(
		Type.String({
			description:
				"Initial MEMORY.md body, without a --- fence, at most 8192 bytes. Omit to skip the file.",
		}),
	),
	knowledge: Type.Optional(
		Type.Array(knowledgeSeed, {
			description: "Initial knowledge files, each stored at version 0.",
		}),
	),
});

function thinkingLevel(
	value: string,
): { ok: true; thinking: string } | { ok: false; error: string } {
	if (value === "") return { ok: true, thinking: "" };
	if ((THINKING_LEVELS as readonly string[]).includes(value))
		return { ok: true, thinking: value };
	return { ok: false, error: "Unknown thinking level." };
}

async function resolveCreate(
	args: {
		name: string;
		slug: string;
		soul: string;
		model?: string;
		effort?: string;
		memory?: string;
		knowledge?: BotKnowledgeSeed[];
	},
	api: ToolExecutionApi,
	context: Context,
): Promise<
	| {
			ok: true;
			slug: string;
			write: {
				id: string;
				name: string;
				model: string;
				thinking: string;
				soul: string;
				memory?: string;
				knowledge?: BotKnowledgeSeed[];
			};
	  }
	| { ok: false; error: string }
> {
	const slug = parseSlug(args.slug, "bot");
	if (!slug) return { ok: false, error: "Slug is not a bot id." };
	const name = args.name.trim();
	if (!name) return { ok: false, error: "Name is empty." };
	const agent = await api.agent(context);
	const model =
		args.model?.trim() || (agent.model ? modelRefString(agent.model) : "");
	if (!model) return { ok: false, error: "This conversation has no model." };
	if (args.model !== undefined) {
		try {
			await checkModel(api.models, parseModelRef(model));
		} catch (error) {
			return { ok: false, error: (error as Error).message };
		}
	}
	let thinking: string;
	if (args.effort !== undefined) {
		const parsed = thinkingLevel(args.effort.trim());
		if (!parsed.ok) return parsed;
		thinking = parsed.thinking;
	} else {
		const stored = await api.snapshot(AgentDoc, api.conversationId, context);
		thinking = stored?.thinkingLevel ?? "";
	}
	return {
		ok: true,
		slug,
		write: {
			id: slug,
			name,
			model,
			thinking,
			soul: args.soul,
			...(args.memory === undefined ? {} : { memory: args.memory }),
			...(args.knowledge === undefined ? {} : { knowledge: args.knowledge }),
		},
	};
}

async function remember(
	api: ToolExecutionApi,
	bot: BotRecord,
	host: SelfHost,
	context: Context,
) {
	host.onBot?.(bot);
	const shown = publicBot(bot);
	await api.memo("bot", shown, context);
	return toolText(JSON.stringify({ bot: shown }));
}

export function createBotTool(host: SelfHost) {
	return defineTool({
		name: "create_bot",
		description:
			"Create a bot. slug is the id and must be free. soul is the full SOUL.md. Omit model to copy this conversation's model. Omit effort to copy this conversation's thinking level. Optional memory is the MEMORY.md body. Optional knowledge entries are initial files. A repeat of this call returns the same bot.",
		parameters: createSchema,
		replay: "safe",
		async execute(args, api, context) {
			const prior = await api.memo<JsonValue>("bot", context);
			if (prior) return toolText(JSON.stringify({ bot: prior }));
			const harness = host.harness;
			if (!harness) return toolError("Bots are not available.");
			const lost = await api.memo<boolean>("lost", context);
			if (lost) return toolError("Slug is taken.");
			const parsed = await resolveCreate(args, api, context);
			if (!parsed.ok) return toolError(parsed.error);
			const existing = (await listBots(harness)).find(
				(bot) => bot.id === parsed.slug,
			);
			const claimed = await api.memo<string>("claimed", context);
			if (existing && claimed === parsed.slug)
				return remember(api, existing, host, context);
			if (existing) return toolError("Slug is taken.");
			await api.memo("claimed", parsed.slug, context);
			const created = await createBotRecord(harness, host.home, parsed.write);
			if (!created.ok) {
				if (created.error === "Slug is taken.")
					await api.memo("lost", true, context);
				return toolError(created.error);
			}
			return remember(api, created.bot, host, context);
		},
	});
}
