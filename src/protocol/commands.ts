import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { ProtocolValidationError } from "./common.js";
import {
	AccountOAuthCancelCommandSchema,
	AccountOAuthProvidersCommandSchema,
	AccountOAuthStartCommandSchema,
	AccountOAuthStatusCommandSchema,
	AccountOAuthSubmitCommandSchema,
} from "./oauth.js";
import {
	CredentialInputSchema,
	ScheduleTargetSchema,
	ThinkingLevelSchema,
	ToolsEnvBindingSchema,
	ToolsEnvSettingSchema,
} from "./records.js";

/**
 * Command to retrieve the current tenant account record, its members, registered bot families, and credential summaries.
 */
export const AccountGetCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("account.get", {
			description: "Command type identifier.",
		}),
		payload: Type.Optional(
			Type.Object({}, { description: "Empty parameter payload." }),
		),
	},
	{
		description:
			"Retrieve tenant account details including membership, configured bot families, and provider credentials.",
	},
);
export type AccountGetCommand = Static<typeof AccountGetCommandSchema>;

/**
 * Command to update account-level settings such as display name and default timezone.
 */
export const AccountUpdateCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("account.update", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{
				name: Type.Optional(
					Type.String({
						minLength: 1,
						description: "Optional new display name for the account.",
					}),
				),
				timezone: Type.Optional(
					Type.String({
						minLength: 1,
						description:
							"Optional new default IANA timezone identifier for the account (e.g. 'UTC', 'America/New_York').",
					}),
				),
				defaultToolsEnv: Type.Optional(
					Type.Union([ToolsEnvBindingSchema, Type.Null()], {
						description:
							"Account default tools env binding, or null to clear it.",
					}),
				),
			},
			{ description: "Account settings to update." },
		),
	},
	{
		description:
			"Update account-level configuration including display name and default timezone.",
	},
);
export type AccountUpdateCommand = Static<typeof AccountUpdateCommandSchema>;

/**
 * Command to list all members and their access roles belonging to this account.
 */
export const AccountMembersListCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("account.members.list", {
			description: "Command type identifier.",
		}),
		payload: Type.Optional(
			Type.Object({}, { description: "Empty parameter payload." }),
		),
	},
	{
		description:
			"List all user members and their roles associated with the tenant account.",
	},
);
export type AccountMembersListCommand = Static<
	typeof AccountMembersListCommandSchema
>;

/**
 * Command to add or invite a user to the account with a specified access role.
 */
export const AccountMembersAddCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("account.members.add", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{
				userId: Type.String({
					minLength: 1,
					description: "Unique identifier of the user to grant access to.",
				}),
				name: Type.Optional(
					Type.String({
						description: "Optional display name for the user.",
					}),
				),
				email: Type.Optional(
					Type.String({
						description: "Optional email address for the user.",
					}),
				),
				role: Type.Optional(
					Type.Union([Type.Literal("owner"), Type.Literal("member")], {
						description:
							"Access role: 'owner' has full administrative rights; 'member' has standard access (defaults to 'member').",
					}),
				),
				token: Type.Optional(
					Type.String({
						description:
							"Optional authentication token associated with this user.",
					}),
				),
			},
			{ description: "Parameters for adding or inviting an account member." },
		),
	},
	{
		description:
			"Add or invite a user to the account with a specified access role and optional credentials.",
	},
);
export type AccountMembersAddCommand = Static<
	typeof AccountMembersAddCommandSchema
>;

/**
 * Command to list configured AI provider credentials (excluding confidential secret values).
 */
export const AccountCredentialsListCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("account.credentials.list", {
			description: "Command type identifier.",
		}),
		payload: Type.Optional(
			Type.Object({}, { description: "Empty parameter payload." }),
		),
	},
	{
		description:
			"List configured AI provider credential summaries (excluding secret tokens).",
	},
);
export type AccountCredentialsListCommand = Static<
	typeof AccountCredentialsListCommandSchema
>;

/**
 * Command to store or update encrypted provider credentials (API key or OAuth token) for the account.
 */
export const AccountCredentialsSetCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("account.credentials.set", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{
				providerId: Type.String({
					minLength: 1,
					description:
						"AI provider identifier (e.g. 'anthropic', 'openai', 'google', 'groq', 'deepseek', 'xai').",
				}),
				credential: CredentialInputSchema,
			},
			{
				description: "Parameters containing the provider credentials to store.",
			},
		),
	},
	{
		description:
			"Store or update encrypted provider credentials (API key or OAuth token set) for the account.",
	},
);
export type AccountCredentialsSetCommand = Static<
	typeof AccountCredentialsSetCommandSchema
>;

/**
 * Command to delete configured credentials for a provider from the account.
 */
export const AccountCredentialsDeleteCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("account.credentials.delete", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{
				providerId: Type.String({
					minLength: 1,
					description:
						"Provider identifier whose credentials should be permanently deleted.",
				}),
			},
			{
				description:
					"Parameters identifying the provider credential to delete.",
			},
		),
	},
	{
		description:
			"Permanently delete configured credentials for a provider from the account.",
	},
);
export type AccountCredentialsDeleteCommand = Static<
	typeof AccountCredentialsDeleteCommandSchema
>;

/**
 * Command to list all available AI models and their capabilities, optionally filtered by provider or credential availability.
 */
