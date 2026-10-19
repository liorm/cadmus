import { type Static, Type } from "typebox";
import {
	AccountMemberSchema,
	AccountRecordSchema,
	BotRecordSchema,
	ChatRecordSchema,
	CredentialSummarySchema,
	FamilyRecordSchema,
	HarvestNoteSchema,
	ModelInfoSchema,
	ScheduleRecordSchema,
	ThinkingLevelSchema,
	TurnBlockSchema,
} from "./records.js";

// ─── RPC Results & Definitions ───────────────────────────────────────────────

/**
 * Result returned by account.get containing the account record, members, families, and credential summaries.
 */
export const AccountGetResultSchema = Type.Object(
	{
		account: AccountRecordSchema,
		members: Type.Array(AccountMemberSchema, {
			description: "List of user members and their roles in this account.",
		}),
		families: Type.Array(FamilyRecordSchema, {
			description: "List of bot families belonging to this account.",
		}),
		credentials: Type.Array(CredentialSummarySchema, {
			description:
				"Summaries of configured AI provider credentials (excluding secrets).",
		}),
	},
	{
		description:
			"Full account details including membership, configured bot families, and provider credentials.",
	},
);
export type AccountGetResult = Static<typeof AccountGetResultSchema>;

/**
 * Result returned by account.update containing the updated account record.
 */
export const AccountUpdateResultSchema = Type.Object(
	{
		account: AccountRecordSchema,
	},
	{
		description:
			"Result payload returned by account.update containing the modified account record.",
	},
);
export type AccountUpdateResult = Static<typeof AccountUpdateResultSchema>;

/**
 * Result returned by account.members.list containing account membership records.
 */
export const AccountMembersListResultSchema = Type.Object(
	{
		members: Type.Array(AccountMemberSchema, {
			description: "List of members belonging to this account.",
		}),
	},
	{
		description:
			"Result payload returned by account.members.list containing the list of account members.",
	},
);
export type AccountMembersListResult = Static<
	typeof AccountMembersListResultSchema
>;

/**
 * Result returned by account.members.add containing the newly added or updated member record.
 */
export const AccountMembersAddResultSchema = Type.Object(
	{
		member: AccountMemberSchema,
	},
	{
		description:
			"Result payload returned by account.members.add containing the created or updated membership.",
	},
);
export type AccountMembersAddResult = Static<
	typeof AccountMembersAddResultSchema
>;

/**
 * Result returned by account.credentials.list containing configured provider credential summaries.
 */
export const AccountCredentialsListResultSchema = Type.Object(
	{
		credentials: Type.Array(CredentialSummarySchema, {
			description:
				"List of configured provider credential summaries (excluding secret tokens).",
		}),
	},
	{
		description:
			"Result payload returned by account.credentials.list containing configured provider summaries.",
	},
);
export type AccountCredentialsListResult = Static<
	typeof AccountCredentialsListResultSchema
>;

/**
 * Result returned by account.credentials.set containing the newly stored or updated credential summary.
 */
export const AccountCredentialsSetResultSchema = Type.Object(
	{
		credential: CredentialSummarySchema,
	},
	{
		description:
			"Result payload returned by account.credentials.set containing the saved credential summary.",
	},
);
export type AccountCredentialsSetResult = Static<
	typeof AccountCredentialsSetResultSchema
>;

/**
 * Result returned by account.credentials.delete confirming credential removal.
 */
export const AccountCredentialsDeleteResultSchema = Type.Object(
	{
		deleted: Type.String({
			description: "Provider identifier whose credentials were deleted.",
		}),
	},
	{
		description:
			"Result payload returned by account.credentials.delete confirming removal of provider credentials.",
	},
);
export type AccountCredentialsDeleteResult = Static<
	typeof AccountCredentialsDeleteResultSchema
>;

/**
 * Result returned by account.models.list containing available models and their capabilities.
 */
export const AccountModelsListResultSchema = Type.Object(
	{
		models: Type.Array(ModelInfoSchema, {
			description:
				"List of available AI models, their capabilities, and authentication status.",
		}),
	},
	{
		description:
			"Result payload returned by account.models.list containing available AI models.",
	},
);
export type AccountModelsListResult = Static<
	typeof AccountModelsListResultSchema
