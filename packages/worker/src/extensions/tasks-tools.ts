import type { JsonValue } from "@earendil-works/chord";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { requireCadmusServices } from "../context.js";
import {
	MAX_OPEN_TASKS,
	MAX_TASK_DETAILS,
	MAX_TASK_SUMMARY,
	MAX_TASK_TITLE,
} from "../tasks/limits.js";
import { TaskContinueTask } from "../tasks/task.js";
import { resolveBotScope, toolError, toolText } from "./knowledge-tools.js";

function markProgress(
	services: ReturnType<typeof requireCadmusServices>,
	chatKey: string,
): void {
	const loop = services.familyStore.tasks.getLoop(chatKey);
	services.familyStore.tasks.setLoop(chatKey, { ...loop, stuckRounds: 0 });
}

export function tasksToolsExtension() {
	return defineExtension({
		name: "cadmus.tasks-tools",
		tasks: [TaskContinueTask],
		tools: [
			defineTool({
				name: "task_add",
				description:
					"Add a pending task to this chat's work list. Returns the new task index.",
				parameters: Type.Object({
					title: Type.String({
						minLength: 1,
						maxLength: MAX_TASK_TITLE,
						description: "Short task title (1-120 characters).",
					}),
					details: Type.String({
						minLength: 1,
						maxLength: MAX_TASK_DETAILS,
						description: "Task details (1-8000 characters).",
					}),
				}),
				replay: "safe",
				executionMode: "sequential",
				async execute(args, api, context) {
					const prior = await api.memo<JsonValue>("result", context);
					if (prior !== undefined) return toolText(JSON.stringify(prior));
					const scope = await resolveBotScope(api, context);
					if (!scope?.chatKey) {
						return toolError("Conversation is not bound to a chat.");
					}
					const services = requireCadmusServices(context);
					if (
						services.familyStore.tasks.openCount(scope.chatKey) >=
						MAX_OPEN_TASKS
					) {
						return toolError(
							`This chat already has ${MAX_OPEN_TASKS} open tasks.`,
						);
					}
					const task = services.familyStore.tasks.add(
						scope.chatKey,
						args.title,
						args.details,
						Date.now(),
					);
					markProgress(services, scope.chatKey);
					services.broadcastChatTasks(scope.chatKey);
					const result = { index: task.index };
					await api.memo("result", result as unknown as JsonValue, context);
					return toolText(JSON.stringify(result));
				},
			}),
			defineTool({
				name: "task_remove",
				description:
					"Remove a task by index. Removing an in-progress task abandons it. Indexes are never reused.",
				parameters: Type.Object({
					index: Type.Integer({
						minimum: 1,
						description: "Task index to remove.",
					}),
				}),
				replay: "safe",
				executionMode: "sequential",
				async execute(args, api, context) {
					const prior = await api.memo<JsonValue>("result", context);
					if (prior !== undefined) return toolText(JSON.stringify(prior));
					const scope = await resolveBotScope(api, context);
					if (!scope?.chatKey) {
						return toolError("Conversation is not bound to a chat.");
					}
					const services = requireCadmusServices(context);
					const removed = services.familyStore.tasks.remove(
						scope.chatKey,
						args.index,
					);
					if (!removed) {
						return toolError(`Task #${args.index} was not found.`);
					}
					markProgress(services, scope.chatKey);
					services.broadcastChatTasks(scope.chatKey);
					const result = { index: args.index, removed: true as const };
					await api.memo("result", result as unknown as JsonValue, context);
					return toolText(JSON.stringify(result));
				},
			}),
			defineTool({
				name: "task_get",
				description:
					"Start a task. With no index, returns the in-progress task or starts the lowest-index pending task. At most one task can be in progress.",
				parameters: Type.Object({
					index: Type.Optional(
						Type.Integer({
							minimum: 1,
							description:
								"Task index to start. Omitted picks the next pending task.",
						}),
					),
				}),
				replay: "safe",
				executionMode: "sequential",
				async execute(args, api, context) {
					const prior = await api.memo<JsonValue>("result", context);
					if (prior !== undefined) return toolText(JSON.stringify(prior));
					const scope = await resolveBotScope(api, context);
					if (!scope?.chatKey) {
						return toolError("Conversation is not bound to a chat.");
					}
					const services = requireCadmusServices(context);
					const current = services.familyStore.tasks.inProgress(scope.chatKey);
					if (args.index === undefined) {
						if (current) {
							const result = {
								index: current.index,
								title: current.title,
								details: current.details,
								status: "in_progress" as const,
							};
							await api.memo("result", result as unknown as JsonValue, context);
							return toolText(JSON.stringify(result));
						}
						const next = services.familyStore.tasks.lowestPending(
							scope.chatKey,
						);
						if (!next) {
							return toolError("No pending task is available.");
						}
						const started = services.familyStore.tasks.start(
							scope.chatKey,
							next.index,
							Date.now(),
						);
						if (!started) {
							return toolError(`Task #${next.index} was not found.`);
						}
						markProgress(services, scope.chatKey);
						services.broadcastChatTasks(scope.chatKey);
						const result = {
							index: started.index,
							title: started.title,
							details: started.details,
							status: "in_progress" as const,
						};
						await api.memo("result", result as unknown as JsonValue, context);
						return toolText(JSON.stringify(result));
					}
					const target = services.familyStore.tasks.get(
						scope.chatKey,
						args.index,
					);
					if (!target) {
						return toolError(`Task #${args.index} was not found.`);
					}
					if (target.status === "done") {
						return toolError(`Task #${args.index} is already done.`);
					}
					if (target.status === "in_progress") {
						const result = {
							index: target.index,
							title: target.title,
							details: target.details,
							status: "in_progress" as const,
						};
						await api.memo("result", result as unknown as JsonValue, context);
						return toolText(JSON.stringify(result));
					}
					if (current && current.index !== target.index) {
						return toolError(
							`Task #${current.index} ("${current.title}") is already in progress.`,
						);
					}
					const started = services.familyStore.tasks.start(
						scope.chatKey,
						target.index,
						Date.now(),
					);
					if (!started) {
						return toolError(`Task #${args.index} was not found.`);
					}
					markProgress(services, scope.chatKey);
					services.broadcastChatTasks(scope.chatKey);
					const result = {
						index: started.index,
						title: started.title,
						details: started.details,
						status: "in_progress" as const,
					};
					await api.memo("result", result as unknown as JsonValue, context);
					return toolText(JSON.stringify(result));
				},
			}),
			defineTool({
				name: "task_finish",
				description:
					"Mark the in-progress task done. Optional summary is stored for observability.",
				parameters: Type.Object({
					index: Type.Integer({
						minimum: 1,
						description: "Task index to finish.",
					}),
					summary: Type.Optional(
						Type.String({
							maxLength: MAX_TASK_SUMMARY,
							description: "Optional result summary (at most 500 characters).",
						}),
					),
				}),
				replay: "safe",
				executionMode: "sequential",
				async execute(args, api, context) {
					const prior = await api.memo<JsonValue>("result", context);
					if (prior !== undefined) return toolText(JSON.stringify(prior));
					const scope = await resolveBotScope(api, context);
					if (!scope?.chatKey) {
						return toolError("Conversation is not bound to a chat.");
					}
					const services = requireCadmusServices(context);
					const task = services.familyStore.tasks.get(
						scope.chatKey,
						args.index,
					);
					if (!task) {
						return toolError(`Task #${args.index} was not found.`);
					}
					if (task.status !== "in_progress") {
						return toolError(`Task #${args.index} is not in progress.`);
					}
					services.familyStore.tasks.finish(
						scope.chatKey,
						args.index,
						Date.now(),
						args.summary,
					);
					markProgress(services, scope.chatKey);
					services.broadcastChatTasks(scope.chatKey);
					const remaining = services.familyStore.tasks.openCount(scope.chatKey);
					const result = {
						index: args.index,
						status: "done" as const,
						remaining,
					};
					await api.memo("result", result as unknown as JsonValue, context);
					return toolText(JSON.stringify(result));
				},
			}),
			defineTool({
				name: "task_list",
				description: "List this chat's tasks with index, title, and status.",
				parameters: Type.Object({}),
				replay: "safe",
				async execute(_args, api, context) {
					const scope = await resolveBotScope(api, context);
					if (!scope?.chatKey) {
						return toolError("Conversation is not bound to a chat.");
					}
					const services = requireCadmusServices(context);
					const tasks = services.familyStore.tasks
						.list(scope.chatKey)
						.map((task) => ({
							index: task.index,
							title: task.title,
							status: task.status,
						}));
					return toolText(JSON.stringify(tasks));
				},
			}),
		],
	});
}
