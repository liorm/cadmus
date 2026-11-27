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
	CADMUS_VFS_ROOT,
	collectVirtualFiles,
	compileGlob,
	findVirtualFiles,
	grepVirtualFiles,
	isVirtualScopePath,
	listVirtualEntries,
	MEMORY_VFS_PATH,
	matchGlobFilter,
	parseVirtualPath,
	SOUL_VFS_PATH,
	sliceTextLines,
} from "./vfs.js";

export const WORKSPACE_ENV_DISABLED_ERROR =
	"No workspace tools environment is enabled for this conversation. Only Cadmus virtual files (/.cadmus/SOUL.md, /.cadmus/MEMORY.md, /.cadmus/skills/bot/<slug>/SKILL.md, /.cadmus/skills/family/<slug>/SKILL.md) are accessible.";

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

const MAX_WORKSPACE_LS_ENTRIES = 500;
const MAX_WORKSPACE_WALK_FILES = 500;
const MAX_WORKSPACE_GREP_FILE_BYTES = 256 * 1024;
const MAX_GREP_SNIPPET_CHARS = 300;
const MAX_FIND_RESULTS = 200;

function joinPosix(base: string, rel: string): string {
	if (!rel) return base;
	return base === "/" ? `/${rel}` : `${base.replace(/\/+$/, "")}/${rel}`;
}

async function walkWorkspaceTree(
	env: NonNullable<ToolExecutionApi["env"]>,
	absRoot: string,
	context: Context,
	options: { maxDepth: number; maxEntries: number },
): Promise<
	| {
			ok: true;
			items: Array<{
				relPath: string;
				absPath: string;
				kind: string;
				size: number;
			}>;
			truncated: boolean;
	  }
	| { ok: false; error: string }
> {
	const items: Array<{
		relPath: string;
		absPath: string;
		kind: string;
		size: number;
	}> = [];
	let truncated = false;

	const visit = async (
		dirAbs: string,
		prefix: string,
		depth: number,
	): Promise<string | null> => {
		const listed = await env.listDir(dirAbs, context);
		if (!listed.ok) {
			return listed.error.message;
		}
		const sorted = [...listed.value].sort((a, b) =>
			a.name.localeCompare(b.name),
		);
		for (const entry of sorted) {
			if (entry.name === ".git") continue;
			if (items.length >= options.maxEntries) {
				truncated = true;
				return null;
			}
			const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
			const absPath = joinPosix(dirAbs, entry.name);
			items.push({
				relPath,
				absPath,
				kind: entry.kind,
				size: entry.size,
			});
			if (entry.kind === "directory" && depth < options.maxDepth) {
				if (entry.name === "node_modules") continue;
				const errMsg = await visit(absPath, relPath, depth + 1);
				if (errMsg) return errMsg;
				if (truncated) return null;
			}
		}
		return null;
	};

	const errMsg = await visit(absRoot, "", 1);
	if (errMsg) return { ok: false, error: errMsg };
	return { ok: true, items, truncated };
}

async function listWorkspaceFiles(
	env: NonNullable<ToolExecutionApi["env"]>,
	absRoot: string,
	context: Context,
): Promise<
	| {
			ok: true;
			files: Array<{ relPath: string; absPath: string }>;
			truncated: boolean;
	  }
	| { ok: false; error: string }
> {
	if (env.listFiles) {
		const listed = await env.listFiles(
			absRoot,
			{ maxEntries: 5000, exclude: ["node_modules"] },
			context,
		);
		if (listed.ok) {
			const files = listed.value.entries
				.filter((e) => e.kind === "file")
				.map((e) => ({
					relPath: e.path,
					absPath: joinPosix(absRoot, e.path),
				}));
			return { ok: true, files, truncated: listed.value.truncated };
		}
		if (listed.error.code !== "not_supported") {
			return { ok: false, error: listed.error.message };
		}
	}

	const walked = await walkWorkspaceTree(env, absRoot, context, {
		maxDepth: 20,
		maxEntries: 5000,
	});
	if (!walked.ok) return walked;
	return {
		ok: true,
		files: walked.items
			.filter((i) => i.kind === "file")
			.map((i) => ({ relPath: i.relPath, absPath: i.absPath })),
		truncated: walked.truncated,
	};
}

