import { type Static, Type } from "typebox";
import {
	AuthAssumeRoleCommandSchema,
	AuthLoginDeviceApproveCommandSchema,
	AuthLoginDeviceDenyCommandSchema,
	AuthLoginDevicePollCommandSchema,
	AuthLoginDeviceStartCommandSchema,
	AuthLoginDevPasswordCommandSchema,
	AuthLoginGoogleStartCommandSchema,
	AuthLoginProvidersCommandSchema,
	AuthSessionLogoutCommandSchema,
	AuthSessionRefreshCommandSchema,
} from "./login.js";
import {
	AccountOAuthCancelCommandSchema,
	AccountOAuthProvidersCommandSchema,
	AccountOAuthStartCommandSchema,
	AccountOAuthStatusCommandSchema,
	AccountOAuthSubmitCommandSchema,
} from "./oauth.js";
import {
	BotMetadataPatchSchema,
	BotMetadataSchema,
	ChatKindSchema,
	ConfinementPolicySchema,
	CredentialInputSchema,
	DeadlinesSchema,
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
		readOnly: true,
		grant: "members.read",
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
		grant: "account.manage",
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
		readOnly: true,
		grant: "members.read",
		description:
			"List all user members and their roles associated with the tenant account.",
	},
);
export type AccountMembersListCommand = Static<
	typeof AccountMembersListCommandSchema
>;

export const AccountMembersInviteCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("account.members.invite", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{
				email: Type.String({ minLength: 3, maxLength: 254 }),
				roles: Type.Optional(
					Type.Array(
						Type.Union([Type.Literal("user"), Type.Literal("account-admin")]),
						{
							minItems: 1,
							description:
								"Roles to give. Omitted means user only. account-admin is management of this account.",
						},
					),
				),
				ttlDays: Type.Optional(Type.Number({ minimum: 0.01, maximum: 60 })),
			},
			{ description: "Invite to create." },
		),
	},
	{
		grant: "members.manage",
		description:
			"Invite an email address. The invite is accepted on the first verified Google sign-in with that email.",
	},
);
export type AccountMembersInviteCommand = Static<
	typeof AccountMembersInviteCommandSchema
>;

export const AccountMembersUpdateCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("account.members.update", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{
				userId: Type.String({ minLength: 1 }),
				op: Type.Union([Type.Literal("grant"), Type.Literal("revoke")], {
					description: "Add or remove this one role. Other roles stay.",
				}),
				role: Type.Union(
					[Type.Literal("user"), Type.Literal("account-admin")],
					{
						description: "Role to grant or revoke: user or account-admin.",
					},
				),
			},
			{ description: "Member and the role to grant or revoke." },
		),
	},
	{
		grant: "members.manage",
		description:
			"Grant or revoke one role. Revoking account-admin revokes their personal tokens. The last account-admin and the member's last role cannot be revoked.",
	},
);
export type AccountMembersUpdateCommand = Static<
	typeof AccountMembersUpdateCommandSchema
>;

export const AccountMembersRemoveCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("account.members.remove", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{ userId: Type.String({ minLength: 1 }) },
			{ description: "Member to remove." },
		),
	},
	{
		grant: "members.manage",
		description:
			"Remove a member from the account. Revokes their sessions and personal tokens; the last account-admin cannot be removed.",
	},
);
export type AccountMembersRemoveCommand = Static<
	typeof AccountMembersRemoveCommandSchema
>;

export const AccountInvitesListCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("account.invites.list", {
			description: "Command type identifier.",
		}),
		payload: Type.Optional(
			Type.Object({}, { description: "Empty parameter payload." }),
		),
	},
	{
		readOnly: true,
		grant: "members.manage",
		description: "List the account's invites.",
	},
);
export type AccountInvitesListCommand = Static<
	typeof AccountInvitesListCommandSchema
>;

