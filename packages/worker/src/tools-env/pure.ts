import { CODING_TOOL_NAMES, type CodingToolName } from "@cadmus/contract/tools";
import type { ToolsEnvBinding, ToolsEnvSetting } from "@cadmus/contract/types";
import { ProtocolValidationError } from "../protocol/validate.js";

export type { CodingToolName };
export { CODING_TOOL_NAMES };

export const WORKSPACE_ROOT = "/workspace";
export const NAMESPACE_BYTE_CAP = 8 * 1024 * 1024;

export function isCodingTool(name: string): name is CodingToolName {
	return (CODING_TOOL_NAMES as readonly string[]).includes(name);
}

export type ToolsEnvKind = "just-bash" | "local-daemon";

export interface ToolsEnvDefinition {
	envId: string;
	kind: ToolsEnvKind;
	label?: string;
	persist: boolean;
	confineToWorkspace: boolean;
	sharedWorkspace: boolean;
	workspacePath?: string;
	secretId?: string;
	updatedAt: number;
}

export type ToolsEnvSource = "chat" | "bot" | "account" | "unbound";

export interface ResolvedToolsEnv {
	enabled: boolean;
	enabledSource: ToolsEnvSource;
	binding: ToolsEnvBinding | null;
	bindingSource: ToolsEnvSource;
	/**
	 * Filesystem persistency scope is always at the bot level.
	 * Even when a chat pins a binding, internal files are scoped to the bot.
	 */
	scopeKind: "bot";
}

export function supportsConfinement(kind: string): boolean {
	return kind === "just-bash" || kind === "local-daemon";
}

export function scopeString(kind: "bot" | "chat", id: string): string {
	return kind === "chat" ? `chat:${id}` : `bot:${id}`;
}

export function storageFamilyId(
	sharedWorkspace: boolean,
	familyId: string,
): string {
	return sharedWorkspace ? "" : familyId;
}

/**
 * Opaque ExecutionEnv id. Do not split this on colon: chat keys contain colons.
 * accountId is included because file-mutation queues are isolate-global.
 */
export function executionEnvId(input: {
	kind: "just-bash" | "daemon";
	accountId: string;
	envId: string;
	sharedWorkspace?: boolean;
	familyId?: string;
	scope?: string;
}): string {
	if (input.kind === "daemon") {
		return `daemon:${input.accountId}:${input.envId}`;
	}
	if (input.sharedWorkspace) {
		return `just-bash:${input.accountId}:${input.envId}:shared:${input.scope}`;
	}
	return `just-bash:${input.accountId}:${input.envId}:${input.familyId}:${input.scope}`;
}

export function envDoName(accountId: string, envId: string): string {
	return `env:${accountId}:${envId}`;
}

/**
 * Chat, then bot, then account. Enabled and binding resolve independently.
 * A missing level inherits. Runtime callers still treat enabled-without-binding as off.
 */
export function resolveToolsEnv(input: {
	chat?: ToolsEnvSetting | null;
	bot?: ToolsEnvSetting | null;
	account?: ToolsEnvBinding | null;
}): ResolvedToolsEnv {
	const chat = input.chat ?? null;
	const bot = input.bot ?? null;
	const account = input.account ?? null;

	let enabled = false;
	let enabledSource: ToolsEnvSource = "unbound";
	if (chat) {
		enabled = chat.enabled;
		enabledSource = "chat";
	} else if (bot) {
		enabled = bot.enabled;
		enabledSource = "bot";
	} else if (account) {
		enabled = true;
		enabledSource = "account";
	}

	let binding: ToolsEnvBinding | null = null;
	let bindingSource: ToolsEnvSource = "unbound";
	if (chat?.binding) {
		binding = chat.binding;
		bindingSource = "chat";
	} else if (bot?.binding) {
		binding = bot.binding;
		bindingSource = "bot";
	} else if (account) {
		binding = account;
		bindingSource = "account";
	}

	return {
		enabled,
		enabledSource,
		binding,
		bindingSource,
		scopeKind: "bot",
	};
}

export function runtimeToolsEnvOn(resolved: ResolvedToolsEnv): boolean {
	return resolved.enabled && resolved.binding !== null;
}

export function assertToolsEnvWrite(input: {
	setting: ToolsEnvSetting | null;
	level: "bot" | "chat";
	botSetting?: ToolsEnvSetting | null;
	accountDefault: ToolsEnvBinding | null;
	lookup: (envId: string) => { kind: string } | undefined;
}): void {
	const setting = input.setting;
	if (setting == null) return;
	if (setting.binding) {
		assertKnownEnv(setting.binding.envId, input.lookup);
	}
	if (!setting.enabled) return;
	let inherited = setting.binding ?? null;
	if (!inherited && input.level === "chat") {
		inherited = input.botSetting?.binding ?? null;
	}
	if (!inherited) inherited = input.accountDefault;
	if (!inherited) {
		throw new ProtocolValidationError(
			"Tools env is enabled but no env binding resolves",
			"tools_env_on_without_config",
		);
	}
	if (!setting.binding) {
		assertKnownEnv(inherited.envId, input.lookup);
	}
}

