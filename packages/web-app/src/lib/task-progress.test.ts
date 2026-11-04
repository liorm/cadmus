import { describe, expect, it } from "bun:test";
import { taskProgress } from "./task-progress.ts";

describe("taskProgress", () => {
	it("is indeterminate without tasks", () => {
		expect(taskProgress(undefined).determinate).toBe(false);
		expect(taskProgress([]).determinate).toBe(false);
	});

	it("counts done / total and the in-progress title", () => {
		const progress = taskProgress([
			{ index: 1, title: "Read", status: "done" },
			{ index: 2, title: "Write", status: "done" },
			{ index: 3, title: "Reload", status: "in_progress" },
			{ index: 4, title: "Later", status: "pending" },
		]);
		expect(progress).toEqual({
			determinate: true,
			done: 2,
			total: 4,
			currentIndex: 3,
			currentTitle: "Reload",
			ratio: 0.5,
		});
	});
});
