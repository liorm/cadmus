import type { Context } from "@earendil-works/chord/context";
import {
	type Conversation,
	type ConversationId,
	defineExtension,
	defineTask,
	type EntryId,
} from "@earendil-works/pi-durable";
import { type CadmusServices, requireCadmusServices } from "./context.js";
import { nextCron } from "./cron.js";
import { getLogger } from "./log.js";
import { parseThinkingLevel } from "./models.js";
import type { HarvestNote, ScheduleRecord } from "./protocol.js";

export const HARVEST_TOOLS = [
	"knowledge_read",
	"knowledge_update",
	"knowledge_delete",
	"memory_read",
	"memory_update",
] as const;

export const DEFAULT_HARVEST_PROMPT =
	"[HARVEST] Review the conversation since the last harvest watermark. Extract durable facts, preferences, or reusable reference notes and persist them using memory_update or knowledge_update. If nothing durable was added, do not modify any files.";

export type ScheduleCheckpoint =
	| { phase: "wait"; nextRun?: number }
	| { phase: "run"; nextRun: number };

export type ScheduleTaskInput = {
	scheduleId: string;
};

function done() {
	return {
		status: "terminal" as const,
		outcome: { status: "completed" as const, result: null },
	};
}

function running(checkpoint: ScheduleCheckpoint) {
	return { status: "running" as const, checkpoint };
}

export function harvestScheduleId(chatKey: string): string {
	return `harvest:${chatKey}`;
}

export const ScheduleTask = defineTask<
	ScheduleTaskInput,
	ScheduleCheckpoint,
	null
>({
	name: "cadmus.schedule",
	version: 1,
	initial: () => ({ phase: "wait" }),
	async abort(_task, runtime, context) {
		await runtime.commit(async () => done(), context);
	},
	phases: {
		async wait(task, runtime, context) {
			const services = requireCadmusServices(context);
			const id = task.input.scheduleId;

			for (;;) {
				const row = services.familyStore.schedules.getSchedule(id);
				if (!row?.enabled) {
					if (row && (row.kind === "relative" || row.kind === "absolute")) {
						services.familyStore.schedules.deleteSchedule(id);
					}
					await runtime.commit(async () => done(), context);
					return;
				}

				const now = runtime.now();
				if (now >= row.nextRun) {
					getLogger().debug("schedule task ready to run", {
						schedule: id,
						nextRun: row.nextRun,
					});
					await runtime.commit(
						async () => running({ phase: "run", nextRun: row.nextRun }),
						context,
					);
					return;
				}

				if (task.state.checkpoint.nextRun !== row.nextRun) {
					await runtime.commit(
						async () => running({ phase: "wait", nextRun: row.nextRun }),
						context,
					);
					return;
				}

				await runtime.sleep(row.nextRun, context);
			}
		},

		async run(task, runtime, context) {
			const services = requireCadmusServices(context);
			const id = task.input.scheduleId;
			const fireTime = task.state.checkpoint.nextRun;
			const row = services.familyStore.schedules.getSchedule(id);

			if (!row?.enabled) {
				if (row && (row.kind === "relative" || row.kind === "absolute")) {
					services.familyStore.schedules.deleteSchedule(id);
				}
				await runtime.commit(async () => done(), context);
				return;
			}

			getLogger().debug("schedule firing", {
				schedule: id,
				kind: row.kind,
				fireTime,
				targetMode: row.target.mode,
			});

			if (!services.familyStore.schedules.hasFired(id, fireTime)) {
				services.familyStore.schedules.recordFire(id, fireTime);
				if (row.kind === "cron") {
					const bot = services.familyStore.bots.getBot(row.botId);
					const tz = bot?.timezone ?? services.getTimezone();
					const cronNext = row.input
						? nextCron(String(row.input), fireTime, tz)
						: undefined;
					if (cronNext !== undefined) {
						services.familyStore.schedules.upsertSchedule({
							...row,
							nextRun: cronNext,
						});
					}
				}
				try {
					await executeScheduleTarget(services, row, fireTime, context);
				} catch (error) {
					getLogger().error("schedule fire failed", {
						schedule: id,
						bot: row.botId,
						error,
					});
					if (row.kind === "relative" || row.kind === "absolute") {
						services.familyStore.schedules.deleteSchedule(id);
					}
					throw error;
				}
			}

			const fresh = services.familyStore.schedules.getSchedule(id);
			if (!fresh?.enabled) {
				if (fresh && (fresh.kind === "relative" || fresh.kind === "absolute")) {
					services.familyStore.schedules.deleteSchedule(id);
				}
				await runtime.commit(async () => done(), context);
				await services.syncAlarm();
				return;
			}

			if (fresh.kind === "relative" || fresh.kind === "absolute") {
				// If it was rescheduled to a newer future time while running, wait for the new time
				if (fresh.nextRun > fireTime) {
					await runtime.commit(
						async () => running({ phase: "wait", nextRun: fresh.nextRun }),
						context,
					);
					await services.syncAlarm();
					return;
				}
				services.familyStore.schedules.deleteSchedule(id);
				await runtime.commit(async () => done(), context);
				await services.syncAlarm();
				return;
			}

			// Cron schedule: calculate next occurrence in bot's timezone
			const bot = services.familyStore.bots.getBot(fresh.botId);
			const tz = bot?.timezone ?? services.getTimezone();
			const cronNext =
				fresh.nextRun > fireTime
					? fresh.nextRun
					: fresh.input
						? nextCron(
								String(fresh.input),
								Math.max(runtime.now(), fireTime),
								tz,
							)
						: undefined;

			if (cronNext === undefined) {
				services.familyStore.schedules.upsertSchedule({
					...fresh,
					enabled: false,
				});
				await runtime.commit(async () => done(), context);
				await services.syncAlarm();
				return;
			}

			if (fresh.nextRun !== cronNext) {
				services.familyStore.schedules.upsertSchedule({
					...fresh,
					nextRun: cronNext,
				});
			}
			await runtime.commit(
				async () => running({ phase: "wait", nextRun: cronNext }),
				context,
			);
			await services.syncAlarm();
		},
	},
});

