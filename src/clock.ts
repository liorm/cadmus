/**
 * Schedule clock. Production reads `Date.now`. Tests pin `setTestClock` so a
 * fire can be proved without waiting on the wall clock. While a test clock is
 * set, the scheduler rechecks soon so a jump forward becomes due.
 */
let read: (() => number) | undefined;

export const testClockPollMs = 20;

export function now(): number {
	return read ? read() : Date.now();
}

export function testClockActive(): boolean {
	return read !== undefined;
}

export function setTestClock(next: () => number): void {
	read = next;
}

export function resetTestClock(): void {
	read = undefined;
}
