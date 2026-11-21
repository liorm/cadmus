import { describe, expect, it } from "bun:test";
import { stripAppBasepath } from "./CommandCockpit";

describe("stripAppBasepath", () => {
	it("strips /app prefix for Desktop Cockpit route matching", () => {
		expect(stripAppBasepath("/app")).toBe("/");
		expect(stripAppBasepath("/app/")).toBe("/");
		expect(stripAppBasepath("/app/chat/foo")).toBe("/chat/foo");
		expect(stripAppBasepath("/app/bot/b1/schedules")).toBe("/bot/b1/schedules");
		expect(stripAppBasepath("/chat/foo")).toBe("/chat/foo");
	});
});