export const AccountModelsListCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("account.models.list", {
			description: "Command type identifier.",
		}),
		payload: Type.Optional(
			Type.Object(
				{
					provider: Type.Optional(
						Type.String({
							description:
								"Optional provider identifier to filter models (e.g. 'anthropic').",
						}),
					),
					onlyAuthenticated: Type.Optional(
						Type.Boolean({
							description:
								"If true, only returns models that have valid configured credentials.",
						}),
					),
				},
				{ description: "Filters for listing models." },
			),
		),
	},
	{
		description:
			"List supported LLM models and their capabilities, optionally filtered by provider or authentication status.",
	},
);
export type AccountModelsListCommand = Static<
	typeof AccountModelsListCommandSchema
>;

/**
 * Command to list all bot families belonging to the account.
 */
export const FamilyListCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("family.list", {
			description: "Command type identifier.",
		}),
		payload: Type.Optional(
			Type.Object({}, { description: "Empty parameter payload." }),
		),
	},
	{
		description:
			"List all bot families (Durable Object clusters) registered to the account.",
	},
);
export type FamilyListCommand = Static<typeof FamilyListCommandSchema>;

/**
 * Command to create a new bot family (Durable Object instance) within the account.
 */
export const FamilyCreateCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("family.create", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{
				familyId: Type.Optional(
					Type.String({
						minLength: 1,
						description:
							"Optional custom identifier / slug for the new family. Generated if omitted.",
					}),
				),
				name: Type.String({
					minLength: 1,
					description: "Human-readable display name for the bot family.",
				}),
				timezone: Type.Optional(
					Type.String({
						description:
							"Optional default IANA timezone identifier for this family (defaults to account timezone).",
					}),
				),
				harvestDelayMs: Type.Optional(
					Type.Number({
						description:
							"Optional idle delay in milliseconds before running background memory harvesting (defaults to 60000ms).",
					}),
				),
			},
			{
				description: "Configuration parameters for creating a new bot family.",
			},
		),
	},
	{
		description:
			"Create a new bot family, initializing its partitioned Cloudflare Durable Object instance.",
	},
);
export type FamilyCreateCommand = Static<typeof FamilyCreateCommandSchema>;

/**
 * Command to retrieve metadata for a bot family.
 */
export const FamilyGetCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("family.get", {
			description: "Command type identifier.",
		}),
		payload: Type.Optional(
			Type.Object(
				{
					familyId: Type.Optional(
						Type.String({
							description:
								"Optional family identifier. Defaults to the currently scoped family.",
						}),
					),
				},
				{ description: "Parameters identifying the family to retrieve." },
			),
		),
	},
	{
		description:
			"Retrieve metadata for a specific bot family or the currently scoped family.",
	},
);
export type FamilyGetCommand = Static<typeof FamilyGetCommandSchema>;

/**
 * Command to update bot family metadata.
 */
export const FamilyUpdateCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("family.update", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{
				familyId: Type.Optional(
					Type.String({
						description:
							"Optional family identifier to update. Defaults to the scoped family.",
					}),
				),
				name: Type.Optional(
					Type.String({
						description: "Optional updated display name for the family.",
					}),
				),
				timezone: Type.Optional(
					Type.String({
						description:
							"Optional updated default IANA timezone identifier for this family.",
					}),
				),
				harvestDelayMs: Type.Optional(
					Type.Number({
						description: "Optional updated idle harvest delay in milliseconds.",
					}),
				),
			},
			{ description: "Parameters for updating bot family configuration." },
		),
	},
	{
		description:
			"Update bot family settings including display name, timezone, or idle harvest delay.",
	},
);
export type FamilyUpdateCommand = Static<typeof FamilyUpdateCommandSchema>;

/**
 * Command to delete a bot family and all of its associated bots, chats, files, and schedules.
 */
export const FamilyDeleteCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("family.delete", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{
				familyId: Type.String({
					minLength: 1,
					description: "Identifier of the bot family to permanently delete.",
				}),
			},
			{ description: "Parameters identifying the bot family to delete." },
		),
	},
	{
		description:
			"Permanently delete a bot family and cascade-delete its Durable Object data.",
	},
);
export type FamilyDeleteCommand = Static<typeof FamilyDeleteCommandSchema>;

/**
 * Command to list all bots configured in this bot family.
 */
export const BotListCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("bot.list", {
			description: "Command type identifier.",
		}),
		payload: Type.Optional(
			Type.Object({}, { description: "Empty parameter payload." }),
		),
	},
	{
		description: "List all bots configured within the current bot family.",
	},
);
export type BotListCommand = Static<typeof BotListCommandSchema>;

/**
 * Command to create a new bot persona with optional initial system prompt (soul), memory, and knowledge base documents.
 */
