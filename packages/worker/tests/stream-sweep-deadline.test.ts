import { describe, expect, it } from "vitest";
import { StreamSweepDeadline } from "../src/alarms";

describe("StreamSweepDeadline", () => {
	it("is not pushed back by repeated syncs while streams stay open", () => {
		const d = new StreamSweepDeadline(60_000);
		expect(d.wake(true, 0)).toBe(60_000);
		for (const t of [50_000, 100_000, 150_000]) {
			expect(d.wake(true, t)).toBe(60_000);
		}
	});

	it("re-anchors to the time after a sweep ran", () => {
		const d = new StreamSweepDeadline(60_000);
		d.wake(true, 0);
		d.swept();
		expect(d.wake(true, 61_000)).toBe(121_000);
	});

	it("clears when no stream is open and restarts for the next one", () => {
		const d = new StreamSweepDeadline(60_000);
		d.wake(true, 0);
		expect(d.wake(false, 10_000)).toBeUndefined();
		expect(d.wake(true, 20_000)).toBe(80_000);
	});

	it("keeps a stored deadline across object recreation", () => {
		const first = new StreamSweepDeadline(60_000);
		const stored = first.wake(true, 0);
		const recreated = new StreamSweepDeadline(60_000);
		recreated.restore(stored);
		expect(recreated.wake(true, 50_000)).toBe(60_000);
	});
});
