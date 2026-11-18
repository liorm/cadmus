import { describe, expect, test } from "bun:test";
import {
	applyPlaceholderKey,
	dimPlaceholder,
} from "../../scripts/placeholder-line.ts";

describe("gray placeholder line", () => {
	test("enter keeps the suggestion and the first key clears it", () => {
		const start = { typed: "", placeholder: "boss@example.com" };
		const kept = applyPlaceholderKey(start, "\r");
		expect(kept.done).toBe(true);
		expect(kept.value).toBe("boss@example.com");

		const typed = applyPlaceholderKey(start, "a");
		expect(typed.state.typed).toBe("a");
		expect(typed.paint.startsWith("\b")).toBe(true);
		expect(typed.paint.endsWith("a")).toBe(true);
		expect(typed.paint).not.toContain("boss@example.com");
		expect(dimPlaceholder("12345678")).toContain("12345678");
		expect(dimPlaceholder("12345678")).toContain("\u001b[90m");
	});

	test("backspacing the last character restores the gray suggestion", () => {
		const typed = applyPlaceholderKey(
			{ typed: "", placeholder: "12345678" },
			"9",
		);
		const cleared = applyPlaceholderKey(typed.state, "\u007f");
		expect(cleared.state.typed).toBe("");
		expect(cleared.paint).toContain(dimPlaceholder("12345678"));
	});
});
