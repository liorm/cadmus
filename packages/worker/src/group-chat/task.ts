import { defineTask } from "@earendil-works/pi-durable";
import { requireCadmusServices } from "../context.js";

export type GroupDriveInput = {
	/** `message_bot` tool task id. The group row uses the same id. */
	taskId: string;
};

type GroupDriveCheckpoint = { phase: "drive" } | { phase: "wake" };

/**
 * Background driver for fire-and-forget group chats.
 * `drive` reuses the send-and-wait loop. `wake` admits one input into the
 * caller's originating chat. The phase boundary is the restart point between
 * the target's reply and that delivery. Delivery itself is exactly-once:
 * the wake submission uses a stable request id, and `wake_admitted` skips
 * a second wait after the turn has already been admitted.
 */
export const GroupDriveTask = defineTask<
	GroupDriveInput,
	GroupDriveCheckpoint,
	null
>({
	name: "cadmus.group_drive",
	version: 1,
	initial: () => ({ phase: "drive" }),
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
		async drive(task, runtime, context) {
			const services = requireCadmusServices(context);
			await services.driveGroupChat(task.input.taskId);
			await runtime.commit(
				async () => ({
					status: "running" as const,
					checkpoint: { phase: "wake" as const },
				}),
				context,
			);
		},
		async wake(task, runtime, context) {
			const services = requireCadmusServices(context);
			const hold = services.groupWakeHold(task.input.taskId);
			const now = runtime.now();
			if (hold !== undefined && hold > now) {
				await runtime.sleep(hold, context);
			}
			await services.deliverGroupWake(task.input.taskId);
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
