import type {
	BotRecord,
	ChatRecord,
	HarvestFileDiff,
	HarvestNote,
	KnowledgeSearchResult,
	ScheduleRecord,
} from "../protocol.js";

export type {
	BotRecord,
	ChatRecord,
	HarvestFileDiff,
	HarvestNote,
	KnowledgeSearchResult,
	ScheduleRecord,
};

export interface MemoryDoc {
	content: string;
	version: number;
	updatedAt: number;
}

export interface KnowledgeDoc {
	slug: string;
	description: string;
	category?: string;
	version: number;
	body: string;
	updatedAt: number;
}

export interface BotStore {
	listBots(): BotRecord[];
	getBot(botId: string): BotRecord | undefined;
	upsertBot(bot: BotRecord): void;
	deleteBot(botId: string): void;
}

export interface BotFileStore {
	getSoul(botId: string): string;
	setSoul(botId: string, content: string): void;

	getMemory(botId: string): MemoryDoc;
	updateMemory(
		botId: string,
		content: string,
		expectedVersion: number,
	): MemoryDoc;

	listKnowledge(botId: string, category?: string): KnowledgeDoc[];
	getKnowledge(botId: string, slug: string): KnowledgeDoc | undefined;
	updateKnowledge(
		botId: string,
		input: {
			slug: string;
			description: string;
			category?: string;
			body: string;
			expectedVersion: number;
		},
	): KnowledgeDoc;
	deleteKnowledge(botId: string, slug: string, expectedVersion: number): void;
	searchKnowledge(
		botId: string,
		query: string,
		category?: string,
	): KnowledgeSearchResult[];

	snapshotFiles(botId: string): Map<string, string>;
	diffSnapshots(
		before: Map<string, string>,
		after: Map<string, string>,
	): HarvestFileDiff[];
}

export interface ChatStore {
	listChats(botId?: string): ChatRecord[];
	getChat(key: string): ChatRecord | undefined;
	getChatByConversationId(conversationId: number): ChatRecord | undefined;
	upsertChat(chat: ChatRecord): void;
	deleteChat(key: string): void;
}

export interface ScheduleStore {
	listSchedules(botId?: string, includeInternal?: boolean): ScheduleRecord[];
	getSchedule(id: string): ScheduleRecord | undefined;
	upsertSchedule(schedule: ScheduleRecord): void;
	deleteSchedule(id: string): void;
	recordFire(scheduleId: string, fireTime: number): void;
	hasFired(scheduleId: string, fireTime: number): boolean;
}

export interface HarvestStore {
	getWatermark(chatKey: string): number;
	setWatermark(chatKey: string, entryId: number): void;
	addNote(note: HarvestNote): void;
	listNotes(chatKey: string): HarvestNote[];
}

/**
 * Per-Family Store interface (backed by DO SQLite in production,
 * or an alternative out-of-band storage adapter in the future).
 * Contains ONLY data belonging to one Bot Family's conversations and chats.
 */
export interface FamilyStore {
	ensureSchema(): void;
	readonly bots: BotStore;
	readonly files: BotFileStore;
	readonly chats: ChatStore;
	readonly schedules: ScheduleStore;
	readonly harvest: HarvestStore;
}
