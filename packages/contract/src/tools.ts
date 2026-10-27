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

export type DefaultCadmusToolName = (typeof DEFAULT_CADMUS_TOOL_NAMES)[number];
export type CodingToolName = (typeof CODING_TOOL_NAMES)[number];
