import {
	CODING_TOOL_NAMES,
	DEFAULT_CADMUS_TOOL_NAMES,
} from "@cadmus/contract/tools";

export const TOOL_CATALOGUE: readonly string[] = [
	...DEFAULT_CADMUS_TOOL_NAMES,
	...CODING_TOOL_NAMES,
];

export interface AllowlistCount {
	allowed: number;
	total: number;
	label: string;
}

/** Omitted `tools` is the default Cadmus set. Coding tools count only when listed. */
export function allowlistCount(
	tools: readonly string[] | undefined,
): AllowlistCount {
	const catalogue = new Set(TOOL_CATALOGUE);
	const source = tools ?? DEFAULT_CADMUS_TOOL_NAMES;
	const allowed = source.filter((name) => catalogue.has(name)).length;
	const total = TOOL_CATALOGUE.length;
	return {
		allowed,
		total,
		label: `${allowed} of ${total} tools allowed`,
	};
}