export const BotCreateCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("bot.create", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{
				slug: Type.Optional(
					Type.String({
						description:
							"Optional unique identifier / slug for the bot (generated from name if omitted).",
					}),
				),
				name: Type.String({
					minLength: 1,
					description: "Human-readable display name of the bot.",
				}),
				model: Type.Optional(
					Type.String({
						description:
							"Default model identifier used for turns (e.g. 'anthropic/claude-3-7-sonnet').",
					}),
				),
				thinking: Type.Optional(ThinkingLevelSchema),
				tools: Type.Optional(
					Type.Array(Type.String(), {
						description:
							"Allowlist of tool names. Omit it for the default set (Cadmus tools allowed, coding tools opt-in). An empty array allows no gated tools.",
					}),
				),
				soul: Type.Optional(
					Type.String({
						description:
							"Optional initial system prompt / personality instructions (SOUL.md content).",
					}),
				),
				memory: Type.Optional(
					Type.String({
						description:
							"Optional initial long-term memory markdown content (MEMORY.md content).",
					}),
				),
				toolsEnv: Type.Optional(ToolsEnvSettingSchema),
				knowledge: Type.Optional(
					Type.Array(
						Type.Object(
							{
								slug: Type.String({
									description:
										"Unique document slug / filename without extension.",
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
								body: Type.String({
									description: "Full markdown content body of the document.",
								}),
							},
							{ description: "Initial knowledge document entry." },
						),
						{
							description:
								"Optional array of initial knowledge documents to create for this bot.",
						},
					),
				),
			},
			{ description: "Parameters for creating a new bot persona." },
		),
	},
	{
		description:
			"Create a new bot persona with default model, thinking budget, tool access, and initial virtual workspace files.",
	},
);
export type BotCreateCommand = Static<typeof BotCreateCommandSchema>;

/**
 * Command to retrieve a bot's configuration, SOUL.md system prompt, MEMORY.md content with version, and knowledge base documents.
 */
export const BotGetCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("bot.get", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{
				botId: Type.String({
					minLength: 1,
					description: "Identifier of the bot to retrieve.",
				}),
			},
			{ description: "Parameters identifying the bot." },
		),
	},
	{
		description:
			"Retrieve full bot configuration, system prompt (SOUL.md), memory state, and knowledge documents.",
	},
);
export type BotGetCommand = Static<typeof BotGetCommandSchema>;

/**
 * Command to update an existing bot's display name, model, thinking level, tool permissions, or soul.
 */
export const BotUpdateCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("bot.update", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{
				botId: Type.String({
					minLength: 1,
					description: "Identifier of the bot to update.",
				}),
				name: Type.Optional(
					Type.String({
						description: "Optional updated display name.",
					}),
				),
				model: Type.Optional(
					Type.String({
						description: "Optional updated default model identifier string.",
					}),
				),
				thinking: Type.Optional(ThinkingLevelSchema),
				tools: Type.Optional(
					Type.Union(
						[
							Type.Array(Type.String(), {
								description:
									"Replacement allowlist. An empty array allows no gated tools and does not offer coding tools.",
							}),
							Type.Null(),
						],
						{
							description:
								"Missing or null leaves the stored allowlist unchanged. An array replaces it.",
						},
					),
				),
				soul: Type.Optional(
					Type.String({
						description: "Optional updated SOUL.md system prompt content.",
					}),
				),
				toolsEnv: Type.Optional(ToolsEnvSettingSchema),
			},
			{ description: "Parameters for updating bot configuration." },
		),
	},
	{
		description:
			"Update an existing bot's model, thinking budget, tool access, display name, or soul.",
	},
);
export type BotUpdateCommand = Static<typeof BotUpdateCommandSchema>;

/**
 * Command to delete a bot and cascade-delete its chats, files, and schedules.
 */
export const BotDeleteCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("bot.delete", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{
				botId: Type.String({
					minLength: 1,
					description: "Identifier of the bot to permanently delete.",
				}),
			},
			{ description: "Parameters identifying the bot to delete." },
		),
	},
	{
		description:
			"Permanently delete a bot persona and cascade-delete its chat history, virtual files, and schedules.",
	},
);
export type BotDeleteCommand = Static<typeof BotDeleteCommandSchema>;

/**
 * Command to create a new chat conversation session with a specified bot.
 */
export const ChatCreateCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("chat.create", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{
				botId: Type.String({
					minLength: 1,
					description: "Identifier of the bot to converse with.",
				}),
				key: Type.Optional(
					Type.String({
						description:
							"Optional custom chat routing key / slug. Generated if omitted.",
					}),
				),
				chatId: Type.Optional(
					Type.String({
						description: "Deprecated alias for key.",
					}),
				),
				title: Type.Optional(
					Type.String({
						description: "Optional title or topic label for the chat session.",
					}),
				),
				thinking: Type.Optional(ThinkingLevelSchema),
				toolsEnv: Type.Optional(ToolsEnvSettingSchema),
			},
			{ description: "Parameters for creating a new chat session." },
		),
	},
	{
		description:
			"Create a new chat conversation thread with a bot, returning its unique routing key.",
	},
);
export type ChatCreateCommand = Static<typeof ChatCreateCommandSchema>;

/**
 * Command to list chat conversation sessions in this family, optionally filtered by bot.
 */
export const ChatListCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("chat.list", {
			description: "Command type identifier.",
		}),
		payload: Type.Optional(
			Type.Object(
				{
					botId: Type.Optional(
						Type.String({
							description: "Optional bot identifier to filter chat sessions.",
						}),
					),
				},
				{ description: "Filters for listing chat sessions." },
			),
		),
	},
	{
		description:
			"List chat conversation sessions in this bot family, optionally filtered by botId.",
	},
);
export type ChatListCommand = Static<typeof ChatListCommandSchema>;

/**
 * Command to retrieve full chat session details, active busy status, recent messages, transcript entries, and harvest notes.
 */
export const ChatGetCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("chat.get", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{
				chatKey: Type.String({
					minLength: 1,
					description: "Unique routing key of the chat session to retrieve.",
				}),
			},
			{ description: "Parameters identifying the chat session." },
		),
	},
	{
		description:
			"Retrieve chat session metadata, active busy flag, recent messages, entries, and harvest notes.",
	},
);
export type ChatGetCommand = Static<typeof ChatGetCommandSchema>;

