import { describe, expect, it } from "bun:test";
import type {
	ChatStatusCompaction,
	TranscriptMessageView,
} from "@cadmus/contract/types";
import {
	compactionContextMetrics,
	countTurnsSincePreviousBoundary,
} from "./compaction-stream";

describe("compaction-stream", () => {
	it("computes context percentage and near-threshold state", () => {
		const base: ChatStatusCompaction = {
			active: false,
			tasks: [],
			contextTokens: 70_000,
			contextWindow: 128_000,
			policy: {
				enabled: true,
				reserveTokens: 16_384,
				keepRecentTokens: 20_000,
				backgroundTokens: 32_768,
			},
		};
		const metrics = compactionContextMetrics(base);
		// 128000 - 16384 - 32768 = 78848 (~62% threshold)
		expect(metrics.thresholdPct).toBe(62);
		expect(metrics.usedPct).toBe(55);
		expect(metrics.nearThreshold).toBe(true);
		expect(compactionContextMetrics(undefined).usedPct).toBe(0);
	});

	it("counts turns summarized before each compaction/reset boundary", () => {
		const msgs: TranscriptMessageView[] = [
			{
				id: 1,
				role: "user",
				text: "u1",
				visibleToUser: true,
				visibleToModel: false,
			},
			{
				id: 2,
				role: "assistant",
				text: "a1",
				visibleToUser: true,
				visibleToModel: false,
			},
			{
				id: 3,
				role: "user",
				text: "u2",
				visibleToUser: true,
				visibleToModel: false,
			},
			{
				id: 4,
				role: "compaction",
				text: "Summary",
				visibleToUser: true,
				visibleToModel: true,
			},
			{
				id: 5,
				role: "user",
				text: "u3",
				visibleToUser: true,
				visibleToModel: true,
			},
			{
				id: 6,
				role: "compaction",
				text: "Summary 2",
				visibleToUser: true,
				visibleToModel: true,
			},
		];
		expect(countTurnsSincePreviousBoundary(msgs, 3)).toBe(2);
		expect(countTurnsSincePreviousBoundary(msgs, 5)).toBe(1);
	});
});