export function filesExtension(options?: ReadToolOptions) {
	const baseRead = createReadTool(options);
	const baseWrite = createWriteTool();
	const baseEdit = createEditTool();

	return defineExtension({
		name: "cadmus.files",
		tools: [
			defineTool({
				name: "read",
				description: `Read a file. Supports Cadmus virtual files (${SOUL_VFS_PATH}, ${MEMORY_VFS_PATH}, /.cadmus/skills/bot/<slug>/SKILL.md, /.cadmus/skills/family/<slug>/SKILL.md) and, when a workspace tools environment is enabled, workspace files and images. Use offset/limit for large files.`,
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
					const doc =
						parsed.scope === "family"
							? services.familyStore.files.getFamilySkill(parsed.slug)
							: services.familyStore.files.getSkill(scope.botId, parsed.slug);
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
				description: `Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Supports Cadmus virtual files (${MEMORY_VFS_PATH}, /.cadmus/skills/bot/<slug>/SKILL.md, and /.cadmus/skills/family/<slug>/SKILL.md with YAML frontmatter) and, when a workspace tools environment is enabled, workspace files. ${SOUL_VFS_PATH} is read-only.`,
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
						const updated =
							parsed.scope === "family"
								? services.familyStore.files.updateFamilySkill({
										slug: parsed.slug,
										description: parsedMd.description,
										category: parsedMd.category,
										body: parsedMd.body,
									})
								: services.familyStore.files.updateSkill(scope.botId, {
										slug: parsed.slug,
										description: parsedMd.description,
										category: parsedMd.category,
										body: parsedMd.body,
									});
						getLogger().debug("virtual skill write succeeded", {
							bot: scope.botId,
							scope: parsed.scope,
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
				description: `Edit a single file using exact text replacement. Supports Cadmus virtual files (${MEMORY_VFS_PATH}, /.cadmus/skills/bot/<slug>/SKILL.md, and /.cadmus/skills/family/<slug>/SKILL.md) and, when a workspace tools environment is enabled, workspace files. ${SOUL_VFS_PATH} is read-only. Every edits[].oldText must match a unique, non-overlapping region of the original file.`,
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

						const existing =
							parsed.scope === "family"
								? services.familyStore.files.getFamilySkill(parsed.slug)
								: services.familyStore.files.getSkill(scope.botId, parsed.slug);
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
						const updated =
							parsed.scope === "family"
								? services.familyStore.files.updateFamilySkill({
										slug: parsed.slug,
										description: parsedMd.description,
										category: parsedMd.category,
										body: parsedMd.body,
									})
								: services.familyStore.files.updateSkill(scope.botId, {
										slug: parsed.slug,
										description: parsedMd.description,
										category: parsedMd.category,
										body: parsedMd.body,
									});
						getLogger().debug("virtual skill edit succeeded", {
							bot: scope.botId,
							scope: parsed.scope,
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
				description: `Delete a file. Supports Cadmus virtual skills (/.cadmus/skills/bot/<slug>/SKILL.md and /.cadmus/skills/family/<slug>/SKILL.md) and, when a workspace tools environment is enabled, workspace files or directories. ${SOUL_VFS_PATH} is read-only; to clear ${MEMORY_VFS_PATH}, write empty content to it.`,
				parameters: Type.Object({
					path: Type.String({
						description:
							"Path to the file to delete (e.g. '/.cadmus/skills/bot/<slug>/SKILL.md', '/.cadmus/skills/family/<slug>/SKILL.md', or a workspace path).",
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
						if (parsed.scope === "family") {
							services.familyStore.files.deleteFamilySkill(parsed.slug);
						} else {
							services.familyStore.files.deleteSkill(scope.botId, parsed.slug);
						}
						getLogger().debug("virtual skill delete succeeded", {
							bot: scope.botId,
							scope: parsed.scope,
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

			defineTool({
				name: "ls",
				description: `List entries in a directory. Supports Cadmus virtual directories (${CADMUS_VFS_ROOT}, /.cadmus/skills, /.cadmus/skills/bot, /.cadmus/skills/family) and, when a workspace tools environment is enabled, workspace directories. Omit path to list ${CADMUS_VFS_ROOT} (when no workspace env is enabled) or the workspace root.`,
				parameters: Type.Object({
					path: Type.Optional(
						Type.String({
							description: `Directory path to list (e.g. '${CADMUS_VFS_ROOT}', '/.cadmus/skills', or a workspace path).`,
						}),
					),
					depth: Type.Optional(
						Type.Number({
							description: "Maximum traversal depth (default 1, max 10).",
						}),
					),
					details: Type.Optional(
						Type.Boolean({
							description:
								"Include file sizes and skill descriptions when true.",
						}),
					),
				}),
				replay: "safe",
				async execute(args, api, context) {
					const scope = await resolveBotScope(api, context);
					if (!scope) {
						return toolError("Conversation is not bound to a bot.");
					}
					const services = requireCadmusServices(context);
					const rawPath = args.path?.trim() ?? "";

					if (rawPath && isVirtualScopePath(rawPath)) {
						const entries = collectVirtualFiles(
							services.familyStore.files,
							scope.botId,
							DEFAULT_SOUL,
						);
						const listed = listVirtualEntries(entries, rawPath, {
							depth: args.depth,
							details: args.details,
						});
						return listed.ok ? toolText(listed.text) : toolError(listed.error);
					}

					const envOn = await services.workspaceEnvEnabled(
						api.conversationId as unknown as number,
						scope.botId,
					);
					if (!rawPath && !envOn) {
						const entries = collectVirtualFiles(
							services.familyStore.files,
							scope.botId,
							DEFAULT_SOUL,
						);
						const listed = listVirtualEntries(entries, CADMUS_VFS_ROOT, {
							depth: args.depth,
							details: args.details,
						});
						return listed.ok ? toolText(listed.text) : toolError(listed.error);
					}
					if (!envOn) {
						return toolError(WORKSPACE_ENV_DISABLED_ERROR);
					}
					const env = api.env;
					if (!env) {
						return toolError("No execution environment is configured.");
					}
					const resolved = await env.absolutePath(rawPath || ".", context);
					if (!resolved.ok) {
						return toolError(
							`Could not resolve path '${rawPath || "."}': ${resolved.error.message}`,
						);
					}
					const info = await env.fileInfo(resolved.value, context);
					if (info.ok && info.value.kind !== "directory") {
						return toolText(
							args.details
								? `${resolved.value} [${info.value.kind}, ${info.value.size} bytes]`
								: resolved.value,
						);
					}
					const maxDepth =
						args.depth !== undefined && Number.isFinite(args.depth)
							? Math.min(10, Math.max(1, Math.trunc(args.depth)))
							: 1;
					const walked = await walkWorkspaceTree(env, resolved.value, context, {
						maxDepth,
						maxEntries: MAX_WORKSPACE_LS_ENTRIES,
					});
					if (!walked.ok) {
						return toolError(
							`Could not list '${rawPath || "."}': ${walked.error}`,
						);
					}
					if (walked.items.length === 0) {
						return toolText("(empty)");
					}
					const lines = walked.items.map((item) => {
						const label =
							item.kind === "directory" ? `${item.relPath}/` : item.relPath;
						if (!args.details) return label;
						return item.kind === "directory"
							? `${label} [dir]`
							: `${label} [${item.kind}, ${item.size} bytes]`;
					});
					if (walked.truncated) {
						lines.push(
							`... (truncated at ${MAX_WORKSPACE_LS_ENTRIES} entries)`,
						);
					}
					return toolText(lines.join("\n"));
				},
			}),

			defineTool({
				name: "find",
				description: `Find files matching a glob pattern. Supports Cadmus virtual files (${CADMUS_VFS_ROOT}/**/*.md, /.cadmus/skills/**/*.md) and, when a workspace tools environment is enabled, workspace files.`,
				parameters: Type.Object({
					pattern: Type.String({
						description:
							"Glob pattern to match (e.g. '/.cadmus/skills/**/*.md', '*.md', or 'src/**/*.ts').",
					}),
					path: Type.Optional(
						Type.String({
							description: `Optional base directory to search within (defaults to ${CADMUS_VFS_ROOT} when no workspace env is enabled, or the workspace root).`,
						}),
					),
				}),
				replay: "safe",
				async execute(args, api, context) {
					const scope = await resolveBotScope(api, context);
					if (!scope) {
						return toolError("Conversation is not bound to a bot.");
					}
					const services = requireCadmusServices(context);
					const rawPath = args.path?.trim() ?? "";
					const pattern = args.pattern.trim();
					if (!pattern) {
						return toolError("Glob pattern cannot be empty.");
					}

					const virtualTarget =
						(rawPath && isVirtualScopePath(rawPath)) ||
						(!rawPath && isVirtualScopePath(pattern));
					if (virtualTarget) {
						const entries = collectVirtualFiles(
							services.familyStore.files,
							scope.botId,
							DEFAULT_SOUL,
						);
						const found = findVirtualFiles(
							entries,
							pattern,
							rawPath || CADMUS_VFS_ROOT,
						);
						if (!found.ok) return toolError(found.error);
						if (found.paths.length === 0) return toolText("No matching files.");
						const out = found.truncated
							? `${found.paths.join("\n")}\n... (truncated at ${MAX_FIND_RESULTS} results)`
							: found.paths.join("\n");
						return toolText(out);
					}

					const envOn = await services.workspaceEnvEnabled(
						api.conversationId as unknown as number,
						scope.botId,
					);
					if (!rawPath && !envOn) {
						const entries = collectVirtualFiles(
							services.familyStore.files,
							scope.botId,
							DEFAULT_SOUL,
						);
						const found = findVirtualFiles(entries, pattern, CADMUS_VFS_ROOT);
						if (!found.ok) return toolError(found.error);
						if (found.paths.length === 0) return toolText("No matching files.");
						const out = found.truncated
							? `${found.paths.join("\n")}\n... (truncated at ${MAX_FIND_RESULTS} results)`
							: found.paths.join("\n");
						return toolText(out);
					}
					if (!envOn) {
						return toolError(WORKSPACE_ENV_DISABLED_ERROR);
					}
					const env = api.env;
					if (!env) {
						return toolError("No execution environment is configured.");
					}
					const resolved = await env.absolutePath(rawPath || ".", context);
					if (!resolved.ok) {
						return toolError(
							`Could not resolve path '${rawPath || "."}': ${resolved.error.message}`,
						);
					}
					const listed = await listWorkspaceFiles(env, resolved.value, context);
					if (!listed.ok) {
						return toolError(
							`Could not search '${rawPath || "."}': ${listed.error}`,
						);
					}
					const globRe = compileGlob(pattern);
					const isAbsPattern = pattern.replace(/\\/g, "/").startsWith("/");
					const matched: string[] = [];
					let truncated = false;
					for (const file of listed.files) {
						const hit = isAbsPattern
							? globRe.test(file.absPath)
							: globRe.test(file.relPath) || globRe.test(file.absPath);
						if (!hit) continue;
						if (matched.length >= MAX_FIND_RESULTS) {
							truncated = true;
							break;
						}
						matched.push(file.absPath);
					}
					if (matched.length === 0) return toolText("No matching files.");
					return toolText(
						truncated
							? `${matched.join("\n")}\n... (truncated at ${MAX_FIND_RESULTS} results)`
							: matched.join("\n"),
					);
				},
			}),

			defineTool({
				name: "grep",
				description: `Search file contents for a regex or literal pattern, returning path:line: snippet matches. Supports Cadmus virtual files (${CADMUS_VFS_ROOT}/*) and, when a workspace tools environment is enabled, workspace files.`,
				parameters: Type.Object({
					pattern: Type.String({
						description: "Regular expression or literal string to search for.",
					}),
					path: Type.Optional(
						Type.String({
							description: `Optional file or directory path to restrict search (e.g. '/.cadmus/skills' or a workspace path).`,
						}),
					),
					glob: Type.Optional(
						Type.String({
							description:
								"Optional glob filter for matching file paths (e.g. '*.md').",
						}),
					),
					ignoreCase: Type.Optional(
						Type.Boolean({
							description: "Perform case-insensitive matching when true.",
						}),
					),
					literal: Type.Optional(
						Type.Boolean({
							description:
								"Treat pattern as a literal string rather than a regex when true.",
						}),
					),
					limit: Type.Optional(
						Type.Number({
							description:
								"Maximum number of matching lines to return (default 50, max 200).",
						}),
					),
				}),
				replay: "safe",
				async execute(args, api, context) {
					const scope = await resolveBotScope(api, context);
					if (!scope) {
						return toolError("Conversation is not bound to a bot.");
					}
					const services = requireCadmusServices(context);
					const rawPath = args.path?.trim() ?? "";

					if (!args.pattern) {
						return toolError("Search pattern cannot be empty.");
					}

					if (rawPath && isVirtualScopePath(rawPath)) {
						const entries = collectVirtualFiles(
							services.familyStore.files,
							scope.botId,
							DEFAULT_SOUL,
						);
						const res = grepVirtualFiles(entries, {
							pattern: args.pattern,
							path: rawPath,
							glob: args.glob,
							ignoreCase: args.ignoreCase,
							literal: args.literal,
							limit: args.limit,
						});
						if (!res.ok) return toolError(res.error);
						if (res.matches.length === 0) return toolText("No matches found.");
						return toolText(
							res.truncated
								? `${res.matches.join("\n")}\n... (results truncated)`
								: res.matches.join("\n"),
						);
					}

					const envOn = await services.workspaceEnvEnabled(
						api.conversationId as unknown as number,
						scope.botId,
					);
					if (!rawPath && !envOn) {
						const entries = collectVirtualFiles(
							services.familyStore.files,
							scope.botId,
							DEFAULT_SOUL,
						);
						const res = grepVirtualFiles(entries, {
							pattern: args.pattern,
							glob: args.glob,
							ignoreCase: args.ignoreCase,
							literal: args.literal,
							limit: args.limit,
						});
						if (!res.ok) return toolError(res.error);
						if (res.matches.length === 0) return toolText("No matches found.");
						return toolText(
							res.truncated
								? `${res.matches.join("\n")}\n... (results truncated)`
								: res.matches.join("\n"),
						);
					}
					if (!envOn) {
						return toolError(WORKSPACE_ENV_DISABLED_ERROR);
					}
					const env = api.env;
					if (!env) {
						return toolError("No execution environment is configured.");
					}

					let regex: RegExp;
					try {
						const source = args.literal
							? args.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
							: args.pattern;
						regex = new RegExp(source, args.ignoreCase ? "i" : "");
					} catch (error) {
						return toolError(
							`Invalid regex pattern: ${(error as Error).message}`,
						);
					}

					const resolved = await env.absolutePath(rawPath || ".", context);
					if (!resolved.ok) {
						return toolError(
							`Could not resolve path '${rawPath || "."}': ${resolved.error.message}`,
						);
					}

					const info = await env.fileInfo(resolved.value, context);
					let targets: Array<{ relPath: string; absPath: string }>;
					if (info.ok && info.value.kind === "file") {
						targets = [{ relPath: info.value.name, absPath: resolved.value }];
					} else {
						const listed = await listWorkspaceFiles(
							env,
							resolved.value,
							context,
						);
						if (!listed.ok) {
							return toolError(
								`Could not search '${rawPath || "."}': ${listed.error}`,
							);
						}
						targets = listed.files;
					}

					const globRe = args.glob?.trim() ? compileGlob(args.glob) : undefined;
					const limit =
						args.limit !== undefined && Number.isFinite(args.limit)
							? Math.min(200, Math.max(1, Math.trunc(args.limit)))
							: 50;

					const matches: string[] = [];
					let truncated = false;
					let scanned = 0;

					for (const target of targets) {
						if (scanned >= MAX_WORKSPACE_WALK_FILES) break;
						if (globRe && args.glob) {
							if (
								!matchGlobFilter(
									args.glob,
									globRe,
									target.absPath,
									target.relPath,
								)
							) {
								continue;
							}
						}
						const meta = await env.fileInfo(target.absPath, context);
						if (!meta.ok || meta.value.size > MAX_WORKSPACE_GREP_FILE_BYTES) {
							continue;
						}
						scanned += 1;
						const content = await env.readTextFile(target.absPath, context);
						if (!content.ok) continue;
						const lines = content.value.split("\n");
						for (let i = 0; i < lines.length; i++) {
							const line = lines[i] ?? "";
							if (!regex.test(line)) continue;
							if (matches.length >= limit) {
								truncated = true;
								break;
							}
							const snippet =
								line.length > MAX_GREP_SNIPPET_CHARS
									? `${line.slice(0, MAX_GREP_SNIPPET_CHARS - 3)}...`
									: line;
							matches.push(`${target.absPath}:${i + 1}: ${snippet}`);
						}
						if (truncated) break;
					}

					if (matches.length === 0) return toolText("No matches found.");
					return toolText(
						truncated
							? `${matches.join("\n")}\n... (results truncated)`
							: matches.join("\n"),
					);
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