function assertKnownEnv(
	envId: string,
	lookup: (envId: string) => { kind: string } | undefined,
): void {
	const def = lookup(envId);
	if (!def) {
		throw new ProtocolValidationError(
			`Unknown tools env '${envId}'`,
			"not_found",
		);
	}
	if (def.kind !== "just-bash" && def.kind !== "local-daemon") {
		throw new ProtocolValidationError(
			`Tools env '${envId}' kind '${def.kind}' is not available`,
			"unsupported_kind",
		);
	}
}

/**
 * local-daemon definitions store workspace, persist, and confinement on the
 * env row. sharedWorkspace stays off. The binding itself is still `{ envId }`.
 */
export function assertDaemonEnvWrite(input: {
	secretId?: string;
	workspacePath?: string;
	confineToWorkspace?: boolean;
	sharedWorkspace?: boolean;
}): void {
	if (!input.secretId?.trim()) {
		throw new ProtocolValidationError(
			"local-daemon envs require an existing secretId",
			"invalid_tools_env",
		);
	}
	if (!input.workspacePath?.trim()) {
		throw new ProtocolValidationError(
			"local-daemon envs require a non-empty workspacePath",
			"invalid_tools_env",
		);
	}
	if (input.confineToWorkspace === undefined) {
		throw new ProtocolValidationError(
			"local-daemon envs require confineToWorkspace",
			"invalid_tools_env",
		);
	}
	if (input.sharedWorkspace === true) {
		throw new ProtocolValidationError(
			"local-daemon envs cannot set sharedWorkspace",
			"invalid_tools_env",
		);
	}
}

export function assertJustBashEnvWrite(input: {
	kind: string;
	confineToWorkspace?: boolean;
	sharedWorkspace?: boolean;
	secretId?: string;
	workspacePath?: string;
}): void {
	if (input.kind !== "just-bash") {
		throw new ProtocolValidationError(
			`Tools env kind '${input.kind}' is not supported`,
			"unsupported_kind",
		);
	}
	if (input.confineToWorkspace === false) {
		throw new ProtocolValidationError(
			"just-bash envs are always confined to the workspace",
			"confinement_required",
		);
	}
	if (input.secretId !== undefined || input.workspacePath !== undefined) {
		throw new ProtocolValidationError(
			"just-bash envs do not take secretId or workspacePath",
			"invalid_tools_env",
		);
	}
}

export interface IdentitySectionInput {
	enabled: boolean;
	connected: boolean;
	toolsOffered: boolean;
	harvest: boolean;
	kind?: string;
	envId?: string;
	enabledSource?: ToolsEnvSource;
	bindingSource?: ToolsEnvSource;
	persist?: boolean;
	confineToWorkspace?: boolean;
	sharedWorkspace?: boolean;
	scopeKind?: "bot" | "chat";
	botDefaultKind?: string;
	root?: string;
}

export function chooseToolsEnvIdentity(
	input: IdentitySectionInput,
): { name: "tools-env" | "tools-env-unavailable"; text: string } | undefined {
	if (!input.enabled || !input.toolsOffered || input.harvest) return undefined;
	if (input.connected) {
		const pin =
			input.bindingSource === "chat"
				? "chat pin"
				: input.bindingSource === "bot"
					? "bot pin"
					: "account default";
		const persist = input.persist === false ? "ephemeral" : "persistent";
		const root = input.root ?? WORKSPACE_ROOT;
		const scope = input.scopeKind === "chat" ? "this chat" : "this bot";
		const shared = input.sharedWorkspace
			? "Other families that reference this env share this namespace."
			: "Another family does not see this namespace unless sharedWorkspace is set.";
		const confine =
			input.confineToWorkspace === false
				? "confineToWorkspace is off."
				: "confineToWorkspace is on.";
		const botDefault =
			input.bindingSource === "chat" && input.botDefaultKind
				? `The bot default is ${input.botDefaultKind}. `
				: "";
		return {
			name: "tools-env",
			text: `Tools env: ${input.kind ?? "just-bash"} (${input.envId ?? ""}), ${pin}, ${persist} workspace at ${root}. Enabled by ${input.enabledSource}, binding from ${input.bindingSource}. The namespace is ${scope}. ${shared} ${confine} ${botDefault}Use bash, read, write, and edit for this workspace. Code runs in the workspace via bash, and code.execute is disabled. Durable facts go through knowledge_* and memory_*. MEMORY.md, SOUL.md, and knowledge/<slug>.md are virtual database entities, NOT workspace files—never use read, write, edit, or bash on them; manage them exclusively with memory_* and knowledge_* tools.`,
		};
	}
	const source =
		input.enabledSource === "chat"
			? "chat pin"
			: input.enabledSource === "bot"
				? "bot default"
				: "account default";
	return {
		name: "tools-env-unavailable",
		text: `The workspace tools env for this chat is unavailable (${input.kind ?? "unknown"}, ${source}). It cannot run commands or touch files. Workspace coding tools stay offered, so code.execute is disabled. The environment reconnects on its own. Do not try to use the workspace. Keep chatting. Memory, knowledge, and schedules still work.`,
	};
}