export const AccountAuditListCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("account.audit.list", {
			description: "Command type identifier.",
		}),
		payload: Type.Optional(
			Type.Object(
				{
					limit: Type.Optional(
						Type.Number({
							minimum: 1,
							maximum: 200,
							description: "Page size.",
						}),
					),
					before: Type.Optional(
						Type.Number({
							description:
								"Page cursor: epoch ms of the last event of the previous page.",
						}),
					),
					beforeId: Type.Optional(
						Type.String({
							description:
								"Page cursor: id of the last event of the previous page. Needed with before so events at the same millisecond are not skipped.",
						}),
					),
				},
				{ description: "Command parameters." },
			),
		),
	},
	{
		readOnly: true,
		grant: "audit.read",
		description:
			"List this account's audit events, newest first. Only rows kept in the caller's own account are returned, including membership changes a super-admin made inside it. Rows kept in the system scope are not included, even when they are about this account.",
	},
);
export type AccountAuditListCommand = Static<
	typeof AccountAuditListCommandSchema
>;

export const AccountInvitesRevokeCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("account.invites.revoke", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{ inviteId: Type.String({ minLength: 1 }) },
			{ description: "Invite to revoke." },
		),
	},
	{
		grant: "members.manage",
		description: "Revoke a pending invite.",
	},
);
export type AccountInvitesRevokeCommand = Static<
	typeof AccountInvitesRevokeCommandSchema
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
		readOnly: true,
		grant: "credentials.read",
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
		grant: "credentials.manage",
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
		grant: "credentials.manage",
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
		readOnly: true,
		grant: "bot.read",
		description:
			"List supported LLM models and their capabilities, optionally filtered by provider or authentication status.",
	},
);
export type AccountModelsListCommand = Static<
	typeof AccountModelsListCommandSchema
>;

/**
 * Command to read the principal the edge authenticated for this request.
 */
export const AuthWhoamiCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("auth.whoami", {
			description: "Command type identifier.",
		}),
		payload: Type.Optional(
			Type.Object({}, { description: "Empty parameter payload." }),
		),
	},
	{
		readOnly: true,
		grant: "tokens.self",
		description:
			"Return the authenticated principal (credential kind, user, account and role) that the server resolved for this request.",
	},
);
export type AuthWhoamiCommand = Static<typeof AuthWhoamiCommandSchema>;

export const AuthTicketCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("auth.ticket", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{
				target: Type.Union([Type.Literal("ws"), Type.Literal("events")], {
					description: "Stream the ticket is for.",
				}),
			},
			{ description: "Ticket request." },
		),
	},
	{
		// The streams carry live chat text and state, which chat.use guards. A
		// scoped token needs chat.use, not tokens.self, to open its own stream.
		grant: "chat.use",
		description:
			"Issue a single-use ticket (60 seconds) for opening the WebSocket or SSE events stream for this session.",
	},
);
export type AuthTicketCommand = Static<typeof AuthTicketCommandSchema>;

export const AuthSessionsListCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("auth.sessions.list", {
			description: "Command type identifier.",
		}),
		payload: Type.Optional(
			Type.Object({}, { description: "Empty parameter payload." }),
		),
	},
	{
		readOnly: true,
		grant: "tokens.self",
		description:
			"List the caller's active sessions with login method or token, user agent, IP country, created and last used.",
	},
);
export type AuthSessionsListCommand = Static<
	typeof AuthSessionsListCommandSchema
>;

export const AuthSessionsRevokeCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("auth.sessions.revoke", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{
				sessionId: Type.String({
					minLength: 1,
					description: "Session to revoke.",
				}),
			},
			{ description: "Session to revoke." },
		),
	},
	{
		grant: "tokens.self",
		description: "Revoke one of the caller's own sessions.",
	},
);
export type AuthSessionsRevokeCommand = Static<
	typeof AuthSessionsRevokeCommandSchema
>;

export const AuthSessionsRevokeOthersCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("auth.sessions.revokeOthers", {
			description: "Command type identifier.",
		}),
		payload: Type.Optional(
			Type.Object({}, { description: "Empty parameter payload." }),
		),
	},
	{
		grant: "tokens.self",
		description: "Revoke every session of the caller except the current one.",
	},
);
export type AuthSessionsRevokeOthersCommand = Static<
	typeof AuthSessionsRevokeOthersCommandSchema
