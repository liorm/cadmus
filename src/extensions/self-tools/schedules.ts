import type { Context, JsonValue } from "@earendil-works/chord";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { ChatsDoc } from "../../channels/telegram/chats.ts";
import { parseCron } from "../../schedules/cron.ts";
import { isHarvestId } from "../../schedules/harvest.ts";
import {
	type Schedule,
	ScheduleRejected,
	type ScheduleTarget,
} from "../../schedules/service.ts";
import {
	type SelfHost,
	type SelfScope,
	selfTool,
	toolError,
	toolText,
} from "./host.ts";

const createSchema = Type.Object({
	text: Type.String({
		description: "Message admitted into the target when the schedule fires.",
	}),
	cron: Type.Optional(
		Type.String({
			description:
				"Five-field cron (minute hour day month weekday) in the process time zone. Omit when `when` is set.",
		}),
	),
	when: Type.Optional(
		Type.Number({
			description:
				"Single fire time as epoch milliseconds. Omit when `cron` is set.",
		}),
	),
	target: Type.Optional(
		Type.Union(
			[Type.Literal("chat"), Type.Literal("new-chat"), Type.Literal("fork")],
			{
				description:
					"Where the fire lands. `chat` is the default and uses this chat unless `chatId` is set. `new-chat` opens a web chat. `fork` is a silent child and is not delivered.",
			},
		),
	),
	chatId: Type.Optional(
		Type.String({
			description:
				"Chat key on this bot. Required for `chat` and `fork` when this conversation is not a chat.",
		}),
	),
});

const idSchema = Type.Object({
	id: Type.String({
		description: "Schedule id returned by schedule_create or schedule_list.",
	}),
});

const updateSchema = Type.Object({
	id: Type.String({
		description: "Schedule id returned by schedule_create or schedule_list.",
	}),
	text: Type.Optional(
		Type.String({ description: "Replacement message admitted when it fires." }),
	),
	name: Type.Optional(
		Type.String({
			description: "Display name. An empty string clears the name.",
		}),
	),
	enabled: Type.Optional(
		Type.Boolean({
			description: "When false, the row stays but the clock does not fire it.",
		}),
	),
	cron: Type.Optional(
		Type.String({
			description:
				"Five-field cron (minute hour day month weekday) in the process time zone. Omit when `when` is set.",
		}),
	),
	when: Type.Optional(
		Type.Number({
			description:
				"Single fire time as epoch milliseconds. Omit when `cron` is set.",
		}),
	),
	target: Type.Optional(
		Type.Union(
			[Type.Literal("chat"), Type.Literal("new-chat"), Type.Literal("fork")],
			{
				description:
					"Where the fire lands. `chat` uses this chat unless `chatId` is set. `new-chat` opens a web chat. `fork` is a silent child and is not delivered.",
			},
		),
	),
	chatId: Type.Optional(
		Type.String({
			description: "Chat key on this bot, for a `chat` or `fork` target.",
		}),
	),
});

export type ScheduleCreateInput = {
	text?: string;
	cron?: string;
	when?: number;
	target?: string;
	chatId?: string;
};

export type ParsedScheduleCreate =
	| {
			ok: true;
			text: string;
			targetMode: "chat" | "new-chat" | "fork";
			chatId?: string;
			when: { cron: string } | { when: number };
	  }
	| { ok: false; error: string };

/** Shape checks for `schedule_create`. Chat membership is checked separately. */
export function parseScheduleCreate(
	input: ScheduleCreateInput,
): ParsedScheduleCreate {
	if (typeof input.text !== "string" || !input.text.trim())
		return { ok: false, error: "Message is missing." };
	const hasCron = input.cron !== undefined;
	const hasWhen = input.when !== undefined;
	if (hasCron === hasWhen)
		return {
			ok: false,
			error: hasCron
				? "Pass cron or when, not both."
				: "Pass a five-field cron or a when timestamp.",
		};
	let when: { cron: string } | { when: number };
	if (hasCron) {
		const cron = input.cron?.trim() ?? "";
		if (!parseCron(cron))
			return { ok: false, error: "Cron must be five fields." };
		when = { cron };
	} else if (typeof input.when !== "number" || !Number.isFinite(input.when)) {
		return { ok: false, error: "When is not a time." };
	} else {
		when = { when: input.when };
	}
	const targetMode = input.target ?? "chat";
	if (
		targetMode !== "chat" &&
		targetMode !== "new-chat" &&
		targetMode !== "fork"
	)
		return { ok: false, error: "Target must be chat, new-chat, or fork." };
	if (input.chatId !== undefined && input.chatId.trim() === "")
		return { ok: false, error: "That chat is not on this bot." };
	return {
		ok: true,
		text: input.text,
		targetMode,
		...(input.chatId === undefined ? {} : { chatId: input.chatId }),
		when,
	};
}

