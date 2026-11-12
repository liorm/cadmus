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
 * Account env binding. Only `envId` is stored on a bot, chat, or account default.
 */
export const ToolsEnvBindingSchema = Type.Object(
	{
		envId: Type.String({
			minLength: 1,
			description: "Account env definition id (for example 'jb_default').",
		}),
	},
	{
		additionalProperties: false,
		description: "Binding that names an account tools env by id.",
	},
);
export type ToolsEnvBinding = Static<typeof ToolsEnvBindingSchema>;

/**
 * Tri-state tools env setting. Null inherits. `enabled` and `binding` resolve independently.
 */
export const ToolsEnvSettingSchema = Type.Union(
	[
		Type.Object(
			{
				enabled: Type.Boolean({
					description: "Whether this level turns the tools env on.",
				}),
				binding: Type.Optional(ToolsEnvBindingSchema),
			},
			{
				additionalProperties: false,
				description: "Explicit tools env setting at one level.",
			},
		),
		Type.Null(),
	],
	{
		description:
			"Tools env setting: an explicit on/off value, or null to inherit.",
	},
);
export type ToolsEnvSetting = Static<typeof ToolsEnvSettingSchema>;

export const ToolsEnvSourceSchema = Type.Union(
	[
		Type.Literal("chat"),
		Type.Literal("bot"),
		Type.Literal("account"),
		Type.Literal("unbound"),
	],
	{ description: "Which level supplied the resolved enabled flag or binding." },
);
export type ToolsEnvSource = Static<typeof ToolsEnvSourceSchema>;

export const ConfinementPolicySchema = Type.Union(
	[
		Type.Literal("required"),
		Type.Literal("preferred"),
		Type.Literal("disabled"),
	],
	{ description: "Confinement policy for tools env execution." },
);
export type ConfinementPolicy = Static<typeof ConfinementPolicySchema>;

export const EffectiveToolsEnvSchema = Type.Object(
	{
		envId: Type.String(),
		kind: Type.Union([Type.Literal("just-bash"), Type.Literal("local-daemon")]),
		persist: Type.Boolean(),
		confineToWorkspace: Type.Boolean(),
		confinementPolicy: Type.Optional(ConfinementPolicySchema),
		sharedWorkspace: Type.Boolean(),
		root: Type.Optional(
			Type.String({
				description:
					"Runtime directory. Present for just-bash, and for a local-daemon only while that daemon is connected.",
			}),
		),
		confined: Type.Optional(
			Type.Boolean({
				description: "Effective confinement state of the active connection.",
			}),
		),
	},
	{
		additionalProperties: false,
		description: "Resolved tools env definition used for a bot or chat.",
	},
);
export type EffectiveToolsEnv = Static<typeof EffectiveToolsEnvSchema>;

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
		defaultToolsEnv: Type.Optional(
			Type.Union([ToolsEnvBindingSchema, Type.Null()], {
				description: "Account default tools env binding, or null when cleared.",
			}),
		),
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
		teamLeaderBotId: Type.Optional(
			Type.String({
				minLength: 1,
				description:
					"Bot id of this family's Team Leader. Omitted when no Team Leader is set.",
			}),
		),
		createdAt: Type.Number({
			description:
				"Epoch timestamp in milliseconds when the family was created.",
		}),
	},
	{
		description:
			"Bot family metadata representing a partitioned Durable Object runtime instance, including the optional Team Leader bot id.",
	},
);
export type FamilyRecord = Static<typeof FamilyRecordSchema>;

/** Maximum number of keys in a bot metadata map. */
export const BOT_METADATA_MAX_KEYS = 32;
/** Maximum character length of a bot metadata value. */
export const BOT_METADATA_MAX_VALUE_LENGTH = 1024;
/**
 * Metadata key pattern: starts with a letter, then letters, digits, `_`, `.`, or `-`,
 * 1–64 characters total.
 */
export const BOT_METADATA_KEY_PATTERN = "^[a-z][a-z0-9_.-]{0,63}$";

const BotMetadataKeySchema = Type.String({
	pattern: BOT_METADATA_KEY_PATTERN,
	description:
		"Metadata key. Must match /^[a-z][a-z0-9_.-]{0,63}$/ (1–64 characters).",
});

const BotMetadataValueSchema = Type.String({
	maxLength: BOT_METADATA_MAX_VALUE_LENGTH,
	description: `Opaque string value (≤ ${BOT_METADATA_MAX_VALUE_LENGTH} characters). The server does not interpret values.`,
});

/**
 * Generic per-bot key-value map for client presentation data.
 * Well-known key `color`: palette slot names `"bot-1"`…`"bot-8"`.
 * The store stays generic; well-known keys are not an enum.
 */
export const BotMetadataSchema = Type.Record(
	BotMetadataKeySchema,
	BotMetadataValueSchema,
	{
		maxProperties: BOT_METADATA_MAX_KEYS,
		additionalProperties: false,
		description:
			"Generic key-value map for per-bot presentation data (≤ 32 keys). Well-known key `color` is a palette slot name (`bot-1`…`bot-8`). Team Leader is a dedicated family field, not metadata.",
	},
);
export type BotMetadata = Static<typeof BotMetadataSchema>;

