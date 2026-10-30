import type { Context, JsonValue } from "@earendil-works/chord";
import {
	defineExtension,
	defineTool,
	type ToolExecutionApi,
	type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { requireCadmusServices } from "../context.js";
import { getLogger } from "../log.js";
import { MAX_MEMORY_BYTES, SLUG_REGEX } from "../store/sqlite-family.js";

export function toolError(message: string): ToolExecutionResult {
	return {
		output: [{ type: "text", text: message }],
		isError: true,
	};
}

export function toolText(text: string): ToolExecutionResult {
	return {
		output: [{ type: "text", text }],
	};
}

export async function resolveBotScope(
	api: ToolExecutionApi,
	context: Context,
): Promise<{ botId: string; chatKey?: string } | undefined> {
	const agent = await api.agent(context);
	const botId = agent.cwd?.trim();
	if (!botId) return undefined;
	const services = requireCadmusServices(context);
	const chat = services.familyStore.chats.getChatByConversationId(
		api.conversationId as unknown as number,
	);
	return {
		botId,
		...(chat && !chat.closed ? { chatKey: chat.key } : {}),
	};
}

export function knowledgeExtension() {
	return defineExtension({
		name: "cadmus.knowledge",
		tools: [
			defineTool({
				name: "knowledge_read",
				description:
					"Read one knowledge entry that belongs to you, the bot running this turn. This never reads a peer. Returns slug, version, and when it exists, description, optional category, and body. A missing entry returns exists: false and version: 0. To seed a new peer, pass knowledge on create_bot.",
				parameters: Type.Object({
					slug: Type.String({
						description:
							"Knowledge slug (lowercase letters, digits, hyphens, 1-64 chars).",
					}),
				}),
				replay: "safe",
				async execute(args, api, context) {
					const scope = await resolveBotScope(api, context);
					if (!scope) {
						return toolError("Conversation is not bound to a bot.");
					}
					if (!SLUG_REGEX.test(args.slug)) {
						return toolError(
							`Invalid knowledge slug '${args.slug}': must match /^[a-z0-9][a-z0-9-]{0,63}$/`,
						);
					}
					const services = requireCadmusServices(context);
					const doc = services.familyStore.files.getKnowledge(
						scope.botId,
						args.slug,
					);
					if (!doc) {
						return toolText(
							JSON.stringify({
								slug: args.slug,
								exists: false,
								version: 0,
							}),
						);
					}
					return toolText(
						JSON.stringify({
							slug: doc.slug,
							exists: true,
							version: doc.version,
							description: doc.description,
							...(doc.category ? { category: doc.category } : {}),
							body: doc.body,
						}),
					);
				},
			}),

			defineTool({
				name: "knowledge_update",
				description:
					"Create or replace one knowledge entry on you, the bot running this turn. There is no target argument; a slug that names another bot still writes your own knowledge. Pass expectedVersion (or version) from knowledge_read (0 when creating), a 1-line description (<= 240 chars), optional 1-line category (<= 64 chars), and markdown body. To give a new peer its own documents, pass them as create_bot knowledge instead of calling this tool.",
				parameters: Type.Object({
					slug: Type.String(),
					description: Type.String(),
					category: Type.Optional(Type.String()),
					body: Type.String(),
					expectedVersion: Type.Optional(Type.Number()),
					version: Type.Optional(Type.Number()),
				}),
				replay: "safe",
				executionMode: "sequential",
				async execute(args, api, context) {
					const prior = await api.memo<JsonValue>("result", context);
					if (prior !== undefined) {
						return toolText(JSON.stringify(prior));
					}
					const scope = await resolveBotScope(api, context);
					if (!scope) {
						return toolError("Conversation is not bound to a bot.");
					}
					const expectedVersion = args.expectedVersion ?? args.version ?? 0;
					if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
						return toolError("expectedVersion must be a non-negative integer.");
					}
					try {
						const services = requireCadmusServices(context);
						const existing = services.familyStore.files.getKnowledge(
							scope.botId,
							args.slug,
						);
						const category =
							args.category === undefined
								? existing?.category
								: args.category === ""
									? undefined
									: args.category;
						const updated = services.familyStore.files.updateKnowledge(
							scope.botId,
							{
								slug: args.slug,
								description: args.description,
								category,
								body: args.body,
								expectedVersion,
							},
						);
						getLogger().debug("knowledge_update tool succeeded", {
							bot: scope.botId,
							slug: updated.slug,
							version: updated.version,
						});
						const record = {
							slug: updated.slug,
							version: updated.version,
							description: updated.description,
							...(updated.category ? { category: updated.category } : {}),
						};
						await api.memo("result", record, context);
						return toolText(JSON.stringify(record));
					} catch (error) {
						return toolError((error as Error).message);
					}
				},
			}),

			defineTool({
				name: "knowledge_delete",
				description:
					"Delete one of your own knowledge entries by slug and expectedVersion (or version). This cannot delete another bot's knowledge.",
				parameters: Type.Object({
					slug: Type.String(),
					expectedVersion: Type.Optional(Type.Number()),
					version: Type.Optional(Type.Number()),
				}),
				replay: "safe",
				executionMode: "sequential",
				async execute(args, api, context) {
					const prior = await api.memo<JsonValue>("deleted", context);
					if (prior !== undefined) {
						return toolText(JSON.stringify(prior));
					}
					const scope = await resolveBotScope(api, context);
					if (!scope) {
						return toolError("Conversation is not bound to a bot.");
					}
					const expectedVersion = args.expectedVersion ?? args.version;
					if (
						expectedVersion === undefined ||
						!Number.isInteger(expectedVersion) ||
						expectedVersion < 1
					) {
						return toolError("expectedVersion must be a positive integer.");
					}
					try {
						const services = requireCadmusServices(context);
						services.familyStore.files.deleteKnowledge(
							scope.botId,
							args.slug,
							expectedVersion,
						);
						getLogger().debug("knowledge_delete tool succeeded", {
							bot: scope.botId,
							slug: args.slug,
						});
						const record = { deleted: args.slug };
						await api.memo("deleted", record, context);
						return toolText(JSON.stringify(record));
					} catch (error) {
						return toolError((error as Error).message);
					}
				},
			}),

			defineTool({
				name: "memory_read",
				description:
					"Read MEMORY.md for you, the bot running this turn. Returns exists, version, and content/body. This does not read a peer.",
				parameters: Type.Object({}),
				replay: "safe",
				async execute(_args, api, context) {
					const scope = await resolveBotScope(api, context);
					if (!scope) {
						return toolError("Conversation is not bound to a bot.");
					}
					const services = requireCadmusServices(context);
					const mem = services.familyStore.files.getMemory(scope.botId);
					return toolText(
						JSON.stringify({
							exists: mem.version > 0,
							version: mem.version,
							content: mem.content,
							body: mem.content,
						}),
					);
				},
			}),

			defineTool({
				name: "memory_update",
				description: `Create or replace MEMORY.md for you, the bot running this turn, with optimistic concurrency (CAS). This never updates a peer. Pass expectedVersion (or version) from memory_read (0 when creating) and content (or body) up to ${MAX_MEMORY_BYTES} bytes without a leading --- frontmatter fence. To seed a new peer's memory, pass memory on create_bot.`,
				parameters: Type.Object({
					content: Type.Optional(Type.String()),
					body: Type.Optional(Type.String()),
					expectedVersion: Type.Optional(Type.Number()),
					version: Type.Optional(Type.Number()),
				}),
				replay: "safe",
				executionMode: "sequential",
				async execute(args, api, context) {
					const prior = await api.memo<JsonValue>("result", context);
					if (prior !== undefined) {
						return toolText(JSON.stringify(prior));
					}
					const scope = await resolveBotScope(api, context);
					if (!scope) {
						return toolError("Conversation is not bound to a bot.");
					}
					const content = args.content ?? args.body;
					if (typeof content !== "string") {
						return toolError("content (or body) string is required.");
					}
					const expectedVersion = args.expectedVersion ?? args.version ?? 0;
					if (!Number.isInteger(expectedVersion) || expectedVersion < 0) {
						return toolError("expectedVersion must be a non-negative integer.");
					}
					try {
						const services = requireCadmusServices(context);
						const updated = services.familyStore.files.updateMemory(
							scope.botId,
							content,
							expectedVersion,
						);
						getLogger().debug("memory_update tool succeeded", {
							bot: scope.botId,
							version: updated.version,
						});
						const record = {
							version: updated.version,
							bytes: new TextEncoder().encode(updated.content).byteLength,
						};
						await api.memo("result", record, context);
						return toolText(JSON.stringify(record));
					} catch (error) {
						return toolError((error as Error).message);
					}
				},
			}),
		],
	});
}
