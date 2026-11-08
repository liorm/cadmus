import { defineExtension, section } from "@earendil-works/pi-durable";
import {
	createBashTool,
	createEditTool,
	createReadTool,
	createWriteTool,
	type ReadToolOptions,
} from "@earendil-works/pi-durable/tools";
import { requireCadmusServices } from "../context.js";
import { isCodingTool } from "../tools-env/pure.js";
import type { CadmusExtensionDescriptor } from "./cadmus-tools.js";

/**
 * Cadmus coding tools extension (`read`, `write`, `edit`, `bash`).
 * Mutating and shell tools (`write`, `edit`, `bash`) specify `executionMode: "sequential"`
 * so that any round containing them executes in causal call order rather than racing concurrently.
 * Read-only tools (`read`) remain parallel.
 */
export function createCadmusCodingTools(options?: ReadToolOptions) {
	return defineExtension({
		name: "coding-tools",
		sections: [
			section("tools-env", async (input, context) => {
				const botId = input.agent.cwd;
				if (!botId) return undefined;
				const services = requireCadmusServices(context);
				const described = await services.describeToolsEnv({
					conversationId: input.conversationId as unknown as number,
					botId,
					toolNames: input.agent.tools
						.map((tool) => tool.name)
						.filter(isCodingTool),
				});
				return described?.name === "tools-env" ? described.text : undefined;
			}),
		],
		tools: [
			{ ...createBashTool(), executionMode: "sequential" as const },
			createReadTool(options), // Cadmus settings read-only: workspace read.
			{ ...createWriteTool(), executionMode: "sequential" as const },
			{ ...createEditTool(), executionMode: "sequential" as const },
		],
	});
}

export function codingToolsExtensionDescriptor(
	options?: ReadToolOptions,
): CadmusExtensionDescriptor {
	return {
		extension: createCadmusCodingTools(options),
		defaultEnabled: false,
		allowlistPolicy: { mode: "catalog" },
		isActive: (ctx) => ctx.codingToolsOffered,
	};
}
