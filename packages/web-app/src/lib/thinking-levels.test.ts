import type { ModelInfo } from "@cadmus/contract/types";
import { describe, expect, test } from "vitest";
import {
	clampThinkingForModel,
	findModelByRef,
	getThinkingOptionsForModel,
	modelSupportsThinking,
} from "./thinking-levels";

function makeModel(overrides: Partial<ModelInfo> = {}): ModelInfo {
	return {
		id: "test-model",
		provider: "anthropic",
		name: "Test Model",
		authenticated: true,
		credentialConfigured: true,
		reasoning: true,
		...overrides,
	};
}

describe("findModelByRef", () => {
	test("matches provider/id format", () => {
		const models = [
			makeModel({ id: "claude-sonnet-4", provider: "anthropic" }),
			makeModel({ id: "openai/gpt-4o", provider: "openrouter" }),
		];
		expect(findModelByRef(models, "anthropic/claude-sonnet-4")?.id).toBe(
			"claude-sonnet-4",
		);
		expect(findModelByRef(models, "openai/gpt-4o")?.provider).toBe(
			"openrouter",
		);
		expect(findModelByRef(models, "missing/model")).toBeUndefined();
		expect(findModelByRef(models, "")).toBeUndefined();
	});
});

describe("modelSupportsThinking", () => {
	test("returns true when model is undefined (not yet loaded)", () => {
		expect(modelSupportsThinking(undefined)).toBe(true);
	});

	test("returns false when reasoning is false or omitted without levels", () => {
		expect(modelSupportsThinking(makeModel({ reasoning: false }))).toBe(false);
		expect(
			modelSupportsThinking(
				makeModel({ reasoning: undefined, thinkingLevels: undefined }),
			),
		).toBe(false);
	});

	test("returns true when reasoning is true", () => {
		expect(
			modelSupportsThinking(
				makeModel({
					reasoning: true,
					thinkingLevels: ["off", "low", "medium", "high"],
				}),
			),
		).toBe(true);
	});
});

describe("getThinkingOptionsForModel", () => {
	test("returns empty array for non-reasoning models", () => {
		expect(
			getThinkingOptionsForModel(makeModel({ reasoning: false }), "off"),
		).toEqual([]);
	});

	test("uses model thinkingLevels including xhigh and max in canonical order", () => {
		const model = makeModel({
			reasoning: true,
			thinkingLevels: ["max", "off", "low", "medium", "high", "xhigh"],
		});
		expect(getThinkingOptionsForModel(model)).toEqual([
			{ value: "off", label: "Off" },
			{ value: "low", label: "Low" },
			{ value: "medium", label: "Medium" },
			{ value: "high", label: "High" },
			{ value: "xhigh", label: "XHigh" },
			{ value: "max", label: "Max" },
		]);
	});

	test("preserves currentThinking if not in default list while loading", () => {
		expect(
			getThinkingOptionsForModel(undefined, "xhigh").map((o) => o.value),
		).toEqual(["off", "minimal", "low", "medium", "high", "xhigh"]);
	});
});

describe("clampThinkingForModel", () => {
	test("returns off for non-reasoning models", () => {
		expect(clampThinkingForModel("high", makeModel({ reasoning: false }))).toBe(
			"off",
		);
	});

	test("keeps supported level unchanged", () => {
		const model = makeModel({
			thinkingLevels: ["off", "low", "medium", "high", "xhigh"],
		});
		expect(clampThinkingForModel("xhigh", model)).toBe("xhigh");
	});

	test("clamps unsupported high level down to nearest supported level", () => {
		const model = makeModel({
			thinkingLevels: ["off", "minimal", "low", "medium", "high"],
		});
		expect(clampThinkingForModel("max", model)).toBe("high");
		expect(clampThinkingForModel("xhigh", model)).toBe("high");
	});

	test("falls back to first supported level when no lower level exists", () => {
		const model = makeModel({
			thinkingLevels: ["medium", "high"],
		});
		expect(clampThinkingForModel("low", model)).toBe("medium");
	});
});
