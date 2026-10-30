import type {
	BotRecord,
	ChatRecord,
	HarvestFileDiff,
	HarvestNote,
	KnowledgeSearchResult,
	ScheduleRecord,
} from "../protocol.js";

export interface ConversationRoute {
	conversationId: number;
	chatKey: string;
	botId: string;
	toolsEnvEnabled: boolean;
}

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
	upsertChat(chat: ChatRecord, options?: { listed?: boolean }): void;
	deleteChat(key: string): void;
	setTurnRoot(chatKey: string, rootRequestId: string): void;
	getTurnRoot(chatKey: string): string | undefined;
	getConversationRoute(conversationId: number): ConversationRoute | undefined;
	listConversationRoutes(chatKey: string): ConversationRoute[];
	recordConversationRoute(route: ConversationRoute): void;
	setConversationToolsEnvEnabled(
		conversationId: number,
		enabled: boolean,
	): void;
	deleteConversationRoute(conversationId: number): void;
	deleteConversationRoutesForChat(chatKey: string): void;
	deleteConversationRoutesForBot(botId: string): void;
	copyConversationRoute(parentId: number, childId: number): void;
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

export type GroupChatStatus = "open" | "ended" | "timed_out" | "capped";

/** `wait` blocks the caller. `forget` returns immediately and wakes later. */
export type GroupChatMode = "wait" | "forget";

export interface GroupMessage {
	seq: number;
	fromBotId: string;
	text: string;
	at: number;
}

export interface GroupChatRecord {
	id: string;
	topic: string;
	members: string[];
	creatorBotId: string;
	rootRequestId: string;
	humanReadOnly: true;
	/**
	 * `message_bot` `readOnly: true`. Target member sessions are limited to
	 * memory and knowledge read tools. The caller session is unchanged.
	 * Omitted or false keeps the normal tool set.
	 */
	toolsReadOnly?: boolean;
	hopChain: string[];
	turnCount: number;
	status: GroupChatStatus;
	/**
	 * `forget`: the caller is not sitting in the group, so `end_conversation`
	 * is not how these chats finish. Two members end on the target's first
	 * non-empty reply. More than two members end when every bot mentioned
	 * in the opening message has posted once. If that opening mentions
	 * nobody, every target is in that set. Cap and watchdog still apply.
	 */
	mode: GroupChatMode;
	originChatKey: string;
	taskId: string;
	openingText: string;
	endResponse?: string;
	createdAt: number;
	updatedAt: number;
	overallDeadline: number;
	replyDeadline?: number;
	delivered: Record<string, number>;
}

export interface GroupStore {
	getById(id: string): GroupChatRecord | undefined;
	getByTaskId(taskId: string): GroupChatRecord | undefined;
	findByMemberKey(
		chatKey: string,
	):
		| { group: GroupChatRecord; botId: string; role: "caller" | "member" }
		| undefined;
	insert(group: GroupChatRecord): void;
	save(group: GroupChatRecord): void;
	list(): GroupChatRecord[];
	listOpen(): GroupChatRecord[];
	appendMessage(
		groupId: string,
		fromBotId: string,
		text: string,
		at: number,
	): GroupMessage;
	listMessages(groupId: string): GroupMessage[];
	peerActions(rootRequestId: string): number;
	setPeerActions(rootRequestId: string, used: number): void;
	/**
	 * Hop chain inherited by a later turn, keyed by that turn's root request
	 * id. Wake turns store the finished group's chain here so the next
	 * `message_bot` continues depth and cycle checks. Peer-action counts are
	 * a different table and stay empty for that new root.
	 */
	setHopContext(rootRequestId: string, chain: readonly string[]): void;
	hopContext(rootRequestId: string): string[] | undefined;
	/** Epoch ms. When set and still in the future, wake delivery waits. */
	wakeHold(id: string): number | undefined;
	wakeAdmitted(id: string): boolean;
	markWakeAdmitted(id: string): void;
	bindMember(
		groupId: string,
		botId: string,
		chatKey: string,
		role: "caller" | "member",
	): void;
	memberChatKeys(groupId: string): string[];
	delete(id: string): void;
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
	readonly groups: GroupStore;
}