>;

export const AuthElevateCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("auth.elevate", {
			description: "Command type identifier.",
		}),
		payload: Type.Optional(
			Type.Object({}, { description: "Empty parameter payload." }),
		),
	},
	{
		grant: "admin.elevate",
		description:
			"Turn on admin mode for the caller's session for 15 minutes. Needs a signed-in session of an account-admin or super-admin.",
	},
);
export type AuthElevateCommand = Static<typeof AuthElevateCommandSchema>;

export const AuthElevationEndCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("auth.elevation.end", {
			description: "Command type identifier.",
		}),
		payload: Type.Optional(
			Type.Object({}, { description: "Empty parameter payload." }),
		),
	},
	{
		grant: "admin.elevate",
		description: "Leave admin mode on the caller's session.",
	},
);
export type AuthElevationEndCommand = Static<
	typeof AuthElevationEndCommandSchema
>;

export const AuthMethodsListCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("auth.methods.list", {
			description: "Command type identifier.",
		}),
		payload: Type.Optional(
			Type.Object({}, { description: "Empty parameter payload." }),
		),
	},
	{
		readOnly: true,
		grant: "tokens.self",
		description: "List the caller's login methods.",
	},
);
export type AuthMethodsListCommand = Static<
	typeof AuthMethodsListCommandSchema
>;

export const AuthMembershipsListCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("auth.memberships.list", {
			description: "Command type identifier.",
		}),
		payload: Type.Optional(
			Type.Object({}, { description: "Empty parameter payload." }),
		),
	},
	{
		readOnly: true,
		grant: "tokens.self",
		description: "List the active accounts the caller is a member of.",
	},
);
export type AuthMembershipsListCommand = Static<
	typeof AuthMembershipsListCommandSchema
>;

