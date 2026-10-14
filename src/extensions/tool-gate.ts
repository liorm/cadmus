import {
	AgentDoc,
	defineExtension,
	hook,
	ToolTask,
} from "@earendil-works/pi-durable";
import { BotsDoc } from "../channels/bots.ts";
import { botIdFromCwd } from "./self-tools/host.ts";

/**
 * Blocks a tool the bot has switched off. The agent tool list is the offer;
 * this still refuses a call that was admitted under an older list.
 */
export function toolGateExtension(home: string) {
	return defineExtension({
		name: "pi-bot.tool-gate",
		hooks: [
			hook(ToolTask, {
				async beforeTool(call, api, context) {
					const agent = await api.snapshot(
						AgentDoc,
						api.conversationId,
						context,
					);
					const botId = botIdFromCwd(home, agent?.cwd);
					if (!botId)
						return {
							block: "This conversation is not inside a bot folder.",
						};
					const bots = await api.snapshot(BotsDoc, context);
					const bot = bots?.items.find((item) => item.id === botId);
					if (!bot || bot.tools === undefined) return;
					if (bot.tools.includes(call.name)) return;
					return { block: "That tool is off for this bot." };
				},
			}),
		],
	});
}