/**
 * Command to set or clear a chat's tools env setting. Title changes stay on chat.rename.
 */
export const ChatUpdateCommandSchema = Type.Object(
	{
		id: Type.String({ minLength: 1 }),
		type: Type.Literal("chat.update"),
		payload: Type.Object(
			{
				chatKey: Type.String({ minLength: 1 }),
				toolsEnv: ToolsEnvSettingSchema,
			},
			{ additionalProperties: false },
		),
	},
	{ description: "Update a chat's tools env setting." },
);
export type ChatUpdateCommand = Static<typeof ChatUpdateCommandSchema>;

const ToolsEnvKindSchema = Type.Union([
	Type.Literal("just-bash"),
	Type.Literal("local-daemon"),
]);

export const AccountToolsEnvsListCommandSchema = Type.Object(
	{
		id: Type.String({ minLength: 1 }),
		type: Type.Literal("account.toolsEnvs.list"),
		payload: Type.Optional(Type.Object({}, { additionalProperties: false })),
	},
	{
		description: "List account tools env definitions and the default binding.",
	},
);
export type AccountToolsEnvsListCommand = Static<
	typeof AccountToolsEnvsListCommandSchema
>;

export const AccountToolsEnvsCreateCommandSchema = Type.Object(
	{
		id: Type.String({ minLength: 1 }),
		type: Type.Literal("account.toolsEnvs.create"),
		payload: Type.Object(
			{
				kind: ToolsEnvKindSchema,
				label: Type.Optional(Type.String()),
				persist: Type.Optional(Type.Boolean()),
				confineToWorkspace: Type.Optional(Type.Boolean()),
				sharedWorkspace: Type.Optional(Type.Boolean()),
				secretId: Type.Optional(Type.String({ minLength: 1 })),
				workspacePath: Type.Optional(Type.String({ minLength: 1 })),
			},
			{ additionalProperties: false },
		),
	},
	{
		description:
			"Create a just-bash or local-daemon tools env definition. Daemon rows require secretId, workspacePath, and confineToWorkspace.",
	},
);
export type AccountToolsEnvsCreateCommand = Static<
	typeof AccountToolsEnvsCreateCommandSchema
>;

export const AccountToolsEnvsUpdateCommandSchema = Type.Object(
	{
		id: Type.String({ minLength: 1 }),
		type: Type.Literal("account.toolsEnvs.update"),
		payload: Type.Object(
			{
				envId: Type.String({ minLength: 1 }),
				label: Type.Optional(Type.String()),
				persist: Type.Optional(Type.Boolean()),
				confineToWorkspace: Type.Optional(Type.Boolean()),
				sharedWorkspace: Type.Optional(Type.Boolean()),
				secretId: Type.Optional(Type.String({ minLength: 1 })),
				workspacePath: Type.Optional(Type.String({ minLength: 1 })),
			},
			{ additionalProperties: false },
		),
	},
	{ description: "Update a tools env definition. Kind is immutable." },
);
export type AccountToolsEnvsUpdateCommand = Static<
	typeof AccountToolsEnvsUpdateCommandSchema
>;

export const AccountToolsEnvsDeleteCommandSchema = Type.Object(
	{
		id: Type.String({ minLength: 1 }),
		type: Type.Literal("account.toolsEnvs.delete"),
		payload: Type.Object(
			{
				envId: Type.String({ minLength: 1 }),
			},
			{ additionalProperties: false },
		),
	},
	{ description: "Delete a tools env definition and its env DO data." },
);
export type AccountToolsEnvsDeleteCommand = Static<
	typeof AccountToolsEnvsDeleteCommandSchema
>;

export const AccountToolsEnvSecretsListCommandSchema = Type.Object(
	{
		id: Type.String({ minLength: 1 }),
		type: Type.Literal("account.toolsEnvSecrets.list"),
		payload: Type.Optional(Type.Object({}, { additionalProperties: false })),
	},
	{
		description:
			"List daemon pairing secrets. Metadata only; the token is never returned.",
	},
);
export type AccountToolsEnvSecretsListCommand = Static<
	typeof AccountToolsEnvSecretsListCommandSchema
>;

export const AccountToolsEnvSecretsSetCommandSchema = Type.Object(
	{
		id: Type.String({ minLength: 1 }),
		type: Type.Literal("account.toolsEnvSecrets.set"),
		payload: Type.Optional(
			Type.Object(
				{
					label: Type.Optional(Type.String()),
				},
				{ additionalProperties: false },
			),
		),
	},
	{
		description:
			"Mint a daemon pairing token (cadmus_dt_ + 64 hex). The token is returned once. A caller-supplied token is rejected.",
	},
);
export type AccountToolsEnvSecretsSetCommand = Static<
	typeof AccountToolsEnvSecretsSetCommandSchema
>;

export const AccountToolsEnvSecretsDeleteCommandSchema = Type.Object(
	{
		id: Type.String({ minLength: 1 }),
		type: Type.Literal("account.toolsEnvSecrets.delete"),
		payload: Type.Object(
			{
				secretId: Type.String({ minLength: 1 }),
			},
			{ additionalProperties: false },
		),
	},
	{
		description:
			"Delete a daemon pairing secret, flag env rows that named it, and clear a default that points at one of them.",
	},
);
export type AccountToolsEnvSecretsDeleteCommand = Static<
	typeof AccountToolsEnvSecretsDeleteCommandSchema