>;

/**
 * Result returned by family.list containing all bot families in the account.
 */
export const FamilyListResultSchema = Type.Object(
	{
		families: Type.Array(FamilyRecordSchema, {
			description: "List of bot families registered to the account.",
		}),
	},
	{
		description:
			"Result payload returned by family.list containing all bot families in the account.",
	},
);
export type FamilyListResult = Static<typeof FamilyListResultSchema>;

/**
 * Result returned by family.create containing the newly created family record.
 */
export const FamilyCreateResultSchema = Type.Object(
	{
		family: FamilyRecordSchema,
	},
	{
		description:
			"Result payload returned by family.create containing the newly registered family record.",
	},
);
export type FamilyCreateResult = Static<typeof FamilyCreateResultSchema>;

/**
 * Result returned by family.get containing metadata for a bot family.
 */
export const FamilyGetResultSchema = Type.Object(
	{
		family: FamilyRecordSchema,
	},
	{
		description:
			"Result payload returned by family.get containing family metadata.",
	},
);
export type FamilyGetResult = Static<typeof FamilyGetResultSchema>;

/**
 * Result returned by family.update containing the updated family metadata.
 */
export const FamilyUpdateResultSchema = Type.Object(
	{
		family: FamilyRecordSchema,
	},
	{
		description:
			"Result payload returned by family.update containing updated family settings.",
	},
);
export type FamilyUpdateResult = Static<typeof FamilyUpdateResultSchema>;

/**
 * Result returned by family.delete confirming family deletion.
 */
export const FamilyDeleteResultSchema = Type.Object(
	{
		deleted: Type.String({
			description: "Identifier of the bot family that was deleted.",
		}),
	},
	{
		description:
			"Result payload returned by family.delete confirming deletion of the bot family.",
	},
);
export type FamilyDeleteResult = Static<typeof FamilyDeleteResultSchema>;

/**
 * Result returned by bot.list containing all bots in the family.
 */
export const BotListResultSchema = Type.Object(
	{
		bots: Type.Array(BotRecordSchema, {
			description: "List of bots configured within this bot family.",
		}),
	},
	{
		description:
			"Result payload returned by bot.list containing all bots in the family.",
	},
);
export type BotListResult = Static<typeof BotListResultSchema>;

/**
 * Result returned by bot.create containing the newly created bot record.
 */
export const BotCreateResultSchema = Type.Object(
	{
		bot: BotRecordSchema,
	},
	{
		description:
			"Result payload returned by bot.create containing the newly created bot record.",
	},
);
export type BotCreateResult = Static<typeof BotCreateResultSchema>;

/**
 * Result returned by bot.get containing bot metadata, SOUL.md prompt, MEMORY.md content with version, and knowledge documents.
 */
export const BotGetResultSchema = Type.Object(
	{
		bot: BotRecordSchema,
		soul: Type.String({
			description:
				"Raw system prompt and personality instructions loaded from SOUL.md.",
		}),
		memory: Type.Object(
			{
				content: Type.String({
					description: "Current markdown content of MEMORY.md.",
				}),
				version: Type.Number({
					description:
						"Current version sequence number of MEMORY.md for optimistic concurrency control.",
				}),
			},
			{ description: "Long-term memory file state and version." },
		),
		knowledge: Type.Array(
			Type.Object(
				{
					slug: Type.String({
						description: "Unique document slug / filename without extension.",
					}),
					description: Type.String({
						description:
							"Document summary used by model tools to decide when to read this document.",
					}),
					category: Type.Optional(
						Type.String({
							description: "Optional categorization tag.",
						}),
					),
					version: Type.Number({
						description:
							"Current version sequence number of the knowledge document.",
					}),
					body: Type.String({
						description: "Full markdown content body of the document.",
					}),
				},
				{ description: "Individual knowledge document record." },
			),
			{
				description:
					"List of all knowledge documents associated with this bot.",
			},
		),
	},
	{
		description:
			"Comprehensive bot state including configuration, system prompt (SOUL.md), memory, and knowledge base.",
	},
);
export type BotGetResult = Static<typeof BotGetResultSchema>;

/**
 * Result returned by bot.update containing the modified bot record.
 */
