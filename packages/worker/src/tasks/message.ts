import type { ChatTask } from "../protocol.js";

export const TASKS_CONTINUE_PREFIX = "**[tasks · auto-continue";

export function formatTasksContinueMessage(input: {
	round: number;
	max: number;
	tasks: readonly Pick<ChatTask, "index" | "title" | "status">[];
}): string {
	const inProgress = input.tasks
		.filter((task) => task.status === "in_progress")
		.slice()
		.sort((a, b) => a.index - b.index);
	const pending = input.tasks
		.filter((task) => task.status === "pending")
		.slice()
		.sort((a, b) => a.index - b.index);

	const sections: string[] = [
		`${TASKS_CONTINUE_PREFIX} round ${input.round}/${input.max}]**`,
	];

	if (inProgress.length > 0) {
		const taskLines = inProgress.map(
			(task) => `- **#${task.index}** \`[in_progress]\` ${task.title}`,
		);
		const note =
			pending.length > 0 ? `\n\n*(${pending.length} more pending)*` : "";
		sections.push(`**Active task:**\n${taskLines.join("\n")}${note}`);
	} else if (pending.length > 0) {
		const next = pending[0];
		const note =
			pending.length > 1 ? `\n\n*(${pending.length - 1} more pending)*` : "";
		sections.push(
			`**Next task:**\n- **#${next.index}** \`[pending]\` ${next.title}${note}`,
		);
	}

	sections.push(
		"**Continue:** Finish the in-progress task (`task_finish`) or take the next one with `task_get`. Reply without tool calls when you need the user.",
	);

	return sections.join("\n\n");
}

export function isTasksContinueText(text: string): boolean {
	return (
		text.startsWith(TASKS_CONTINUE_PREFIX) ||
		text.includes("[tasks · auto-continue")
	);
}

export function parseAutoContinueRound(text: string): number | undefined {
	const match = /\[tasks · auto-continue round (\d+)\//.exec(text);
	if (!match?.[1]) return undefined;
	return Number(match[1]);
}

export function tasksContinueRequestId(chatKey: string, round: number): string {
	return `tasks-continue:${chatKey}:${round}`;
}
