import type { Context } from "@earendil-works/chord/context";
import {
	defineExtension,
	defineTool,
	type ToolExecutionApi,
	type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import {
	createEditTool,
	createReadTool,
	createWriteTool,
	type ReadToolOptions,
} from "@earendil-works/pi-durable/tools";
import { Type } from "typebox";
import { requireCadmusServices } from "../context.js";
import { getLogger } from "../log.js";
import {
	formatSkillMarkdown,
	parseSkillMarkdown,
} from "../store/sqlite-family.js";
import type { CadmusExtensionDescriptor } from "./cadmus-tools.js";
import { DEFAULT_SOUL } from "./identity.js";
import {
	applyVirtualEdits,
	MEMORY_VFS_PATH,
	parseVirtualPath,
	SOUL_VFS_PATH,
	sliceTextLines,
} from "./vfs.js";

export const WORKSPACE_ENV_DISABLED_ERROR =
	"No workspace tools environment is enabled for this conversation. Only Cadmus virtual files (/.cadmus/SOUL.md, /.cadmus/MEMORY.md, /.cadmus/skills/<slug>/SKILL.md) are accessible.";

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

type MemoEditResult = {
	text: string;
	patch: string;
	firstChangedLine?: number;
};

export function filesExtension(options?: ReadToolOptions) {
	const baseRead = createReadTool(options);
	const baseWrite = createWriteTool();
	const baseEdit = createEditTool();

	return defineExtension({
		name: "cadmus.files",
		tools: [
			defineTool({
				name: "read",
				description: `Read a file. Supports Cadmus virtual files (${SOUL_VFS_PATH}, ${MEMORY_VFS_PATH}, /.cadmus/skills/<slug>/SKILL.md) and, when a workspace tools environment is enabled, workspace files and images. Use offset/limit for large files.`,
				parameters: baseRead.parameters,
				replay: "safe",
				async execute(args, api, context) {
					const parsed = parseVirtualPath(args.path);
					const scope = await resolveBotScope(api, context);
					if (!scope) {
						return toolError("Conversation is not bound to a bot.");
					}
					const services = requireCadmusServices(context);

					if (!parsed) {
						const envOn = await services.workspaceEnvEnabled(
							api.conversationId as unknown as number,
							scope.botId,
						);
						if (!envOn) {
							return toolError(WORKSPACE_ENV_DISABLED_ERROR);
						}
						return baseRead.execute(args, api, context);
					}

					if (parsed.kind === "invalid") {
						return toolError(parsed.error);
					}
					if (parsed.kind === "soul") {
						const raw =
							services.familyStore.files.getSoul(scope.botId).trim() ||
							DEFAULT_SOUL;
						const sliced = sliceTextLines(raw, args.offset, args.limit);
						return toolText(sliced.text);
					}
					if (parsed.kind === "memory") {
						const mem = services.familyStore.files.getMemory(scope.botId);
						const sliced = sliceTextLines(mem.content, args.offset, args.limit);
						return toolText(sliced.text);
					}
					const doc = services.familyStore.files.getSkill(
						scope.botId,
						parsed.slug,
					);
					if (!doc) {
						return toolError(`Skill file '${parsed.canonicalPath}' not found.`);
					}
					const formatted = formatSkillMarkdown(doc);
					const sliced = sliceTextLines(formatted, args.offset, args.limit);
					return toolText(sliced.text);
				},
			}),

			defineTool({
				name: "write",
				description: `Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Supports Cadmus virtual files (${MEMORY_VFS_PATH} and /.cadmus/skills/<slug>/SKILL.md with YAML frontmatter) and, when a workspace tools environment is enabled, workspace files. ${SOUL_VFS_PATH} is read-only.`,
				parameters: baseWrite.parameters,
				replay: "safe",
				executionMode: "sequential",
				async execute(args, api, context) {
					const parsed = parseVirtualPath(args.path);
					const scope = await resolveBotScope(api, context);
					if (!scope) {
						return toolError("Conversation is not bound to a bot.");
					}
					const services = requireCadmusServices(context);

					if (!parsed) {
						const envOn = await services.workspaceEnvEnabled(
							api.conversationId as unknown as number,
							scope.botId,
						);
						if (!envOn) {
							return toolError(WORKSPACE_ENV_DISABLED_ERROR);
						}
						return baseWrite.execute(args, api, context);
					}

					if (parsed.kind === "invalid") {
						return toolError(parsed.error);
					}
					if (parsed.kind === "soul") {
						return toolError(
							`${SOUL_VFS_PATH} is read-only and cannot be modified by the bot.`,
						);
					}

					const prior = await api.memo<string>("result", context);
					if (prior !== undefined) {
						return toolText(prior);
					}

					try {
						if (parsed.kind === "memory") {
							const updated = services.familyStore.files.updateMemory(
								scope.botId,
								args.content,
							);
							getLogger().debug("virtual memory write succeeded", {
								bot: scope.botId,
								version: updated.version,
							});
							const text = `Successfully wrote to ${MEMORY_VFS_PATH}`;
							await api.memo("result", text, context);
							return toolText(text);
						}

						const parsedMd = parseSkillMarkdown(args.content);
						if (parsedMd.name && parsedMd.name !== parsed.slug) {
							return toolError(
								`Skill frontmatter name '${parsedMd.name}' does not match path slug '${parsed.slug}'.`,
							);
						}
						if (!parsedMd.description.trim()) {
							return toolError(
								"Skill frontmatter must include a non-empty one-line 'description'.",
							);
						}
						const updated = services.familyStore.files.updateSkill(
							scope.botId,
							{
								slug: parsed.slug,
								description: parsedMd.description,
								category: parsedMd.category,
								body: parsedMd.body,
							},
						);
						getLogger().debug("virtual skill write succeeded", {
							bot: scope.botId,
							slug: updated.slug,
							version: updated.version,
						});
						const text = `Successfully wrote to ${parsed.canonicalPath}`;
						await api.memo("result", text, context);
						return toolText(text);
					} catch (error) {
						return toolError((error as Error).message);
					}
				},
			}),

			defineTool({
				name: "edit",
				description: `Edit a single file using exact text replacement. Supports Cadmus virtual files (${MEMORY_VFS_PATH} and /.cadmus/skills/<slug>/SKILL.md) and, when a workspace tools environment is enabled, workspace files. ${SOUL_VFS_PATH} is read-only. Every edits[].oldText must match a unique, non-overlapping region of the original file.`,
				parameters: baseEdit.parameters,
				prepareArguments: baseEdit.prepareArguments,
				replay: "safe",
				executionMode: "sequential",
				async execute(args, api, context) {
					const parsed = parseVirtualPath(args.path);
					const scope = await resolveBotScope(api, context);
					if (!scope) {
						return toolError("Conversation is not bound to a bot.");
					}
					const services = requireCadmusServices(context);

					if (!parsed) {
						const envOn = await services.workspaceEnvEnabled(
							api.conversationId as unknown as number,
							scope.botId,
						);
						if (!envOn) {
							return toolError(WORKSPACE_ENV_DISABLED_ERROR);
						}
						return baseEdit.execute(args, api, context);
					}

					if (parsed.kind === "invalid") {
						return toolError(parsed.error);
					}
					if (parsed.kind === "soul") {
						return toolError(
							`${SOUL_VFS_PATH} is read-only and cannot be modified by the bot.`,
						);
					}

					const prior = await api.memo<MemoEditResult>("result", context);
					if (prior !== undefined) {
						return {
							output: [{ type: "text", text: prior.text }],
							details: {
								diff: prior.patch,
								patch: prior.patch,
								...(prior.firstChangedLine !== undefined
									? { firstChangedLine: prior.firstChangedLine }
									: {}),
							},
						};
					}

					try {
						if (parsed.kind === "memory") {
							const mem = services.familyStore.files.getMemory(scope.botId);
							const edited = applyVirtualEdits(
								mem.content,
								args.edits,
								MEMORY_VFS_PATH,
							);
							const updated = services.familyStore.files.updateMemory(
								scope.botId,
								edited.finalContent,
							);
							getLogger().debug("virtual memory edit succeeded", {
								bot: scope.botId,
								version: updated.version,
							});
							const memoVal: MemoEditResult = {
								text: `Successfully replaced ${args.edits.length} block(s) in ${MEMORY_VFS_PATH}.`,
								patch: edited.patch,
								...(edited.firstChangedLine !== undefined
									? { firstChangedLine: edited.firstChangedLine }
									: {}),
							};
							await api.memo("result", memoVal, context);
							return {
								output: [{ type: "text", text: memoVal.text }],
								details: {
									diff: memoVal.patch,
									patch: memoVal.patch,
									...(memoVal.firstChangedLine !== undefined
										? { firstChangedLine: memoVal.firstChangedLine }
										: {}),
								},
							};
						}

						const existing = services.familyStore.files.getSkill(
							scope.botId,
							parsed.slug,
						);
						if (!existing) {
							return toolError(
								`Could not edit '${parsed.canonicalPath}': file not found. Use write to create it.`,
							);
						}
						const currentMarkdown = formatSkillMarkdown(existing);
						const edited = applyVirtualEdits(
							currentMarkdown,
							args.edits,
							parsed.canonicalPath,
						);
						const parsedMd = parseSkillMarkdown(edited.finalContent);
						if (parsedMd.name && parsedMd.name !== parsed.slug) {
							return toolError(
								`Skill frontmatter name '${parsedMd.name}' does not match path slug '${parsed.slug}'.`,
							);
						}
						if (!parsedMd.description.trim()) {
							return toolError(
								"Skill frontmatter must include a non-empty one-line 'description'.",
							);
						}
						const updated = services.familyStore.files.updateSkill(
							scope.botId,
							{
								slug: parsed.slug,
								description: parsedMd.description,
								category: parsedMd.category,
								body: parsedMd.body,
							},
						);
						getLogger().debug("virtual skill edit succeeded", {
							bot: scope.botId,
							slug: updated.slug,
							version: updated.version,
						});
						const memoVal: MemoEditResult = {
							text: `Successfully replaced ${args.edits.length} block(s) in ${parsed.canonicalPath}.`,
							patch: edited.patch,
							...(edited.firstChangedLine !== undefined
								? { firstChangedLine: edited.firstChangedLine }
								: {}),
						};
						await api.memo("result", memoVal, context);
						return {
							output: [{ type: "text", text: memoVal.text }],
							details: {
								diff: memoVal.patch,
								patch: memoVal.patch,
								...(memoVal.firstChangedLine !== undefined
									? { firstChangedLine: memoVal.firstChangedLine }
									: {}),
							},
						};
					} catch (error) {
						return toolError((error as Error).message);
					}
				},
			}),

			defineTool({
				name: "delete",
				description: `Delete a file. Supports Cadmus virtual skills (/.cadmus/skills/<slug>/SKILL.md) and, when a workspace tools environment is enabled, workspace files or directories. ${SOUL_VFS_PATH} is read-only; to clear ${MEMORY_VFS_PATH}, write empty content to it.`,
				parameters: Type.Object({
					path: Type.String({
						description:
							"Path to the file to delete (e.g. '/.cadmus/skills/<slug>/SKILL.md' or a workspace path).",
					}),
					recursive: Type.Optional(
						Type.Boolean({
							description:
								"For workspace directories only: remove recursively when true.",
						}),
					),
				}),
				replay: "safe",
				executionMode: "sequential",
				async execute(args, api, context) {
					const parsed = parseVirtualPath(args.path);
					const scope = await resolveBotScope(api, context);
					if (!scope) {
						return toolError("Conversation is not bound to a bot.");
					}
					const services = requireCadmusServices(context);

					if (!parsed) {
						const envOn = await services.workspaceEnvEnabled(
							api.conversationId as unknown as number,
							scope.botId,
						);
						if (!envOn) {
							return toolError(WORKSPACE_ENV_DISABLED_ERROR);
						}
						const env = api.env;
						if (!env) {
							return toolError("No execution environment is configured.");
						}
						const resolved = await env.absolutePath(args.path, context);
						if (!resolved.ok) {
							return toolError(
								`Could not resolve path '${args.path}': ${resolved.error.message}`,
							);
						}
						const removed = await env.remove(
							resolved.value,
							{ recursive: args.recursive === true },
							context,
						);
						if (!removed.ok) {
							return toolError(
								`Could not delete '${args.path}': ${removed.error.message}`,
							);
						}
						return toolText(`Successfully deleted ${args.path}`);
					}

					if (parsed.kind === "invalid") {
						return toolError(parsed.error);
					}
					if (parsed.kind === "soul") {
						return toolError(
							`${SOUL_VFS_PATH} is read-only and cannot be deleted by the bot.`,
						);
					}
					if (parsed.kind === "memory") {
						return toolError(
							`${MEMORY_VFS_PATH} cannot be deleted. Write empty content to ${MEMORY_VFS_PATH} to clear it.`,
						);
					}

					const prior = await api.memo<string>("deleted", context);
					if (prior !== undefined) {
						return toolText(prior);
					}

					try {
						services.familyStore.files.deleteSkill(scope.botId, parsed.slug);
						getLogger().debug("virtual skill delete succeeded", {
							bot: scope.botId,
							slug: parsed.slug,
						});
						const text = `Successfully deleted ${parsed.canonicalPath}`;
						await api.memo("deleted", text, context);
						return toolText(text);
					} catch (error) {
						return toolError((error as Error).message);
					}
				},
			}),
		],
	});
}

export function filesExtensionDescriptor(
	options?: ReadToolOptions,
): CadmusExtensionDescriptor {
	return {
		extension: filesExtension(options),
		defaultEnabled: true,
		allowlistPolicy: { mode: "catalog" },
		isActive: () => true,
	};
}
