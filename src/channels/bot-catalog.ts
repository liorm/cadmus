/** Every model tool this process registers, in offer order. */
export const TOOL_CATALOG = [
	{ group: "Knowledge", name: "knowledge_read" },
	{ group: "Knowledge", name: "knowledge_update" },
	{ group: "Knowledge", name: "knowledge_delete" },
	{ group: "Schedules", name: "schedule_create" },
	{ group: "Schedules", name: "schedule_list" },
	{ group: "Schedules", name: "schedule_update" },
	{ group: "Schedules", name: "schedule_delete" },
	{ group: "Web", name: "web.search" },
	{ group: "Web", name: "web.fetch" },
	{ group: "Provider", name: "x.search" },
	{ group: "Provider", name: "code.execute" },
] as const;

export const KNOWLEDGE_TOOLS = [
	"knowledge_read",
	"knowledge_update",
	"knowledge_delete",
] as const;
export const WEB_TOOLS = ["web.search", "web.fetch"] as const;

export const TOOL_NAMES: readonly string[] = TOOL_CATALOG.map(
	(tool) => tool.name,
);

const TOOL_NAME_SET = new Set<string>(TOOL_NAMES);

/** Providers the bot dialog offers. */
export const OFFERED_PROVIDERS = ["xai", "faux"] as const;

export function isToolName(name: string): boolean {
	return TOOL_NAME_SET.has(name);
}

/**
 * `undefined` means every tool is on, including tools added later.
 * A full list collapses to that. Any other list is the enabled set, and may be empty.
 */
export function normalizeEnabled(
	tools: readonly string[] | undefined,
): string[] | undefined {
	if (tools === undefined) return undefined;
	const unique = [...new Set(tools)];
	if (
		unique.length === TOOL_NAMES.length &&
		TOOL_NAMES.every((name) => unique.includes(name))
	)
		return undefined;
	return unique;
}
