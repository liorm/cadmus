import { describe, expect, it } from "bun:test";
import { botColor, hashBotIdToSlot } from "./bot-color.ts";

describe("botColor", () => {
	it("hashes the same id to the same slot", () => {
		expect(hashBotIdToSlot("assistant")).toBe(hashBotIdToSlot("assistant"));
		expect(botColor({ id: "assistant" })).toBe(hashBotIdToSlot("assistant"));
	});

	it("uses metadata.color when it is a valid slot", () => {
		expect(botColor({ id: "assistant", metadata: { color: "bot-7" } })).toBe(7);
		expect(botColor({ id: "assistant", metadata: { color: "2" } })).toBe(2);
	});

	it("falls back to the hash when color is missing or invalid", () => {
		const hashed = hashBotIdToSlot("researcher");
		expect(botColor({ id: "researcher", metadata: { color: "0" } })).toBe(
			hashed,
		);
		expect(botColor({ id: "researcher", metadata: { color: "9" } })).toBe(
			hashed,
		);
		expect(botColor({ id: "researcher", metadata: { color: "teal" } })).toBe(
			hashed,
		);
		expect(botColor({ id: "researcher" })).toBe(hashed);
	});
});
