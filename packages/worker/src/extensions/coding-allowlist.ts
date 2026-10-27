import {
	CODING_TOOL_NAMES,
	DEFAULT_CADMUS_TOOL_NAMES,
} from "@cadmus/contract/tools";

const CODING_TOOL_NAME_SET = new Set<string>(CODING_TOOL_NAMES);

/**
 * `create_bot` callers that pass only coding tool names are enabling coding
 * tools, the same choice as the web form's empty field plus the coding
 * checkbox. Store the default Cadmus set plus those coding tools.
 * Any other array, including `[]` and a mix of Cadmus and coding names, is an
 * explicit allowlist and is returned unchanged.
 */
export function expandCodingOnlyAllowlist(
	tools: readonly string[] | undefined,
): string[] | undefined {
	if (tools === undefined) return undefined;
	if (
		tools.length === 0 ||
		!tools.every((name) => CODING_TOOL_NAME_SET.has(name))
	) {
		return [...tools];
	}
	const requested = new Set(tools);
	return [
		...DEFAULT_CADMUS_TOOL_NAMES,
		...CODING_TOOL_NAMES.filter((name) => requested.has(name)),
	];
}