export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

export interface ResolvedPath {
	ok: true;
	path: string;
}

export function daemonCwd(def: {
	workspacePath?: string;
	persist: boolean;
}): string {
	const base = def.workspacePath ?? "";
	if (def.persist) return base;
	return base.endsWith("/")
		? `${base}.cadmus-ephemeral`
		: `${base}/.cadmus-ephemeral`;
}

/**
 * Host paths for a daemon. `..` and absolute paths are forwarded.
 * The daemon jail returns permission_denied; this resolver does not.
 */
export function resolveHostPath(
	input: string,
	cwd: string,
): { ok: true; path: string } | { ok: false; message: string } {
	if (input.includes("\0")) {
		return { ok: false, message: "path contains NUL" };
	}
	const joined = input.startsWith("/") ? input : posixJoin(cwd, input);
	const absolute = joined.startsWith("/") ? joined : `/${joined}`;
	const parts: string[] = [];
	for (const part of absolute.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			parts.pop();
			continue;
		}
		parts.push(part);
	}
	return { ok: true, path: `/${parts.join("/")}` };
}

export function resolveWorkspacePath(
	input: string,
	cwd = WORKSPACE_ROOT,
): { ok: true; path: string } | { ok: false; message: string } {
	if (input.includes("\0")) {
		return { ok: false, message: "path contains NUL" };
	}
	const joined = posixJoin(cwd, input);
	const parts: string[] = [];
	for (const part of joined.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			if (parts.length === 0) {
				return { ok: false, message: "path escapes /workspace" };
			}
			parts.pop();
			continue;
		}
		parts.push(part);
	}
	const path = `/${parts.join("/")}`;
	if (path !== WORKSPACE_ROOT && !path.startsWith(`${WORKSPACE_ROOT}/`)) {
		return { ok: false, message: "path escapes /workspace" };
	}
	return { ok: true, path };
}

const WRITE_OP_LOCKS = new Set([
	"writeFile",
	"appendFile",
	"truncateFile",
	"renameFile",
	"createDir",
	"remove",
]);

/**
 * Canonical lock keys for mutating ops. Relative and absolute aliases of the
 * same workspace path share one key so the per-path queue serializes them.
 */
export function writeOpLockPaths(
	op: string,
	payload: Record<string, unknown>,
): string[] {
	if (!WRITE_OP_LOCKS.has(op)) return [];
	const normalize = (value: unknown): string | undefined => {
		if (typeof value !== "string" || value.length === 0) return undefined;
		const resolved = resolveWorkspacePath(value, WORKSPACE_ROOT);
		return resolved.ok ? resolved.path : value;
	};
	if (op === "renameFile") {
		return [normalize(payload.source), normalize(payload.dest)].filter(
			(path): path is string => Boolean(path),
		);
	}
	const path = normalize(payload.path);
	return path ? [path] : [];
}

/**
 * Daemon write locks use the path string the tool already resolved.
 * They are not rewritten under /workspace.
 */
export function daemonLockPaths(
	op: string,
	payload: Record<string, unknown>,
): string[] {
	if (!WRITE_OP_LOCKS.has(op)) return [];
	const raw = (value: unknown): string | undefined =>
		typeof value === "string" && value.length > 0 ? value : undefined;
	if (op === "renameFile") {
		return [raw(payload.source), raw(payload.dest)].filter(
			(path): path is string => Boolean(path),
		);
	}
	const path = raw(payload.path);
	return path ? [path] : [];
}

export function posixJoin(base: string, next: string): string {
	if (next.startsWith("/")) return next;
	if (base.endsWith("/")) return `${base}${next}`;
	return `${base}/${next}`;
}

export function parentPath(path: string): string {
	const idx = path.lastIndexOf("/");
	if (idx <= 0) return "/";
	return path.slice(0, idx);
}

export function baseName(path: string): string {
	const idx = path.lastIndexOf("/");
	return idx < 0 ? path : path.slice(idx + 1);
}

export function joinWorkspace(
	parts: readonly string[],
	cwd = WORKSPACE_ROOT,
): string {
	let current = cwd;
	for (const part of parts) {
		current = posixJoin(current, part);
	}
	return current;
}

export const OFFLINE_TOOLS_ENV =
	"The tools env for this chat is offline (env disconnected). Chat, memory, knowledge, and schedules still work. Do not retry; the environment reconnects on its own.";
