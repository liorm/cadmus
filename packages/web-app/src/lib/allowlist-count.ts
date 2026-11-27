import {
	availableAllowlistNames,
	CATALOG_TOOL_NAMES,
	displayedAllowlist,
} from "@cadmus/contract/tools";

export const TOOL_CATALOGUE: readonly string[] = availableAllowlistNames();

export interface AllowlistCount {
	allowed: number;
	total: number;
	label: string;
}

/** Omitted `tools` is the catalog set for the current model. */
export function allowlistCount(
	tools: readonly string[] | undefined,
	model?: string | null,
): AllowlistCount {
	const available = availableAllowlistNames(model);
	const source = displayedAllowlist({
		stored: tools,
		available,
		model,
	});
	const total = available.length;
	return {
		allowed: source.length,
		total,
		label: `${source.length} of ${total} tools allowed`,
	};
}

export { CATALOG_TOOL_NAMES };
