import { defineExtension } from "@earendil-works/pi-durable";
import type { SelfHost } from "../self-tools/host.ts";
import { createBotTool } from "./create.ts";
import { messageBotTool } from "./message.ts";
import { searchBotTool } from "./search.ts";
import { SearchBotTask } from "./search-task.ts";

/** Model tools that create, find, and (later) message bots in this process. */
export function internalExtension(host: SelfHost) {
	return defineExtension({
		name: "pi-bot.internal",
		tools: [createBotTool(host), searchBotTool(host), messageBotTool()],
		tasks: [SearchBotTask],
	});
}
