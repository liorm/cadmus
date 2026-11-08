import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { unavailableToolMessage } from "../models.js";
import type { CadmusExtensionDescriptor } from "./cadmus-tools.js";
import { toolError } from "./knowledge-tools.js";

export function xaiToolsExtension() {
	return defineExtension({
		name: "cadmus.xai-tools",
		tools: [
			defineTool({
				name: "web.search",
				description: "Provider-native web search tool (available on xAI).",
				parameters: Type.Object({
					query: Type.Optional(Type.String()),
				}),
				replay: "safe",
				async execute(_args, api, context) {
					const agent = await api.agent(context);
					const provider = agent.model?.provider ?? "unknown";
					return toolError(unavailableToolMessage("web.search", provider));
				},
			}),
			defineTool({
				name: "x.search",
				description:
					"Provider-native X/Twitter search tool (available on xAI).",
				parameters: Type.Object({
					query: Type.Optional(Type.String()),
				}),
				replay: "safe",
				async execute(_args, api, context) {
					const agent = await api.agent(context);
					const provider = agent.model?.provider ?? "unknown";
					return toolError(unavailableToolMessage("x.search", provider));
				},
			}),
			defineTool({
				name: "code.execute",
				description:
					"Provider-native code execution sandbox (available on xAI).",
				parameters: Type.Object({
					code: Type.Optional(Type.String()),
				}),
				replay: "safe",
				async execute(_args, api, context) {
					const agent = await api.agent(context);
					const provider = agent.model?.provider ?? "unknown";
					return toolError(unavailableToolMessage("code.execute", provider));
				},
			}),
		],
	});
}

export function xaiToolsExtensionDescriptor(): CadmusExtensionDescriptor {
	return {
		extension: xaiToolsExtension(),
		defaultEnabled: false,
		allowlistPolicy: { mode: "catalog" },
		isActive: (ctx) =>
			ctx.provider === null ||
			ctx.provider === "xai" ||
			ctx.provider === "faux",
		nativeProviderTools: {
			xai: {
				"web.search": { type: "web_search" },
				"x.search": { type: "x_search" },
				"code.execute": { type: "code_interpreter" },
			},
		},
	};
}
