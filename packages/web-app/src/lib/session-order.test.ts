import { describe, expect, it } from "bun:test";
import { orderSessions } from "./session-order";

describe("orderSessions", () => {
	it("puts the current session first, then last used", () => {
		const ordered = orderSessions([
			{ id: "old", current: false, lastUsedAt: 1 },
			{ id: "now", current: true, lastUsedAt: 2 },
			{ id: "newer", current: false, lastUsedAt: 9 },
		]);
		expect(ordered.map((row) => row.id)).toEqual(["now", "newer", "old"]);
	});
});