export const BotUpdateResultSchema = Type.Object(
	{
		bot: BotRecordSchema,
	},
	{
		description:
			"Result payload returned by bot.update containing the updated bot record.",
	},
);
export type BotUpdateResult = Static<typeof BotUpdateResultSchema>;

/**
 * Result returned by bot.delete confirming bot deletion.
 */
export const BotDeleteResultSchema = Type.Object(
	{
		deleted: Type.String({
			description: "Identifier of the bot that was deleted.",
		}),
	},
	{
		description:
			"Result payload returned by bot.delete confirming deletion of the bot.",
	},
);
export type BotDeleteResult = Static<typeof BotDeleteResultSchema>;

/**
 * Result returned by chat.list containing matching chat sessions.
 */
export const ChatListResultSchema = Type.Object(
	{
		chats: Type.Array(ChatRecordSchema, {
			description: "List of chat sessions matching the query.",
		}),
	},
	{
		description:
			"Result payload returned by chat.list containing chat sessions.",
	},
);
export type ChatListResult = Static<typeof ChatListResultSchema>;

/**
 * Result returned by chat.create containing the newly created chat session record.
 */
export const ChatCreateResultSchema = Type.Object(
	{
		chat: ChatRecordSchema,
	},
	{
		description:
			"Result payload returned by chat.create containing the new chat session record.",
	},
);
export type ChatCreateResult = Static<typeof ChatCreateResultSchema>;

/**
 * Result returned by chat.get containing chat session details, active busy status, messages, entries, and harvest notes.
 */
export const ChatGetResultSchema = Type.Object(
	{
		chat: ChatRecordSchema,
		busy: Type.Boolean({
			description:
				"True if the chat is actively executing a model turn or scheduled task.",
		}),
		messages: Type.Array(Type.Unknown(), {
			description: "Recent message exchange history for this chat session.",
		}),
		entries: Type.Array(Type.Unknown(), {
			description: "Raw transcript entries recorded for this conversation.",
		}),
		notes: Type.Array(HarvestNoteSchema, {
			description:
				"Historical harvest notes recording memory and knowledge updates from this chat.",
		}),
	},
	{
		description:
			"Full chat session state including recent messages, transcript entries, and harvest audit notes.",
	},
);
export type ChatGetResult = Static<typeof ChatGetResultSchema>;
export type ChatMessagesResult = ChatGetResult;
export type ChatEntriesResult = ChatGetResult;
export type ChatSubscribeResult = ChatGetResult;

/**
 * Structured runtime status record for a chat session.
 */
export const ChatStatusRecordSchema = Type.Object(
	{
		chatKey: Type.String({
			description: "Chat session routing key.",
		}),
		conversationId: Type.Number({
			description:
				"Internal durable conversation sequence ID backing this chat.",
		}),
		botId: Type.String({
			description: "Identifier of the bot participating in this chat.",
		}),
		botName: Type.String({
			description: "Display name of the participating bot.",
		}),
		model: Type.String({
			description: "Active model identifier used for turns in this chat.",
		}),
		thinking: ThinkingLevelSchema,
		tools: Type.Union(
			[
				Type.Array(Type.String(), {
					description: "List of permitted tool names or patterns.",
				}),
				Type.Literal("all", {
					description: "All registered tools are permitted.",
				}),
			],
			{
				description:
					"Permitted tools policy for this chat: explicit tool list or 'all'.",
			},
		),
		busy: Type.Boolean({
			description:
				"True if a model turn is currently in progress, false if idle.",
		}),
		entryCount: Type.Number({
			description:
				"Total number of transcript entries recorded in this conversation.",
		}),
		harvestWatermark: Type.Number({
			description:
				"Highest transcript entry sequence number harvested into long-term memory.",
		}),
		nextWakeAt: Type.Union([Type.Number(), Type.Null()], {
			description:
				"Epoch timestamp in milliseconds of the next scheduled alarm wake, or null if no alarm is pending.",
		}),
		usage: Type.Record(Type.String(), Type.Unknown(), {
			description:
				"Aggregated token and prompt usage statistics for this chat session.",
		}),
	},
	{
		description:
			"Live runtime execution status, active model configuration, and alarm scheduling for a chat session.",
	},
);
export type ChatStatusRecord = Static<typeof ChatStatusRecordSchema>;