/**
 * Patch for `bot.update` metadata: string sets/overwrites a key, `null` deletes it,
 * omitted keys are left unchanged.
 */
export const BotMetadataPatchSchema = Type.Record(
	BotMetadataKeySchema,
	Type.Union([BotMetadataValueSchema, Type.Null()]),
	{
		maxProperties: BOT_METADATA_MAX_KEYS,
		additionalProperties: false,
		description:
			"Metadata patch. A string value sets or overwrites the key; `null` deletes it; omitted keys are unchanged.",
	},
);
export type BotMetadataPatch = Static<typeof BotMetadataPatchSchema>;

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
					"Allowlist of tool names. Omitted means the default set (Cadmus tools allowed, coding tools opt-in). An empty array allows no gated tools.",
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
		toolsEnv: Type.Optional(ToolsEnvSettingSchema),
		metadata: Type.Optional(BotMetadataSchema),
	},
	{
		description:
			"Bot persona configuration defining default model, thinking budget, tool access, timezone, and optional client metadata.",
	},
);
export type BotRecord = Static<typeof BotRecordSchema>;

export const ChatKindSchema = Type.Union(
	[
		Type.Literal("direct"),
		Type.Literal("group"),
		Type.Literal("group-member"),
		Type.Literal("scheduled"),
	],
	{
		description:
			"direct is a user-created 1-on-1 session. group is a bot-created group chat. group-member is an internal per-bot group execution session. scheduled is an automated session created by a schedule.",
	},
);
export type ChatKind = Static<typeof ChatKindSchema>;

export const MAX_DEADLINE_MS = 24 * 60 * 60 * 1000;

/**
 * Per-chat turn and run limits. A field omitted inherits the default.
 * `0` means no limit. A positive value is a limit in milliseconds and
 * must not exceed 24 hours.
 */
export const DeadlinesSchema = Type.Object(
	{
		turnMs: Type.Optional(
			Type.Integer({
				minimum: 0,
				maximum: MAX_DEADLINE_MS,
				description:
					"Limit for one turn in milliseconds. Omitted inherits the default. 0 means no limit. Values above 24 hours are rejected.",
			}),
		),
		runMs: Type.Optional(
			Type.Integer({
				minimum: 0,
				maximum: MAX_DEADLINE_MS,
				description:
					"Limit for an autonomous run (task loop or group chat) in milliseconds. Omitted inherits the default. 0 means no limit. Values above 24 hours are rejected.",
			}),
		),
	},
	{
		additionalProperties: false,
		description:
			"Per-chat deadline overrides. Omitted fields inherit defaults. 0 means no limit.",
	},
);
export type Deadlines = Static<typeof DeadlinesSchema>;

export const ChatTaskStatusSchema = Type.Union(
	[Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("done")],
	{ description: "Lifecycle status of a chat task." },
);
export type ChatTaskStatus = Static<typeof ChatTaskStatusSchema>;

export const ChatTaskSchema = Type.Object(
	{
		index: Type.Integer({
			minimum: 1,
			description: "Per-chat task index. Never reused after removal.",
		}),
		title: Type.String({
			minLength: 1,
			maxLength: 120,
			description: "Short task title.",
		}),
		details: Type.String({
			minLength: 1,
			maxLength: 8000,
			description: "Task details for the bot.",
		}),
		status: ChatTaskStatusSchema,
		summary: Type.Optional(
			Type.String({
				maxLength: 500,
				description: "Optional result summary from task_finish.",
			}),
		),
		createdAt: Type.Number({
			description: "Epoch timestamp in milliseconds when the task was created.",
		}),
		updatedAt: Type.Number({
			description:
				"Epoch timestamp in milliseconds when the task last changed.",
		}),
	},
	{ description: "A semi-autonomous chat task." },
);
export type ChatTask = Static<typeof ChatTaskSchema>;

export const ChatTaskLoopStateSchema = Type.Union(
	[
		Type.Literal("running"),
		Type.Literal("idle"),
		Type.Literal("paused"),
		Type.Literal("capped"),
	],
	{ description: "Auto-continue loop state." },
);
export type ChatTaskLoopState = Static<typeof ChatTaskLoopStateSchema>;

