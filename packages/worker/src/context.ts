import {
	BACKGROUND_CONTEXT,
	type Context,
	createContextKey,
	withContextValue,
} from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import type { GroupRunResult } from "./group-chat/drive.js";
import type {
	BotRecord,
	ChatKind,
	ChatRecord,
	ServerEvent,
	ThinkingLevel,
	ToolsEnvSetting,
} from "./protocol.js";
import type { FamilyStore } from "./store/family-interface.js";

export interface CadmusServices {
	readonly familyStore: FamilyStore;
	harness: Harness;
	getTimezone(): string;
	getHarvestDelayMs(): number;
	createBot(input: {
		slug?: string;
		name: string;
		model?: string;
		thinking?: ThinkingLevel;
		tools?: string[];
		soul?: string;
		memory?: string;
		knowledge?: {
			slug: string;
			description: string;
			category?: string;
			body: string;
		}[];
		toolsEnv?: ToolsEnvSetting | null;
		timezone?: string;
		metadata?: BotRecord["metadata"];
	}): Promise<BotRecord>;
	prepareCodingTools(conversationId: number): Promise<void>;
	codingToolsOffered(conversationId: number, botId: string): Promise<boolean>;
	codingToolAllowed(
		conversationId: number,
		botId: string,
		toolName: string,
	): Promise<boolean>;
	describeToolsEnv(input: {
		conversationId: number;
		botId: string;
		toolNames: readonly string[];
	}): Promise<
		{ name: "tools-env" | "tools-env-unavailable"; text: string } | undefined
	>;
	createChat(input: {
		botId: string;
		key?: string;
		title?: string;
		thinking?: ThinkingLevel;
		toolsEnv?: ToolsEnvSetting | null;
		harvest?: boolean;
		kind?: ChatKind;
	}): Promise<ChatRecord>;
	submitChatTurn(input: {
		chatKey: string;
		text: string;
		requestId?: string;
	}): Promise<{ reply: string; conversationId: number }>;
	runMessageBot(input: {
		taskId: string;
		callerBotId: string;
		targetBotId?: string;
		targetBotIds?: readonly string[];
		topic: string;
		text: string;
		originChatKey: string;
		wait?: boolean;
		readOnly?: boolean;
	}): Promise<GroupRunResult>;
	/**
	 * If this chat's current user turn is a group-chat wake, point its root
	 * request id at that wake so peer limits start fresh and the stored hop
	 * chain applies. Queued wakes must not do this while an older turn is
	 * still calling tools.
	 */
	adoptGroupWakeRoot(chatKey: string): Promise<void>;
	driveGroupChat(taskId: string): Promise<void>;
	deliverGroupWake(taskId: string): Promise<void>;
	groupWakeHold(taskId: string): number | undefined;
	endGroupConversation(chatKey: string, response: string): boolean;
	isGroupCallerSession(chatKey: string): boolean;
	ensureScheduleTask(scheduleId: string): Promise<void>;
	syncAlarm(): Promise<number | undefined>;
	broadcast(event: ServerEvent): void;
	broadcastChatTasks(chatKey: string): void;
	deliverTaskContinue(chatKey: string, round: number): Promise<void>;
}

export const cadmusServicesKey =
	createContextKey<CadmusServices>("cadmus.services");

export function createCadmusContext(services: CadmusServices): Context {
	return withContextValue(cadmusServicesKey, services, BACKGROUND_CONTEXT);
}

export function requireCadmusServices(context: Context): CadmusServices {
	const services = context.value(cadmusServicesKey);
	if (!services) {
		throw new Error("CadmusServices are not bound to this Chord context");
	}
	return services;
}
