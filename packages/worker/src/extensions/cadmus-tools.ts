import {
	BASH_TOOL_NAME,
	isFileTool,
	isReadOnlyGroupTool,
	TOOL_CATALOG,
	type ToolCatalogEntry,
} from "@cadmus/contract/tools";
import type { Extension, ToolRegistration } from "@earendil-works/pi-durable";
import type { ReadToolOptions } from "@earendil-works/pi-durable/tools";
import type { BotRecord, ChatRecord } from "../protocol.js";
import { scheduleTaskExtensionDescriptor } from "../schedules.js";
import { codingToolsExtensionDescriptor } from "./coding-tools.js";
import { compactionExtensionDescriptor } from "./compaction.js";
import { filesExtensionDescriptor } from "./file-tools.js";
import { groupCallerExtensionDescriptor } from "./group-caller-tools.js";
import { identityExtensionDescriptor } from "./identity.js";
import { internalToolsExtensionDescriptor } from "./internal-tools.js";
import { schedulesToolsExtensionDescriptor } from "./schedules-tools.js";
import {
	tasksFollowupExtensionDescriptor,
	tasksToolsExtensionDescriptor,
} from "./tasks-tools.js";
import { toolGateExtensionDescriptor } from "./tool-gate.js";
import { webToolsExtensionDescriptor } from "./web-tools.js";
import { xaiToolsExtensionDescriptor } from "./xai-tools.js";

export interface ExtensionActivationContext {
	bot: BotRecord;
	chat?: ChatRecord;
	workspaceEnvEnabled: boolean;
	isGroupSession: boolean;
	isGroupCaller: boolean;
	isConsultMember: boolean;
	isHarvest?: boolean;
	hasActiveTasks: boolean;
	provider: string | null;
}

export type ExtensionAllowlistPolicy =
	| { mode: "catalog" }
	| { mode: "always" }
	| { mode: "impliedBy"; catalogTool: string };

export interface CadmusExtensionDescriptor {
	extension: Extension;
	defaultEnabled: boolean;
	allowlistPolicy: ExtensionAllowlistPolicy;
	isActive?: (ctx: ExtensionActivationContext) => boolean;
	nativeProviderTools?: Readonly<
		Record<string, Readonly<Record<string, Readonly<Record<string, unknown>>>>>
	>;
}

export function cadmusExtensionDescriptors(options?: {
	now?: () => Date;
	readToolOptions?: ReadToolOptions;
}): readonly CadmusExtensionDescriptor[] {
	return [
		identityExtensionDescriptor(options),
		filesExtensionDescriptor(options?.readToolOptions),
		schedulesToolsExtensionDescriptor(),
		tasksToolsExtensionDescriptor(),
		tasksFollowupExtensionDescriptor(),
		internalToolsExtensionDescriptor(),
		groupCallerExtensionDescriptor(),
		webToolsExtensionDescriptor(),
		xaiToolsExtensionDescriptor(),
		codingToolsExtensionDescriptor(),
		toolGateExtensionDescriptor(),
		compactionExtensionDescriptor(),
		scheduleTaskExtensionDescriptor(),
	];
}

/**
 * Default extensions enabled for root and default conversations.
 */
export function cadmusDefaultExtensions(): Extension[] {
	return cadmusExtensionDescriptors()
		.filter((desc) => desc.defaultEnabled)
		.map((desc) => desc.extension);
}

/**
 * Merge native provider tools across all descriptors.
 */
export function collectNativeProviderTools(
	descriptors: readonly CadmusExtensionDescriptor[] = cadmusExtensionDescriptors(),
): Record<string, Record<string, Readonly<Record<string, unknown>>>> {
	const merged: Record<
		string,
		Record<string, Readonly<Record<string, unknown>>>
	> = {};
	for (const desc of descriptors) {
		if (!desc.nativeProviderTools) continue;
		for (const [provider, tools] of Object.entries(desc.nativeProviderTools)) {
			merged[provider] ??= {};
			Object.assign(merged[provider], tools);
		}
	}
	return merged;
}

