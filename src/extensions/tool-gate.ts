import {
	AgentDoc,
	defineExtension,
	hook,
	ToolTask,
} from "@earendil-works/pi-durable";
import { requireCadmusServices } from "../context.js";
import { getLogger } from "../log.js";
import { isCodingTool } from "../tools-env/pure.js";

/**
 * Enforces per-bot `bot.tools` allowlist on every tool execution.
 */
export function toolGateExtension() {
	return defineExtension({
		name: "cadmus.tool-gate",
		hooks: [
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
					const bot = services.familyStore.bots.getBot(botId);
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
