import {
	CODE_EXECUTE_TOOL_NAME,
	isReadOnlyGroupTool,
	readOnlyGroupToolNames,
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
	noteProviderTools,
	omitCodeExecuteFromProviderMessages,
	omitProviderTools,
	providerToolNames,
} from "./provider-tools.js";

const CODE_EXECUTE_ENV_BLOCK =
	"code.execute is disabled while the workspace tools env is on; use bash";

const READONLY_GROUP_BLOCK =
	"This group chat is read-only. Only knowledge_read and memory_read are available.";

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
					let messages = request.messages;
					if (consult) {
						const bot = botId
							? services.familyStore.bots.getBot(botId)
							: undefined;
						const allowed = new Set(readOnlyGroupToolNames(bot?.tools));
						const drop = providerToolNames(messages).filter(
							(name) => !allowed.has(name),
						);
						messages = omitProviderTools(messages, drop);
					} else {
						messages = offered
							? omitCodeExecuteFromProviderMessages(messages)
							: messages;
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
					if (
						consultMember(services, api.conversationId as unknown as number) &&
						!isReadOnlyGroupTool(call.name)
					) {
						getLogger().warn("tool call blocked in read-only group chat", {
							bot: botId,
							tool: call.name,
							session: api.conversationId,
						});
						return { block: READONLY_GROUP_BLOCK };
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

						if (
							call.name === "write" ||
							call.name === "edit" ||
							call.name === "read"
						) {
							const path =
								typeof (call.arguments as { path?: unknown })?.path === "string"
									? (call.arguments as { path: string }).path.trim()
									: "";
							const normalized = path
								.toLowerCase()
								.replace(/\\/g, "/")
								.replace(/^\/workspace\//, "")
								.replace(/^\.\//, "");
							if (
								normalized === "memory.md" ||
								normalized.endsWith("/memory.md") ||
								normalized === "soul.md" ||
								normalized.endsWith("/soul.md") ||
								normalized.startsWith("knowledge/")
							) {
								getLogger().warn("coding tool call blocked on virtual entity", {
									bot: botId,
									tool: call.name,
									path,
									session: api.conversationId,
								});
								return {
									block: `'${path}' is a virtual entity in the bot database, not a workspace file. Do not use '${call.name}' on it. Use dedicated tools: 'memory_read'/'memory_update' for MEMORY.md, and 'knowledge_read'/'knowledge_update'/'knowledge_delete' for knowledge.`,
								};
							}
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
