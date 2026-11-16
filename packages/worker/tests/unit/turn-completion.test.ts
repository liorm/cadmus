import { describe, expect, it } from "bun:test";
import { completionOutcome } from "../../src/turn-completion.js";

describe("completionOutcome", () => {
	it("reports an interrupt as unanswered/aborted", () => {
		expect(
			completionOutcome({ status: "unanswered", reason: "aborted" }),
		).toEqual({
			status: "unanswered",
			reason: "aborted",
		});
	});
	it("keeps done for a done settle", () => {
		expect(completionOutcome({ status: "done" })).toEqual({ status: "done" });
	});
	for (const reason of [
		undefined,
		"model_error",
		"no_model",
		"reset",
		"stale",
		"faulted",
	]) {
		it(`keeps done for unanswered with reason ${String(reason)}`, () => {
			expect(completionOutcome({ status: "unanswered", reason })).toEqual({
				status: "done",
			});
		});
	}
	it("keeps done when only the reason says aborted", () => {
		expect(completionOutcome({ status: "done", reason: "aborted" })).toEqual({
			status: "done",
		});
		expect(completionOutcome({ status: "aborted", reason: "aborted" })).toEqual(
			{ status: "done" },
		);
	});
});