/**
 * Out-of-band result payload returned by chat.status or slash command /status.
 * Processed directly by CadmusBotFamilyDO without invoking the LLM or polluting conversation history.
 */
export const ChatStatusResultSchema = Type.Object(
	{
		outOfBand: Type.Literal(true, {
			description:
				"Always true, confirming this result was evaluated out-of-band without invoking the model.",
		}),
		command: Type.Literal("/status", {
			description: "The out-of-band slash command executed ('/status').",
		}),
		status: ChatStatusRecordSchema,
		text: Type.String({
			description:
				"Pre-formatted, human-readable status text summarizing chat state, model, thinking, tools, and alarms.",
		}),
	},
	{
		description:
			"Out-of-band status result produced by /status without appending to the conversation transcript.",
	},
);
export type ChatStatusResult = Static<typeof ChatStatusResultSchema>;

/**
 * Result returned by chat.rename containing the updated chat session record.
 */
export const ChatRenameResultSchema = Type.Object(
	{
		chat: ChatRecordSchema,
	},
	{
		description:
			"Result payload returned by chat.rename containing the renamed chat record.",
	},
);
export type ChatRenameResult = Static<typeof ChatRenameResultSchema>;

/**
 * Result returned by chat.reset confirming conversation reset.
 */
export const ChatResetResultSchema = Type.Object(
	{
		chat: ChatRecordSchema,
		reset: Type.Literal(true, {
			description:
				"Always true, confirming the conversation transcript was reset.",
		}),
	},
	{
		description:
			"Result payload returned by chat.reset confirming conversation history reset.",
	},
);
export type ChatResetResult = Static<typeof ChatResetResultSchema>;

/**
 * Result returned by chat.close containing the closed chat record.
 */
export const ChatCloseResultSchema = Type.Object(
	{
		chat: ChatRecordSchema,
	},
	{
		description:
			"Result payload returned by chat.close containing the closed chat record.",
	},
);
export type ChatCloseResult = Static<typeof ChatCloseResultSchema>;

/**
 * Result returned when a model turn completes synchronously or settles.
 */
export const TurnSettledResultSchema = Type.Object(
	{
		chatKey: Type.String({
			description: "Target chat session routing key.",
		}),
		conversationId: Type.Number({
			description:
				"Internal durable conversation sequence ID backing this chat.",
		}),
		reply: Type.String({
			description: "Final assistant text response message.",
		}),
		entryId: Type.Optional(
			Type.Number({
				description:
					"Transcript entry sequence number assigned to this completed turn.",
			}),
		),
		blocks: Type.Optional(
			Type.Array(TurnBlockSchema, {
				description:
					"Structured content blocks (thinking, tool calls, text) produced during the turn.",
			}),
		),
	},
	{
		description:
			"Result payload returned upon synchronous completion of a model turn.",
	},
);
export type TurnSettledResult = Static<typeof TurnSettledResultSchema>;

/**
 * Result payload returned by turn.submit.
 * Returns TurnSettledResult on normal model completion, or ChatStatusResult if the user submitted an out-of-band slash command (/status).
 */
export const TurnSubmitResultSchema = Type.Union(
	[TurnSettledResultSchema, ChatStatusResultSchema],
	{
		description:
			"Result payload returned by turn.submit: standard model turn reply or out-of-band command status.",
	},
);
export type TurnSubmitResult = Static<typeof TurnSubmitResultSchema>;

/**
 * Result returned by turn.command (currently /status).
 */
export const TurnCommandResultSchema = ChatStatusResultSchema;
export type TurnCommandResult = Static<typeof TurnCommandResultSchema>;

/**
 * Result returned by turn.steer.
 */
export const TurnSteerResultSchema = TurnSettledResultSchema;
export type TurnSteerResult = Static<typeof TurnSteerResultSchema>;

/**
 * Result returned by turn.interrupt or turn.abort confirming turn cancellation.
 */
