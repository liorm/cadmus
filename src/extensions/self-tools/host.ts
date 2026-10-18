import { join, relative, sep } from "node:path";
import type { Context } from "@earendil-works/chord";
import type {
	Harness,
	ToolExecutionApi,
	ToolExecutionResult,
	ToolRegistration,
} from "@earendil-works/pi-durable";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import type { Static, TSchema } from "typebox";
import type { BotRecord } from "../../channels/bots.ts";
import { ChatsDoc } from "../../channels/telegram/chats.ts";
import type { ScheduleService } from "../../schedules/service.ts";

/**
 * Services a self tool may call. The registry is installed before those services exist,
 * so the host fills the fields in before a turn runs.
 */
export type SelfHost = {
	home: string;
	schedules?: ScheduleService;
	/** Set once the harness is open. Bot tools refuse to run before that. */
	harness?: Harness;
	/** Register a bot created during a turn so it can take chats without a restart. */
	onBot?: (bot: BotRecord) => void;
};

/** The bot (and chat, when this conversation is one) the tool is allowed to touch. */
export type SelfScope = {
	botId: string;
	chatKey?: string;
};

const BOT_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** `bots/<id>` under `home`, and nothing else. */
export function botIdFromCwd(
	home: string,
	cwd: string | undefined,
): string | undefined {
	if (!cwd) return undefined;
	const rel = relative(join(home, "bots"), cwd);
	if (!rel || rel === "." || rel.startsWith(`..${sep}`) || rel.includes(sep))
		return undefined;
	if (rel === "..") return undefined;
	return BOT_ID.test(rel) ? rel : undefined;
}

export async function resolveSelfScope(
	host: SelfHost,
	api: ToolExecutionApi,
	context: Context,
): Promise<{ ok: true; scope: SelfScope } | { ok: false; error: string }> {
	const agent = await api.agent(context);
	const botId = botIdFromCwd(host.home, agent.cwd);
	if (!botId)
		return {
			ok: false,
			error: "This conversation is not inside a bot folder.",
		};
	const chats = await api.snapshot(ChatsDoc, context);
	const chat = chats?.items.find(
		(item) =>
			item.conversationId === api.conversationId &&
			(item.botId ?? botId) === botId &&
			!(chats.closed ?? []).includes(item.key),
	);
	return {
		ok: true,
		scope: { botId, ...(chat ? { chatKey: chat.key } : {}) },
	};
}

export function toolError(message: string): ToolExecutionResult {
	return {
		output: [{ type: "text", text: message }],
		isError: true,
	};
}

export function toolText(text: string): ToolExecutionResult {
	return { output: [{ type: "text", text }] };
}

/** One model-facing operation on the current bot. Writes must stay idempotent when replayed. */
export type SelfToolDefinition<TParameters extends TSchema> = {
	name: string;
	description: string;
	parameters: TParameters;
	replay?: "safe" | "unsafe";
	run(
		host: SelfHost,
		scope: SelfScope,
		args: Static<TParameters>,
		api: ToolExecutionApi,
		context: Context,
	): Promise<ToolExecutionResult>;
};

export function selfTool<TParameters extends TSchema>(
	host: SelfHost,
	definition: SelfToolDefinition<TParameters>,
): ToolRegistration<TParameters> {
	return defineTool({
		name: definition.name,
		description: definition.description,
		parameters: definition.parameters,
		replay: definition.replay ?? "safe",
		async execute(args, api, context) {
			const resolved = await resolveSelfScope(host, api, context);
			if (!resolved.ok) return toolError(resolved.error);
			return definition.run(host, resolved.scope, args, api, context);
		},
	});
}

export function selfToolsExtension(tools: readonly ToolRegistration[]) {
	return defineExtension({
		name: "pi-bot.self",
		tools,
	});
}