>;

/**
 * Command to update the title or topic of a chat session.
 */
export const ChatRenameCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("chat.rename", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{
				chatKey: Type.String({
					minLength: 1,
					description: "Chat routing key to rename.",
				}),
				title: Type.String({
					description: "New title string for the conversation.",
				}),
			},
			{ description: "Parameters for renaming a chat session." },
		),
	},
	{
		description: "Rename the title or topic of an existing chat session.",
	},
);
export type ChatRenameCommand = Static<typeof ChatRenameCommandSchema>;

/**
 * Command to close or archive a chat session.
 */
export const ChatCloseCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("chat.close", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{
				chatKey: Type.String({
					minLength: 1,
					description: "Chat routing key to close.",
				}),
			},
			{ description: "Parameters identifying the chat session to close." },
		),
	},
	{
		description: "Close and archive a chat conversation session.",
	},
);
export type ChatCloseCommand = Static<typeof ChatCloseCommandSchema>;

/**
 * Command to reset a chat conversation transcript while preserving the chat routing key, optionally providing handoff summary text.
 */
export const ChatResetCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("chat.reset", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{
				chatKey: Type.String({
					minLength: 1,
					description: "Chat routing key to reset.",
				}),
				handoff: Type.Optional(
					Type.String({
						description:
							"Optional summary context seeded into the reset conversation.",
					}),
				),
			},
			{ description: "Parameters for resetting a chat conversation." },
		),
	},
	{
		description:
			"Reset conversation history for a chat session while preserving its key, optionally injecting handoff context.",
	},
);
export type ChatResetCommand = Static<typeof ChatResetCommandSchema>;

/**
 * Command to fetch the message exchange history of a chat session.
 */
export const ChatMessagesCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("chat.messages", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{
				chatKey: Type.String({
					minLength: 1,
					description: "Chat routing key whose messages to fetch.",
				}),
			},
			{ description: "Parameters identifying the chat session." },
		),
	},
	{
		description:
			"Fetch the user and assistant message exchange history for a chat session.",
	},
);
export type ChatMessagesCommand = Static<typeof ChatMessagesCommandSchema>;

/**
 * Command to fetch the raw durable transcript entries for a chat session.
 */
export const ChatEntriesCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("chat.entries", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{
				chatKey: Type.String({
					minLength: 1,
					description: "Chat routing key whose transcript entries to fetch.",
				}),
			},
			{ description: "Parameters identifying the chat session." },
		),
	},
	{
		description:
			"Fetch the underlying durable transcript entries (including tool calls and state records) for a chat session.",
	},
);
export type ChatEntriesCommand = Static<typeof ChatEntriesCommandSchema>;

/**
 * Command to retrieve live out-of-band runtime status for a chat (busy state, active model, thinking budget, tool access, usage, and next scheduled alarm).
 */
export const ChatStatusCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("chat.status", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{
				chatKey: Type.String({
					minLength: 1,
					description: "Chat routing key whose status to inspect.",
				}),
			},
			{ description: "Parameters identifying the chat session." },
		),
	},
	{
		description:
			"Fetch out-of-band runtime execution status for a chat session without invoking the model or modifying history.",
	},
);
export type ChatStatusCommand = Static<typeof ChatStatusCommandSchema>;

/**
 * Command to subscribe the active WebSocket or SSE connection to real-time events emitted by this chat session.
 */
export const ChatSubscribeCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("chat.subscribe", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{
				chatKey: Type.String({
					minLength: 1,
					description: "Chat routing key to subscribe to.",
				}),
			},
			{ description: "Parameters identifying the chat session." },
		),
	},
	{
		description:
			"Subscribe the current connection (WebSocket or SSE) to real-time streaming deltas, tool calls, and state events for a chat.",
	},
);
export type ChatSubscribeCommand = Static<typeof ChatSubscribeCommandSchema>;

/**
 * Command to submit a user message turn to a chat session, initiating model reasoning and tool execution.
 */
export const TurnSubmitCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("turn.submit", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{
				chatKey: Type.String({
					minLength: 1,
					description: "Target chat session routing key.",
				}),
				text: Type.String({
					minLength: 1,
					description: "User message prompt text to submit.",
				}),
				requestId: Type.Optional(
					Type.String({
						description:
							"Optional client request correlation identifier for deduplication.",
					}),
				),
				clientMsgId: Type.Optional(
					Type.String({
						description:
							"Optional client message identifier for idempotent replay tracking.",
					}),
				),
				whenBusy: Type.Optional(
					Type.Union(
						[
							Type.Literal("queue", {
								description:
									"Buffer the turn and execute once the current turn completes.",
							}),
							Type.Literal("steer", {
								description:
									"Inject this prompt as steering guidance into the active turn without waiting.",
							}),
							Type.Literal("reject", {
								description:
									"Immediately fail this command with an error if the chat is busy.",
							}),
						],
						{
							description:
								"Concurrency handling policy when the chat is busy: 'queue' (default), 'steer', or 'reject'.",
						},
					),
				),
			},
			{ description: "Parameters for submitting a user message turn." },
		),
	},
	{
		description:
			"Submit a user message turn to a chat session, initiating model reasoning, tool calling, and response generation.",
	},
);
export type TurnSubmitCommand = Static<typeof TurnSubmitCommandSchema>;

/**
 * Command to execute an out-of-band slash command (e.g. '/status') on a chat session without invoking the LLM.
 */
