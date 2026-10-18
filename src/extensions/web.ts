import type { Context } from "@earendil-works/chord";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { unavailableToolMessage } from "./provider-tools.ts";

/**
 * Catalog tools whose real work is either a provider server tool or, later, a
 * local implementation. Nothing here calls the network. Replay stays unsafe.
 */
async function unavailable(
	name: string,
	api: ToolExecutionApi,
	context: Context,
) {
	const agent = await api.agent(context);
	return {
		output: [
			{
				type: "text" as const,
				text: unavailableToolMessage(name, agent.model?.provider ?? "unknown"),
			},
		],
		isError: true,
	};
}

export function webExtension() {
	return defineExtension({
		name: "pi-bot.web",
		tools: [
			defineTool({
				name: "web.search",
				description: "Search the web and return the results.",
				parameters: Type.Object({
					query: Type.String({ description: "Search query." }),
				}),
				replay: "unsafe",
				execute(_args, api, context) {
					return unavailable("web.search", api, context);
				},
			}),
			defineTool({
				name: "web.fetch",
				description: "Fetch the text of one web page.",
				parameters: Type.Object({
					url: Type.String({ description: "Absolute URL to fetch." }),
				}),
				replay: "unsafe",
				execute(_args, api, context) {
					return unavailable("web.fetch", api, context);
				},
			}),
			defineTool({
				name: "x.search",
				description: "Search posts and profiles on X.",
				parameters: Type.Object({
					query: Type.String({ description: "Search query." }),
				}),
				replay: "unsafe",
				execute(_args, api, context) {
					return unavailable("x.search", api, context);
				},
			}),
			defineTool({
				name: "code.execute",
				description: "Run Python in a sandbox and return the output.",
				parameters: Type.Object({
					code: Type.String({ description: "Python source to run." }),
				}),
				replay: "unsafe",
				execute(_args, api, context) {
					return unavailable("code.execute", api, context);
				},
			}),
		],
	});
}
