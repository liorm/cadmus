import { describe, expect, it } from "bun:test";
import { reportChildClose } from "../../scripts/child-close.ts";

describe("reportChildClose", () => {
	it("preserves a normal exit and its output", () => {
		expect(reportChildClose("ok\n", 0, null)).toEqual({
			code: 0,
			output: "ok\n",
		});
	});

	it("preserves a non-zero exit code", () => {
		expect(reportChildClose("nope\n", 2, null)).toEqual({
			code: 2,
			output: "nope\n",
		});
	});

	it("treats a missing code as failure", () => {
		expect(reportChildClose("partial\n", null, null)).toEqual({
			code: 1,
			output: "partial\n",
		});
	});

	it("appends a signal line and fails when output already ends with a newline", () => {
		expect(reportChildClose("partial\n", null, "SIGKILL")).toEqual({
			code: 1,
			output: "partial\nkilled by signal SIGKILL\n",
		});
	});

	it("puts the signal line on its own line", () => {
		expect(reportChildClose("partial", 0, "SIGTERM")).toEqual({
			code: 1,
			output: "partial\nkilled by signal SIGTERM\n",
		});
	});

	it("reports a signal when there is no other output", () => {
		expect(reportChildClose("", null, "SIGINT")).toEqual({
			code: 1,
			output: "killed by signal SIGINT\n",
		});
	});
});
