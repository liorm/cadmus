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
	"task_add",
	"task_remove",
	"task_get",
	"task_finish",
	"task_list",
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

export const TASK_TOOL_NAMES = [
	"task_add",
	"task_remove",
	"task_get",
	"task_finish",
	"task_list",
] as const;

export type TaskToolName = (typeof TASK_TOOL_NAMES)[number];

export function isTaskTool(name: string): boolean {
	return (TASK_TOOL_NAMES as readonly string[]).includes(name);
}

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

/**
 * Extension groupings from `cadmusDefaultExtensions()` plus `coding-tools`.
 * `readOnly` is true only when `execute()` inspects Cadmus state (or a
 * public URL) and does not mutate bots, files, chats, schedules, or tasks.
 * `task_get` starts a task. `search_bot` commits a durable matcher task.
 * Unlisted tools are not known read-only.
 */
export const TOOL_CATEGORIES = [
	{ id: "knowledge", label: "Knowledge", extension: "cadmus.knowledge" },
	{
		id: "schedules",
		label: "Schedules",
		extension: "cadmus.schedules-tools",
	},
	{ id: "tasks", label: "Tasks", extension: "cadmus.tasks-tools" },
	{ id: "bots", label: "Bots", extension: "cadmus.internal-tools" },
	{ id: "web", label: "Web", extension: "cadmus.web-tools" },
	{ id: "coding", label: "Coding", extension: "coding-tools" },
] as const;

export type ToolCategoryId = (typeof TOOL_CATEGORIES)[number]["id"];

export type ToolCatalogEntry = {
	name: string;
	category: ToolCategoryId;
	readOnly: boolean;
	codingEnv: boolean;
};

export const TOOL_CATALOG: readonly ToolCatalogEntry[] = [
	{
		name: "knowledge_read",
		category: "knowledge",
		readOnly: true,
		codingEnv: false,
	},
	{
		name: "knowledge_update",
		category: "knowledge",
		readOnly: false,
		codingEnv: false,
	},
	{
		name: "knowledge_delete",
		category: "knowledge",
		readOnly: false,
		codingEnv: false,
	},
	{
		name: "memory_read",
		category: "knowledge",
		readOnly: true,
		codingEnv: false,
	},
	{
		name: "memory_update",
		category: "knowledge",
		readOnly: false,
		codingEnv: false,
	},
	{
		name: "schedule_create",
		category: "schedules",
		readOnly: false,
		codingEnv: false,
	},
	{
		name: "schedule_list",
		category: "schedules",
		readOnly: true,
		codingEnv: false,
	},
	{
		name: "schedule_update",
		category: "schedules",
		readOnly: false,
		codingEnv: false,
	},
	{
		name: "schedule_delete",
		category: "schedules",
		readOnly: false,
		codingEnv: false,
	},
	{ name: "task_add", category: "tasks", readOnly: false, codingEnv: false },
	{
		name: "task_remove",
		category: "tasks",
		readOnly: false,
		codingEnv: false,
	},
	{ name: "task_get", category: "tasks", readOnly: false, codingEnv: false },
	{
		name: "task_finish",
		category: "tasks",
		readOnly: false,
		codingEnv: false,
	},
	{ name: "task_list", category: "tasks", readOnly: true, codingEnv: false },
	{ name: "create_bot", category: "bots", readOnly: false, codingEnv: false },
	{ name: "search_bot", category: "bots", readOnly: false, codingEnv: false },
	{ name: "list_bots", category: "bots", readOnly: true, codingEnv: false },
	{
		name: "message_bot",
		category: "bots",
		readOnly: false,
		codingEnv: false,
	},
	{
		name: "end_conversation",
		category: "bots",
		readOnly: false,
		codingEnv: false,
	},
	{ name: "web.fetch", category: "web", readOnly: true, codingEnv: false },
	{ name: "web.search", category: "web", readOnly: true, codingEnv: false },
	{ name: "x.search", category: "web", readOnly: true, codingEnv: false },
	{
		name: CODE_EXECUTE_TOOL_NAME,
		category: "web",
		readOnly: false,
		codingEnv: false,
	},
	{ name: "bash", category: "coding", readOnly: false, codingEnv: true },
	{ name: "read", category: "coding", readOnly: true, codingEnv: true },
	{ name: "write", category: "coding", readOnly: false, codingEnv: true },
	{ name: "edit", category: "coding", readOnly: false, codingEnv: true },
];

