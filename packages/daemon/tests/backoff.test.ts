import { describe, expect, it } from "bun:test";
import {
	BACKOFF_CAP_MS,
	BACKOFF_INITIAL_MS,
	backoffDelayMs,
	createBackoff,
	noteAttempt,
	noteConfigChange,
} from "../src/backoff.js";

describe("daemon backoff", () => {
	it("starts at 1s, doubles, and caps at 60s with ±20% jitter", () => {
		for (let index = 0; index < 10; index += 1) {
			const base = Math.min(BACKOFF_INITIAL_MS * 2 ** index, BACKOFF_CAP_MS);
			const low = backoffDelayMs(index, () => 0);
			const mid = backoffDelayMs(index, () => 0.5);
			const high = backoffDelayMs(index, () => 1);
			expect(low).toBe(Math.round(base * 0.8));
			expect(mid).toBe(base);
			expect(high).toBe(Math.round(base * 1.2));
		}
		expect(backoffDelayMs(0, () => 0.5)).toBe(1_000);
		expect(backoffDelayMs(1, () => 0.5)).toBe(2_000);
		expect(backoffDelayMs(6, () => 0.5)).toBe(60_000);
	});

	it("resets after a successful accept", () => {
		const state = createBackoff("cfg");
		expect(noteAttempt(state, 500, () => 0.5)).toEqual({
			action: "wait",
			delayMs: 1_000,
		});
		expect(state.failureIndex).toBe(1);
		expect(noteAttempt(state, 101, () => 0.5)).toEqual({ action: "reset" });
		expect(state.failureIndex).toBe(0);
		expect(state.stopped).toBeNull();
		const again = noteAttempt(state, 500, () => 0.5);
		expect(again.action).toBe("wait");
		if (again.action === "wait") expect(again.delayMs).toBe(1_000);
	});

	it("stops on 401", () => {
		const state = createBackoff("cfg");
		expect(noteAttempt(state, 401)).toEqual({ action: "stop", reason: "401" });
		expect(state.stopped).toBe("401");
		noteConfigChange(state, "other");
		expect(state.stopped).toBe("401");
	});

	it("stops on 409 until the config stamp changes", () => {
		const state = createBackoff("cfg");
		expect(noteAttempt(state, 409)).toEqual({ action: "stop", reason: "409" });
		noteConfigChange(state, "cfg");
		expect(state.stopped).toBe("409");
		noteConfigChange(state, "cfg-2");
		expect(state.stopped).toBeNull();
		expect(state.failureIndex).toBe(0);
	});
});