export const TurnCommandCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("turn.command", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{
				chatKey: Type.String({
					minLength: 1,
					description: "Target chat session routing key.",
				}),
				command: Type.String({
					minLength: 1,
					description:
						"Slash command string (currently '/status' is supported out-of-band).",
				}),
			},
			{ description: "Parameters for executing an out-of-band slash command." },
		),
	},
	{
		description:
			"Execute an out-of-band slash command on a chat session without invoking the LLM or polluting transcript history.",
	},
);
export type TurnCommandCommand = Static<typeof TurnCommandCommandSchema>;

/**
 * Command to steer an in-progress model turn by injecting additional guidance instructions into the active run.
 */
export const TurnSteerCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("turn.steer", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{
				chatKey: Type.String({
					minLength: 1,
					description: "Target chat session routing key.",
				}),
				text: Type.String({
					minLength: 1,
					description:
						"Steering instruction text injected into the actively running turn.",
				}),
				requestId: Type.Optional(
					Type.String({
						description: "Optional client request correlation identifier.",
					}),
				),
				clientMsgId: Type.Optional(
					Type.String({
						description: "Optional client message identifier.",
					}),
				),
			},
			{ description: "Parameters for steering an active turn." },
		),
	},
	{
		description:
			"Steer an active model turn by injecting guidance instructions into the running agent loop without cancelling it.",
	},
);
export type TurnSteerCommand = Static<typeof TurnSteerCommandSchema>;

/**
 * Command to interrupt and cancel the currently executing model turn on a chat session.
 */
export const TurnInterruptCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("turn.interrupt", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{
				chatKey: Type.String({
					minLength: 1,
					description:
						"Chat session routing key where the turn should be interrupted.",
				}),
			},
			{ description: "Parameters identifying the chat session to interrupt." },
		),
	},
	{
		description:
			"Interrupt and immediately abort the currently running model turn or tool call on a chat session.",
	},
);
export type TurnInterruptCommand = Static<typeof TurnInterruptCommandSchema>;

/**
 * Command to abort and terminate the currently running turn on a chat session (synonym for turn.interrupt).
 */
export const TurnAbortCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("turn.abort", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{
				chatKey: Type.String({
					minLength: 1,
					description:
						"Chat session routing key where the turn should be aborted.",
				}),
			},
			{ description: "Parameters identifying the chat session to abort." },
		),
	},
	{
		description:
			"Abort and cancel an active turn on a chat session (synonym for turn.interrupt).",
	},
);
export type TurnAbortCommand = Static<typeof TurnAbortCommandSchema>;

/**
 * Command to list virtual workspace files (SOUL.md, MEMORY.md, and knowledge documents) for a bot.
 */
export const FileListCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("file.list", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{
				botId: Type.String({
					minLength: 1,
					description: "Bot identifier whose virtual files to list.",
				}),
				category: Type.Optional(
					Type.String({
						description:
							"Optional category tag filter for knowledge documents.",
					}),
				),
			},
			{ description: "Parameters for listing virtual workspace files." },
		),
	},
	{
		description:
			"List virtual workspace files (SOUL.md, MEMORY.md, and knowledge documents) associated with a bot.",
	},
);
export type FileListCommand = Static<typeof FileListCommandSchema>;

/**
 * Command to read a virtual workspace file's content and version metadata, or list files if path is omitted.
 */
export const FileReadCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("file.read", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{
				botId: Type.String({
					minLength: 1,
					description: "Bot identifier whose file to read.",
				}),
				path: Type.Optional(
					Type.String({
						description:
							"Virtual workspace file path to read (e.g. 'SOUL.md', 'MEMORY.md', 'knowledge/topic.md'). If omitted, lists all files.",
					}),
				),
			},
			{ description: "Parameters identifying the file to read." },
		),
	},
	{
		description:
			"Read a virtual workspace file's content and version metadata, or list files if path is omitted.",
	},
);
export type FileReadCommand = Static<typeof FileReadCommandSchema>;

/**
 * Command to create, update, or delete a virtual workspace file with optimistic concurrency version control (CAS).
 */
export const FileWriteCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("file.write", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{
				botId: Type.String({
					minLength: 1,
					description: "Bot identifier owning the file.",
				}),
				path: Type.String({
					minLength: 1,
					description:
						"Virtual workspace file path (e.g. 'SOUL.md', 'MEMORY.md', 'knowledge/topic.md').",
				}),
				content: Type.Optional(
					Type.String({
						description: "File content string to write.",
					}),
				),
				text: Type.Optional(
					Type.String({
						description: "Alias for content.",
					}),
				),
				expectedVersion: Type.Optional(
					Type.Number({
						description:
							"Expected current version for optimistic concurrency control (CAS). Write fails if version does not match.",
					}),
				),
				version: Type.Optional(
					Type.Number({
						description: "Alias for expectedVersion.",
					}),
				),
				description: Type.Optional(
					Type.String({
						description: "Summary description for knowledge documents.",
					}),
				),
				category: Type.Optional(
					Type.String({
						description: "Optional category tag for knowledge documents.",
					}),
				),
				body: Type.Optional(
					Type.String({
						description: "Markdown body for knowledge documents.",
					}),
				),
				delete: Type.Optional(
					Type.Boolean({
						description:
							"If true, deletes the virtual file instead of writing.",
					}),
				),
			},
			{ description: "Parameters for writing or deleting a virtual file." },
		),
	},
	{
		description:
			"Create, update, or delete a virtual workspace file with optimistic concurrency version control (CAS).",
	},
);
export type FileWriteCommand = Static<typeof FileWriteCommandSchema>;