async function executeScheduleTarget(
	services: CadmusServices,
	schedule: ScheduleRecord,
	fireTime: number,
	context: Context,
): Promise<void> {
	const requestId = `sched:${schedule.id}:${fireTime}`;
	const target = schedule.target;
	const log = getLogger().child({
		bot: schedule.botId,
		schedule: schedule.id,
		requestId,
		mode: target.mode,
	});

	if (target.mode === "chat") {
		log.debug("schedule fire into chat", { chat: target.chatKey });
		await services.submitChatTurn({
			chatKey: target.chatKey,
			text: schedule.text,
			requestId,
		});
		return;
	}

	if (target.mode === "new-chat") {
		const chat = await services.createChat({
			botId: schedule.botId,
			title: schedule.name ?? "Scheduled Chat",
			thinking: schedule.thinking,
		});
		log.debug("schedule fire into new chat", { chat: chat.key });
		await services.submitChatTurn({
			chatKey: chat.key,
			text: schedule.text,
			requestId,
		});
		return;
	}

	if (target.mode === "fork") {
		log.debug("schedule fork fire", { chat: target.chatKey });
		if (target.harvest) {
			await executeHarvestFork(
				services,
				schedule,
				target.chatKey,
				target.at,
				fireTime,
				context,
			);
		} else {
			await executeStandardFork(
				services,
				schedule,
				target.chatKey,
				target.at,
				requestId,
				context,
			);
		}
	}
}

async function executeStandardFork(
	services: CadmusServices,
	schedule: ScheduleRecord,
	chatKey: string,
	targetAt: number | undefined,
	requestId: string,
	context: Context,
): Promise<void> {
	const chat = services.familyStore.chats.getChat(chatKey);
	if (!chat) return;
	const parent = await services.harness.conversation(
		chat.conversationId as ConversationId,
		context,
	);
	if (!parent) return;

	let at = targetAt as EntryId | undefined;
	if (at === undefined) {
		const page = await parent.entries(
			{ order: "descending" },
			1,
			undefined,
			context,
		);
		at = page.items[0]?.id;
	}
	if (at === undefined) return;

	const child = await parent.fork(
		at,
		{ ownership: { kind: "ownerless" } },
		context,
	);
	if (schedule.thinking) {
		const thinkingLevel = parseThinkingLevel(schedule.thinking);
		if (thinkingLevel !== undefined) {
			await child.configure({ thinkingLevel }, context);
		}
	}
	const submission = await child.submit(
		{
			type: "input",
			content: schedule.text,
			requestId,
			whenBusy: "steer",
		},
		context,
	);
	await submission.wait(context);
	await child.waitForIdle(context);
}