function catalogEntry(name: string): ToolCatalogEntry | undefined {
	return TOOL_CATALOG.find((entry) => entry.name === name);
}

function isCatalogToolRegistered(
	name: string,
	ctx: ExtensionActivationContext,
): boolean {
	const entry = catalogEntry(name);
	if (entry) {
		if (entry.disallowedInGroup && ctx.isGroupSession) return false;
		if (
			entry.providers &&
			entry.providers.length > 0 &&
			ctx.provider !== null &&
			!entry.providers.includes(ctx.provider)
		) {
			return false;
		}
	}
	if (ctx.bot.tools === undefined) return true;
	return ctx.bot.tools.includes(name);
}

function isCatalogToolActive(
	name: string,
	ctx: ExtensionActivationContext,
): boolean {
	if (!isCatalogToolRegistered(name, ctx)) return false;
	const entry = catalogEntry(name);
	if (
		entry?.suppressedByWorkspaceEnv &&
		ctx.workspaceEnvEnabled &&
		isCatalogToolRegistered(BASH_TOOL_NAME, ctx)
	) {
		return false;
	}
	return true;
}

/**
 * Resolve the dynamic extensions, registered tools, and active model-facing tool names
 * for a conversation in a single pass.
 */
export function resolveConversationExtensionsAndTools(
	ctx: ExtensionActivationContext,
	descriptors: readonly CadmusExtensionDescriptor[] = cadmusExtensionDescriptors(),
): {
	extensions: { add: Extension[]; remove: Extension[] };
	tools: ToolRegistration[];
	effectiveToolNames: string[];
} {
	const add: Extension[] = [];
	const remove: Extension[] = [];
	const tools: ToolRegistration[] = [];
	const activeToolNames: string[] = [];

	for (const desc of descriptors) {
		const ext = desc.extension;
		const toolList = ext.tools ?? [];
		const hasTools = toolList.length > 0;
		const active = desc.isActive ? desc.isActive(ctx) : true;

		if (!hasTools) {
			if (!active) {
				remove.push(ext);
			} else if (!desc.defaultEnabled) {
				add.push(ext);
			}
			continue;
		}

		let allowedTools: ToolRegistration[] = [];
		if (desc.allowlistPolicy.mode === "always") {
			allowedTools = [...toolList];
		} else if (desc.allowlistPolicy.mode === "impliedBy") {
			const parentAllowed = isCatalogToolRegistered(
				desc.allowlistPolicy.catalogTool,
				ctx,
			);
			if (parentAllowed) {
				allowedTools = [...toolList];
			}
		} else {
			allowedTools = toolList.filter((tool) =>
				isCatalogToolRegistered(tool.name, ctx),
			);
		}

		// Mid-turn batch support: if a descriptor is inactive only because tasks don't exist yet,
		// but task_add is allowed, register the tools with agent.tools so startToolRound passes.
		const shouldRegisterWithAgent =
			allowedTools.length > 0 &&
			(active ||
				(desc.allowlistPolicy.mode === "impliedBy" &&
					desc.allowlistPolicy.catalogTool === "task_add" &&
					!ctx.isGroupSession &&
					!ctx.isConsultMember));

		if (shouldRegisterWithAgent) {
			if (!desc.defaultEnabled) {
				add.push(ext);
			}
			tools.push(...allowedTools);
			if (active) {
				const names = ctx.isConsultMember
					? allowedTools
							.filter((t) => isReadOnlyGroupTool(t.name))
							.map((t) => t.name)
					: ctx.isHarvest
						? allowedTools.filter((t) => isFileTool(t.name)).map((t) => t.name)
						: allowedTools
								.filter((t) => isCatalogToolActive(t.name, ctx))
								.map((t) => t.name);
				activeToolNames.push(...names);
			}
		} else {
			remove.push(ext);
		}
	}

	return {
		extensions: { add, remove },
		tools,
		effectiveToolNames: activeToolNames,
	};
}
