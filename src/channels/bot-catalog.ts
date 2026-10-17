import type { RegistryReader } from "@earendil-works/pi-durable";

export type CatalogTool = { group: string; name: string };

const GROUPS: Record<string, string> = {
	"pi-bot.knowledge": "Knowledge",
	"pi-bot.self": "Schedules",
	"pi-bot.internal": "Internal",
	"pi-bot.web": "Web",
};

/** Dialog group for an installed extension. Unknown names keep the suffix after `pi-bot.`. */
export function catalogGroup(extensionName: string): string | undefined {
	const mapped = GROUPS[extensionName];
	if (mapped) return mapped;
	if (!extensionName.startsWith("pi-bot.")) return undefined;
	const rest = extensionName.slice("pi-bot.".length);
	if (!rest) return undefined;
	return rest.charAt(0).toUpperCase() + rest.slice(1);
}

/** Tools the registry has installed, in install order, grouped for the dialog. */
export function toolCatalog(registry: RegistryReader): CatalogTool[] {
	return registry
		.snapshot()
		.tools()
		.flatMap((entry) => {
			const group = catalogGroup(entry.extension.name);
			if (!group) return [];
			return [{ group, name: entry.tool.name }];
		});
}

export function toolNames(registry: RegistryReader): readonly string[] {
	return toolCatalog(registry).map((tool) => tool.name);
}

/** Knowledge tools the harvest fork may call. */
export function knowledgeToolNames(
	registry: RegistryReader,
): readonly string[] {
	return (
		registry
			.snapshot()
			.extension("pi-bot.knowledge")
			?.tools?.map((tool) => tool.name) ?? []
	);
}

export function isToolName(registry: RegistryReader, name: string): boolean {
	return toolNames(registry).includes(name);
}

/** Providers the bot dialog offers. */
export const OFFERED_PROVIDERS = ["xai", "faux"] as const;

/**
 * `undefined` means every tool is on, including tools added later.
 * A full list collapses to that. Any other list is the enabled set, and may be empty.
 */
export function normalizeEnabled(
	tools: readonly string[] | undefined,
	all: readonly string[],
): string[] | undefined {
	if (tools === undefined) return undefined;
	const unique = [...new Set(tools)];
	if (
		all.length > 0 &&
		unique.length === all.length &&
		all.every((name) => unique.includes(name))
	)
		return undefined;
	return unique;
}
