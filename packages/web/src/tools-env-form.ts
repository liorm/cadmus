import {
	CODING_TOOL_NAMES,
	DEFAULT_CADMUS_TOOL_NAMES,
} from "@cadmus/contract/tools";
import type { ToolsEnvSetting } from "@cadmus/contract/types";

export type ToolsEnvChoice = "inherit" | "on" | "off";

export interface ToolsEnvCatalogChoice {
	envId: string;
	kind: "just-bash" | "local-daemon" | string;
	label?: string;
}

/**
 * Bot and chat pins submit `{ envId }` only. Persist, confinement, workspace,
 * and the pairing token stay on the account env definition.
 */
export function buildToolsEnvSetting(input: {
	choice: ToolsEnvChoice;
	envId?: string;
	retainEnvId?: string;
}): ToolsEnvSetting {
	if (input.choice === "inherit") return null;
	if (input.choice === "off") {
		const retained = input.retainEnvId?.trim();
		return retained
			? { enabled: false, binding: { envId: retained } }
			: { enabled: false };
	}
	const envId = input.envId?.trim();
	if (envId) return { enabled: true, binding: { envId } };
	return { enabled: true };
}

/**
 * Returns true if the tools env choice or pinned env ID differs from the stored setting.
 */
export function hasToolsEnvChanged(input: {
	stored: ToolsEnvSetting | null | undefined;
	choice: ToolsEnvChoice;
	envId: string;
}): boolean {
	const initialChoice: ToolsEnvChoice =
		input.stored == null ? "inherit" : input.stored.enabled ? "on" : "off";
	if (input.choice !== initialChoice) {
		return true;
	}
	if (input.choice === "on") {
		const initialEnvId = input.stored?.binding?.envId?.trim() ?? "";
		return input.envId.trim() !== initialEnvId;
	}
	return false;
}

const CODING_TOOL_NAME_SET = new Set<string>(CODING_TOOL_NAMES);

export function codingToolsSelected(
	tools: readonly string[] | undefined,
): boolean {
	if (!tools || tools.length === 0) return false;
	return CODING_TOOL_NAMES.every((name) => tools.includes(name));
}

function sameNameSet(
	left: readonly string[],
	right: readonly string[],
): boolean {
	const a = new Set(left);
	const b = new Set(right);
	if (a.size !== b.size) return false;
	for (const name of a) {
		if (!b.has(name)) return false;
	}
	return true;
}

/**
 * Parsed names, with coding tools appended when requested. An empty field
 * without coding tools is undefined (the default Cadmus set). An empty field
 * plus coding tools expands to that default set plus the coding tools, because
 * an explicit `bot.tools` array replaces the default set.
 *
 * Coding names stay in the text unless the checkbox represents the full coding
 * set. A partial set such as `bash` alone is part of the stored allowlist.
 */
export function mergeCodingTools(
	toolsText: string,
	includeCoding: boolean,
): string[] | undefined {
	const parsed = toolsText
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean);
	const current = includeCoding
		? parsed.filter((name) => !CODING_TOOL_NAME_SET.has(name))
		: parsed;
	if (current.length === 0) {
		if (!includeCoding) return undefined;
		return [...DEFAULT_CADMUS_TOOL_NAMES, ...CODING_TOOL_NAMES];
	}
	return includeCoding ? [...current, ...CODING_TOOL_NAMES] : current;
}

/** Tools text and coding-tools checkbox as the editor first showed them. */
export interface ToolsFormBaseline {
	toolsText: string;
	includeCoding: boolean;
}

/**
 * Text for the tools field. Coding names are removed only when every coding
 * tool is present, because the checkbox represents that full set. A partial
 * coding set stays in the text so an edit cannot drop a name such as `bash`.
 * When the remaining names are the default Cadmus set, the field is empty so
 * a bot saved as "blank + coding" opens the same way.
 */
export function toolsTextFromBot(tools: readonly string[] | undefined): string {
	if (!tools || tools.length === 0) return "";
	if (!codingToolsSelected(tools)) return tools.join(", ");
	const rest = tools.filter((name) => !CODING_TOOL_NAME_SET.has(name));
	if (sameNameSet(rest, DEFAULT_CADMUS_TOOL_NAMES)) return "";
	return rest.join(", ");
}