export const AuthMethodsDeleteCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("auth.methods.delete", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{
				methodId: Type.String({
					minLength: 1,
					description: "Login method to delete.",
				}),
			},
			{ description: "Login method to delete." },
		),
	},
	{
		grant: "tokens.self",
		description:
			"Delete one of the caller's login methods and the sessions opened through it. Refuses the last active method (last_login_method). Does not remove the user or any email row.",
	},
);
export type AuthMethodsDeleteCommand = Static<
	typeof AuthMethodsDeleteCommandSchema
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
		readOnly: true,
		grant: "bot.read",
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
		grant: "family.manage",
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
		readOnly: true,
		grant: "bot.read",
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
				teamLeaderBotId: Type.Optional(
					Type.Union([Type.String({ minLength: 1 }), Type.Null()], {
						description:
							"Team Leader bot id. A non-empty string sets it to a bot in this family, null clears it, and omitting it leaves the current value unchanged.",
					}),
				),
			},
			{
				description:
					"Parameters for updating bot family configuration, including the optional Team Leader bot id.",
			},
		),
	},
	{
		grant: "family.manage",
		description:
			"Update bot family settings including display name, timezone, idle harvest delay, or Team Leader bot.",
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
		grant: "family.manage",
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
		readOnly: true,
		grant: "bot.read",
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
				timezone: Type.Optional(
					Type.String({
						minLength: 1,
						description:
							"Optional IANA timezone identifier for this bot (defaults to the family timezone when omitted).",
					}),
				),
				metadata: Type.Optional(BotMetadataSchema),
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
			{
				description:
					"Parameters for creating a new bot persona, including optional timezone and metadata.",
			},
		),
	},
	{
		grant: "bot.write",
		description:
			"Create a new bot persona with default model, thinking budget, tool access, optional timezone and metadata, and initial virtual workspace files.",
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
		readOnly: true,
		grant: "bot.read",
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
								"Omit to leave the stored allowlist unchanged. Null clears it back to the default set (Cadmus tools allowed, coding tools opt-in). An array replaces it. An empty array allows no gated tools.",
						},
					),
				),
				soul: Type.Optional(
					Type.String({
						description: "Optional updated SOUL.md system prompt content.",
					}),
				),
				toolsEnv: Type.Optional(ToolsEnvSettingSchema),
				timezone: Type.Optional(
					Type.String({
						minLength: 1,
						description:
							"Optional updated IANA timezone identifier for cron schedules and time context.",
					}),
				),
				metadata: Type.Optional(BotMetadataPatchSchema),
			},
			{
				description:
					"Parameters for updating bot configuration. `metadata` is a patch: string values set keys, `null` deletes them.",
			},
		),
	},
	{
		grant: "bot.write",
		description:
			"Update an existing bot's model, thinking budget, tool access, display name, soul, timezone, or metadata.",
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
		grant: "bot.delete",
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
				harvest: Type.Optional(
					Type.Boolean({
						description:
							"Idle harvest switch for this chat. Omitted or true arms harvest after turns. False leaves harvest off. Group-chat sessions are created off.",
					}),
				),
				kind: Type.Optional(
					Type.Union([Type.Literal("direct"), Type.Literal("scheduled")], {
						description: "Kind of chat to create. Defaults to 'direct'.",
					}),
				),
			},
			{ description: "Parameters for creating a new chat session." },
		),
	},
	{
		grant: "chat.use",
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
					kinds: Type.Optional(
						Type.Array(ChatKindSchema, {
							description:
								"Kinds of chat sessions to include. Defaults to ['direct'] (user-created chats).",
						}),
					),
					includeDeleted: Type.Optional(
						Type.Boolean({
							description:
								"Whether to include soft-deleted chat sessions. Defaults to false.",
						}),
					),
				},
				{ description: "Filters for listing chat sessions." },
			),
		),
	},
	{
		readOnly: true,
		grant: "chat.use",
		description:
			"List chat conversation sessions in this bot family, optionally filtered by botId and kinds.",
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
		readOnly: true,
		grant: "chat.use",
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
				toolsEnv: Type.Optional(ToolsEnvSettingSchema),
				harvest: Type.Optional(
					Type.Boolean({
						description:
							"Set the per-chat idle harvest switch. Omitted leaves it unchanged.",
					}),
				),
				deadlines: Type.Optional(
					Type.Union([
						DeadlinesSchema,
						Type.Null({
							description:
								"Clear per-chat deadline overrides and restore kind defaults.",
						}),
					]),
				),
			},
			{ additionalProperties: false },
		),
	},
	{
		grant: "chat.use",
		description:
			"Update a chat's tools env setting, per-chat harvest switch, or deadline overrides. deadlines null resets overrides. 0 on a field means no limit.",
	},
);
export type ChatUpdateCommand = Static<typeof ChatUpdateCommandSchema>;

export const ChatTasksListCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("chat.tasks.list", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{
				chatKey: Type.String({
					minLength: 1,
					description: "Unique routing key of the chat session.",
				}),
			},
			{ additionalProperties: false },
		),
	},
	{
		readOnly: true,
		grant: "chat.use",
		description: "List tasks for a chat, including details and summaries.",
	},
);
export type ChatTasksListCommand = Static<typeof ChatTasksListCommandSchema>;

export const ChatTasksGetCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("chat.tasks.get", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{
				chatKey: Type.String({
					minLength: 1,
					description: "Unique routing key of the chat session.",
				}),
				index: Type.Integer({
					minimum: 1,
					description: "Per-chat task index.",
				}),
			},
			{ additionalProperties: false },
		),
	},
	{
		readOnly: true,
		grant: "chat.use",
		description: "Get one chat task by index, including details and summary.",
	},
);
export type ChatTasksGetCommand = Static<typeof ChatTasksGetCommandSchema>;

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
		readOnly: true,
		grant: "toolsEnv.read",
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
				confinementPolicy: Type.Optional(ConfinementPolicySchema),
				sharedWorkspace: Type.Optional(Type.Boolean()),
				baseUrl: Type.Optional(Type.String()),
			},
			{ additionalProperties: false },
		),
	},
	{
		grant: "toolsEnv.manage",
		description:
			"Create a just-bash or local-daemon tools env definition. Daemon rows require confineToWorkspace or confinementPolicy. The workspace path is reported by the daemon process.",
	},
);
export type AccountToolsEnvsCreateCommand = Static<
	typeof AccountToolsEnvsCreateCommandSchema
