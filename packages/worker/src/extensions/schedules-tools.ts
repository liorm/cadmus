import type { JsonValue } from "@earendil-works/chord";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { requireCadmusServices } from "../context.js";
import {
	computeInSeconds,
	isValidCron,
	nextCron,
	parseAbsoluteTime,
	parseRelativeDuration,
} from "../cron.js";
import { getLogger } from "../log.js";
import type { ScheduleRecord, ScheduleTarget } from "../protocol.js";
import { ThinkingLevelSchema } from "../protocol.js";
import { resolveBotScope, toolError, toolText } from "./knowledge-tools.js";

export function schedulesToolsExtension() {
	return defineExtension({
		name: "cadmus.schedules-tools",
		tools: [
			defineTool({
				name: "schedule_create",
				description:
					"Create a scheduled task for this bot. Requires 'kind' ('relative', 'absolute', or 'cron') and a unified 'input' string/number: 'relative' for duration from now (e.g. '5s', '10m', '1s4m', '100ms', or plain number in seconds), 'absolute' for exact date/time (e.g. 'tomorrow at 5pm', ISO string '2026-10-18T22:30:00Z', or epoch timestamp), or 'cron' for recurring patterns (e.g. '0 9 * * *' or '@hourly'). The result reports nextRun, inSeconds (remaining seconds), and recurring (boolean).",
				parameters: Type.Object({
					name: Type.Optional(
						Type.String({
							description: "Optional human-readable label for the schedule.",
						}),
					),
					kind: Type.Union(
						[
							Type.Literal("relative", {
								description:
									"One-shot schedule based on relative duration strictly from now (e.g. '10s', '5m', '1s4m', '4s 2m', '100ms', or plain number in seconds).",
							}),
							Type.Literal("absolute", {
								description:
									"One-shot schedule targeted at an absolute date and time (e.g. 'tomorrow at 5pm', ISO string '2026-10-18T22:30:00Z', or epoch timestamp).",
							}),
							Type.Literal("cron", {
								description:
									"Recurring schedule governed by a cron pattern expression or standard nickname (e.g. '0 9 * * *' or '@hourly').",
							}),
						],
						{
							description:
								"Schedule timing kind: 'relative', 'absolute', or 'cron'.",
						},
					),
					input: Type.Union([Type.String(), Type.Number()], {
						description:
							"Unified timing input: duration for 'relative' (e.g. '5s', '10m', 10), date/time for 'absolute' (e.g. 'tomorrow at 5pm', ISO string, epoch ms), or cron pattern for 'cron' (e.g. '0 9 * * *', '@hourly').",
					}),
					text: Type.String({
						minLength: 1,
						description:
							"Prompt text delivered to the bot when the schedule triggers.",
					}),
					thinking: Type.Optional(ThinkingLevelSchema),
					target: Type.Optional(
						Type.Union([
							Type.Object({
								mode: Type.Literal("chat"),
								chatKey: Type.Optional(Type.String()),
							}),
							Type.Object({
								mode: Type.Literal("new-chat"),
							}),
							Type.Object({
								mode: Type.Literal("fork"),
								chatKey: Type.Optional(Type.String()),
								at: Type.Optional(Type.Number()),
							}),
						]),
					),
				}),
				replay: "safe",
				executionMode: "sequential",
				async execute(args, api, context) {
					const prior = await api.memo<JsonValue>("result", context);
					if (prior !== undefined) {
						return toolText(JSON.stringify(prior));
					}
					const scope = await resolveBotScope(api, context);
					if (!scope) {
						return toolError("Conversation is not bound to a bot.");
					}
					const services = requireCadmusServices(context);
					const bot = services.familyStore.bots.getBot(scope.botId);
					const timezone = bot?.timezone ?? services.getTimezone();

					let nextRun: number;
					if (args.kind === "relative") {
						try {
							nextRun = parseRelativeDuration(args.input, Date.now());
						} catch (err) {
							return toolError((err as Error).message);
						}
					} else if (args.kind === "absolute") {
						try {
							nextRun = parseAbsoluteTime(args.input, Date.now(), timezone);
						} catch (err) {
							return toolError((err as Error).message);
						}
					} else if (args.kind === "cron") {
						const cronStr = String(args.input);
						if (!cronStr || !isValidCron(cronStr)) {
							return toolError(`Invalid cron expression: '${cronStr}'`);
						}
						const computed = nextCron(cronStr, Date.now(), timezone);
						if (computed === undefined) {
							return toolError(
								`Cron expression '${cronStr}' has no upcoming occurrence.`,
							);
						}
						nextRun = computed;
					} else {
						return toolError(`Invalid schedule kind: '${args.kind}'`);
					}

					let target: ScheduleTarget;
					if (!args.target || args.target.mode === "chat") {
						const chatKey =
							(args.target && "chatKey" in args.target
								? args.target.chatKey
								: undefined) ?? scope.chatKey;
						if (!chatKey) {
							target = { mode: "new-chat" };
						} else {
							const existingChat = services.familyStore.chats.getChat(chatKey);
							if (existingChat && existingChat.botId !== scope.botId) {
								return toolError(
									`Chat '${chatKey}' belongs to bot '${existingChat.botId}', not '${scope.botId}'.`,
								);
							}
							target = { mode: "chat", chatKey };
						}
					} else if (args.target.mode === "fork") {
						const chatKey = args.target.chatKey ?? scope.chatKey;
						if (!chatKey) {
							return toolError("fork schedule requires a chatKey.");
						}
						const existingChat = services.familyStore.chats.getChat(chatKey);
						if (existingChat && existingChat.botId !== scope.botId) {
							return toolError(
								`Chat '${chatKey}' belongs to bot '${existingChat.botId}', not '${scope.botId}'.`,
							);
						}
						target = {
							mode: "fork",
							chatKey,
							...(args.target.at !== undefined ? { at: args.target.at } : {}),
						};
					} else {
						target = { mode: "new-chat" };
					}

					const inSeconds = computeInSeconds(nextRun, Date.now());
					const id = `sched-${crypto.randomUUID().slice(0, 8)}`;
					const schedule: ScheduleRecord = {
						id,
						botId: scope.botId,
						...(args.name ? { name: args.name } : {}),
						kind: args.kind,
						input: args.input,
						nextRun,
						inSeconds,
						recurring: args.kind === "cron",
						text: args.text,
						target,
						...(args.thinking ? { thinking: args.thinking } : {}),
						enabled: true,
					};

					services.familyStore.schedules.upsertSchedule(schedule);
					await services.ensureScheduleTask(schedule.id);
					await services.syncAlarm();

					getLogger().info("schedule created via schedule_create tool", {
						bot: scope.botId,
						schedule: schedule.id,
						kind: schedule.kind,
						nextRun: schedule.nextRun,
						inSeconds: schedule.inSeconds,
					});

					const result = schedule as unknown as JsonValue;
					await api.memo("result", result, context);
					return toolText(JSON.stringify(schedule));
				},
			}),

			defineTool({
				name: "schedule_list",
				// Cadmus settings read-only: execute() lists schedules.
				description: "List all schedules configured for this bot.",
				parameters: Type.Object({}),
				replay: "safe",
				async execute(_args, api, context) {
					const scope = await resolveBotScope(api, context);
					if (!scope) {
						return toolError("Conversation is not bound to a bot.");
					}
					const services = requireCadmusServices(context);
					const list = services.familyStore.schedules.listSchedules(
						scope.botId,
						false,
					);
					return toolText(JSON.stringify({ schedules: list }));
				},
			}),

			defineTool({
				name: "schedule_update",
				description: "Update an existing schedule belonging to this bot.",
				parameters: Type.Object({
					id: Type.String({
						description: "Identifier of the schedule to update.",
					}),
					name: Type.Optional(
						Type.String({
							description: "Optional updated label or description.",
						}),
					),
					kind: Type.Optional(
						Type.Union(
							[
								Type.Literal("relative"),
								Type.Literal("absolute"),
								Type.Literal("cron"),
							],
							{
								description:
									"Optional updated schedule kind ('relative', 'absolute', 'cron').",
							},
						),
					),
					input: Type.Optional(
						Type.Union([Type.String(), Type.Number()], {
							description:
								"Optional updated timing input (duration for 'relative', date/time for 'absolute', cron expression for 'cron').",
						}),
					),
					text: Type.Optional(
						Type.String({
							description: "Optional updated prompt text.",
						}),
					),
					thinking: Type.Optional(ThinkingLevelSchema),
					enabled: Type.Optional(
						Type.Boolean({
							description:
								"Optional boolean to enable (true) or pause (false) the schedule.",
						}),
					),
				}),
				replay: "safe",
				executionMode: "sequential",
				async execute(args, api, context) {
					const prior = await api.memo<JsonValue>("result", context);
					if (prior !== undefined) {
						return toolText(JSON.stringify(prior));
					}
					const scope = await resolveBotScope(api, context);
					if (!scope) {
						return toolError("Conversation is not bound to a bot.");
					}
					const services = requireCadmusServices(context);
					const existing = services.familyStore.schedules.getSchedule(args.id);
					if (
						!existing ||
						existing.botId !== scope.botId ||
						existing.internal
					) {
						return toolError(`Schedule '${args.id}' not found.`);
					}

					const bot = services.familyStore.bots.getBot(existing.botId);
					const timezone = bot?.timezone ?? services.getTimezone();

					let nextRun = existing.nextRun;
					const kind = args.kind ?? existing.kind;
					const input = args.input ?? existing.input;

					if (args.input !== undefined) {
						if (kind === "relative") {
							try {
								nextRun = parseRelativeDuration(args.input, Date.now());
							} catch (err) {
								return toolError((err as Error).message);
							}
						} else if (kind === "absolute") {
							try {
								nextRun = parseAbsoluteTime(args.input, Date.now(), timezone);
							} catch (err) {
								return toolError((err as Error).message);
							}
						} else if (kind === "cron") {
							const cronStr = String(args.input);
							if (!cronStr || !isValidCron(cronStr)) {
								return toolError(`Invalid cron expression: '${cronStr}'`);
							}
							const computed = nextCron(cronStr, Date.now(), timezone);
							if (computed === undefined) {
								return toolError(
									`Cron expression '${cronStr}' has no upcoming occurrence.`,
								);
							}
							nextRun = computed;
						}
					} else if (args.kind !== undefined && args.kind !== existing.kind) {
						return toolError(
							`Cannot change schedule kind to '${args.kind}' without specifying new timing input.`,
						);
					}

					const inSeconds = computeInSeconds(nextRun, Date.now());
					const updated: ScheduleRecord = {
						...existing,
						...(args.name !== undefined ? { name: args.name } : {}),
						kind,
						input,
						nextRun,
						inSeconds,
						recurring: kind === "cron",
						text: args.text ?? existing.text,
						...(args.thinking !== undefined ? { thinking: args.thinking } : {}),
						enabled: args.enabled ?? existing.enabled,
					};

					services.familyStore.schedules.upsertSchedule(updated);
					if (updated.enabled) {
						await services.ensureScheduleTask(updated.id);
					}
					await services.syncAlarm();

					getLogger().info("schedule updated via schedule_update tool", {
						bot: scope.botId,
						schedule: updated.id,
						enabled: updated.enabled,
						nextRun: updated.nextRun,
						inSeconds: updated.inSeconds,
					});

					const result = updated as unknown as JsonValue;
					await api.memo("result", result, context);
					return toolText(JSON.stringify(updated));
				},
			}),

			defineTool({
				name: "schedule_delete",
				description: "Delete a schedule belonging to this bot.",
				parameters: Type.Object({
					id: Type.String({
						description: "Identifier of the schedule to delete.",
					}),
				}),
				replay: "safe",
				executionMode: "sequential",
				async execute(args, api, context) {
					const prior = await api.memo<JsonValue>("deleted", context);
					if (prior !== undefined) {
						return toolText(JSON.stringify(prior));
					}
					const scope = await resolveBotScope(api, context);
					if (!scope) {
						return toolError("Conversation is not bound to a bot.");
					}
					const services = requireCadmusServices(context);
					const existing = services.familyStore.schedules.getSchedule(args.id);
					if (
						!existing ||
						existing.botId !== scope.botId ||
						existing.internal
					) {
						return toolError(`Schedule '${args.id}' not found.`);
					}

					services.familyStore.schedules.deleteSchedule(args.id);
					await services.syncAlarm();

					getLogger().info("schedule deleted via schedule_delete tool", {
						bot: scope.botId,
						schedule: args.id,
					});

					const record = { deleted: args.id };
					await api.memo("deleted", record, context);
					return toolText(JSON.stringify(record));
				},
			}),
		],
	});
}
