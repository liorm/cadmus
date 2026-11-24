import type { ModelInfo, ThinkingLevel } from "@cadmus/contract/types";
import { modelListRef } from "@/lib/model-ref";

export const CANONICAL_THINKING_LEVELS: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
];

export const DEFAULT_THINKING_LEVELS: readonly ThinkingLevel[] = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
];

export const THINKING_LEVEL_LABELS: Record<ThinkingLevel, string> = {
	off: "Off",
	minimal: "Minimal",
	low: "Low",
	medium: "Medium",
	high: "High",
	xhigh: "XHigh",
	max: "Max",
};

export interface ThinkingOption {
	value: ThinkingLevel;
	label: string;
}

export function findModelByRef(
	models: readonly ModelInfo[],
	ref: string,
): ModelInfo | undefined {
	if (!ref) return undefined;
	return models.find((m) => modelListRef(m) === ref);
}

export function modelSupportsThinking(model: ModelInfo | undefined): boolean {
	if (!model) return true;
	if (model.reasoning === false) return false;
	if (model.reasoning === undefined && !model.thinkingLevels?.length) {
		return false;
	}
	return model.thinkingLevels === undefined || model.thinkingLevels.length > 0;
}

export function getThinkingOptionsForModel(
	model: ModelInfo | undefined,
	currentThinking?: ThinkingLevel,
): ThinkingOption[] {
	if (model && !modelSupportsThinking(model)) {
		return [];
	}
	const base =
		model?.thinkingLevels && model.thinkingLevels.length > 0
			? model.thinkingLevels
			: DEFAULT_THINKING_LEVELS;

	const allowed = new Set<ThinkingLevel>(base);
	if (currentThinking) {
		allowed.add(currentThinking);
	}

	return CANONICAL_THINKING_LEVELS.filter((level) => allowed.has(level)).map(
		(level) => ({
			value: level,
			label: THINKING_LEVEL_LABELS[level],
		}),
	);
}

export function clampThinkingForModel(
	thinking: ThinkingLevel,
	model: ModelInfo | undefined,
): ThinkingLevel {
	if (!model) return thinking;
	if (!modelSupportsThinking(model)) return "off";

	const supported =
		model.thinkingLevels && model.thinkingLevels.length > 0
			? model.thinkingLevels
			: DEFAULT_THINKING_LEVELS;

	if (supported.includes(thinking)) return thinking;

	const targetIdx = CANONICAL_THINKING_LEVELS.indexOf(thinking);
	for (let i = targetIdx - 1; i >= 0; i--) {
		const candidate = CANONICAL_THINKING_LEVELS[i];
		if (candidate && supported.includes(candidate)) {
			return candidate;
		}
	}
	return supported[0] ?? "off";
}
