import { type Static, Type } from "typebox";

/**
 * Budget/intensity level for extended model reasoning (thinking).
 * - "off": Reasoning/thinking disabled.
 * - "minimal" through "max": Incrementally allocates larger token budgets to internal reasoning.
 */
export const ThinkingLevelSchema = Type.Union(
	[
		Type.Literal("off", {
			description: "Disable extended thinking/reasoning.",
		}),
		Type.Literal("minimal", {
			description: "Minimal thinking budget (fastest reasoning).",
		}),
		Type.Literal("low", { description: "Low thinking budget." }),
		Type.Literal("medium", {
			description: "Medium thinking budget (balanced).",
		}),
		Type.Literal("high", { description: "High thinking budget." }),
		Type.Literal("xhigh", { description: "Extra-high thinking budget." }),
		Type.Literal("max", {
			description: "Maximum supported thinking token budget.",
		}),
	],
	{
		description:
			"Budget and intensity level for extended model reasoning / thinking tokens.",
	},
);
export type ThinkingLevel = Static<typeof ThinkingLevelSchema>;

/**
 * Input payload for storing provider BYOK credentials (API key or OAuth token).
 */
export const CredentialInputSchema = Type.Union(
	[
		Type.Object(
			{
				type: Type.Literal("api_key", {
					description: "Static API key credential type.",
				}),
				apiKey: Type.String({
					minLength: 1,
					description: "Provider API key secret token.",
				}),
			},
			{ description: "Static API key credential configuration." },
		),
		Type.Object(
			{
				type: Type.Literal("oauth", {
					description: "OAuth token set credential type.",
				}),
				accessToken: Type.String({
					minLength: 1,
					description: "Active OAuth access token.",
				}),
				refreshToken: Type.Optional(
					Type.String({
						description:
							"Optional refresh token used to renew expired access tokens.",
					}),
				),
				expiresAt: Type.Optional(
					Type.Number({
						description:
							"Optional epoch timestamp in milliseconds when the access token expires.",
					}),
				),
			},
			{ description: "OAuth access and refresh token configuration." },
		),
	],
	{
		description:
			"Authentication credentials for an AI provider, supporting static API keys or refreshed OAuth tokens.",
	},
);
export type CredentialInput = Static<typeof CredentialInputSchema>;

/**
 * Sanitized summary of a configured provider credential, safe for client display (omits secret keys).
 */
export const CredentialSummarySchema = Type.Object(
	{
		providerId: Type.String({
			description:
				"Unique identifier of the AI provider (e.g. 'anthropic', 'openai', 'google', 'groq', 'deepseek', 'xai').",
		}),
		type: Type.Union([Type.Literal("api_key"), Type.Literal("oauth")], {
			description:
				"Authorization mechanism: static 'api_key' or refreshed 'oauth'.",
		}),
		updatedAt: Type.Number({
			description:
				"Epoch timestamp in milliseconds when this credential was stored or last refreshed.",
		}),
	},
	{
		description:
			"Sanitized metadata summarizing a configured AI provider credential without revealing secret values.",
	},
);
export type CredentialSummary = Static<typeof CredentialSummarySchema>;

/**
 * Descriptor of an available LLM model, its capabilities, and its authentication status.
 */
export const ModelInfoSchema = Type.Object(
	{
		id: Type.String({
			description:
				"Full model identifier string (e.g. 'anthropic/claude-3-7-sonnet', 'openai/gpt-4o').",
		}),
		provider: Type.String({
			description:
				"Identifier of the provider hosting the model (e.g. 'anthropic', 'openai').",
		}),
		name: Type.String({
			description: "Human-readable display name of the model.",
		}),
		contextWindow: Type.Optional(
			Type.Number({
				description: "Maximum context window size in tokens, if known.",
			}),
		),
		maxTokens: Type.Optional(
			Type.Number({
				description:
					"Maximum completion / generation token limit supported, if known.",
			}),
		),
		reasoning: Type.Optional(
			Type.Boolean({
				description:
					"True if the model supports extended reasoning / thinking tokens.",
			}),
		),
		thinkingLevels: Type.Optional(
			Type.Array(ThinkingLevelSchema, {
				description:
					"List of discrete thinking levels supported by this model.",
			}),
		),
		input: Type.Optional(
			Type.Array(Type.String(), {
				description: "Supported input modalities (e.g. ['text', 'image']).",
			}),
		),
		authenticated: Type.Boolean({
			description:
				"True if valid credentials currently exist to invoke this model.",
		}),
		credentialConfigured: Type.Boolean({
			description:
				"True if an account-level or environment credential has been configured for the model's provider.",
		}),
	},
	{
		description:
			"Capability descriptor and credential availability status for an LLM model.",
	},
);
export type ModelInfo = Static<typeof ModelInfoSchema>;