export const TurnInterruptResultSchema = Type.Object(
	{
		aborted: Type.Literal(true, {
			description:
				"Always true, confirming the in-progress turn was interrupted and aborted.",
		}),
		chatKey: Type.String({
			description: "Chat session routing key where the turn was aborted.",
		}),
	},
	{
		description:
			"Result payload returned by turn.interrupt or turn.abort confirming cancellation.",
	},
);
export type TurnInterruptResult = Static<typeof TurnInterruptResultSchema>;
export type TurnAbortResult = TurnInterruptResult;

/**
 * Summary metadata for a single virtual workspace file (SOUL.md, MEMORY.md, or knowledge document).
 */
export const FileListItemSchema = Type.Object(
	{
		path: Type.String({
			description:
				"Virtual workspace file path (e.g. 'SOUL.md', 'MEMORY.md', 'knowledge/topic.md').",
		}),
		kind: Type.Union(
			[
				Type.Literal("soul", {
					description: "Bot system prompt / personality instructions file.",
				}),
				Type.Literal("memory", {
					description: "Bot long-term memory file.",
				}),
				Type.Literal("knowledge", {
					description: "Topic-specific knowledge base document.",
				}),
			],
			{
				description:
					"File classification: 'soul' (SOUL.md), 'memory' (MEMORY.md), or 'knowledge' (knowledge doc).",
			},
		),
		size: Type.Number({
			description: "File content size in bytes.",
		}),
		version: Type.Optional(
			Type.Number({
				description:
					"Version sequence number for optimistic concurrency control (CAS).",
			}),
		),
		slug: Type.Optional(
			Type.String({
				description: "Document slug / identifier (for knowledge documents).",
			}),
		),
		description: Type.Optional(
			Type.String({
				description: "Document summary description (for knowledge documents).",
			}),
		),
		category: Type.Optional(
			Type.String({
				description: "Optional categorization tag (for knowledge documents).",
			}),
		),
	},
	{
		description:
			"Summary descriptor of a virtual workspace file belonging to a bot.",
	},
);
export type FileListItem = Static<typeof FileListItemSchema>;

/**
 * Result returned by file.list containing virtual files.
 */
export const FileListResultSchema = Type.Object(
	{
		files: Type.Array(FileListItemSchema, {
			description:
				"List of virtual workspace files (SOUL.md, MEMORY.md, knowledge documents).",
		}),
	},
	{
		description:
			"Result payload returned by file.list containing virtual workspace files.",
	},
);
export type FileListResult = Static<typeof FileListResultSchema>;

/**
 * Result returned by file.read when reading a single document.
 */
export const FileReadDocResultSchema = Type.Object(
	{
		path: Type.String({
			description: "Virtual workspace file path.",
		}),
		content: Type.String({
			description: "Full raw file content string.",
		}),
		text: Type.String({
			description: "Text content of the file (alias for content).",
		}),
		version: Type.Number({
			description:
				"Current version sequence number for optimistic concurrency control.",
		}),
		slug: Type.Optional(
			Type.String({
				description: "Document slug / identifier (for knowledge documents).",
			}),
		),
		description: Type.Optional(
			Type.String({
				description: "Document summary description (for knowledge documents).",
			}),
		),
		category: Type.Optional(
			Type.String({
				description: "Optional categorization tag (for knowledge documents).",
			}),
		),
		body: Type.Optional(
			Type.String({
				description:
					"Document markdown body without header metadata (for knowledge documents).",
			}),
		),
	},
	{
		description:
			"Content and version metadata of a single virtual workspace file.",
	},
);
export type FileReadDocResult = Static<typeof FileReadDocResultSchema>;

/**
 * Result returned by file.read: either a single document result or a file list result (when path is omitted).
 */
export const FileReadResultSchema = Type.Union(
	[FileListResultSchema, FileReadDocResultSchema],
	{
		description:
			"Result payload returned by file.read: document content or file listing.",
	},
);
export type FileReadResult = Static<typeof FileReadResultSchema>;

/**
 * Result returned by file.write: either confirming deletion (when delete is true) or returning updated file metadata.
 */
