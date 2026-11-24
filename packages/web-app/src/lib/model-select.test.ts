import type { ModelInfo } from "@cadmus/contract/types";
import { describe, expect, it } from "vitest";
import { effectiveModelTier, groupModelsForSelect } from "./model-select";

const SAMPLE_MODELS: ModelInfo[] = [
	{
		id: "echo",
		provider: "faux",
		name: "Echo",
		authenticated: true,
		credentialConfigured: true,
	},
	{
		id: "gemini-4-hydrogen",
		provider: "google",
		name: "Gemini 4 Hydrogen",
		tier: "frontier",
		authenticated: true,
		credentialConfigured: true,
	},
	{
		id: "gemini-3.8-flash",
		provider: "google",
		name: "Gemini 3.8 Flash",
		tier: "fast",
		authenticated: true,
		credentialConfigured: true,
	},
	{
		id: "gemini-2.5-flash",
		provider: "google",
		name: "Gemini 2.5 Flash",
		authenticated: true,
		credentialConfigured: true,
	},
	{
		id: "claude-opus-5-5",
		provider: "anthropic",
		name: "Claude Opus 5.5",
		tier: "frontier",
		authenticated: false,
		credentialConfigured: false,
	},
];

describe("model-select", () => {
	it("treats omitted tier as 'other'", () => {
		expect(effectiveModelTier({ tier: undefined })).toBe("other");
		expect(effectiveModelTier({ tier: "frontier" })).toBe("frontier");
		expect(effectiveModelTier({ tier: "fast" })).toBe("fast");
	});

	it("shows only frontier and fast models by default, grouped by provider with authenticated first", () => {
		const res = groupModelsForSelect(SAMPLE_MODELS);
		expect(res.totalCount).toBe(5);
		expect(res.visibleCount).toBe(3);
		expect(res.hiddenCount).toBe(2);
		expect(res.groups.map((g) => g.provider)).toEqual(["google", "anthropic"]);
		expect(res.groups[0]?.items.map((i) => i.ref)).toEqual([
			"google/gemini-4-hydrogen",
			"google/gemini-3.8-flash",
		]);
	});

	it("includes selectedRef even if its tier is 'other'", () => {
		const res = groupModelsForSelect(SAMPLE_MODELS, {
			selectedRef: "google/gemini-2.5-flash",
		});
		expect(res.groups[0]?.items.map((i) => i.ref)).toContain(
			"google/gemini-2.5-flash",
		);
	});

	it("shows all models when showAll is true", () => {
		const res = groupModelsForSelect(SAMPLE_MODELS, { showAll: true });
		expect(res.visibleCount).toBe(5);
		expect(res.hiddenCount).toBe(0);
		expect(res.groups.map((g) => g.provider)).toEqual([
			"google",
			"faux",
			"anthropic",
		]);
	});

	it("searches across all models including 'other' tier when query is set", () => {
		const res = groupModelsForSelect(SAMPLE_MODELS, { query: "2.5" });
		expect(res.visibleCount).toBe(1);
		expect(res.groups[0]?.items[0]?.ref).toBe("google/gemini-2.5-flash");
	});
});
