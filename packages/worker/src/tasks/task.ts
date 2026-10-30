import { defineTask } from "@earendil-works/pi-durable";
import { requireCadmusServices } from "../context.js";

export type TaskContinueInput = {
	chatKey: string;
	round: number;
};

type TaskContinueCheckpoint = { phase: "run" };

/**
 * One auto-continue round. The stable request id makes admission exactly-once
 * across Durable Object restarts.
 */
export const TaskContinueTask = defineTask<
	TaskContinueInput,
	TaskContinueCheckpoint,
	null
>({
	name: "cadmus.task_continue",
	version: 1,
	initial: () => ({ phase: "run" }),
	async abort(_task, runtime, context) {
		await runtime.commit(
			async () => ({
				status: "terminal" as const,
				outcome: { status: "completed" as const, result: null },
			}),
			context,
		);
	},
	phases: {
		async run(task, runtime, context) {
			const services = requireCadmusServices(context);
			await services.deliverTaskContinue(task.input.chatKey, task.input.round);
			await runtime.commit(
				async () => ({
					status: "terminal" as const,
					outcome: { status: "completed" as const, result: null },
				}),
				context,
			);
		},
	},
});