export const FileWriteResultSchema = Type.Union(
	[
		Type.Object(
			{
				deleted: Type.String({
					description: "Virtual file path that was deleted.",
				}),
			},
			{ description: "Confirmation of file deletion." },
		),
		Type.Object(
			{
				path: Type.String({
					description: "Virtual workspace file path that was written.",
				}),
				version: Type.Number({
					description: "New version sequence number assigned after the write.",
				}),
				content: Type.Optional(
					Type.String({
						description: "Written file content string.",
					}),
				),
				slug: Type.Optional(
					Type.String({
						description:
							"Document slug / identifier (for knowledge documents).",
					}),
				),
				description: Type.Optional(
					Type.String({
						description:
							"Document summary description (for knowledge documents).",
					}),
				),
				category: Type.Optional(
					Type.String({
						description:
							"Optional categorization tag (for knowledge documents).",
					}),
				),
				body: Type.Optional(
					Type.String({
						description: "Document markdown body (for knowledge documents).",
					}),
				),
			},
			{ description: "Metadata and new version of written file." },
		),
	],
	{
		description:
			"Result payload returned by file.write confirming file write or deletion.",
	},
);
export type FileWriteResult = Static<typeof FileWriteResultSchema>;

/**
 * Result returned by file.delete confirming file deletion.
 */
export const FileDeleteResultSchema = Type.Object(
	{
		deleted: Type.String({
			description: "Virtual workspace file path that was deleted.",
		}),
	},
	{
		description:
			"Result payload returned by file.delete confirming deletion of the file.",
	},
);
export type FileDeleteResult = Static<typeof FileDeleteResultSchema>;

/**
 * Individual search result match from knowledge.search.
 */
export const KnowledgeSearchResultSchema = Type.Object(
	{
		slug: Type.String({
			description: "Knowledge document slug / identifier.",
		}),
		description: Type.String({
			description: "Document summary description.",
		}),
		category: Type.Optional(
			Type.String({
				description: "Optional categorization tag.",
			}),
		),
		version: Type.Number({
			description: "Current version sequence number of the document.",
		}),
		snippet: Type.String({
			description:
				"Matching text excerpt from the document body or description.",
		}),
	},
	{
		description:
			"Individual knowledge document search match with snippet excerpt.",
	},
);
export type KnowledgeSearchResult = Static<typeof KnowledgeSearchResultSchema>;

/**
 * Result returned by knowledge.search containing matched knowledge snippets.
 */
export const KnowledgeSearchResultsSchema = Type.Object(
	{
		results: Type.Array(KnowledgeSearchResultSchema, {
			description: "List of matching knowledge document excerpts.",
		}),
	},
	{
		description:
			"Result payload returned by knowledge.search containing search matches.",
	},
);
export type KnowledgeSearchResults = Static<
	typeof KnowledgeSearchResultsSchema
>;

/**
 * Result returned by schedule.create containing the created schedule record.
 */
export const ScheduleCreateResultSchema = Type.Object(
	{
		schedule: ScheduleRecordSchema,
	},
	{
		description:
			"Result payload returned by schedule.create containing the newly registered schedule record.",
	},
);
export type ScheduleCreateResult = Static<typeof ScheduleCreateResultSchema>;

/**
 * Result returned by schedule.list containing scheduled tasks.
 */
export const ScheduleListResultSchema = Type.Object(
	{
		schedules: Type.Array(ScheduleRecordSchema, {
			description: "List of scheduled tasks.",
		}),
	},
	{
		description:
			"Result payload returned by schedule.list containing scheduled tasks.",
	},
);
export type ScheduleListResult = Static<typeof ScheduleListResultSchema>;

/**
 * Result returned by schedule.update containing the updated schedule record.
 */
export const ScheduleUpdateResultSchema = Type.Object(
	{
		schedule: ScheduleRecordSchema,
	},
	{
		description:
			"Result payload returned by schedule.update containing updated schedule settings.",
	},
);
export type ScheduleUpdateResult = Static<typeof ScheduleUpdateResultSchema>;

/**
 * Result returned by schedule.delete confirming schedule deletion.
 */
export const ScheduleDeleteResultSchema = Type.Object(
	{
		deleted: Type.String({
			description: "Identifier of the schedule that was deleted.",
		}),
	},
	{
		description:
			"Result payload returned by schedule.delete confirming deletion of the schedule.",
	},
);
export type ScheduleDeleteResult = Static<typeof ScheduleDeleteResultSchema>;
