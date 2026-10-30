import { describe, expect, it } from "bun:test";
import {
	formatTasksContinueMessage,
	isTasksContinueText,
	parseAutoContinueRound,
	TASKS_CONTINUE_PREFIX,
	tasksContinueRequestId,
} from "../../packages/worker/src/tasks/message.js";

describe("task continue message", () => {
	it("formats the auto-continue prompt and request id", () => {
		const text = formatTasksContinueMessage({
			round: 3,
			max: 20,
			tasks: [
				{ index: 3, title: "Write migration", status: "in_progress" },
				{ index: 4, title: "Add e2e test", status: "pending" },
				{ index: 1, title: "Old", status: "done" },
			],
		});
		expect(text.startsWith(TASKS_CONTINUE_PREFIX)).toBe(true);
		expect(text).toContain("round 3/20");
		expect(text).toContain("#3 [in_progress] Write migration");
		expect(text).toContain("#4 [pending] Add e2e test");
		expect(text).not.toContain("Old");
		expect(isTasksContinueText(text)).toBe(true);
		expect(parseAutoContinueRound(text)).toBe(3);
		expect(tasksContinueRequestId("main", 3)).toBe("tasks-continue:main:3");
	});
});
