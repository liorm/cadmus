import {
	AgentDoc,
	defineExtension,
	hook,
	ToolTask,
} from "@earendil-works/pi-durable";
import { requireCadmusServices } from "../context.js";
import { getLogger } from "../log.js";

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