/**
 * Command to delete a virtual workspace file with optimistic concurrency version control.
 */
export const FileDeleteCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("file.delete", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{
				botId: Type.String({
					minLength: 1,
					description: "Bot identifier owning the file.",
				}),
				path: Type.String({
					minLength: 1,
					description: "Virtual workspace file path to delete.",
				}),
				expectedVersion: Type.Optional(
					Type.Number({
						description:
							"Expected current version for optimistic concurrency control (CAS). Delete fails if version does not match.",
					}),
				),
				version: Type.Optional(
					Type.Number({
						description: "Alias for expectedVersion.",
					}),
				),
			},
			{ description: "Parameters identifying the file to delete." },
		),
	},
	{
		description:
			"Delete a virtual workspace file with optimistic concurrency version verification.",
	},
);
export type FileDeleteCommand = Static<typeof FileDeleteCommandSchema>;

/**
 * Command to search across knowledge base documents for a bot using keyword matching.
 */
export const KnowledgeSearchCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("knowledge.search", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{
				botId: Type.String({
					minLength: 1,
					description: "Bot identifier whose knowledge documents to search.",
				}),
				query: Type.Optional(
					Type.String({
						description: "Keyword or substring search query.",
					}),
				),
				category: Type.Optional(
					Type.String({
						description: "Optional category filter tag.",
					}),
				),
			},
			{ description: "Parameters for searching knowledge documents." },
		),
	},
	{
		description:
			"Search across knowledge base documents for a bot using keyword and category filters.",
	},
);
export type KnowledgeSearchCommand = Static<
	typeof KnowledgeSearchCommandSchema
>;

/**
 * Command to create a scheduled task (recurring cron, relative delay timer, or absolute date/time) for a bot.
 */
export const ScheduleCreateCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("schedule.create", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{
				id: Type.Optional(
					Type.String({
						description:
							"Optional custom identifier for the schedule. Generated if omitted.",
					}),
				),
				botId: Type.String({
					minLength: 1,
					description:
						"Identifier of the bot that will execute the scheduled prompt.",
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
							"Schedule timing mode: 'relative', 'absolute', or 'cron'.",
					},
				),
				input: Type.Union([Type.String(), Type.Number()], {
					description:
						"Unified timing input interpreted according to kind: relative duration for 'relative' (e.g. '5s', '10m', 10), absolute date/time for 'absolute' (e.g. 'tomorrow at 5pm', ISO string, epoch ms), or cron pattern for 'cron' (e.g. '0 9 * * *', '@hourly').",
				}),
				text: Type.String({
					minLength: 1,
					description:
						"Prompt text delivered to the bot when the schedule triggers.",
				}),
				target: ScheduleTargetSchema,
				thinking: Type.Optional(ThinkingLevelSchema),
				enabled: Type.Optional(
					Type.Boolean({
						description:
							"Whether the schedule is initially active (defaults to true).",
					}),
				),
			},
			{ description: "Parameters for creating a scheduled task." },
		),
	},
	{
		description:
			"Create a scheduled task (recurring cron, relative delay timer, or absolute timestamp) for a bot.",
	},
);
export type ScheduleCreateCommand = Static<typeof ScheduleCreateCommandSchema>;

/**
 * Command to list scheduled tasks for a bot in the family.
 */
export const ScheduleListCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("schedule.list", {
			description: "Command type identifier.",
		}),
		payload: Type.Optional(
			Type.Object(
				{
					botId: Type.Optional(
						Type.String({
							description: "Optional bot identifier to filter schedules.",
						}),
					),
					includeInternal: Type.Optional(
						Type.Boolean({
							description:
								"Whether to include system-internal schedules (such as idle harvest timers).",
						}),
					),
				},
				{ description: "Filters for listing schedules." },
			),
		),
	},
	{
		description:
			"List scheduled tasks for a bot, optionally including internal idle harvest schedules.",
	},
);
export type ScheduleListCommand = Static<typeof ScheduleListCommandSchema>;

/**
 * Command to update an existing schedule's configuration, timing, prompt, or enabled status.
 */
export const ScheduleUpdateCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("schedule.update", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{
				id: Type.String({
					minLength: 1,
					description: "Identifier of the schedule to update.",
				}),
				name: Type.Optional(
					Type.String({
						description: "Optional updated label or description.",
					}),
				),
				kind: Type.Optional(
					Type.Union(
						[
							Type.Literal("relative", {
								description:
									"Update kind to relative duration strictly from now.",
							}),
							Type.Literal("absolute", {
								description: "Update kind to absolute date and time.",
							}),
							Type.Literal("cron", {
								description:
									"Update kind to recurring cron expression or nickname.",
							}),
						],
						{
							description:
								"Optional updated schedule kind ('relative', 'absolute', 'cron').",
						},
					),
				),
				input: Type.Optional(
					Type.Union([Type.String(), Type.Number()], {
						description:
							"Optional updated unified timing input interpreted according to kind.",
					}),
				),
				text: Type.Optional(
					Type.String({
						description: "Optional updated prompt text.",
					}),
				),
				target: Type.Optional(ScheduleTargetSchema),
				thinking: Type.Optional(ThinkingLevelSchema),
				enabled: Type.Optional(
					Type.Boolean({
						description:
							"Optional boolean to enable (true) or pause (false) the schedule.",
					}),
				),
			},
			{ description: "Parameters for updating a scheduled task." },
		),
	},
	{
		description:
			"Update an existing schedule's timing, prompt, destination chat, thinking budget, or enabled status.",
	},
);
export type ScheduleUpdateCommand = Static<typeof ScheduleUpdateCommandSchema>;