/**
 * Top-level tenant account record stored globally in D1.
 */
export const AccountRecordSchema = Type.Object(
	{
		id: Type.String({
			description: "Unique tenant account identifier (e.g. 'acc_main').",
		}),
		name: Type.String({
			description: "Human-readable display name of the account.",
		}),
		timezone: Type.String({
			description:
				"Default IANA timezone identifier for the account (e.g. 'UTC', 'America/New_York'). Inherited by families if unspecified.",
		}),
		createdAt: Type.Number({
			description:
				"Epoch timestamp in milliseconds when the account was created.",
		}),
	},
	{
		description:
			"Tenant account record representing the administrative boundary for users, credentials, and bot families.",
	},
);
export type AccountRecord = Static<typeof AccountRecordSchema>;

/**
 * Account membership record linking a user to an account with a role.
 */
export const AccountMemberSchema = Type.Object(
	{
		accountId: Type.String({
			description: "Identifier of the account the user belongs to.",
		}),
		userId: Type.String({
			description: "Identifier of the user member.",
		}),
		role: Type.Union([Type.Literal("owner"), Type.Literal("member")], {
			description:
				"Access role: 'owner' has full administrative rights (credentials, members, families); 'member' has standard access.",
		}),
		createdAt: Type.Number({
			description:
				"Epoch timestamp in milliseconds when the membership was created.",
		}),
	},
	{
		description:
			"Membership relation linking a user identity to a tenant account with an access role.",
	},
);
export type AccountMember = Static<typeof AccountMemberSchema>;

/**
 * Bot family record representing an isolated Durable Object cluster of bots, chats, files, and schedules.
 */
export const FamilyRecordSchema = Type.Object(
	{
		accountId: Type.String({
			description: "Identifier of the owning tenant account.",
		}),
		familyId: Type.String({
			description:
				"Unique slug or identifier of the bot family within the account.",
		}),
		name: Type.String({
			description: "Human-readable display name of the bot family.",
		}),
		doName: Type.String({
			description:
				"Deterministic Cloudflare Durable Object instance name backing this family ('cadmus:{accountId}:{familyId}').",
		}),
		timezone: Type.String({
			description:
				"Default IANA timezone identifier for this family (e.g. 'America/Los_Angeles').",
		}),
		harvestDelayMs: Type.Number({
			description:
				"Idle delay in milliseconds after conversation activity before running background memory/knowledge harvesting.",
		}),
		createdAt: Type.Number({
			description:
				"Epoch timestamp in milliseconds when the family was created.",
		}),
	},
	{
		description:
			"Bot family metadata representing a partitioned Durable Object runtime instance.",
	},
);
export type FamilyRecord = Static<typeof FamilyRecordSchema>;

/**
 * Autonomous bot persona record within a bot family.
 */
export const BotRecordSchema = Type.Object(
	{
		id: Type.String({
			description:
				"Unique identifier / slug of the bot within the family (e.g. 'assistant', 'researcher').",
		}),
		name: Type.String({
			description: "Human-readable display name of the bot.",
		}),
		model: Type.String({
			description:
				"Default model identifier string used for bot turns (e.g. 'anthropic/claude-3-7-sonnet').",
		}),
		thinking: ThinkingLevelSchema,
		tools: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"Optional list of allowed tool names or patterns. If omitted, all enabled tools are permitted.",
			}),
		),
		timezone: Type.String({
			description:
				"IANA timezone identifier for cron schedules and time context (e.g. 'UTC').",
		}),
		rootConversationId: Type.Number({
			description:
				"Internal numeric ID of the primary root conversation associated with the bot.",
		}),
		createdAt: Type.Number({
			description: "Epoch timestamp in milliseconds when the bot was created.",
		}),
	},
	{
		description:
			"Bot persona configuration defining default model, thinking budget, tool access, and timezone.",
	},
);
export type BotRecord = Static<typeof BotRecordSchema>;

