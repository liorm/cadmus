import { describe, expect, it } from "bun:test";
import { needsYou } from "./needs-you.ts";

describe("needsYou", () => {
	const chats = [
		{ key: "a", botId: "bot-a", title: "Failed one", createdAt: 1 },
		{ key: "b", botId: "bot-b", title: "Unread one", createdAt: 2 },
		{ key: "c", botId: "bot-c", title: "Seen", createdAt: 3 },
		{ key: "d", botId: "bot-d", title: "Closed", closed: true, createdAt: 4 },
	];

	it("lists failed turns and unread replies, newest first", () => {
		const items = needsYou(
			chats,
			{
				a: { failedReason: "Google auth expired", lastUserText: "sync" },
				b: { lastBotText: "Done", lastBotAt: 50 },
				c: { lastBotText: "ok", lastBotAt: 10 },
			},
			{ b: 40, c: 20 },
		);
		expect(items.map((item) => item.chatKey)).toEqual(["b", "a"]);
		expect(items[0]?.kind).toBe("unread");
		expect(items[1]?.kind).toBe("failed");
		expect(items[1]?.reason).toBe("Google auth expired");
	});

	it("uses the first user message when the chat is untitled", () => {
		const items = needsYou(
			[{ key: "a", botId: "bot", createdAt: 1 }],
			{
				a: {
					lastBotAt: 20,
					lastBotText: "Done",
					lastUserText: "Redo the dashboard for the wall tablet tonight please",
				},
			},
			{},
		);
		expect(items[0]?.title).toBe(
			"Redo the dashboard for the wall tablet tonight …",
		);
	});

	it("skips a failed chat from the unread list", () => {
		const items = needsYou(
			[{ key: "a", botId: "bot", title: "X", createdAt: 1 }],
			{
				a: {
					failedReason: "aborted",
					lastBotAt: 99,
					lastBotText: "nope",
				},
			},
			{},
		);
		expect(items).toHaveLength(1);
		expect(items[0]?.kind).toBe("failed");
	});
});
