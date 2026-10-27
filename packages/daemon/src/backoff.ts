export const BACKOFF_INITIAL_MS = 1_000;
export const BACKOFF_CAP_MS = 60_000;

export interface BackoffState {
	failureIndex: number;
	stopped: null | "401" | "409";
	configStamp: string;
}

export type BackoffStep =
	| { action: "wait"; delayMs: number }
	| { action: "stop"; reason: "401" | "409" }
	| { action: "reset" };

export function createBackoff(configStamp: string): BackoffState {
	return { failureIndex: 0, stopped: null, configStamp };
}

/** 1s, doubled, capped at 60s, with ±20% jitter. `failureIndex` 0 is the first wait. */
export function backoffDelayMs(
	failureIndex: number,
	random: () => number = Math.random,
): number {
	const exponent = Math.max(0, failureIndex);
	const base = Math.min(BACKOFF_INITIAL_MS * 2 ** exponent, BACKOFF_CAP_MS);
	const unit = Math.min(1, Math.max(0, random()));
	const jitter = 1 + (unit * 2 - 1) * 0.2;
	return Math.round(base * jitter);
}

export function noteAttempt(
	state: BackoffState,
	status: number,
	random: () => number = Math.random,
): BackoffStep {
	if (status === 101) {
		state.failureIndex = 0;
		state.stopped = null;
		return { action: "reset" };
	}
	if (status === 401) {
		state.stopped = "401";
		return { action: "stop", reason: "401" };
	}
	if (status === 409) {
		state.stopped = "409";
		return { action: "stop", reason: "409" };
	}
	const delayMs = backoffDelayMs(state.failureIndex, random);
	state.failureIndex += 1;
	return { action: "wait", delayMs };
}

/** A 409 stop resumes only when the caller presents a new config stamp. 401 stays stopped. */
export function noteConfigChange(
	state: BackoffState,
	configStamp: string,
): void {
	if (configStamp === state.configStamp) return;
	state.configStamp = configStamp;
	if (state.stopped === "409") {
		state.stopped = null;
		state.failureIndex = 0;
	}
}
