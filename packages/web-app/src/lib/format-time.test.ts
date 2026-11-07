import { describe, expect, it } from "bun:test";
import { chatTitle } from "./format-time.ts";

describe("chatTitle", () => {
	it("prefers an explicit stored title", () => {
		expect(chatTitle({ key: "c", title: "Named" }, "Morning notes")).toBe(
			"Named",
		);
	});

	it("uses the first line of the fallback when untitled", () => {
		expect(chatTitle({ key: "c" }, "Morning notes\nsecond line")).toBe(
			"Morning notes",
		);
	});

	it("returns New task when untitled with no fallback", () => {
		expect(chatTitle({ key: "c" })).toBe("New task");
		expect(chatTitle({ key: "c", title: "  " }, "  ")).toBe("New task");
	});
});
