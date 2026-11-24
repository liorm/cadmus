import {
	CODE_EXECUTE_TOOL_NAME,
	extractModelProvider,
	isFileTool,
	isReadOnlyGroupTool,
	isTaskTool,
} from "@cadmus/contract/tools";
import {
	AgentDoc,
	defineExtension,
	GenerationTask,
	hook,
	ToolTask,
} from "@earendil-works/pi-durable";
import { requireCadmusServices } from "../context.js";
import { getLogger } from "../log.js";
import { isCodingTool } from "../tools-env/pure.js";
import {
	type CadmusExtensionDescriptor,
	type ExtensionActivationContext,
	resolveConversationExtensionsAndTools,
} from "./cadmus-tools.js";
import {
	noteProviderTools,
	omitProviderTools,
	providerToolNames,
} from "./provider-tools.js";
import { isVirtualScopePath, parseVirtualPath } from "./vfs.js";

const VFS_NAV_TOOLS = new Set(["ls", "find", "grep"]);

function isAllowedVirtualFileCall(toolName: string, args: unknown): boolean {
	const record =
		args && typeof args === "object" ? (args as Record<string, unknown>) : {};
	const rawPath = typeof record.path === "string" ? record.path.trim() : "";
	if (VFS_NAV_TOOLS.has(toolName)) {
		if (rawPath) return isVirtualScopePath(rawPath);
		if (toolName === "find") {
			const pattern =
				typeof record.pattern === "string" ? record.pattern.trim() : "";
			if (pattern.startsWith("/")) return isVirtualScopePath(pattern);
		}
		return true;
	}
	const parsed = parseVirtualPath(rawPath);
	return Boolean(parsed && parsed.kind !== "invalid");
}

const CODE_EXECUTE_ENV_BLOCK =
	"code.execute is disabled while the workspace tools env is on; use bash";

const READONLY_GROUP_BLOCK =
	"This group chat is read-only. Only reading Cadmus virtual files (/.cadmus/SOUL.md, /.cadmus/MEMORY.md, /.cadmus/skills/<slug>/SKILL.md) is available.";

function consultMember(
	services: ReturnType<typeof requireCadmusServices>,
	conversationId: number,
): boolean {
	const chat =
		services.familyStore.chats.getChatByConversationId(conversationId);
	if (!chat) return false;
	const member = services.familyStore.groups.findByMemberKey(chat.key);
	return member?.role === "member" && member.group.toolsReadOnly === true;
}

/**
 * Enforces per-bot `bot.tools` allowlist on every tool execution.
 */
