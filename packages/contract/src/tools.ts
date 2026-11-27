/**
 * Tool name lists the protocol exposes to clients.
 *
 * `bot.tools` omitted (or undefined) means the full catalog set.
 * An explicit array replaces that set.
 */
export const FILE_TOOL_NAMES = [
	"read",
	"write",
	"edit",
	"delete",
	"ls",
	"find",
	"grep",
] as const;

export const BASH_TOOL_NAME = "bash";

export const WORKSPACE_TOOL_NAMES = [
	"bash",
	"read",
	"write",
	"edit",
	"delete",
	"ls",
	"find",
	"grep",
] as const;

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
 * Extension groupings from `cadmusDefaultExtensions()`.
 * `readOnly` is true only when `execute()` inspects Cadmus state (or a
 * public URL) and does not mutate bots, files, chats, schedules, or tasks.
 * `task_get` starts a task. `search_bot` commits a durable matcher task.
 * Unlisted tools are not known read-only.
 */
export const TOOL_CATEGORIES = [
	{ id: "files", label: "Files & Skills", extension: "cadmus.files" },
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
	/** Suppressed at runtime when a workspace env is active and `bash` is allowed. */
	suppressedByWorkspaceEnv?: boolean;
	/** Allowed for target members in a readOnly: true group consultation. */
	readOnlyGroup?: boolean;
	/** Disallowed inside group chat sessions. */
	disallowedInGroup?: boolean;
	/** Provider ids that support this tool; omitted means all providers. */
	providers?: readonly string[];
};

export const TOOL_CATALOG: readonly ToolCatalogEntry[] = [
	{
		name: "read",
		category: "files",
		readOnly: true,
		readOnlyGroup: true,
	},
	{
		name: "write",
		category: "files",
		readOnly: false,
	},
	{
		name: "edit",
		category: "files",
		readOnly: false,
	},
	{
		name: "delete",
		category: "files",
		readOnly: false,
	},
	{
		name: "ls",
		category: "files",
		readOnly: true,
		readOnlyGroup: true,
	},
	{
		name: "find",
		category: "files",
		readOnly: true,
		readOnlyGroup: true,
	},
	{
		name: "grep",
		category: "files",
		readOnly: true,
		readOnlyGroup: true,
	},
	{
		name: "schedule_create",
		category: "schedules",
		readOnly: false,
	},
	{
		name: "schedule_list",
		category: "schedules",
		readOnly: true,
	},
	{
		name: "schedule_update",
		category: "schedules",
		readOnly: false,
	},
	{
		name: "schedule_delete",
		category: "schedules",
		readOnly: false,
	},
	{
		name: "task_add",
		category: "tasks",
		readOnly: false,
		disallowedInGroup: true,
	},
	{ name: "create_bot", category: "bots", readOnly: false },
	{ name: "search_bot", category: "bots", readOnly: false },
	{ name: "list_bots", category: "bots", readOnly: true },
	{
		name: "message_bot",
		category: "bots",
		readOnly: false,
	},
	{ name: "web.fetch", category: "web", readOnly: true },
	{
		name: "web.search",
		category: "web",
		readOnly: true,
		providers: ["xai", "google", "faux"],
	},
	{
		name: "x.search",
		category: "web",
		readOnly: true,
		providers: ["xai", "faux"],
	},
	{
		name: CODE_EXECUTE_TOOL_NAME,
		category: "web",
		readOnly: false,
		suppressedByWorkspaceEnv: true,
		providers: ["xai", "google", "faux"],
	},
	{ name: BASH_TOOL_NAME, category: "coding", readOnly: false },
];

/**
 * Tool name lists the protocol exposes to clients.
 *
 * `bot.tools` omitted (or undefined) means this full catalog set.
 * An explicit array replaces that set.
 */
export const CATALOG_TOOL_NAMES: readonly string[] = TOOL_CATALOG.map(
	(entry) => entry.name,
);

/**
 * Tools a `message_bot` `readOnly` target may use. Reading Cadmus virtual files
 * (`/.cadmus/*`) only. Writes, schedules, messaging, coding, and bot management
 * stay off this list.
 */
export const READONLY_GROUP_TOOL_NAMES: readonly string[] = TOOL_CATALOG.filter(
	(entry) => entry.readOnlyGroup === true,
).map((entry) => entry.name);

export type ReadOnlyGroupToolName = string;

export function isReadOnlyGroupTool(name: string): boolean {
	return (READONLY_GROUP_TOOL_NAMES as readonly string[]).includes(name);
}

/**
 * Intersection of a bot's tool list with {@link READONLY_GROUP_TOOL_NAMES}.
 * An omitted list is the full catalog set. Order follows that source.
 * Coding tools are never included.
 */