export type ScheduleUpdateInput = {
	id?: string;
	text?: string;
	name?: string;
	enabled?: boolean;
	cron?: string;
	when?: number;
	target?: string;
	chatId?: string;
};

export type ParsedScheduleUpdate =
	| {
			ok: true;
			id: string;
			text?: string;
			name?: string | null;
			enabled?: boolean;
			targetMode?: "chat" | "new-chat" | "fork";
			chatId?: string;
			when?: { cron: string } | { when: number };
	  }
	| { ok: false; error: string };

/** Shape checks for `schedule_update`. Chat membership is checked separately. */
export function parseScheduleUpdate(
	input: ScheduleUpdateInput,
): ParsedScheduleUpdate {
	if (typeof input.id !== "string" || !input.id.trim())
		return { ok: false, error: "Schedule id is missing." };
	const hasText = input.text !== undefined;
	const hasName = input.name !== undefined;
	const hasEnabled = input.enabled !== undefined;
	const hasCron = input.cron !== undefined;
	const hasWhen = input.when !== undefined;
	const hasTarget = input.target !== undefined;
	const hasChat = input.chatId !== undefined;
	if (
		!hasText &&
		!hasName &&
		!hasEnabled &&
		!hasCron &&
		!hasWhen &&
		!hasTarget &&
		!hasChat
	)
		return { ok: false, error: "Nothing to update." };
	if (hasCron && hasWhen)
		return { ok: false, error: "Pass cron or when, not both." };
	let when: { cron: string } | { when: number } | undefined;
	if (hasCron) {
		const cron = input.cron?.trim() ?? "";
		if (!parseCron(cron))
			return { ok: false, error: "Cron must be five fields." };
		when = { cron };
	} else if (hasWhen) {
		if (typeof input.when !== "number" || !Number.isFinite(input.when))
			return { ok: false, error: "When is not a time." };
		when = { when: input.when };
	}
	if (hasText && (typeof input.text !== "string" || !input.text.trim()))
		return { ok: false, error: "Message is missing." };
	if (hasName && typeof input.name !== "string")
		return { ok: false, error: "Name is not text." };
	if (hasName && (input.name?.trim().length ?? 0) > 80)
		return { ok: false, error: "Name is too long." };
	if (hasEnabled && typeof input.enabled !== "boolean")
		return { ok: false, error: "Enabled must be true or false." };
	let targetMode: "chat" | "new-chat" | "fork" | undefined;
	if (hasTarget) {
		if (
			input.target !== "chat" &&
			input.target !== "new-chat" &&
			input.target !== "fork"
		)
			return { ok: false, error: "Target must be chat, new-chat, or fork." };
		targetMode = input.target;
	}
	if (
		hasChat &&
		(typeof input.chatId !== "string" || input.chatId.trim() === "")
	)
		return { ok: false, error: "That chat is not on this bot." };
	return {
		ok: true,
		id: input.id.trim(),
		...(hasText ? { text: input.text } : {}),
		...(hasName ? { name: input.name?.trim() ? input.name.trim() : null } : {}),
		...(hasEnabled ? { enabled: input.enabled } : {}),
		...(targetMode === undefined ? {} : { targetMode }),
		...(hasChat ? { chatId: input.chatId } : {}),
		...(when === undefined ? {} : { when }),
	};
}

export type PublicSchedule = {
	id: string;
	kind: "cron" | "when";
	cron?: string;
	when?: number;
	text: string;
	target: ScheduleTarget;
	name?: string;
	enabled: boolean;
	nextRun?: number;
};

export function publicSchedule(schedule: Schedule): PublicSchedule | undefined {
	if (isHarvestId(schedule.id)) return undefined;
	const base = {
		id: schedule.id,
		text: schedule.text,
		target: schedule.target,
		enabled: schedule.enabled !== false,
		...(schedule.name === undefined ? {} : { name: schedule.name }),
		...(schedule.nextRun === undefined ? {} : { nextRun: schedule.nextRun }),
	};
	if (schedule.kind === "cron")
		return { ...base, kind: "cron", cron: schedule.cron };
	return { ...base, kind: "when", when: schedule.when };
}

