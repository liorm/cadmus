import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type Cursor,
	defineTool,
	type TaskId,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { botDir, listBots } from "../../channels/bots.ts";
import { knowledgeIndex } from "../knowledge.ts";
import { type SelfHost, toolError, toolText } from "../self-tools/host.ts";
import { type CatalogBot, excerptSoul, formatSearchCatalog } from "./match.ts";
import { type SearchBotResult, SearchBotTask } from "./search-task.ts";

async function readOptional(path: string): Promise<string | undefined> {
	try {
		return await readFile(path, "utf8");
	} catch {
		return undefined;
	}
}

async function catalog(host: SelfHost): Promise<{
	text: string;
	slugs: string[];
}> {
	const harness = host.harness;
	if (!harness) return { text: "No bots are stored.", slugs: [] };
	const bots = await listBots(harness);
	const entries: CatalogBot[] = [];
	for (const bot of bots) {
		const dir = botDir(host.home, bot.id);
		const soul = await readOptional(join(dir, "SOUL.md"));
		const knowledge = await knowledgeIndex(dir);
		entries.push({
			slug: bot.id,
			name: bot.name,
			model: bot.model,
			soul: excerptSoul(soul ?? ""),
			...(knowledge ? { knowledge } : {}),
		});
	}
	return formatSearchCatalog(entries);
}

export function searchBotTool(host: SelfHost) {
	return defineTool({
		name: "search_bot",
		description:
			"Find the bot that matches a description. Returns one slug, or null when none matches. A model pass reads the bot list. A reply that is not an exact slug is asked again, up to 3 times. Empty or null means none match.",
		parameters: Type.Object({
			description: Type.String({
				description: "What the bot should be, in a sentence or two.",
			}),
		}),
		replay: "safe",
		async execute(args, api, context) {
			const description = args.description.trim();
			if (!description) return toolError("Description is empty.");
			if (!host.harness) return toolError("Bots are not available.");
			const agent = await api.agent(context);
			const model = agent.model;
			if (!model) return toolError("This conversation has no model.");
			const listed = await catalog(host);
			const taskId = await api.commit(async (tx) => {
				let cursor: Cursor | undefined;
				for (;;) {
					const page = await tx.scanTasks(
						{ kind: SearchBotTask.definition.name },
						50,
						cursor,
					);
					const found = page.items.find((item) => item.owner === api.taskId);
					if (found) return found.id as TaskId<SearchBotResult>;
					if (!page.next) break;
					cursor = page.next;
				}
				return tx.createTask(
					SearchBotTask,
					{
						description,
						model: { provider: model.provider, modelId: model.modelId },
						thinking: agent.thinkingLevel,
						catalog: listed.text,
						slugs: listed.slugs,
					},
					{ ownership: { kind: "task", taskId: api.taskId } },
				);
			}, context);
			const settled = await api.waitForTask(taskId, context);
			const outcome = settled.state.outcome;
			if (outcome.status === "completed") {
				return toolText(JSON.stringify({ slug: outcome.result.slug }));
			}
			if (outcome.status === "aborted") return toolError("Search was aborted.");
			if (outcome.status === "failed") return toolError(outcome.error.message);
			return toolError("Search did not finish.");
		},
	});
}
