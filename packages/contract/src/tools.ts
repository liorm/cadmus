/**
 * Tool name lists the protocol exposes to clients.
 *
 * `bot.tools` omitted (or undefined) means this default Cadmus set.
 * An explicit array replaces that set. Coding tools are opt-in and are
 * never part of the default set.
 */
export const DEFAULT_CADMUS_TOOL_NAMES = [
	"knowledge_read",
	"knowledge_update",
	"knowledge_delete",
	"memory_read",
	"memory_update",
	"schedule_create",
	"schedule_list",
	"schedule_update",
	"schedule_delete",
	"create_bot",
	"search_bot",
	"message_bot",
	"web.fetch",
	"web.search",
	"x.search",
	"code.execute",
] as const;

export const CODING_TOOL_NAMES = ["bash", "read", "write", "edit"] as const;

export const CODE_EXECUTE_TOOL_NAME = "code.execute";

export type DefaultCadmusToolName = (typeof DEFAULT_CADMUS_TOOL_NAMES)[number];
export type CodingToolName = (typeof CODING_TOOL_NAMES)[number];

/**
 * Tool names a turn may offer.
 *
 * `codingToolsOffered` is the worker's existing coding-tools condition
 * (the bot lists bash/read/write/edit and the chat resolves an enabled
 * just-bash or local-daemon env). When that is true, `code.execute` is
 * removed. The stored `bot.tools` array is not rewritten. `undefined`
 * means the default Cadmus set and is returned unchanged, because that
 * condition is never true unless `tools` lists a coding tool.
 */
export function effectiveToolNames(
	tools: readonly string[] | undefined,
	options: { codingToolsOffered: boolean },
): readonly string[] | undefined {
	if (!options.codingToolsOffered || tools === undefined) return tools;
	if (!tools.includes(CODE_EXECUTE_TOOL_NAME)) return tools;
	return tools.filter((name) => name !== CODE_EXECUTE_TOOL_NAME);
}
