import { describe, expect, it } from "bun:test";
import { modelListRef } from "./model-ref.ts";

describe("modelListRef", () => {
	it("prefixes a provider-local id", () => {
		expect(modelListRef({ id: "echo", provider: "faux" })).toBe("faux/echo");
		expect(modelListRef({ id: "grok-4", provider: "xai" })).toBe("xai/grok-4");
	});

	it("keeps an already-prefixed id", () => {
		expect(
			modelListRef({
				id: "anthropic/claude-3-7-sonnet",
				provider: "anthropic",
			}),
		).toBe("anthropic/claude-3-7-sonnet");
	});
});
