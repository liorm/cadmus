export const MAX_TASK_ROUNDS = 20;
export const MAX_OPEN_TASKS = 50;
export const MAX_TASK_TITLE = 120;
export const MAX_TASK_DETAILS = 8000;
export const MAX_TASK_SUMMARY = 500;
export const STUCK_ROUNDS = 2;

export function resolveTaskMaxRounds(raw: string | undefined): number {
	if (raw === undefined || raw.trim() === "") return MAX_TASK_ROUNDS;
	const value = Number(raw);
	if (!Number.isFinite(value)) return MAX_TASK_ROUNDS;
	return Math.min(Math.max(Math.floor(value), 1), MAX_TASK_ROUNDS);
}