/**
 * Chat session record tracking an active or archived conversation with a bot.
 */
export const ChatRecordSchema = Type.Object(
	{
		key: Type.String({
			description:
				"Unique conversation routing key / slug for this chat session (e.g. 'chat_default' or user-specified key).",
		}),
		botId: Type.String({
			description: "Identifier of the bot participating in this chat session.",
		}),
		conversationId: Type.Number({
			description:
				"Internal durable conversation sequence ID backing this chat.",
		}),
		title: Type.Optional(
			Type.String({
				description: "Optional human-readable title or topic for the chat.",
			}),
		),
		thinking: Type.Optional(ThinkingLevelSchema),
		closed: Type.Optional(
			Type.Boolean({
				description: "Whether this chat session has been closed or archived.",
			}),
		),
		createdAt: Type.Number({
			description:
				"Epoch timestamp in milliseconds when the chat session was created.",
		}),
	},
	{
		description:
			"Chat session record tracking a conversation thread with a specific bot.",
	},
);
export type ChatRecord = Static<typeof ChatRecordSchema>;

/**
 * Target destination and execution mode for a scheduled task when triggered.
 */
export const ScheduleTargetSchema = Type.Union(
	[
		Type.Object(
			{
				mode: Type.Literal("chat", {
					description:
						"Deliver the scheduled prompt to an existing chat session.",
				}),
				chatKey: Type.String({
					minLength: 1,
					description: "Target chat session routing key.",
				}),
			},
			{ description: "Target an existing persistent chat session." },
		),
		Type.Object(
			{
				mode: Type.Literal("new-chat", {
					description:
						"Create a brand new chat session for each scheduled trigger.",
				}),
			},
			{ description: "Spawn a new chat session per schedule execution." },
		),
		Type.Object(
			{
				mode: Type.Literal("fork", {
					description:
						"Fork from an existing chat session at a given transcript entry watermark.",
				}),
				chatKey: Type.String({
					minLength: 1,
					description: "Source chat session routing key to fork from.",
				}),
				at: Type.Optional(
					Type.Number({
						description:
							"Optional transcript entry sequence number watermark up to which conversation is forked.",
					}),
				),
				harvest: Type.Optional(
					Type.Boolean({
						description:
							"True if this fork is an internal idle harvest task inspecting conversation history.",
					}),
				),
			},
			{
				description:
					"Fork an existing chat at a specific watermark, typically for background memory/knowledge harvesting.",
			},
		),
	],
	{
		description:
			"Target execution destination and mode for a scheduled task or idle harvest.",
	},
);
export type ScheduleTarget = Static<typeof ScheduleTargetSchema>;

/**
 * Scheduled task record for cron jobs, one-shot timers, or internal idle harvest tasks.
 */