>;

export const AccountToolsEnvsPairCommandSchema = Type.Object(
	{
		id: Type.String({ minLength: 1 }),
		type: Type.Literal("account.toolsEnvs.pair"),
		payload: Type.Object(
			{
				envId: Type.String({ minLength: 1 }),
				baseUrl: Type.Optional(Type.String()),
			},
			{ additionalProperties: false },
		),
	},
	{
		grant: "toolsEnv.manage",
		description:
			"Mint a 15-minute single-use pairing token for a local-daemon env.",
	},
);
export type AccountToolsEnvsPairCommand = Static<
	typeof AccountToolsEnvsPairCommandSchema
>;

export const AccountToolsEnvsDeregisterCommandSchema = Type.Object(
	{
		id: Type.String({ minLength: 1 }),
		type: Type.Literal("account.toolsEnvs.deregister"),
		payload: Type.Object(
			{
				envId: Type.String({ minLength: 1 }),
			},
			{ additionalProperties: false },
		),
	},
	{
		grant: "toolsEnv.manage",
		description:
			"Deregister a tools env. Every kind is removed the same way as delete: env state is wiped, the account row is dropped, and the account default is cleared when it pointed at this env. A local-daemon env first has its pairing revoked and any live connection closed.",
	},
);
export type AccountToolsEnvsDeregisterCommand = Static<
	typeof AccountToolsEnvsDeregisterCommandSchema
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
				confinementPolicy: Type.Optional(ConfinementPolicySchema),
				sharedWorkspace: Type.Optional(Type.Boolean()),
			},
			{ additionalProperties: false },
		),
	},
	{
		grant: "toolsEnv.manage",
		description: "Update a tools env definition. Kind is immutable.",
	},
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
	{
		grant: "toolsEnv.manage",
		description: "Delete a tools env definition and its env DO data.",
	},
);
export type AccountToolsEnvsDeleteCommand = Static<
	typeof AccountToolsEnvsDeleteCommandSchema
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
		grant: "chat.use",
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
		grant: "chat.use",
		description: "Close and archive a chat conversation session.",
	},
);
export type ChatCloseCommand = Static<typeof ChatCloseCommandSchema>;

/**
 * Command to soft-delete a chat session, preserving its history and token costs.
 */
export const ChatDeleteCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("chat.delete", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{
				chatKey: Type.String({
					minLength: 1,
					description: "Chat routing key to soft-delete.",
				}),
			},
			{ description: "Parameters identifying the chat session to delete." },
		),
	},
	{
		grant: "chat.use",
		description:
			"Soft-delete a chat conversation session, preserving conversation history and bot token/cost accounting.",
	},
);
export type ChatDeleteCommand = Static<typeof ChatDeleteCommandSchema>;

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
		grant: "chat.use",
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
		readOnly: true,
		grant: "chat.use",
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
		readOnly: true,
		grant: "chat.use",
		description:
			"Fetch the underlying durable transcript entries (including tool calls and state records) for a chat session.",
	},
);
export type ChatEntriesCommand = Static<typeof ChatEntriesCommandSchema>;

