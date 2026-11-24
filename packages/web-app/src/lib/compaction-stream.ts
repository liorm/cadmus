import type {
	ChatStatusCompaction,
	TranscriptMessageView,
} from "@cadmus/contract/types";

export interface CompactionContextMetrics {
	contextTokens: number;
	contextWindow: number;
	backgroundThresholdTokens: number;
	usedPct: number;
	thresholdPct: number;
	nearThreshold: boolean;
	active: boolean;
}

/**
 * Computes context-window usage & threshold percentages from `ChatStatusRecord.compaction`.
 */
export function compactionContextMetrics(
	compaction: ChatStatusCompaction | undefined,
): CompactionContextMetrics {
	if (!compaction || compaction.contextWindow <= 0) {
		return {
			contextTokens: compaction?.contextTokens ?? 0,
			contextWindow: compaction?.contextWindow ?? 0,
			backgroundThresholdTokens: 0,
			usedPct: 0,
			thresholdPct: 80,
			nearThreshold: false,
			active: Boolean(compaction?.active),
		};
	}
	const { contextTokens, contextWindow, policy, active } = compaction;
	const backgroundThresholdTokens = Math.max(
		0,
		contextWindow - policy.reserveTokens - policy.backgroundTokens,
	);
	const usedPct = Math.min(
		100,
		Math.max(0, Math.round((contextTokens / contextWindow) * 100)),
	);
	const thresholdPct = Math.min(
		100,
		Math.max(0, Math.round((backgroundThresholdTokens / contextWindow) * 100)),
	);
	return {
		contextTokens,
		contextWindow,
		backgroundThresholdTokens,
		usedPct,
		thresholdPct,
		nearThreshold: usedPct >= Math.max(0, thresholdPct - 8),
		active,
	};
}

/**
 * Counts how many user turns occurred in the contiguous slice leading up to a
 * `compaction` or `reset` boundary marker at `boundaryIndex`.
 */
export function countTurnsSincePreviousBoundary(
	messages: readonly TranscriptMessageView[],
	boundaryIndex: number,
): number {
	let users = 0;
	for (let i = boundaryIndex - 1; i >= 0; i--) {
		const msg = messages[i];
		if (!msg) continue;
		if (msg.role === "compaction" || msg.role === "reset") break;
		if (msg.role === "user") users += 1;
	}
	return users;
}
