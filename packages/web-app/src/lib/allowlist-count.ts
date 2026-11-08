import {
	availableAllowlistNames,
	DEFAULT_CADMUS_TOOL_NAMES,
	displayedAllowlist,
} from "@cadmus/contract/tools";

export const TOOL_CATALOGUE: readonly string[] = availableAllowlistNames(true);

export interface AllowlistCount {
	allowed: number;
	total: number;
	label: string;
}

/** Omitted `tools` is the default set for the current env and model. */
export function allowlistCount(
	tools: readonly string[] | undefined,
	codingEnvOffered = false,
	model?: string | null,
): AllowlistCount {
	const available = availableAllowlistNames(codingEnvOffered, model);
	const source = displayedAllowlist({
		stored: tools,
		available,
		codingEnvOffered,
		model,
	});
	const total = available.length;
	return {
		allowed: source.length,
		total,
		label: `${source.length} of ${total} tools allowed`,
	};
}

export { DEFAULT_CADMUS_TOOL_NAMES };
