import {
	BACKGROUND_CONTEXT,
	type Context,
	createContextKey,
	withContextValue,
} from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import type {
	BotRecord,
	ChatRecord,
	ServerEvent,
	ThinkingLevel,
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
	}): Promise<BotRecord>;
	createChat(input: {
		botId: string;
		key?: string;
		title?: string;
		thinking?: ThinkingLevel;
	}): Promise<ChatRecord>;
	submitChatTurn(input: {
		chatKey: string;
		text: string;
		requestId?: string;
	}): Promise<{ reply: string; conversationId: number }>;
	ensureScheduleTask(scheduleId: string): Promise<void>;
	syncAlarm(): Promise<number | undefined>;
	broadcast(event: ServerEvent): void;
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
