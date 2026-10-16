import { now as clockNow, testClockActive, testClockPollMs } from "../clock.ts";

/**
 * When to tick. The in-process implementation is a `setTimeout` pump.
 * A later central clock (Durable Object alarm, cron, another process) calls
 * `fire(id)` on the harness owner instead of running this loop.
 */
export type ScheduleTimer = {
	start(): void;
	stop(): void;
	/** Recompute the next wake after a store write. */
	wake(): void;
	readonly started: boolean;
};

export function createScheduleTimer(options: {
	now?: () => number;
	dueIds(now: number): string[];
	nextRunAfter(now: number): number | undefined;
	fire(id: string): Promise<void>;
	track(work: Promise<void>): void;
}): ScheduleTimer {
	const now = () => options.now?.() ?? clockNow();
	let started = false;
	let pumping = false;
	let dirty = false;
	let timer: ReturnType<typeof setTimeout> | undefined;

	const armTimer = () => {
		if (!started) return;
		const upcoming = options.nextRunAfter(now());
		if (upcoming === undefined) return;
		const delay = Math.min(Math.max(0, upcoming - now()), 2_147_483_647);
		// A pinned test clock can jump; the wall-clock delay would not notice.
		const wait =
			testClockActive() && delay > testClockPollMs ? testClockPollMs : delay;
		timer = setTimeout(() => {
			timer = undefined;
			dirty = true;
			void pump();
		}, wait);
		timer.unref?.();
	};

	const pump = (): Promise<void> => {
		if (pumping || !started) return Promise.resolve();
		pumping = true;
		const run = (async () => {
			try {
				while (started && dirty) {
					dirty = false;
					for (const id of options.dueIds(now())) {
						if (!started) return;
						await options.fire(id);
					}
				}
			} finally {
				pumping = false;
				if (started && dirty) void pump();
				else armTimer();
			}
		})();
		options.track(run);
		return run;
	};

	const wake = () => {
		dirty = true;
		if (!started) return;
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}
		void pump();
	};

	return {
		get started() {
			return started;
		},
		start() {
			if (started) return;
			started = true;
			wake();
		},
		stop() {
			started = false;
			if (timer) clearTimeout(timer);
			timer = undefined;
		},
		wake,
	};
}
