import { BASH_TOOL_NAME } from "@cadmus/contract/tools";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { createBashTool } from "@earendil-works/pi-durable/tools";
import { requireCadmusServices } from "../context.js";
import type { CadmusExtensionDescriptor } from "./cadmus-tools.js";
import { resolveBotScope, toolError } from "./file-tools.js";

export const BASH_WORKSPACE_ENV_DISABLED_ERROR =
	"No workspace tools environment is enabled for this conversation. bash is not available without an enabled workspace environment.";

/**
 * Cadmus coding tools extension (`bash`).
 * Registered uniformly alongside `cadmus.files`; checks `workspaceEnvEnabled`
 * at runtime and fails cleanly when no workspace environment is active.
 */
export function createCadmusCodingTools() {
	const baseBash = createBashTool();
	return defineExtension({
		name: "coding-tools",
		tools: [
			defineTool({
				name: BASH_TOOL_NAME,
				description: baseBash.description,
				parameters: baseBash.parameters,
				...(baseBash.structuredOutputSchema
					? { structuredOutputSchema: baseBash.structuredOutputSchema }
					: {}),
				...(baseBash.outputLimits
					? { outputLimits: baseBash.outputLimits }
					: {}),
				executionMode: "sequential",
				async execute(args, api, context) {
					const scope = await resolveBotScope(api, context);
					if (!scope) {
						return toolError("Conversation is not bound to a bot.");
					}
					const services = requireCadmusServices(context);
					const envOn = await services.workspaceEnvEnabled(
						api.conversationId as unknown as number,
						scope.botId,
					);
					if (!envOn) {
						return toolError(BASH_WORKSPACE_ENV_DISABLED_ERROR);
					}
					if (!api.env) {
						return toolError("No execution environment is configured.");
					}
					return baseBash.execute(args, api, context);
				},
			}),
		],
	});
}

export function codingToolsExtensionDescriptor(): CadmusExtensionDescriptor {
	return {
		extension: createCadmusCodingTools(),
		defaultEnabled: true,
		allowlistPolicy: { mode: "catalog" },
		isActive: (ctx) => !ctx.isConsultMember && !ctx.isHarvest,
	};
}