async function executeHarvestFork(
	services: CadmusServices,
	schedule: ScheduleRecord,
	chatKey: string,
	targetAt: number | undefined,
	fireTime: number,
	context: Context,
): Promise<void> {
	const log = getLogger().child({
		harvest: chatKey,
		chat: chatKey,
		bot: schedule.botId,
	});

	log.debug("harvest fired", {
		schedule: schedule.id,
		chat: chatKey,
		at: targetAt,
		fireTime,
	});

	const chat = services.familyStore.chats.getChat(chatKey);
	if (!chat) return;
	const parent = await services.harness.conversation(
		chat.conversationId as ConversationId,
		context,
	);
	if (!parent) return;

	const page = await parent.entries(
		{ order: "descending" },
		1,
		undefined,
		context,
	);
	const latestEntryId = page.items[0]?.id as unknown as number | undefined;
	const at = targetAt ?? latestEntryId;
	if (at === undefined) return;

	const watermark = services.familyStore.harvest.getWatermark(chatKey);
	if (watermark >= at) {
		log.debug("harvest skipped: watermark already at or past entry", {
			watermark,
			at,
		});
		return;
	}

	const hasNewUserTurn = await hasUserAfter(parent, watermark, at, context);
	if (!hasNewUserTurn) {
		services.familyStore.harvest.setWatermark(chatKey, at);
		log.debug("harvest skipped: no new user turn since watermark", {
			watermark,
			at,
		});
		return;
	}

	const before = services.familyStore.files.snapshotFiles(schedule.botId);

	const child = await parent.fork(
		at as EntryId,
		{ ownership: { kind: "ownerless" } },
		context,
	);

	const bot = services.familyStore.bots.getBot(schedule.botId);
	const allowedToolNames = bot?.tools
		? HARVEST_TOOLS.filter((t) => bot.tools?.includes(t))
		: [...HARVEST_TOOLS];

	await child.configure(
		{
			tools: allowedToolNames.map(
				(name) =>
					({
						name,
					}) as unknown as import("@earendil-works/pi-durable").ToolRegistration,
			),
		},
		context,
	);

	const submission = await child.submit(
		{
			type: "input",
			content: schedule.text || DEFAULT_HARVEST_PROMPT,
			requestId: `harvest:${chatKey}:${at}:${fireTime}`,
			whenBusy: "steer",
		},
		context,
	);
	await submission.wait(context);
	await child.waitForIdle(context);

	const after = services.familyStore.files.snapshotFiles(schedule.botId);
	const files = services.familyStore.files.diffSnapshots(before, after);

	services.familyStore.harvest.setWatermark(chatKey, at);

	if (files.length === 0) {
		log.debug("harvest finished with no file changes", { at });
	} else {
		log.debug("harvest wrote knowledge", {
			at,
			files: files.map((file) => file.path),
		});
		const note: HarvestNote = {
			chatKey,
			at,
			files,
			when: Date.now(),
		};
		services.familyStore.harvest.addNote(note);
		services.broadcast({
			type: "harvest.note",
			payload: note,
		});
	}
}

async function hasUserAfter(
	conversation: Conversation,
	after: number,
	through: number,
	context: Context,
): Promise<boolean> {
	let cursor: Parameters<Conversation["entries"]>[2];
	for (;;) {
		const page = await conversation.entries(
			{
				order: "ascending",
				minEntryId: after as EntryId,
				maxEntryId: through as EntryId,
			},
			100,
			cursor,
			context,
		);
		for (const entry of page.items) {
			const id = entry.id as unknown as number;
			if (id <= after || id > through) continue;
			if (entry.model?.[0]?.role === "user") return true;
		}
		if (page.next === undefined) return false;
		cursor = page.next;
	}
}

export function scheduleExtension() {
	return defineExtension({
		name: "cadmus.schedule",
		tasks: [ScheduleTask],
	});
}