async function remembered<T extends JsonValue>(
	api: ToolExecutionApi,
	name: string,
	context: Context,
): Promise<T | undefined> {
	return api.memo<T>(name, context);
}

export function scheduleTools(host: SelfHost) {
	const create = selfTool(host, {
		name: "schedule_create",
		description:
			"Create a schedule for this bot only. The id is chosen for you. Internal harvest jobs cannot be created. A repeat of this call returns the same schedule.",
		parameters: createSchema,
		replay: "safe",
		async run(bound, scope, args, api, context) {
			const prior = await remembered<PublicSchedule>(api, "schedule", context);
			if (prior) return toolText(JSON.stringify({ schedule: prior }));
			const schedules = bound.schedules;
			if (!schedules) return toolError("Schedules are not available.");
			const parsed = parseScheduleCreate(args);
			if (!parsed.ok) return toolError(parsed.error);
			const target = await resolveTarget(api, scope, parsed, context);
			if (!target.ok) return toolError(target.error);
			const id = await api.memo(
				"id",
				`u-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
				context,
			);
			const schedule: Schedule = {
				id,
				botId: scope.botId,
				text: parsed.text,
				target: target.target,
				...(parsed.when && "cron" in parsed.when
					? { kind: "cron", cron: parsed.when.cron }
					: { kind: "when", when: parsed.when.when }),
			};
			let rejected: string | undefined;
			try {
				await schedules.put(schedule);
			} catch (error) {
				if (!(error instanceof ScheduleRejected)) throw error;
				rejected = error.message;
			}
			// A replay after the row commit and before the outcome memo reuses `id`.
			// `put` then reports the existing row (or rejects); return that row.
			const stored = (await schedules.list(scope.botId)).find(
				(item) => item.id === id,
			);
			const shown = stored ? publicSchedule(stored) : undefined;
			if (!shown) return toolError(rejected ?? "Schedule was not stored.");
			await api.memo("schedule", shown, context);
			return toolText(JSON.stringify({ schedule: shown }));
		},
	});

	const list = selfTool(host, {
		name: "schedule_list",
		description:
			"List this bot's schedules. Other bots' rows and internal harvest jobs are omitted.",
		parameters: Type.Object({}),
		replay: "safe",
		async run(bound, scope) {
			const schedules = bound.schedules;
			if (!schedules) return toolError("Schedules are not available.");
			const rows = (await schedules.list(scope.botId))
				.map(publicSchedule)
				.filter((row): row is PublicSchedule => row !== undefined);
			return toolText(JSON.stringify({ schedules: rows }));
		},
	});

	const remove = selfTool(host, {
		name: "schedule_delete",
		description:
			"Delete one schedule that belongs to this bot. Harvest jobs and other bots' schedules are not deletable.",
		parameters: idSchema,
		replay: "safe",
		async run(bound, scope, args, api, context) {
			const prior = await remembered<{ id: string }>(api, "deleted", context);
			if (prior) return toolText(JSON.stringify({ deleted: prior.id }));
			const schedules = bound.schedules;
			if (!schedules) return toolError("Schedules are not available.");
			const id = args.id.trim();
			if (!id || isHarvestId(id)) return toolError("No such schedule.");
			const claimed = await remembered<string>(api, "target", context);
			const existing = (await schedules.list(scope.botId)).find(
				(item) => item.id === id,
			);
			if (!existing) {
				// The row was removed after `target` was memoized and before `deleted`.
				if (claimed === id) {
					await api.memo("deleted", { id }, context);
					return toolText(JSON.stringify({ deleted: id }));
				}
				return toolError("No such schedule.");
			}
			await api.memo("target", existing.id, context);
			await schedules.remove(existing.id);
			await api.memo("deleted", { id: existing.id }, context);
			return toolText(JSON.stringify({ deleted: existing.id }));
		},
	});

	const update = selfTool(host, {
		name: "schedule_update",
		description:
			"Change one schedule that belongs to this bot: message, name, enabled, cron or when, or target. Harvest jobs and other bots' schedules are not editable. A repeat of this call returns the same schedule.",
		parameters: updateSchema,
		replay: "safe",
		async run(bound, scope, args, api, context) {
			const prior = await remembered<PublicSchedule>(api, "schedule", context);
			if (prior) return toolText(JSON.stringify({ schedule: prior }));
			const schedules = bound.schedules;
			if (!schedules) return toolError("Schedules are not available.");
			const parsed = parseScheduleUpdate(args);
			if (!parsed.ok) return toolError(parsed.error);
			if (isHarvestId(parsed.id)) return toolError("No such schedule.");
			const plan = await remembered<Schedule>(api, "plan", context);
			let next = plan;
			if (!next) {
				const existing = (await schedules.list(scope.botId)).find(
					(item) => item.id === parsed.id,
				);
				if (!existing) return toolError("No such schedule.");
				const built = await applyScheduleUpdate(
					api,
					scope,
					existing,
					parsed,
					context,
				);
				if (!built.ok) return toolError(built.error);
				let nextRun: number;
				try {
					nextRun = schedules.nextRun(built.schedule);
				} catch (error) {
					if (!(error instanceof ScheduleRejected)) throw error;
					return toolError(error.message);
				}
				next = { ...built.schedule, nextRun };
				await api.memo("plan", next, context);
			}
			try {
				await schedules.put(next, {
					ifExists: "replace",
					...(next.nextRun === undefined ? {} : { nextRun: next.nextRun }),
				});
			} catch (error) {
				if (!(error instanceof ScheduleRejected)) throw error;
				return toolError(error.message);
			}
			const stored = (await schedules.list(scope.botId)).find(
				(item) => item.id === next.id,
			);
			const shown = stored ? publicSchedule(stored) : undefined;
			if (!shown) return toolError("No such schedule.");
			await api.memo("schedule", shown, context);
			return toolText(JSON.stringify({ schedule: shown }));
		},
	});

	return [create, list, update, remove];
}

async function applyScheduleUpdate(
	api: ToolExecutionApi,
	scope: SelfScope,
	existing: Schedule,
	parsed: Extract<ParsedScheduleUpdate, { ok: true }>,
	context: Context,
): Promise<{ ok: true; schedule: Schedule } | { ok: false; error: string }> {
	let target = existing.target;
	if (parsed.targetMode !== undefined || parsed.chatId !== undefined) {
		const mode =
			parsed.targetMode ??
			(existing.target.mode === "new-chat" ? undefined : existing.target.mode);
		if (mode === undefined)
			return { ok: false, error: "That chat is not on this bot." };
		const resolved = await resolveTarget(
			api,
			scope,
			{
				ok: true,
				text: parsed.text ?? existing.text,
				targetMode: mode,
				...(parsed.chatId === undefined
					? existing.target.mode === "new-chat"
						? {}
						: { chatId: existing.target.chatId }
					: { chatId: parsed.chatId }),
				when: { when: 0 },
			},
			context,
		);
		if (!resolved.ok) return resolved;
		target = resolved.target;
	}
	const text = parsed.text ?? existing.text;
	const name =
		parsed.name === undefined
			? existing.name
			: parsed.name === null
				? undefined
				: parsed.name;
	const enabled = parsed.enabled ?? existing.enabled;
	const timing =
		parsed.when === undefined
			? existing.kind === "cron"
				? { kind: "cron" as const, cron: existing.cron }
				: { kind: "when" as const, when: existing.when }
			: "cron" in parsed.when
				? { kind: "cron" as const, cron: parsed.when.cron }
				: { kind: "when" as const, when: parsed.when.when };
	return {
		ok: true,
		schedule: {
			id: existing.id,
			botId: existing.botId,
			text,
			target,
			...(name === undefined ? {} : { name }),
			...(enabled === false ? { enabled: false } : {}),
			...timing,
		},
	};
}

async function resolveTarget(
	api: ToolExecutionApi,
	scope: SelfScope,
	parsed: Extract<ParsedScheduleCreate, { ok: true }>,
	context: Context,
): Promise<
	{ ok: true; target: ScheduleTarget } | { ok: false; error: string }
> {
	if (parsed.targetMode === "new-chat")
		return { ok: true, target: { mode: "new-chat" } };
	const chatId = parsed.chatId ?? scope.chatKey;
	if (!chatId)
		return {
			ok: false,
			error: "That chat is not on this bot.",
		};
	const chats = await api.snapshot(ChatsDoc, context);
	const chat = chats?.items.find(
		(item) =>
			item.key === chatId &&
			(item.botId ?? scope.botId) === scope.botId &&
			!(chats.closed ?? []).includes(item.key),
	);
	if (!chat) return { ok: false, error: "That chat is not on this bot." };
	return { ok: true, target: { mode: parsed.targetMode, chatId } };
}
