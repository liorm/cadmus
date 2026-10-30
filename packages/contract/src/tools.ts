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
	"list_bots",
	"message_bot",
	"end_conversation",
	"web.fetch",
	"web.search",
	"x.search",
	"code.execute",
] as const;

export const CODING_TOOL_NAMES = ["bash", "read", "write", "edit"] as const;

export const CODE_EXECUTE_TOOL_NAME = "code.execute";

/**
 * Tools a `message_bot` `readOnly` target may use. Memory and knowledge
 * reads only. Writes, schedules, messaging, coding, and bot management
 * stay off this list.
 */
export const READONLY_GROUP_TOOL_NAMES = [
	"knowledge_read",
	"memory_read",
] as const;

export type ReadOnlyGroupToolName = (typeof READONLY_GROUP_TOOL_NAMES)[number];

export function isReadOnlyGroupTool(name: string): boolean {
	return (READONLY_GROUP_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * Intersection of a bot's tool list with {@link READONLY_GROUP_TOOL_NAMES}.
 * An omitted list is the default Cadmus set. Order follows that source.
 * Coding tools are never included.
 */
export function readOnlyGroupToolNames(
	tools: readonly string[] | undefined,
): string[] {
	const source = tools ?? DEFAULT_CADMUS_TOOL_NAMES;
	return source.filter((name) => isReadOnlyGroupTool(name));
}

export type DefaultCadmusToolName = (typeof DEFAULT_CADMUS_TOOL_NAMES)[number];
export type CodingToolName = (typeof CODING_TOOL_NAMES)[number];

/**
 * Tool names a turn may offer.
 *
 * `codingToolsOffered` is the worker's coding-tools condition: the chat
 * resolves an enabled just-bash or local-daemon env, and the bot allowlist
 * either lists a coding tool or is omitted (the default Cadmus set). An
 * explicit allowlist that does not list a coding tool never offers them.
 * When coding tools are offered, `code.execute` is removed. An omitted
 * allowlist expands to the default Cadmus names (without `code.execute`)
 * plus bash, read, write, and edit. The stored `bot.tools` array is not
 * rewritten. An explicit array is returned as stored, aside from dropping
 * `code.execute`.
 */
export function effectiveToolNames(
	tools: readonly string[] | undefined,
	options: { codingToolsOffered: boolean },
): readonly string[] | undefined {
	if (!options.codingToolsOffered) return tools;
	if (tools === undefined) {
		return [
			...DEFAULT_CADMUS_TOOL_NAMES.filter(
				(name) => name !== CODE_EXECUTE_TOOL_NAME,
			),
			...CODING_TOOL_NAMES,
		];
	}
	if (!tools.includes(CODE_EXECUTE_TOOL_NAME)) return tools;
	return tools.filter((name) => name !== CODE_EXECUTE_TOOL_NAME);
}
