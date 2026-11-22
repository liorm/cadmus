import { isWorkspaceTool } from "@cadmus/contract/tools";
import { defineExtension, section } from "@earendil-works/pi-durable";
import { createBashTool } from "@earendil-works/pi-durable/tools";
import { requireCadmusServices } from "../context.js";
import type { CadmusExtensionDescriptor } from "./cadmus-tools.js";

/**
 * Cadmus coding tools extension (`bash`).
 * File tools (`read`, `write`, `edit`, `delete`) live in `cadmus.files` and are
 * always available for `/.cadmus/*` virtual files, forwarding workspace paths to
 * `tools-env` when enabled.
 */
export function createCadmusCodingTools() {
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
						.filter(isWorkspaceTool),
				});
				return described?.name === "tools-env" ? described.text : undefined;
			}),
		],
		tools: [{ ...createBashTool(), executionMode: "sequential" as const }],
	});
}

export function codingToolsExtensionDescriptor(): CadmusExtensionDescriptor {
	return {
		extension: createCadmusCodingTools(),
		defaultEnabled: false,
		allowlistPolicy: { mode: "catalog" },
		isActive: (ctx) => ctx.codingToolsOffered,
	};
}