/**
 * Command to delete a scheduled task by ID.
 */
export const ScheduleDeleteCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("schedule.delete", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{
				id: Type.String({
					minLength: 1,
					description: "Identifier of the schedule to permanently delete.",
				}),
			},
			{ description: "Parameters identifying the schedule to delete." },
		),
	},
	{
		description: "Permanently delete a scheduled task by ID.",
	},
);
export type ScheduleDeleteCommand = Static<typeof ScheduleDeleteCommandSchema>;

/**
 * Discriminated union of all valid client-to-server protocol commands.
 */
export const ClientCommandSchema = Type.Union(
	[
		AccountGetCommandSchema,
		AccountUpdateCommandSchema,
		AccountMembersListCommandSchema,
		AccountMembersAddCommandSchema,
		AccountCredentialsListCommandSchema,
		AccountCredentialsSetCommandSchema,
		AccountCredentialsDeleteCommandSchema,
		AccountModelsListCommandSchema,
		AccountOAuthProvidersCommandSchema,
		AccountOAuthStartCommandSchema,
		AccountOAuthStatusCommandSchema,
		AccountOAuthSubmitCommandSchema,
		AccountOAuthCancelCommandSchema,
		FamilyListCommandSchema,
		FamilyCreateCommandSchema,
		FamilyGetCommandSchema,
		FamilyUpdateCommandSchema,
		FamilyDeleteCommandSchema,
		BotListCommandSchema,
		BotCreateCommandSchema,
		BotGetCommandSchema,
		BotUpdateCommandSchema,
		BotDeleteCommandSchema,
		ChatCreateCommandSchema,
		ChatListCommandSchema,
		ChatGetCommandSchema,
		ChatRenameCommandSchema,
		ChatCloseCommandSchema,
		ChatResetCommandSchema,
		ChatMessagesCommandSchema,
		ChatEntriesCommandSchema,
		ChatStatusCommandSchema,
		ChatSubscribeCommandSchema,
		TurnSubmitCommandSchema,
		TurnCommandCommandSchema,
		TurnSteerCommandSchema,
		TurnInterruptCommandSchema,
		TurnAbortCommandSchema,
		FileListCommandSchema,
		FileReadCommandSchema,
		FileWriteCommandSchema,
		FileDeleteCommandSchema,
		KnowledgeSearchCommandSchema,
		ScheduleCreateCommandSchema,
		ScheduleListCommandSchema,
		ScheduleUpdateCommandSchema,
		ScheduleDeleteCommandSchema,
		ChatUpdateCommandSchema,
		AccountToolsEnvsListCommandSchema,
		AccountToolsEnvsCreateCommandSchema,
		AccountToolsEnvsUpdateCommandSchema,
		AccountToolsEnvsDeleteCommandSchema,
		AccountToolsEnvSecretsListCommandSchema,
		AccountToolsEnvSecretsSetCommandSchema,
		AccountToolsEnvSecretsDeleteCommandSchema,
	],
	{
		description:
			"Complete discriminated union of all client-to-server commands in the Cadmus protocol.",
	},
);

/**
 * Strongly typed representation of any valid client command.
 */
export type ClientCommand = Static<typeof ClientCommandSchema>;

/**
 * Valid command type string names recognized by the protocol.
 */
export type CommandType = ClientCommand["type"];

const EDGE_COMMAND_TYPES = new Set<CommandType>([
	"account.get",
	"account.update",
	"account.members.list",
	"account.members.add",
	"account.credentials.list",
	"account.credentials.set",
	"account.credentials.delete",
	"account.models.list",
	"account.oauth.providers",
	"account.oauth.start",
	"account.oauth.status",
	"account.oauth.submit",
	"account.oauth.cancel",
	"family.list",
	"family.create",
	"family.delete",
]);

/**
 * Returns true if the command is handled exclusively at the Edge worker level without forwarding to a Durable Object.
 */
export function isEdgeOnlyCommand(type: CommandType): boolean {
	return EDGE_COMMAND_TYPES.has(type);
}

/**
 * Validates an unknown incoming payload against ClientCommandSchema.
 * Throws ProtocolValidationError with an informative message if validation fails.
 */
export function validateClientCommand(input: unknown): ClientCommand {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		throw new ProtocolValidationError(
			"Command must be a JSON object",
			"invalid_command",
		);
	}
	const record = input as Record<string, unknown>;
	if (typeof record.id !== "string" || record.id.trim().length === 0) {
		throw new ProtocolValidationError(
			"Command 'id' must be a non-empty string",
			"invalid_command",
		);
	}
	if (typeof record.type !== "string" || record.type.trim().length === 0) {
		throw new ProtocolValidationError(
			"Command 'type' must be a non-empty string",
			"invalid_command",
		);
	}
	if (!Value.Check(ClientCommandSchema, input)) {
		const errors = [...Value.Errors(ClientCommandSchema, input)];
		const first = errors[0];
		const detail = first
			? `${first.instancePath || "/"} ${first.message}`
			: "Schema validation failed";
		throw new ProtocolValidationError(
			`Invalid command '${record.type}': ${detail}`,
			"invalid_command",
		);
	}
	return input;
}