export function toolGateExtension() {
	return defineExtension({
		name: "cadmus.tool-gate",
		hooks: [
			hook(GenerationTask, {
				async beforeRequest(request, api, context) {
					const services = requireCadmusServices(context);
					const agent = await api.snapshot(
						AgentDoc,
						api.conversationId,
						context,
					);
					const botId = agent?.cwd?.trim() ?? "";
					const offered = botId
						? await services.codingToolsOffered(
								api.conversationId as unknown as number,
								botId,
							)
						: false;
					const conversationId = api.conversationId as unknown as number;
					const chat =
						services.familyStore.chats.getChatByConversationId(conversationId);
					const consult = consultMember(services, conversationId);
					const offerEnd = chat
						? services.isGroupCallerSession(chat.key)
						: false;
					const bot = botId
						? services.familyStore.bots.getBot(botId)
						: undefined;
					let messages = request.messages;
					if (bot) {
						const modelRef = agent?.model;
						const provider =
							modelRef?.provider ?? extractModelProvider(bot.model);
						const groupSession =
							chat?.kind === "group" ||
							chat?.kind === "group-member" ||
							Boolean(chat?.key.startsWith("gmem:"));
						const hasActiveTasks = chat
							? services.familyStore.tasks.openCount(chat.key) > 0
							: false;
						const route =
							services.familyStore.chats.getConversationRoute(conversationId);
						const ctx: ExtensionActivationContext = {
							bot,
							chat,
							codingToolsOffered: offered,
							isGroupSession: groupSession,
							isGroupCaller: offerEnd,
							isConsultMember: consult,
							isHarvest: route?.kind === "harvest",
							hasActiveTasks,
							provider,
						};
						const resolved = resolveConversationExtensionsAndTools(ctx);
						const activeSet = new Set(resolved.effectiveToolNames);
						const drop = providerToolNames(messages).filter(
							(name) => !activeSet.has(name),
						);
						messages = omitProviderTools(messages, drop);
					} else {
						if (!offerEnd) {
							messages = omitProviderTools(messages, ["end_conversation"]);
						}
					}
					noteProviderTools(botId, providerToolNames(messages));
					if (messages === request.messages) return undefined;
					return { messages };
				},
			}),
			hook(ToolTask, {
				async beforeTool(call, api, context) {
					const agent = await api.snapshot(
						AgentDoc,
						api.conversationId,
						context,
					);
					const botId = agent?.cwd?.trim();
					if (!botId) {
						getLogger().warn("tool call blocked: unbound conversation", {
							tool: call.name,
							session: api.conversationId,
						});
						return {
							block: "Conversation is not bound to a bot.",
						};
					}
					const services = requireCadmusServices(context);
					if (isTaskTool(call.name)) {
						const chat = services.familyStore.chats.getChatByConversationId(
							api.conversationId as unknown as number,
						);
						const groupSession =
							chat?.kind === "group" ||
							chat?.kind === "group-member" ||
							Boolean(chat?.key.startsWith("gmem:"));
						if (groupSession) {
							return {
								block: "Task tools are not available in group chats.",
							};
						}
					}
					if (
						consultMember(services, api.conversationId as unknown as number)
					) {
						if (!isReadOnlyGroupTool(call.name)) {
							getLogger().warn("tool call blocked in read-only group chat", {
								bot: botId,
								tool: call.name,
								session: api.conversationId,
							});
							return { block: READONLY_GROUP_BLOCK };
						}
						if (isFileTool(call.name)) {
							if (!isAllowedVirtualFileCall(call.name, call.arguments)) {
								const rawPath =
									typeof (call.arguments as { path?: unknown })?.path ===
									"string"
										? (call.arguments as { path: string }).path
										: "";
								getLogger().warn(
									"workspace file read blocked in read-only group chat",
									{
										bot: botId,
										tool: call.name,
										path: rawPath,
										session: api.conversationId,
									},
								);
								return { block: READONLY_GROUP_BLOCK };
							}
						}
					}
					if (isFileTool(call.name)) {
						const route = services.familyStore.chats.getConversationRoute(
							api.conversationId as unknown as number,
						);
						if (route?.kind === "harvest") {
							if (!isAllowedVirtualFileCall(call.name, call.arguments)) {
								return {
									block:
										"Idle harvest can only access Cadmus virtual files (/.cadmus/SOUL.md, /.cadmus/MEMORY.md, /.cadmus/skills/<slug>/SKILL.md).",
								};
							}
						}
					}
					if (call.name === "end_conversation") {
						const chat = services.familyStore.chats.getChatByConversationId(
							api.conversationId as unknown as number,
						);
						if (!chat || !services.isGroupCallerSession(chat.key)) {
							return {
								block:
									"end_conversation is only available in a group chat you started.",
							};
						}
						return;
					}
					const bot = services.familyStore.bots.getBot(botId);
					if (call.name === CODE_EXECUTE_TOOL_NAME && bot) {
						const offered = await services.codingToolsOffered(
							api.conversationId as unknown as number,
							bot.id,
						);
						if (offered) {
							getLogger().warn("tool call blocked by tool-gate", {
								bot: botId,
								tool: call.name,
								session: api.conversationId,
							});
							return { block: CODE_EXECUTE_ENV_BLOCK };
						}
					}
					if (isCodingTool(call.name)) {
						const allowed = bot
							? await services.codingToolAllowed(
									api.conversationId,
									bot.id,
									call.name,
								)
							: false;
						if (!allowed) {
							getLogger().warn("tool call blocked by tool-gate", {
								bot: botId,
								tool: call.name,
								session: api.conversationId,
							});
							return {
								block: `Tool '${call.name}' is disabled for bot '${botId}'.`,
							};
						}
						return;
					}
					if (!bot || bot.tools === undefined) return;
					if (bot.tools.includes(call.name)) return;
					getLogger().warn("tool call blocked by tool-gate", {
						bot: botId,
						tool: call.name,
						session: api.conversationId,
					});
					return {
						block: `Tool '${call.name}' is disabled for bot '${botId}'.`,
					};
				},
			}),
		],
	});
}

export function toolGateExtensionDescriptor(): CadmusExtensionDescriptor {
	return {
		extension: toolGateExtension(),
		defaultEnabled: true,
		allowlistPolicy: { mode: "always" },
		isActive: () => true,
	};
}