export function readOnlyGroupToolNames(
	tools: readonly string[] | undefined,
): string[] {
	const source = tools ?? CATALOG_TOOL_NAMES;
	return source.filter((name) => isReadOnlyGroupTool(name));
}

export type CatalogToolName = string;
export type FileToolName = (typeof FILE_TOOL_NAMES)[number];
export type WorkspaceToolName = (typeof WORKSPACE_TOOL_NAMES)[number];

export function isFileTool(name: string): name is FileToolName {
	return (FILE_TOOL_NAMES as readonly string[]).includes(name);
}

export function isWorkspaceTool(name: string): name is WorkspaceToolName {
	return (WORKSPACE_TOOL_NAMES as readonly string[]).includes(name);
}

export function extractModelProvider(model?: string | null): string | null {
	if (!model) return null;
	const slash = model.indexOf("/");
	if (slash === -1) return null;
	const provider = model.slice(0, slash).trim();
	return provider.length > 0 ? provider : null;
}

export function isToolEntryAvailable(
	entry: ToolCatalogEntry,
	model?: string | null,
): boolean {
	if (entry.providers && entry.providers.length > 0) {
		const provider = extractModelProvider(model);
		if (provider !== null && !entry.providers.includes(provider)) {
			return false;
		}
	}
	return true;
}

/**
 * Tool names a turn may offer.
 *
 * When `workspaceEnvEnabled` is true and `bash` is allowed (via `tools === undefined`
 * or `tools.includes("bash")`), tools with `suppressedByWorkspaceEnv` (like `code.execute`)
 * are removed. Provider-gated tools are also filtered by `model`.
 */
export function effectiveToolNames(
	tools: readonly string[] | undefined,
	options?: { workspaceEnvEnabled?: boolean; model?: string | null },
): readonly string[] | undefined {
	const provider = extractModelProvider(options?.model);
	const bashAllowed = tools === undefined || tools.includes(BASH_TOOL_NAME);
	const suppressCodeExecute =
		Boolean(options?.workspaceEnvEnabled) && bashAllowed;
	const unavailable = new Set(
		TOOL_CATALOG.filter((entry) => {
			if (suppressCodeExecute && entry.suppressedByWorkspaceEnv) return true;
			if (
				entry.providers &&
				provider !== null &&
				!entry.providers.includes(provider)
			) {
				return true;
			}
			return false;
		}).map((entry) => entry.name),
	);

	if (tools === undefined) {
		if (unavailable.size === 0) return undefined;
		return CATALOG_TOOL_NAMES.filter((name) => !unavailable.has(name));
	}

	if (unavailable.size === 0) return tools;
	return tools.filter((name) => !unavailable.has(name));
}

const READONLY_TOOL_NAME_SET = new Set(
	TOOL_CATALOG.filter((entry) => entry.readOnly).map((entry) => entry.name),
);

export function isKnownReadOnlyTool(name: string): boolean {
	return READONLY_TOOL_NAME_SET.has(name);
}

export function knownReadOnlyToolNames(available: readonly string[]): string[] {
	return available.filter((name) => isKnownReadOnlyTool(name));
}

export function availableAllowlistCatalog(
	model?: string | null,
): ToolCatalogEntry[] {
	return TOOL_CATALOG.filter((entry) => isToolEntryAvailable(entry, model));
}

export function availableAllowlistNames(model?: string | null): string[] {
	return availableAllowlistCatalog(model).map((entry) => entry.name);
}

/** Displayed selection for an omitted allowlist at the current model. */
export function defaultDisplayedTools(model?: string | null): string[] {
	return availableAllowlistNames(model);
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
 * Persist allowlist. Keep unavailable model-specific tool names from the last
 * stored selection so switching models does not drop intentional picks.
 */
export function persistAllowlist(input: {
	selected: readonly string[];
	available: readonly string[];
	previous: readonly string[] | undefined;
	model?: string | null;
}): string[] | null {
	const available = new Set(input.available);
	const hiddenPrevious = (input.previous ?? []).filter(
		(name) => !available.has(name),
	);
	const next = [
		...input.selected.filter((name) => available.has(name)),
		...hiddenPrevious,
	];
	const defaults = defaultDisplayedTools(input.model);
	if (hiddenPrevious.length === 0 && sameToolSet(next, defaults)) return null;
	return next;
}

export function displayedAllowlist(input: {
	stored: readonly string[] | undefined;
	available: readonly string[];
	model?: string | null;
}): string[] {
	const available = new Set(input.available);
	if (input.stored === undefined) {
		return defaultDisplayedTools(input.model).filter((name) =>
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
