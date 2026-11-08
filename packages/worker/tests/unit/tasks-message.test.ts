import { describe, expect, it } from "bun:test";
import {
	formatTasksContinueMessage,
	isTasksContinueText,
	parseAutoContinueRound,
	TASKS_CONTINUE_PREFIX,
	tasksContinueRequestId,
} from "../../src/tasks/message.js";

describe("task continue message", () => {
	it("formats the auto-continue prompt with active task and omits rest of pending queue", () => {
		const text = formatTasksContinueMessage({
			round: 3,
			max: 20,
			tasks: [
				{ index: 3, title: "Write migration", status: "in_progress" },
				{ index: 4, title: "Add e2e test", status: "pending" },
				{ index: 5, title: "Deploy prod", status: "pending" },
				{ index: 1, title: "Old", status: "done" },
			],
		});
		expect(text.startsWith(TASKS_CONTINUE_PREFIX)).toBe(true);
		expect(text).toContain("round 3/20");
		expect(text).toContain("**Active task:**");
		expect(text).toContain("**#3** `[in_progress]` Write migration");
		expect(text).toContain("*(2 more pending)*");
		expect(text).not.toContain("Add e2e test");
		expect(text).not.toContain("Deploy prod");
		expect(text).not.toContain("Old");
		expect(isTasksContinueText(text)).toBe(true);
		expect(parseAutoContinueRound(text)).toBe(3);
		expect(tasksContinueRequestId("main", 3)).toBe("tasks-continue:main:3");
	});

	it("formats the auto-continue prompt with next task when none is in progress", () => {
		const text = formatTasksContinueMessage({
			round: 1,
			max: 20,
			tasks: [
				{ index: 4, title: "Add e2e test", status: "pending" },
				{ index: 5, title: "Deploy prod", status: "pending" },
			],
		});
		expect(text.startsWith(TASKS_CONTINUE_PREFIX)).toBe(true);
		expect(text).toContain("**Next task:**");
		expect(text).toContain("**#4** `[pending]` Add e2e test");
		expect(text).toContain("*(1 more pending)*");
		expect(text).not.toContain("Deploy prod");
	});

	it("formats final task cleanly without pending notes", () => {
		const text = formatTasksContinueMessage({
			round: 4,
			max: 20,
			tasks: [{ index: 5, title: "Deploy prod", status: "pending" }],
		});
		expect(text).toContain("**Next task:**");
		expect(text).toContain("**#5** `[pending]` Deploy prod");
		expect(text).not.toContain("more pending");
	});
});