export const ScheduleRecordSchema = Type.Object(
	{
		id: Type.String({
			description: "Unique identifier of the schedule.",
		}),
		botId: Type.String({
			description: "Identifier of the bot executing the scheduled prompt.",
		}),
		name: Type.Optional(
			Type.String({
				description:
					"Optional human-readable label or description for the schedule.",
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
					"Schedule timing mechanism: 'relative' for relative delay from now, 'absolute' for absolute date and time, or 'cron' for recurring cron jobs.",
			},
		),
		input: Type.Union([Type.String(), Type.Number()], {
			description:
				"Unified timing expression interpreted according to kind: relative duration for 'relative' (e.g. '5s', '10m', 10), absolute date/time for 'absolute' (e.g. 'tomorrow at 5pm', ISO string, epoch ms), or cron expression for 'cron' (e.g. '0 9 * * *', '@hourly').",
		}),
		nextRun: Type.Number({
			description:
				"Epoch timestamp in milliseconds when the schedule will next execute.",
		}),
		inSeconds: Type.Optional(
			Type.Number({
				description:
					"Remaining relative time from now until nextRun execution in seconds, reported for convenience regardless of scheduling method.",
			}),
		),
		recurring: Type.Optional(
			Type.Boolean({
				description:
					"Whether the schedule repeats periodically (true for recurring cron schedules, false for one-shot relative or absolute timers).",
			}),
		),
		text: Type.String({
			description:
				"Prompt text delivered to the bot when the schedule triggers.",
		}),
		target: ScheduleTargetSchema,
		thinking: Type.Optional(ThinkingLevelSchema),
		enabled: Type.Boolean({
			description:
				"Whether the schedule is active. Disabled schedules are skipped during alarm checks.",
		}),
		internal: Type.Optional(
			Type.Boolean({
				description:
					"True if this schedule was generated internally by the system (e.g. idle harvest timer).",
			}),
		),
	},
	{
		description:
			"Scheduled task record defining execution cadence, target chat mode, prompt, and next run timestamp.",
	},
);
export type ScheduleRecord = Static<typeof ScheduleRecordSchema>;

/**
 * File modification diff produced during an idle conversation harvest.
 */
export const HarvestFileDiffSchema = Type.Object(
	{
		path: Type.String({
			description:
				"Virtual workspace file path modified (e.g. 'MEMORY.md', 'knowledge/topic.md').",
		}),
		diff: Type.String({
			description:
				"Unified diff representation showing modifications applied to the file.",
		}),
	},
	{
		description:
			"Individual file modification diff recorded during an idle harvest run.",
	},
);
export type HarvestFileDiff = Static<typeof HarvestFileDiffSchema>;

/**
 * Record of an idle conversation harvest run, tracking memory and knowledge updates.
 */
export const HarvestNoteSchema = Type.Object(
	{
		chatKey: Type.String({
			description:
				"Routing key of the chat session whose conversation was harvested.",
		}),
		at: Type.Number({
			description:
				"Conversation entry sequence number / watermark up to which harvest was performed.",
		}),
		files: Type.Array(HarvestFileDiffSchema, {
			description:
				"List of files modified during harvest with their unified diffs.",
		}),
		when: Type.Number({
			description:
				"Epoch timestamp in milliseconds when the harvest execution occurred.",
		}),
	},
	{
		description:
			"Audit note recording knowledge and memory extractions completed by background idle harvest tasks.",
	},
);
export type HarvestNote = Static<typeof HarvestNoteSchema>;

/**
 * Content block within a completed model turn.
 */
export const TurnBlockSchema = Type.Union(
	[
		Type.Object(
			{
				type: Type.Literal("thinking", {
					description: "Extended model reasoning / thinking block.",
				}),
			},
			{ description: "Thinking block produced during model reasoning." },
		),
		Type.Object(
			{
				type: Type.Literal("tool_call", {
					description: "Tool invocation block.",
				}),
				toolName: Type.String({
					description: "Name of the invoked agent tool.",
				}),
			},
			{ description: "Agent tool invocation block." },
		),
		Type.Object(
			{
				type: Type.Literal("text", {
					description: "Assistant text response block.",
				}),
				text: Type.Optional(
					Type.String({
						description: "Text content of the assistant message chunk.",
					}),
				),
			},
			{ description: "Assistant response text block." },
		),
	],
	{
		description:
			"Structured turn component block representing reasoning, tool call, or text output.",
	},
);
export type TurnBlock = Static<typeof TurnBlockSchema>;

/**
 * Summary of a completed tool call result, recorded server-side for transcript inspection.
 */
export const ToolCallResultSummarySchema = Type.Object({
	content: Type.String({
		description: "Serialized output or return value produced by the tool.",
	}),
	isError: Type.Boolean({
		description: "True if the tool execution failed with an error.",
	}),
	durationMs: Type.Optional(
		Type.Number({
			description: "Execution duration in milliseconds, if recorded.",
		}),
	),
});
export type ToolCallResultSummary = Static<typeof ToolCallResultSummarySchema>;

/**
 * Projected view of an agent tool call within an assistant message.
 */
export const TranscriptToolCallViewSchema = Type.Object({
	id: Type.String({ description: "Unique tool call identifier." }),
	name: Type.String({ description: "Name of the invoked tool." }),
	arguments: Type.Unknown({
		description: "Arguments object passed to the tool.",
	}),
	result: Type.Optional(ToolCallResultSummarySchema),
});
export type TranscriptToolCallView = Static<
	typeof TranscriptToolCallViewSchema
>;

/**
 * Structured content block within a transcript message.
 */
export const TranscriptContentBlockSchema = Type.Union(
	[
		Type.Object(
			{
				type: Type.Literal("text"),
				text: Type.String({ description: "Text content." }),
			},
			{ description: "Plain text content block." },
		),
		Type.Object(
			{
				type: Type.Literal("thinking"),
				thinking: Type.String({
					description: "Model reasoning / thinking text.",
				}),
				redacted: Type.Optional(
					Type.Boolean({
						description:
							"True if the thinking block was redacted by provider safety.",
					}),
				),
			},
			{ description: "Extended model reasoning / thinking block." },
		),
		Type.Object(
			{
				type: Type.Literal("toolCall"),
				id: Type.String({ description: "Unique tool call identifier." }),
				name: Type.String({ description: "Name of the invoked tool." }),
				arguments: Type.Unknown({
					description: "Arguments object passed to the tool.",
				}),
				result: Type.Optional(ToolCallResultSummarySchema),
			},
			{
				description:
					"Tool invocation block with optional server-bound result summary.",
			},
		),
		Type.Object(
			{
				type: Type.Literal("image"),
				mimeType: Type.String({ description: "MIME type of the image." }),
				data: Type.String({ description: "Base64 data or URI of the image." }),
			},
			{ description: "Image content block." },
		),
	],
	{
		description: "Content block within a transcript message.",
	},
);
export type TranscriptContentBlock = Static<
	typeof TranscriptContentBlockSchema
>;

/**
 * Projected view of a message entry in a conversation transcript.
 */
export const TranscriptMessageViewSchema = Type.Object({
	id: Type.Number({ description: "Transcript entry sequence number." }),
	role: Type.Union([
		Type.Literal("user"),
		Type.Literal("assistant"),
		Type.Literal("system"),
		Type.Literal("toolResult"),
	]),
	text: Type.String({
		description: "Rendered plain text content of the message.",
	}),
	replyToEntryId: Type.Optional(
		Type.Number({
			description:
				"Server-bound entry ID of the user request that this message responds to.",
		}),
	),
	thinking: Type.Optional(
		Type.String({
			description: "Combined extended reasoning/thinking text, if any.",
		}),
	),
	toolCalls: Type.Optional(Type.Array(TranscriptToolCallViewSchema)),
	blocks: Type.Optional(Type.Array(TranscriptContentBlockSchema)),
	toolCallId: Type.Optional(
		Type.String({ description: "Tool call ID for toolResult messages." }),
	),
	toolName: Type.Optional(
		Type.String({ description: "Tool name for toolResult messages." }),
	),
	isError: Type.Optional(
		Type.Boolean({ description: "Error flag for toolResult messages." }),
	),
	model: Type.Optional(
		Type.String({ description: "Model identifier for assistant messages." }),
	),
	provider: Type.Optional(
		Type.String({
			description: "Provider identifier for assistant messages.",
		}),
	),
	stopReason: Type.Optional(
		Type.String({ description: "Stop reason for assistant messages." }),
	),
	usage: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
	timestamp: Type.Optional(Type.Number()),
	durationMs: Type.Optional(Type.Number()),
});
export type TranscriptMessageView = Static<typeof TranscriptMessageViewSchema>;

/**
 * Raw durable transcript entry recorded in the underlying conversation storage.
 */
export const RawTranscriptEntrySchema = Type.Object({
	id: Type.Number({
		description: "Durable transcript entry sequence ID.",
	}),
	conversationId: Type.Number({
		description: "Owning conversation sequence ID.",
	}),
	kind: Type.String({
		description:
			"Entry kind discriminator (e.g. 'user', 'assistant', 'system', 'toolResult', 'reset', 'compaction').",
	}),
	model: Type.Optional(
		Type.Array(Type.Unknown(), {
			description: "Underlying pi-ai model messages with inner content blocks.",
		}),
	),
	data: Type.Optional(
		Type.Unknown({
			description: "Optional entry metadata/diagnostics payload.",
		}),
	),
	head: Type.Optional(
		Type.Number({ description: "Optional context head entry ID." }),
	),
	edits: Type.Optional(Type.Array(Type.Unknown())),
	byTaskId: Type.Optional(
		Type.Number({ description: "Task ID that appended this entry." }),
	),
});
export type RawTranscriptEntry = Static<typeof RawTranscriptEntrySchema>;
