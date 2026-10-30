import type { ChatKind, ChatRecord, Deadlines } from "./protocol.js";

export const MAX_DEADLINE_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_DIRECT_TURN_MS = 0;
export const DEFAULT_DIRECT_RUN_MS = 60 * 60 * 1000;
export const DEFAULT_GROUP_TURN_MS = 120_000;
export const DEFAULT_GROUP_RUN_MS = 10 * 60_000;

export class TurnDeadlineError extends Error {
	constructor(message = "turn deadline exceeded") {
		super(message);
		this.name = "TurnDeadlineError";
	}
}

export type DeadlineEnv = {
	CADMUS_TURN_MS?: string;
	CADMUS_RUN_MS?: string;
};

export type ResolvedDeadlines = { turnMs: number; runMs: number };

function kindDefaults(kind: ChatKind | undefined): ResolvedDeadlines {
	if (kind === "group" || kind === "group-member") {
		return { turnMs: DEFAULT_GROUP_TURN_MS, runMs: DEFAULT_GROUP_RUN_MS };
	}
	return { turnMs: DEFAULT_DIRECT_TURN_MS, runMs: DEFAULT_DIRECT_RUN_MS };
}

/**
 * Parse an env override. Empty/invalid falls through. `0` is no limit.
 * Values above 24h are ignored so they do not silently clamp.
 */
export function parseDeadlineEnv(raw: string | undefined): number | undefined {
	if (raw === undefined || raw.trim() === "") return undefined;
	const value = Number(raw);
	if (!Number.isFinite(value)) return undefined;
	const ms = Math.floor(value);
	if (ms < 0) return undefined;
	if (ms > MAX_DEADLINE_MS) return undefined;
	return ms;
}

export function resolveDeadlines(
	chat: Pick<ChatRecord, "kind" | "deadlines"> | undefined,
	env?: DeadlineEnv,
): ResolvedDeadlines {
	const defaults = kindDefaults(chat?.kind);
	const envTurn = parseDeadlineEnv(env?.CADMUS_TURN_MS);
	const envRun = parseDeadlineEnv(env?.CADMUS_RUN_MS);
	const stored = chat?.deadlines;
	return {
		turnMs:
			stored?.turnMs !== undefined
				? stored.turnMs
				: (envTurn ?? defaults.turnMs),
		runMs:
			stored?.runMs !== undefined ? stored.runMs : (envRun ?? defaults.runMs),
	};
}

export function mergeDeadlines(
	stored: Deadlines | undefined,
	patch: Deadlines,
): Deadlines {
	const next: Deadlines = { ...(stored ?? {}) };
	if (patch.turnMs !== undefined) next.turnMs = patch.turnMs;
	if (patch.runMs !== undefined) next.runMs = patch.runMs;
	return next;
}