const READONLY_TOOL_NAME_SET = new Set(
	TOOL_CATALOG.filter((entry) => entry.readOnly).map((entry) => entry.name),
);

export function isKnownReadOnlyTool(name: string): boolean {
	return READONLY_TOOL_NAME_SET.has(name);
}

export function knownReadOnlyToolNames(available: readonly string[]): string[] {
	return available.filter((name) => isKnownReadOnlyTool(name));
}

/**
 * Bot-settings coding-env visibility. Chat pins are out of scope.
 * Matches `resolveToolsEnv` + just-bash/local-daemon, ignoring `bot.tools`
 * so the allowlist can opt coding tools in.
 */
export function codingToolsEnvWouldOffer(input: {
	botSetting?: {
		enabled: boolean;
		binding?: { envId: string } | null;
	} | null;
	accountDefaultEnvId?: string | null;
	envKindById: Readonly<Record<string, string>>;
}): boolean {
	const bot = input.botSetting ?? null;
	let enabled = false;
	let envId: string | undefined;
	if (bot) {
		enabled = bot.enabled;
		envId = bot.binding?.envId ?? input.accountDefaultEnvId ?? undefined;
	} else if (input.accountDefaultEnvId) {
		enabled = true;
		envId = input.accountDefaultEnvId;
	}
	if (!enabled || !envId) return false;
	const kind = input.envKindById[envId];
	return kind === "just-bash" || kind === "local-daemon";
}

export function availableAllowlistCatalog(
	codingEnvOffered: boolean,
): ToolCatalogEntry[] {
	return TOOL_CATALOG.filter((entry) => {
		if (entry.codingEnv) return codingEnvOffered;
		if (codingEnvOffered && entry.name === CODE_EXECUTE_TOOL_NAME) {
			return false;
		}
		return true;
	});
}

export function availableAllowlistNames(codingEnvOffered: boolean): string[] {
	return availableAllowlistCatalog(codingEnvOffered).map((entry) => entry.name);
}

/** Displayed selection for an omitted allowlist at the current env. */
export function defaultDisplayedTools(codingEnvOffered: boolean): string[] {
	const expanded = effectiveToolNames(undefined, {
		codingToolsOffered: codingEnvOffered,
	});
	if (expanded) return [...expanded];
	return [...DEFAULT_CADMUS_TOOL_NAMES];
}

export function sameToolSet(
	left: readonly string[],
	right: readonly string[],
): boolean {
	if (left.length !== right.length) return false;
	const have = new Set(left);
	return right.every((name) => have.has(name));
}

/**
 * Persist allowlist. Keep unavailable coding names from the last stored
 * selection so clearing an env does not drop an intentional coding pick.
 */
export function persistAllowlist(input: {
	selected: readonly string[];
	available: readonly string[];
	previous: readonly string[] | undefined;
	codingEnvOffered: boolean;
}): string[] | null {
	const available = new Set(input.available);
	const hiddenCoding = (input.previous ?? []).filter(
		(name) =>
			!available.has(name) &&
			(CODING_TOOL_NAMES as readonly string[]).includes(name),
	);
	const next = [
		...input.selected.filter((name) => available.has(name)),
		...hiddenCoding,
	];
	const defaults = defaultDisplayedTools(input.codingEnvOffered);
	if (hiddenCoding.length === 0 && sameToolSet(next, defaults)) return null;
	return next;
}

export function displayedAllowlist(input: {
	stored: readonly string[] | undefined;
	available: readonly string[];
	codingEnvOffered: boolean;
}): string[] {
	const available = new Set(input.available);
	if (input.stored === undefined) {
		return defaultDisplayedTools(input.codingEnvOffered).filter((name) =>
			available.has(name),
		);
	}
	return input.stored.filter((name) => available.has(name));
}

export function categorySelectionState(
	members: readonly string[],
	selected: ReadonlySet<string>,
): "all" | "none" | "mixed" {
	if (members.length === 0) return "none";
	let on = 0;
	for (const name of members) {
		if (selected.has(name)) on += 1;
	}
	if (on === 0) return "none";
	if (on === members.length) return "all";
	return "mixed";
}