/**
 * Command to retrieve live runtime status for a chat (busy state, active model, thinking budget, tool access, usage, and next scheduled alarm).
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
		readOnly: true,
		grant: "chat.use",
		description:
			"Fetch live runtime execution status for a chat session without invoking the model or modifying history.",
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
		grant: "chat.use",
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
		grant: "chat.use",
		description:
			"Submit a user message turn to a chat session, initiating model reasoning, tool calling, and response generation.",
	},
);
export type TurnSubmitCommand = Static<typeof TurnSubmitCommandSchema>;

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
		grant: "chat.use",
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
		grant: "chat.use",
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
		grant: "chat.use",
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
		readOnly: true,
		grant: "bot.read",
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
		readOnly: true,
		grant: "bot.read",
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
		grant: "files.write",
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
		grant: "files.write",
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
		readOnly: true,
		grant: "bot.read",
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
		grant: "schedule.write",
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
		readOnly: true,
		grant: "bot.read",
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
		grant: "schedule.write",
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
		grant: "schedule.write",
		description: "Permanently delete a scheduled task by ID.",
	},
);
export type ScheduleDeleteCommand = Static<typeof ScheduleDeleteCommandSchema>;

/**
 * Discriminated union of all valid client-to-server protocol commands.
 */
export const SystemAccountsListCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("system.accounts.list", {
			description: "Command type identifier.",
		}),
		payload: Type.Optional(
			Type.Object({}, { description: "Empty parameter payload." }),
		),
	},
	{
		readOnly: true,
		grant: "system.accounts.read",
		description:
			"List every tenant account with its status and member count. Super-admin only. Account records only, never tenant data.",
	},
);
export type SystemAccountsListCommand = Static<
	typeof SystemAccountsListCommandSchema
>;

export const SystemAccountsCreateCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("system.accounts.create", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{
				name: Type.String({
					minLength: 1,
					maxLength: 80,
					description: "Display name of the new account.",
				}),
				timezone: Type.Optional(
					Type.String({ description: "IANA timezone for the account." }),
				),
				ownerEmail: Type.String({
					minLength: 3,
					description:
						"Email of the account owner. A new address creates a user with a primary email and no login method. An address that already belongs to a user reuses that user.",
				}),
			},
			{ description: "Command parameters." },
		),
	},
	{
		grant: "system.accounts.manage",
		description:
			"Create a tenant account and an account-admin membership for ownerEmail. Needs admin mode. Does not create a login method or a session.",
	},
);
export type SystemAccountsCreateCommand = Static<
	typeof SystemAccountsCreateCommandSchema
>;

export const SystemAccountsSuspendCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("system.accounts.suspend", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{
				accountId: Type.String({
					minLength: 1,
					description: "Tenant account to suspend.",
				}),
			},
			{ description: "Command parameters." },
		),
	},
	{
		grant: "system.accounts.manage",
		description:
			"Suspend a tenant account. Its principals are refused and live sockets are closed. Needs admin mode.",
	},
);
export type SystemAccountsSuspendCommand = Static<
	typeof SystemAccountsSuspendCommandSchema
>;

export const SystemAccountsResumeCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("system.accounts.resume", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{
				accountId: Type.String({
					minLength: 1,
					description: "Tenant account to resume.",
				}),
			},
			{ description: "Command parameters." },
		),
	},
	{
		grant: "system.accounts.manage",
		description: "Resume a suspended tenant account. Needs admin mode.",
	},
);
export type SystemAccountsResumeCommand = Static<
	typeof SystemAccountsResumeCommandSchema
>;

export const SystemAccountsRenameCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("system.accounts.rename", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{
				accountId: Type.String({
					minLength: 1,
					description: "Tenant account to rename.",
				}),
				name: Type.String({
					minLength: 1,
					maxLength: 80,
					description: "New display name.",
				}),
			},
			{ description: "Command parameters." },
		),
	},
	{
		grant: "system.accounts.manage",
		description: "Rename a tenant account. Needs admin mode.",
	},
);
export type SystemAccountsRenameCommand = Static<
	typeof SystemAccountsRenameCommandSchema
>;

