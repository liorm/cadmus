import type { ToolsEnvSetting } from "@cadmus/contract/types";

export const CODING_TOOL_NAMES = ["bash", "read", "write", "edit"] as const;

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

export function codingToolsSelected(
	tools: readonly string[] | undefined,
): boolean {
	if (!tools || tools.length === 0) return false;
	return CODING_TOOL_NAMES.every((name) => tools.includes(name));
}

/** Parsed names, with coding tools appended when requested. An empty result is undefined. */
export function mergeCodingTools(
	toolsText: string,
	includeCoding: boolean,
): string[] | undefined {
	const current = toolsText
		.split(",")
		.map((part) => part.trim())
		.filter(Boolean)
		.filter((name) => !(CODING_TOOL_NAMES as readonly string[]).includes(name));
	const next = includeCoding ? [...current, ...CODING_TOOL_NAMES] : current;
	return next.length > 0 ? next : undefined;
}

/** Tools text and coding-tools checkbox as the editor first showed them. */
export interface ToolsFormBaseline {
	toolsText: string;
	includeCoding: boolean;
}

/** Same text the bot editor stores in the tools field for `bot.tools`. */
export function toolsTextFromBot(tools: readonly string[] | undefined): string {
	return tools && tools.length > 0 ? tools.join(", ") : "";
}

export function toolsFormBaseline(
	tools: readonly string[] | undefined,
): ToolsFormBaseline {
	return {
		toolsText: toolsTextFromBot(tools),
		includeCoding: codingToolsSelected(tools),
	};
}

/**
 * Payload `tools` for bot create and edit. Never returns null.
 * Create with no names omits the field (the default set; coding tools stay opt-in).
 * Edit omits the field unless the tools text or the coding-tools checkbox differs
 * from `initial`. A change sends the resulting list, and `[]` means zero tools.
 */
export function toolsPayload(
	toolsText: string,
	includeCoding: boolean,
	mode: "create" | "edit",
	initial?: ToolsFormBaseline,
): string[] | undefined {
	const parsed = mergeCodingTools(toolsText, includeCoding);
	if (mode === "create") return parsed;
	const unchanged =
		initial !== undefined &&
		initial.toolsText === toolsText &&
		initial.includeCoding === includeCoding;
	if (unchanged) return undefined;
	return parsed ?? [];
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
