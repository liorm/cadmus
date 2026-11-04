import { describe, expect, it } from "bun:test";
import { mergeMetadataPatch } from "../../src/bot-metadata.js";

describe("mergeMetadataPatch", () => {
	it("sets and overwrites keys", () => {
		expect(
			mergeMetadataPatch({ color: "bot-1", note: "a" }, { color: "bot-2" }),
		).toEqual({ color: "bot-2", note: "a" });
	});

	it("deletes keys when the patch value is null", () => {
		expect(
			mergeMetadataPatch({ color: "bot-1", note: "a" }, { note: null }),
		).toEqual({ color: "bot-1" });
	});

	it("returns undefined when every key is deleted", () => {
		expect(mergeMetadataPatch({ color: "bot-1" }, { color: null })).toBe(
			undefined,
		);
	});

	it("leaves omitted keys untouched and starts from empty", () => {
		expect(mergeMetadataPatch(undefined, { color: "bot-3" })).toEqual({
			color: "bot-3",
		});
	});
});