export const SystemAuditListCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("system.audit.list", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{
				limit: Type.Optional(
					Type.Number({ minimum: 1, maximum: 200, description: "Page size." }),
				),
				accountId: Type.Optional(
					Type.String({
						description: "Only events about this tenant account.",
					}),
				),
				before: Type.Optional(
					Type.Number({
						description:
							"Page cursor: epoch ms of the last event of the previous page.",
					}),
				),
				beforeId: Type.Optional(
					Type.String({
						description:
							"Page cursor: id of the last event of the previous page. Needed with before so events at the same millisecond are not skipped.",
					}),
				),
			},
			{ description: "Command parameters." },
		),
	},
	{
		readOnly: true,
		grant: "system.audit.read",
		description:
			"List system-scope audit events (account changes made by super-admins), newest first. Also includes membership changes a super-admin made inside a tenant (actor kind super-admin); ordinary tenant audit rows are not included.",
	},
);
export type SystemAuditListCommand = Static<
	typeof SystemAuditListCommandSchema
>;

export const SystemMembersListCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("system.members.list", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{
				accountId: Type.String({
					minLength: 1,
					description: "Tenant account the change is about.",
				}),
			},
			{ description: "Command parameters." },
		),
	},
	{
		readOnly: true,
		grant: "system.members.manage",
		description:
			"List the members of one tenant account with their identity and disabled state. Needs admin mode. Membership data only, never tenant data.",
	},
);
export type SystemMembersListCommand = Static<
	typeof SystemMembersListCommandSchema
>;

export const SystemMembersInviteCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("system.members.invite", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{
				accountId: Type.String({
					minLength: 1,
					description: "Tenant account the change is about.",
				}),
				email: Type.String({ minLength: 3, maxLength: 254 }),
				roles: Type.Optional(
					Type.Array(
						Type.Union([Type.Literal("user"), Type.Literal("account-admin")]),
						{
							minItems: 1,
							description: "Roles to give. Omitted means user only.",
						},
					),
				),
				ttlDays: Type.Optional(Type.Number({ minimum: 0.01, maximum: 60 })),
			},
			{ description: "Command parameters." },
		),
	},
	{
		grant: "system.members.manage",
		description:
			"Invite an email address to a tenant account, for example to assign its first account-admin. Needs admin mode.",
	},
);
export type SystemMembersInviteCommand = Static<
	typeof SystemMembersInviteCommandSchema
>;

export const SystemMembersUpdateCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("system.members.update", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{
				accountId: Type.String({
					minLength: 1,
					description: "Tenant account the change is about.",
				}),
				userId: Type.String({ minLength: 1, description: "Target user." }),
				op: Type.Union([Type.Literal("grant"), Type.Literal("revoke")], {
					description: "Add or remove this one role. Other roles stay.",
				}),
				role: Type.Union(
					[Type.Literal("user"), Type.Literal("account-admin")],
					{
						description: "Role to grant or revoke: user or account-admin.",
					},
				),
			},
			{ description: "Command parameters." },
		),
	},
	{
		grant: "system.members.manage",
		description:
			"Grant or revoke one tenant role. The last account-admin and the member's last role cannot be revoked. Needs admin mode.",
	},
);
export type SystemMembersUpdateCommand = Static<
	typeof SystemMembersUpdateCommandSchema
>;

export const SystemMembersRemoveCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("system.members.remove", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{
				accountId: Type.String({
					minLength: 1,
					description: "Tenant account the change is about.",
				}),
				userId: Type.String({ minLength: 1, description: "Target user." }),
			},
			{ description: "Command parameters." },
		),
	},
	{
		grant: "system.members.manage",
		description:
			"Remove a member from a tenant account. The last account-admin cannot be removed. Needs admin mode.",
	},
);
export type SystemMembersRemoveCommand = Static<
	typeof SystemMembersRemoveCommandSchema
>;

export const SystemUsersDisableCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("system.users.disable", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{ userId: Type.String({ minLength: 1, description: "Target user." }) },
			{ description: "Command parameters." },
		),
	},
	{
		grant: "system.users.manage",
		description:
			"Disable a user in every account. Their sessions are refused and live sockets close. Super-admins cannot be disabled here, and you cannot disable yourself. Needs admin mode.",
	},
);
export type SystemUsersDisableCommand = Static<
	typeof SystemUsersDisableCommandSchema
>;