export const ChatTaskLoopSchema = Type.Object(
	{
		round: Type.Integer({
			minimum: 0,
			description: "Auto-continue rounds since the last user message.",
		}),
		max: Type.Integer({
			minimum: 0,
			description: "Round cap for this loop.",
		}),
		state: ChatTaskLoopStateSchema,
	},
	{ description: "Task auto-continue loop snapshot." },
);
export type ChatTaskLoop = Static<typeof ChatTaskLoopSchema>;

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
		toolsEnv: Type.Optional(ToolsEnvSettingSchema),
		kind: Type.Optional(ChatKindSchema),
		members: Type.Optional(
			Type.Array(Type.String(), {
				description: "Bot ids that belong to a group chat, in join order.",
			}),
		),
		topic: Type.Optional(
			Type.String({
				description: "Topic of a group chat.",
			}),
		),
		readOnly: Type.Optional(
			Type.Boolean({
				description:
					"When true, the user can view the chat but cannot post. Group chats and group member chats are read-only.",
			}),
		),
		toolsReadOnly: Type.Optional(
			Type.Boolean({
				description:
					"When true, this group chat was opened with message_bot readOnly. Target members are offered only memory and knowledge read tools. Absent or false keeps each member's normal tools. The user still cannot post.",
			}),
		),
		harvest: Type.Optional(
			Type.Boolean({
				description:
					"Per-chat idle harvest switch. Omitted means on. Group-chat sessions default to off.",
			}),
		),
		groupStatus: Type.Optional(
			Type.Union(
				[
					Type.Literal("open"),
					Type.Literal("ended"),
					Type.Literal("timed_out"),
					Type.Literal("capped"),
				],
				{
					description: "Lifecycle status of a group chat.",
				},
			),
		),
		deadlines: Type.Optional(DeadlinesSchema),
		effectiveDeadlines: Type.Optional(
			Type.Object(
				{
					turnMs: Type.Integer({
						minimum: 0,
						description:
							"Resolved turn limit in milliseconds. 0 means no limit.",
					}),
					runMs: Type.Integer({
						minimum: 0,
						description:
							"Resolved run limit in milliseconds. 0 means no limit.",
					}),
				},
				{ additionalProperties: false },
			),
		),
		deleted: Type.Optional(
			Type.Boolean({
				description: "Whether this chat has been soft-deleted.",
			}),
		),
		deletedAt: Type.Optional(
			Type.Number({
				description:
					"Epoch timestamp in milliseconds when the chat was soft-deleted.",
			}),
		),
		originChatKey: Type.Optional(
			Type.String({
				description:
					"Routing key of the originating chat that spawned this child or group member chat.",
			}),
		),
	},
	{
		description:
			"Chat session record tracking a conversation thread with a specific bot, or a read-only group chat shared by bots.",
	},
);
export type ChatRecord = Static<typeof ChatRecordSchema>;

/**
 * Monetary cost breakdown in USD.
 */
export const UsageCostSchema = Type.Object(
	{
		input: Type.Number({ description: "Input token cost in USD." }),
		output: Type.Number({ description: "Output token cost in USD." }),
		cacheRead: Type.Number({ description: "Cache read token cost in USD." }),
		cacheWrite: Type.Number({ description: "Cache write token cost in USD." }),
		total: Type.Number({ description: "Total cost in USD." }),
	},
	{
		additionalProperties: false,
		description: "Estimated cost breakdown in USD.",
	},
);
export type UsageCost = Static<typeof UsageCostSchema>;

/**
 * Token and cost metrics for one bucket (overall, per-model, or per-source).
 */
export const UsageBucketSchema = Type.Object(
	{
		input: Type.Number({ description: "Input tokens count." }),
		output: Type.Number({ description: "Output tokens count." }),
		cacheRead: Type.Number({ description: "Tokens read from cache." }),
		cacheWrite: Type.Number({ description: "Tokens written to cache." }),
		cacheWrite1h: Type.Optional(
			Type.Number({
				description: "Tokens written to 1-hour cache if supported.",
			}),
		),
		reasoning: Type.Optional(
			Type.Number({ description: "Reasoning / thinking tokens count." }),
		),
		totalTokens: Type.Number({ description: "Total tokens consumed." }),
		cost: UsageCostSchema,
	},
	{
		additionalProperties: false,
		description: "Token counts and estimated costs.",
	},
);
export type UsageBucket = Static<typeof UsageBucketSchema>;

/**
 * Usage categorized by origin/source.
 */
export const UsageSourcesSchema = Type.Object(
	{
		direct: UsageBucketSchema,
		harvest: UsageBucketSchema,
		schedules: UsageBucketSchema,
		botMessages: UsageBucketSchema,
		search: UsageBucketSchema,
		tools: Type.Optional(UsageBucketSchema),
	},
	{
		additionalProperties: false,
		description: "Token usage and costs broken down by execution source.",
	},
);
export type UsageSources = Static<typeof UsageSourcesSchema>;

/**
 * Comprehensive usage summary including totals, per-model, per-tool, and per-source breakdowns.
 */
export const UsageSummarySchema = Type.Object(
	{
		totals: UsageBucketSchema,
		models: Type.Record(Type.String(), UsageBucketSchema, {
			description: "Token usage by model ID.",
		}),
		tools: Type.Record(Type.String(), UsageBucketSchema, {
			description: "Token usage directly attributed to tool executions.",
		}),
		sources: UsageSourcesSchema,
	},
	{
		additionalProperties: false,
		description: "Aggregated usage metrics with multi-dimensional breakdowns.",
	},
);
export type UsageSummary = Static<typeof UsageSummarySchema>;

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
	fromBotId: Type.Optional(
		Type.String({
			description:
				"Bot that posted this group-chat message. Present on member-attributed group logs.",
		}),
	),
	authorUserId: Type.Optional(
		Type.String({
			description:
				"User who authored this user message, as authenticated by the server. Absent for messages written before authorship was recorded and for bot-originated turns.",
		}),
	),
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
