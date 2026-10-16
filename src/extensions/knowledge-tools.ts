import type { Context, JsonValue } from "@earendil-works/chord";
import {
	defineExtension,
	defineTool,
	type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { type TSchema, Type } from "typebox";
import {
	commitKnowledgeUpdate,
	deleteKnowledge,
	KNOWLEDGE_FIELDS,
	KNOWLEDGE_VERSION_FIELD,
	knowledgeReadPayload,
	loadKnowledge,
	parseSlug,
	parseVersion,
} from "./knowledge.ts";
import { toolError, toolText } from "./self-tools/host.ts";

const slugSchema = Type.String({
	description:
		"Knowledge slug. Lowercase letters, digits, and hyphens, 1–64 characters.",
});

function knowledgeUpdateParameters(): TSchema {
	const properties: Record<string, TSchema> = { slug: slugSchema };
	for (const field of KNOWLEDGE_FIELDS) {
		if (field.kind === "line") {
			const schema = Type.String({ description: field.description });
			properties[field.name] = field.required ? schema : Type.Optional(schema);
		} else if (field.kind === "version") {
			properties.version = Type.Number({ description: field.description });
		} else {
			properties.body = Type.String({ description: field.description });
		}
	}
	return Type.Object(properties);
}

async function botFolder(
	api: ToolExecutionApi,
	context: Context,
): Promise<string | undefined> {
	const agent = await api.agent(context);
	return agent.cwd;
}

async function remembered<T extends JsonValue>(
	api: ToolExecutionApi,
	name: string,
	context: Context,
): Promise<T | undefined> {
	return api.memo<T>(name, context);
}

/**
 * `knowledge_read`, `knowledge_update`, and `knowledge_delete` for the conversation's bot.
 * Persistence lives in knowledge.ts. Replay is safe: update and delete memo the outcome.
 */
export function knowledgeExtension() {
	return defineExtension({
		name: "pi-bot.knowledge",
		tools: [
			defineTool({
				name: "knowledge_read",
				description:
					"Read one knowledge entry for this bot. Returns slug, version, and when it exists, description, optional category, and body. A missing entry returns exists false and version 0. Use that version on knowledge_update.",
				parameters: Type.Object({ slug: slugSchema }),
				replay: "safe",
				async execute(args, api, context) {
					const cwd = await botFolder(api, context);
					if (!cwd)
						return toolError("This conversation is not inside a bot folder.");
					const slug = parseSlug(args.slug, "knowledge");
					if (!slug) return toolError("The name is not a legal slug.");
					const loaded = await loadKnowledge(cwd, slug);
					const payload = knowledgeReadPayload(slug, loaded);
					if (!payload.ok) return toolError(payload.error);
					return toolText(JSON.stringify(payload.record));
				},
			}),
			defineTool({
				name: "knowledge_update",
				description:
					"Create or replace one knowledge entry. Pass the version from knowledge_read (0 when it does not exist), a one-line description (at most 240 characters), and the full body without a --- frontmatter fence. Optional category is a one-line grouping label (at most 64 characters); omit it to keep the current value, pass an empty string to clear it. A stale version does not write.",
				parameters: knowledgeUpdateParameters(),
				replay: "safe",
				async execute(args, api, context) {
					const prior = await remembered<JsonValue>(api, "result", context);
					if (prior) return toolText(JSON.stringify(prior));
					const cwd = await botFolder(api, context);
					if (!cwd)
						return toolError("This conversation is not inside a bot folder.");
					const result = await commitKnowledgeUpdate(
						cwd,
						args as Record<string, unknown>,
					);
					if (!result.ok) return toolError(result.error);
					await api.memo("result", result.record, context);
					return toolText(JSON.stringify(result.record));
				},
			}),
			defineTool({
				name: "knowledge_delete",
				description:
					"Delete one knowledge entry. Pass the version from knowledge_read. A stale version does not delete. An unreadable entry is removed without a version check.",
				parameters: Type.Object({
					slug: slugSchema,
					version: Type.Number({
						description: KNOWLEDGE_VERSION_FIELD.description,
					}),
				}),
				replay: "safe",
				async execute(args, api, context) {
					const prior = await remembered<{ deleted: string }>(
						api,
						"deleted",
						context,
					);
					if (prior) return toolText(JSON.stringify(prior));
					const cwd = await botFolder(api, context);
					if (!cwd)
						return toolError("This conversation is not inside a bot folder.");
					const slug = parseSlug(args.slug, "knowledge");
					if (!slug) return toolError("The name is not a legal slug.");
					const expected = parseVersion(args.version);
					if (expected === undefined)
						return toolError("Version is not a whole number.");
					const loaded = await loadKnowledge(cwd, slug);
					if (loaded.status === "outside")
						return toolError("The name is not a legal slug.");
					const claimed = await remembered<string>(api, "target", context);
					if (loaded.status === "missing") {
						if (claimed === slug) {
							await api.memo("deleted", { deleted: slug }, context);
							return toolText(JSON.stringify({ deleted: slug }));
						}
						return toolError("No such knowledge entry.");
					}
					if (loaded.status === "ok" && loaded.doc.version !== expected)
						return toolError("Version does not match.");
					await api.memo("target", slug, context);
					const deleted = await deleteKnowledge(cwd, slug);
					if (!deleted.ok) return toolError(deleted.error);
					await api.memo("deleted", { deleted: slug }, context);
					return toolText(JSON.stringify({ deleted: slug }));
				},
			}),
		],
	});
}