export const SystemUsersEnableCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("system.users.enable", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{ userId: Type.String({ minLength: 1, description: "Target user." }) },
			{ description: "Command parameters." },
		),
	},
	{
		grant: "system.users.manage",
		description: "Enable a disabled user again. Needs admin mode.",
	},
);
export type SystemUsersEnableCommand = Static<
	typeof SystemUsersEnableCommandSchema
>;

export const SystemUsersRevokeSessionsCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("system.users.revokeSessions", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{ userId: Type.String({ minLength: 1, description: "Target user." }) },
			{ description: "Command parameters." },
		),
	},
	{
		grant: "system.users.manage",
		description: "Revoke every live session of a user. Needs admin mode.",
	},
);
export type SystemUsersRevokeSessionsCommand = Static<
	typeof SystemUsersRevokeSessionsCommandSchema
>;

export const ClientCommandSchema = Type.Union(
	[
		AccountGetCommandSchema,
		AccountUpdateCommandSchema,
		AccountMembersListCommandSchema,
		AccountMembersInviteCommandSchema,
		AccountMembersUpdateCommandSchema,
		AccountMembersRemoveCommandSchema,
		AccountInvitesListCommandSchema,
		AccountAuditListCommandSchema,
		AccountInvitesRevokeCommandSchema,
		AccountCredentialsListCommandSchema,
		AccountCredentialsSetCommandSchema,
		AccountCredentialsDeleteCommandSchema,
		AccountModelsListCommandSchema,
		AccountOAuthProvidersCommandSchema,
		AccountOAuthStartCommandSchema,
		AccountOAuthStatusCommandSchema,
		AccountOAuthSubmitCommandSchema,
		AccountOAuthCancelCommandSchema,
		AuthWhoamiCommandSchema,
		AuthTicketCommandSchema,
		AuthSessionsListCommandSchema,
		AuthSessionsRevokeCommandSchema,
		AuthSessionsRevokeOthersCommandSchema,
		AuthElevateCommandSchema,
		AuthElevationEndCommandSchema,
		SystemAccountsListCommandSchema,
		SystemAccountsCreateCommandSchema,
		SystemAccountsSuspendCommandSchema,
		SystemAccountsResumeCommandSchema,
		SystemAccountsRenameCommandSchema,
		SystemAuditListCommandSchema,
		SystemMembersListCommandSchema,
		SystemMembersInviteCommandSchema,
		SystemMembersUpdateCommandSchema,
		SystemMembersRemoveCommandSchema,
		SystemUsersDisableCommandSchema,
		SystemUsersEnableCommandSchema,
		SystemUsersRevokeSessionsCommandSchema,
		AuthMethodsListCommandSchema,
		AuthMembershipsListCommandSchema,
		AuthMethodsDeleteCommandSchema,
		AuthLoginProvidersCommandSchema,
		AuthAssumeRoleCommandSchema,
		AuthLoginDevPasswordCommandSchema,
		AuthLoginGoogleStartCommandSchema,
		AuthLoginDeviceStartCommandSchema,
		AuthLoginDevicePollCommandSchema,
		AuthLoginDeviceApproveCommandSchema,
		AuthLoginDeviceDenyCommandSchema,
		AuthSessionRefreshCommandSchema,
		AuthSessionLogoutCommandSchema,
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
		ChatDeleteCommandSchema,
		ChatResetCommandSchema,
		ChatMessagesCommandSchema,
		ChatEntriesCommandSchema,
		ChatStatusCommandSchema,
		ChatSubscribeCommandSchema,
		TurnSubmitCommandSchema,
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
		ChatTasksListCommandSchema,
		ChatTasksGetCommandSchema,
		AccountToolsEnvsListCommandSchema,
		AccountToolsEnvsCreateCommandSchema,
		AccountToolsEnvsUpdateCommandSchema,
		AccountToolsEnvsDeleteCommandSchema,
		AccountToolsEnvsPairCommandSchema,
		AccountToolsEnvsDeregisterCommandSchema,
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