/**
 * Shown in the bot editor when the stored allowlist is `[]`. Saving the
 * field untouched must omit `tools`. Restoring the default set is an explicit
 * edit: change the field or the coding checkbox, then save a blank field with
 * coding off.
 */
export const EMPTY_TOOLS_ALLOWLIST_HINT =
	"This bot currently permits no tools. Change the tools field or the coding-tools checkbox and save a blank field with coding off to restore the default set.";

export function toolsFormBaseline(
	tools: readonly string[] | undefined,
): ToolsFormBaseline {
	return {
		toolsText: toolsTextFromBot(tools),
		includeCoding: codingToolsSelected(tools),
	};
}

/**
 * Payload `tools` for bot create and edit.
 * Create with an empty field and coding off omits the field (the default set).
 * An empty field plus coding tools sends the default Cadmus names plus the
 * coding tools. A non-empty field sends that list, plus coding tools when asked.
 * Edit omits the field unless the tools text or the coding-tools checkbox differs
 * from `initial`. An empty field with coding off sends `null`, which clears a
 * stored allowlist back to the default set. The form never sends `[]`: a blank
 * field means the default set ("Leave blank to allow all tools").
 */
export function toolsPayload(
	toolsText: string,
	includeCoding: boolean,
	mode: "create",
): string[] | undefined;
export function toolsPayload(
	toolsText: string,
	includeCoding: boolean,
	mode: "edit",
	initial?: ToolsFormBaseline,
): string[] | null | undefined;
export function toolsPayload(
	toolsText: string,
	includeCoding: boolean,
	mode: "create" | "edit",
	initial?: ToolsFormBaseline,
): string[] | null | undefined {
	const parsed = mergeCodingTools(toolsText, includeCoding);
	if (mode === "create") return parsed;
	const unchanged =
		initial !== undefined &&
		initial.toolsText === toolsText &&
		initial.includeCoding === includeCoding;
	if (unchanged) return undefined;
	return parsed ?? null;
}

/**
 * Edit payload. An untouched blank field on a stored `[]` allowlist omits
 * `tools` (a rename must not restore the default set). After the field or the
 * coding checkbox changes, a blank field with coding off sends `null`.
 */
export function toolsPayloadForEdit(
	toolsText: string,
	includeCoding: boolean,
	initial: ToolsFormBaseline,
	storedTools: readonly string[] | undefined,
	toolsTouched: boolean,
): string[] | null | undefined {
	const parsed = toolsPayload(toolsText, includeCoding, "edit", initial);
	if (
		parsed === undefined &&
		toolsTouched &&
		storedTools !== undefined &&
		storedTools.length === 0
	) {
		return null;
	}
	return parsed;
}

export function formatToolsEnvSummary(input: {
	stored: ToolsEnvSetting | null | undefined;
	enabled?: boolean;
	enabledSource?: string;
	bindingSource?: string;
	effective?: {
		kind?: string;
		envId?: string;
	} | null;
	status?: string;
	connectedAt?: number | null;
	lastError?: string | null;
}): string {
	const storedLabel =
		input.stored == null ? "Inherit" : input.stored.enabled ? "On" : "Off";
	if (input.enabled === undefined) {
		return `Tools env: ${storedLabel}`;
	}
	const enabled = input.enabled ? "On" : "Off";
	const source = input.enabledSource ? ` (${input.enabledSource})` : "";
	const parts = [
		`Tools env: ${storedLabel} stored, effective ${enabled}${source}`,
	];
	if (input.enabled && input.effective?.kind && input.effective.envId) {
		parts.push(input.effective.kind);
		parts.push(input.effective.envId);
		if (input.bindingSource) parts.push(`binding ${input.bindingSource}`);
		if (input.effective.kind === "just-bash") {
			parts.push("connected");
		} else if (input.status) {
			parts.push(input.status);
			if (input.connectedAt) {
				parts.push(`connectedAt ${new Date(input.connectedAt).toISOString()}`);
			}
			if (input.lastError) parts.push(`error ${input.lastError}`);
		}
	}
	return parts.join(" · ");
}
