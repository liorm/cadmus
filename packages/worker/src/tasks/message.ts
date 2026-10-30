import type { ChatTask } from "../protocol.js";

export const TASKS_CONTINUE_PREFIX = "[tasks · auto-continue";

export function formatTasksContinueMessage(input: {
	round: number;
	max: number;
	tasks: readonly Pick<ChatTask, "index" | "title" | "status">[];
}): string {
	const open = input.tasks.filter((task) => task.status !== "done");
	const lines = open.map(
		(task) => `#${task.index} [${task.status}] ${task.title}`,
	);
	return [
		`${TASKS_CONTINUE_PREFIX} round ${input.round}/${input.max}]`,
		"Open tasks:",
		...lines,
		"Continue: finish the in-progress task (task_finish) or take the next one with task_get. Reply without tool calls when you need the user.",
	].join("\n");
}

export function isTasksContinueText(text: string): boolean {
	return text.startsWith(TASKS_CONTINUE_PREFIX);
}

export function parseAutoContinueRound(text: string): number | undefined {
	const match = /\[tasks · auto-continue round (\d+)\//.exec(text);
	if (!match?.[1]) return undefined;
	return Number(match[1]);
}

export function tasksContinueRequestId(chatKey: string, round: number): string {
	return `tasks-continue:${chatKey}:${round}`;
}
