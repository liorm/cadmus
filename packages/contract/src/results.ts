import { type Static, Type } from "typebox";
import {
	AccountMemberSchema,
	AccountRecordSchema,
	BotRecordSchema,
	ChatRecordSchema,
	ChatTaskLoopSchema,
	ChatTaskSchema,
	ConfinementPolicySchema,
	CredentialSummarySchema,
	EffectiveToolsEnvSchema,
	FamilyRecordSchema,
	HarvestNoteSchema,
	ModelInfoSchema,
	RawTranscriptEntrySchema,
	ScheduleRecordSchema,
	ThinkingLevelSchema,
	TranscriptMessageViewSchema,
	TurnBlockSchema,
	UsageSummarySchema,
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
export const AccountMembersInviteResultSchema = Type.Object(
	{
		invite: Type.Object(
			{
				id: Type.String(),
				email: Type.String(),
				roles: Type.Array(Type.String()),
				invitedBy: Type.Union([Type.String(), Type.Null()]),
				createdAt: Type.Number(),
				expiresAt: Type.Number(),
				acceptedAt: Type.Union([Type.Number(), Type.Null()]),
				revokedAt: Type.Union([Type.Number(), Type.Null()]),
			},
			{ description: "One invite." },
		),
	},
	{ description: "Result payload returned by account.members.invite." },
);
export type AccountMembersInviteResult = Static<
	typeof AccountMembersInviteResultSchema
>;

export const AccountMembersUpdateResultSchema = Type.Object(
	{ updated: Type.Boolean(), tokensRevoked: Type.Number() },
	{ description: "Result payload returned by account.members.update." },
);
export type AccountMembersUpdateResult = Static<
	typeof AccountMembersUpdateResultSchema
>;

export const AccountMembersRemoveResultSchema = Type.Object(
	{
		removed: Type.Boolean(),
		tokensRevoked: Type.Number(),
		sessionsRevoked: Type.Number(),
	},
	{ description: "Result payload returned by account.members.remove." },
);
export type AccountMembersRemoveResult = Static<
	typeof AccountMembersRemoveResultSchema
>;

export const AccountInvitesListResultSchema = Type.Object(
	{
		invites: Type.Array(
			Type.Object(
				{
					id: Type.String(),
					email: Type.String(),
					roles: Type.Array(Type.String()),
					invitedBy: Type.Union([Type.String(), Type.Null()]),
					createdAt: Type.Number(),
					expiresAt: Type.Number(),
					acceptedAt: Type.Union([Type.Number(), Type.Null()]),
					revokedAt: Type.Union([Type.Number(), Type.Null()]),
				},
				{ description: "One invite." },
			),
		),
	},
	{ description: "Result payload returned by account.invites.list." },
);
export type AccountInvitesListResult = Static<
	typeof AccountInvitesListResultSchema
>;

export const AccountInvitesRevokeResultSchema = Type.Object(
	{ revoked: Type.Boolean() },
	{ description: "Result payload returned by account.invites.revoke." },
);
export type AccountInvitesRevokeResult = Static<
	typeof AccountInvitesRevokeResultSchema
>;

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
 * Result returned by auth.whoami: the principal resolved at the edge.
 */
export const AuthWhoamiResultSchema = Type.Object(
	{
		principal: Type.Object(
			{
				kind: Type.Union(
					[Type.Literal("user"), Type.Literal("token"), Type.Literal("daemon")],
					{ description: "Credential kind that authenticated the request." },
				),
				userId: Type.Optional(
					Type.String({ description: "Authenticated user id, when known." }),
				),
				name: Type.Optional(
					Type.String({
						description:
							"Display name from the user record. Absent for credentials with no user row.",
					}),
				),
				email: Type.Optional(
					Type.String({
						description:
							"Primary email from the user record. Absent when the user has none.",
					}),
				),
				accountId: Type.String({ description: "Account the request acts in." }),
				viaToken: Type.Optional(
					Type.Boolean({
						description:
							"True when the session was opened by an API token. Such sessions cannot enter admin mode.",
					}),
				),
				elevatedUntil: Type.Optional(
					Type.Number({
						description:
							"Epoch ms when admin mode on this session ends. Absent when it is off.",
					}),
				),
				role: Type.Union(
					[
						Type.Literal("user"),
						Type.Literal("account-admin"),
						Type.Literal("super-admin"),
					],
					{
						description: "Session hat. Grants and the shell follow this role.",
					},
				),
				provisional: Type.Optional(
					Type.Boolean({
						description:
							"True when this sign-in is the short role-choice session. Assume a role to open a full session.",
					}),
				),
			},
			{ description: "Resolved principal." },
		),
	},
	{ description: "Result payload returned by auth.whoami." },
);
export type AuthWhoamiResult = Static<typeof AuthWhoamiResultSchema>;

export const AuthTicketResultSchema = Type.Object(
	{
		ticket: Type.String({
			description: "Single-use ticket. Send it as the ticket query parameter.",
		}),
		expiresAt: Type.Number({
			description: "Epoch ms when the ticket expires.",
		}),
	},
	{ description: "Result payload returned by auth.ticket." },
);
export type AuthTicketResult = Static<typeof AuthTicketResultSchema>;

export const AuthSessionsListResultSchema = Type.Object(
	{
		sessions: Type.Array(
			Type.Object(
				{
					id: Type.String(),
					accountId: Type.String(),
					current: Type.Boolean(),
					loginMethod: Type.Optional(
						Type.String({ description: "Login method provider, e.g. google." }),
					),
					tokenId: Type.Optional(Type.String()),
					userAgent: Type.Optional(Type.String()),
					ipCountry: Type.Optional(Type.String()),
					createdAt: Type.Number(),
					lastUsedAt: Type.Number(),
				},
				{ description: "One active session." },
			),
		),
	},
	{ description: "Result payload returned by auth.sessions.list." },
);
export type AuthSessionsListResult = Static<
	typeof AuthSessionsListResultSchema
>;

export const AuthSessionsRevokeResultSchema = Type.Object(
	{
		revoked: Type.Boolean({
			description: "True when the session was active and is now revoked.",
		}),
	},
	{ description: "Result payload returned by auth.sessions.revoke." },
);
export type AuthSessionsRevokeResult = Static<
	typeof AuthSessionsRevokeResultSchema
>;

export const SystemAccountSummarySchema = Type.Object(
	{
		id: Type.String({ description: "Tenant account id." }),
		name: Type.String({ description: "Display name." }),
		timezone: Type.String({ description: "IANA timezone." }),
		createdAt: Type.Number({ description: "Epoch ms of creation." }),
		status: Type.Union([Type.Literal("active"), Type.Literal("suspended")], {
			description: "Whether the account accepts sign-ins and commands.",
		}),
		suspendedAt: Type.Optional(
			Type.Number({ description: "Epoch ms when it was suspended." }),
		),
		memberCount: Type.Number({ description: "Number of members." }),
	},
	{ description: "A tenant account as the system console sees it." },
);
export type SystemAccountSummary = Static<typeof SystemAccountSummarySchema>;

export const SystemAccountsListResultSchema = Type.Object(
	{ accounts: Type.Array(SystemAccountSummarySchema) },
	{ description: "Result payload returned by system.accounts.list." },
);
export type SystemAccountsListResult = Static<
	typeof SystemAccountsListResultSchema
>;

export const SystemAccountsCreateResultSchema = Type.Object(
	{ account: SystemAccountSummarySchema },
	{ description: "Result payload returned by system.accounts.create." },
);
export type SystemAccountsCreateResult = Static<
	typeof SystemAccountsCreateResultSchema
>;

export const SystemAccountsSuspendResultSchema = Type.Object(
	{
		account: SystemAccountSummarySchema,
		changed: Type.Boolean({
			description: "False when the account was already suspended.",
		}),
	},
	{ description: "Result payload returned by system.accounts.suspend." },
);
export type SystemAccountsSuspendResult = Static<
	typeof SystemAccountsSuspendResultSchema
>;

export const SystemAccountsResumeResultSchema = Type.Object(
	{
		account: SystemAccountSummarySchema,
		changed: Type.Boolean({
			description: "False when the account was already active.",
		}),
	},
	{ description: "Result payload returned by system.accounts.resume." },
);
export type SystemAccountsResumeResult = Static<
	typeof SystemAccountsResumeResultSchema
>;

export const SystemAccountsRenameResultSchema = Type.Object(
	{
		account: SystemAccountSummarySchema,
		changed: Type.Boolean({
			description: "False when the name was already the same.",
		}),
	},
	{ description: "Result payload returned by system.accounts.rename." },
);
export type SystemAccountsRenameResult = Static<
	typeof SystemAccountsRenameResultSchema
>;

export const AccountAuditEventSchema = Type.Object(
	{
		id: Type.String({ description: "Audit row id." }),
		accountId: Type.String({ description: "Account the row is kept in." }),
		actorUserId: Type.Optional(Type.String({ description: "Acting user." })),
		actorKind: Type.String({ description: "Kind of actor." }),
		action: Type.String({ description: "What happened." }),
		targetAccountId: Type.Optional(
			Type.String({ description: "Account the action was about." }),
		),
		target: Type.Optional(Type.String({ description: "Target id." })),
		data: Type.Optional(
			Type.Unknown({
				description:
					"Action details. Show as text; its shape depends on the action.",
			}),
		),
		at: Type.Number({ description: "Epoch ms." }),
	},
	{ description: "One audit event kept in an account." },
);
export type AccountAuditEvent = Static<typeof AccountAuditEventSchema>;

export const AccountAuditListResultSchema = Type.Object(
	{ events: Type.Array(AccountAuditEventSchema) },
	{ description: "Result payload returned by account.audit.list." },
);
export type AccountAuditListResult = Static<
	typeof AccountAuditListResultSchema
>;

export const SystemAuditEventSchema = Type.Object(
	{
		id: Type.String({ description: "Audit row id." }),
		accountId: Type.String({ description: "Account the row is kept in." }),
		actorUserId: Type.Optional(Type.String({ description: "Acting user." })),
		actorKind: Type.String({ description: "Kind of actor." }),
		action: Type.String({ description: "What happened." }),
		targetAccountId: Type.Optional(
			Type.String({ description: "Account the action was about." }),
		),
		target: Type.Optional(Type.String({ description: "Target id." })),
		data: Type.Optional(Type.Unknown({ description: "Action details." })),
		at: Type.Number({ description: "Epoch ms." }),
	},
	{ description: "One system-scope audit event." },
);
export type SystemAuditEvent = Static<typeof SystemAuditEventSchema>;

export const SystemAuditListResultSchema = Type.Object(
	{ events: Type.Array(SystemAuditEventSchema) },
	{ description: "Result payload returned by system.audit.list." },
);
export type SystemAuditListResult = Static<typeof SystemAuditListResultSchema>;

export const SystemMemberSchema = Type.Object(
	{
		userId: Type.String({ description: "User id." }),
		name: Type.String({ description: "Display name." }),
		email: Type.Optional(Type.String({ description: "Primary email." })),
		roles: Type.Array(Type.String(), {
			description: "Stored roles in this account, lowest rank first.",
		}),
		createdAt: Type.Number({ description: "Epoch ms the membership began." }),
		disabledAt: Type.Optional(
			Type.Number({ description: "Epoch ms the user was disabled." }),
		),
	},
	{
		description: "A member of a tenant account as the system console sees it.",
	},
);
export type SystemMember = Static<typeof SystemMemberSchema>;

export const SystemMembersListResultSchema = Type.Object(
	{ members: Type.Array(SystemMemberSchema) },
	{ description: "Result payload returned by system.members.list." },
);
export type SystemMembersListResult = Static<
	typeof SystemMembersListResultSchema
>;

export const SystemUsersDisableResultSchema = Type.Object(
	{ changed: Type.Boolean({ description: "False when already disabled." }) },
	{ description: "Result payload returned by system.users.disable." },
);
export type SystemUsersDisableResult = Static<
	typeof SystemUsersDisableResultSchema
>;

export const SystemUsersEnableResultSchema = Type.Object(
	{ changed: Type.Boolean({ description: "False when already enabled." }) },
	{ description: "Result payload returned by system.users.enable." },
);
export type SystemUsersEnableResult = Static<
	typeof SystemUsersEnableResultSchema
>;

export const SystemUsersRevokeSessionsResultSchema = Type.Object(
	{ revoked: Type.Number({ description: "Sessions revoked." }) },
	{ description: "Result payload returned by system.users.revokeSessions." },
);
export type SystemUsersRevokeSessionsResult = Static<
	typeof SystemUsersRevokeSessionsResultSchema
>;

export const AuthElevateResultSchema = Type.Object(
	{
		elevatedUntil: Type.Number({
			description: "Epoch ms when admin mode on this session ends.",
		}),
	},
	{ description: "Result payload returned by auth.elevate." },
);
export type AuthElevateResult = Static<typeof AuthElevateResultSchema>;

export const AuthElevationEndResultSchema = Type.Object(
	{
		ended: Type.Boolean({
			description: "True when admin mode was on and is now off.",
		}),
	},
	{ description: "Result payload returned by auth.elevation.end." },
);
export type AuthElevationEndResult = Static<
	typeof AuthElevationEndResultSchema
>;

export const AuthSessionsRevokeOthersResultSchema = Type.Object(
	{
		revoked: Type.Number({ description: "Number of other sessions revoked." }),
	},
	{ description: "Result payload returned by auth.sessions.revokeOthers." },
);
export type AuthSessionsRevokeOthersResult = Static<
	typeof AuthSessionsRevokeOthersResultSchema
>;

export const AuthTokensListResultSchema = Type.Object(
	{
		tokens: Type.Array(
			Type.Object(
				{
					id: Type.String(),
					kind: Type.Union([Type.Literal("pat"), Type.Literal("service")]),
					label: Type.String(),
					grants: Type.Array(Type.String()),
					createdBy: Type.Union([Type.String(), Type.Null()]),
					createdAt: Type.Number(),
					expiresAt: Type.Union([Type.Number(), Type.Null()]),
					lastUsedAt: Type.Union([Type.Number(), Type.Null()]),
					revokedAt: Type.Union([Type.Number(), Type.Null()]),
					elevated: Type.Boolean(),
				},
				{ description: "One API token (never the secret)." },
			),
		),
	},
	{ description: "Result payload returned by auth.tokens.list." },
);
export type AuthTokensListResult = Static<typeof AuthTokensListResultSchema>;

export const AuthTokensCreateResultSchema = Type.Object(
	{
		token: Type.String({ description: "The secret, shown once." }),
		summary: Type.Object(
			{
				id: Type.String(),
				kind: Type.Union([Type.Literal("pat"), Type.Literal("service")]),
				label: Type.String(),
				grants: Type.Array(Type.String()),
				createdBy: Type.Union([Type.String(), Type.Null()]),
				createdAt: Type.Number(),
				expiresAt: Type.Union([Type.Number(), Type.Null()]),
				lastUsedAt: Type.Union([Type.Number(), Type.Null()]),
				revokedAt: Type.Union([Type.Number(), Type.Null()]),
				elevated: Type.Boolean(),
			},
			{ description: "One API token (never the secret)." },
		),
	},
	{ description: "Result payload returned by auth.tokens.create." },
);
export type AuthTokensCreateResult = Static<
	typeof AuthTokensCreateResultSchema
>;

export const AuthTokensRevokeResultSchema = Type.Object(
	{ revoked: Type.Boolean() },
	{ description: "Result payload returned by auth.tokens.revoke." },
);
export type AuthTokensRevokeResult = Static<
	typeof AuthTokensRevokeResultSchema
>;

export const AuthMethodsListResultSchema = Type.Object(
	{
		methods: Type.Array(
			Type.Object(
				{
					id: Type.String(),
					provider: Type.String(),
					display: Type.Optional(Type.String()),
					createdAt: Type.Number(),
					lastUsedAt: Type.Optional(Type.Number()),
				},
				{ description: "One active login method." },
			),
		),
	},
	{ description: "Result payload returned by auth.methods.list." },
);
export type AuthMethodsListResult = Static<typeof AuthMethodsListResultSchema>;

export const AuthMembershipsListResultSchema = Type.Object(
	{
		memberships: Type.Array(
			Type.Object(
				{
					accountId: Type.String(),
					name: Type.String(),
					roles: Type.Array(Type.String(), {
						description: "Stored roles, lowest rank first.",
					}),
				},
				{ description: "One active account the caller belongs to." },
			),
		),
	},
	{ description: "Result payload returned by auth.memberships.list." },
);
export type AuthMembershipsListResult = Static<
	typeof AuthMembershipsListResultSchema
>;

export const AuthMethodsDeleteResultSchema = Type.Object(
	{
		deleted: Type.Boolean({
			description: "True when the method was active and is now deleted.",
		}),
		sessionsRevoked: Type.Number({
			description: "Sessions opened through the method that were revoked.",
		}),
	},
	{ description: "Result payload returned by auth.methods.delete." },
);
export type AuthMethodsDeleteResult = Static<
	typeof AuthMethodsDeleteResultSchema
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
			"Result payload returned by family.list. Each family includes teamLeaderBotId when a Team Leader is set.",
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
			"Result payload returned by family.get, including teamLeaderBotId when a Team Leader is set.",
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
			"Result payload returned by family.update, including teamLeaderBotId when a Team Leader is set.",
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
		toolsEnvEnabled: Type.Optional(Type.Boolean()),
		toolsEnvEnabledSource: Type.Optional(Type.String()),
		effectiveToolsEnv: Type.Optional(
			Type.Union([EffectiveToolsEnvSchema, Type.Null()]),
		),
		toolsEnvBindingSource: Type.Optional(Type.String()),
		toolsEnvStatus: Type.Optional(Type.String()),
		toolsEnvConnectedAt: Type.Optional(
			Type.Union([Type.Number(), Type.Null()]),
		),
		toolsEnvLastError: Type.Optional(Type.Union([Type.String(), Type.Null()])),
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
		messages: Type.Array(TranscriptMessageViewSchema, {
			description: "Recent message exchange history for this chat session.",
		}),
		entries: Type.Array(RawTranscriptEntrySchema, {
			description: "Raw transcript entries recorded for this conversation.",
		}),
		notes: Type.Array(HarvestNoteSchema, {
			description:
				"Historical harvest notes recording memory and knowledge updates from this chat.",
		}),
		tasks: Type.Optional(
			Type.Array(ChatTaskSchema, {
				description: "Chat tasks for this session.",
			}),
		),
		taskLoop: Type.Optional(ChatTaskLoopSchema),
		toolsEnvEnabled: Type.Optional(Type.Boolean()),
		toolsEnvEnabledSource: Type.Optional(Type.String()),
		effectiveToolsEnv: Type.Optional(
			Type.Union([EffectiveToolsEnvSchema, Type.Null()]),
		),
		toolsEnvBindingSource: Type.Optional(Type.String()),
		toolsEnvStatus: Type.Optional(Type.String()),
		toolsEnvConnectedAt: Type.Optional(
			Type.Union([Type.Number(), Type.Null()]),
		),
		toolsEnvLastError: Type.Optional(Type.Union([Type.String(), Type.Null()])),
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
					"Permitted tools for this chat. An array is the bot allowlist, and an empty array allows no gated tools. 'all' is the default when bot.tools is omitted.",
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
		usage: UsageSummarySchema,
		botUsage: UsageSummarySchema,
		tasks: Type.Optional(
			Type.Object(
				{
					open: Type.Integer({
						minimum: 0,
						description: "Pending plus in-progress task count.",
					}),
					done: Type.Integer({
						minimum: 0,
						description: "Finished task count still on the chat.",
					}),
					loopRound: Type.Integer({
						minimum: 0,
						description: "Current auto-continue round.",
					}),
				},
				{ additionalProperties: false },
			),
		),
		toolsEnv: Type.Optional(
			Type.Object(
				{
					enabled: Type.Boolean(),
					enabledSource: Type.String(),
					kind: Type.Optional(Type.String()),
					envId: Type.Optional(Type.String()),
					bindingSource: Type.Optional(Type.String()),
					status: Type.Optional(Type.String()),
					connectedAt: Type.Optional(Type.Number()),
					lastError: Type.Optional(Type.String()),
				},
				{ additionalProperties: false },
			),
		),
	},
	{
		description:
			"Live runtime execution status, active model configuration, and alarm scheduling for a chat session.",
	},
);
export type ChatStatusRecord = Static<typeof ChatStatusRecordSchema>;

/**
 * Result payload returned by chat.status.
 */
export const ChatStatusResultSchema = Type.Object(
	{
		status: ChatStatusRecordSchema,
	},
	{
		description: "Live runtime status for a chat session.",
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
 * Result returned by chat.delete confirming the chat has been soft-deleted.
 */
export const ChatDeleteResultSchema = Type.Object(
	{
		chat: ChatRecordSchema,
		deleted: Type.Literal(true, {
			description: "Always true, confirming the chat was soft-deleted.",
		}),
	},
	{
		description:
			"Result payload returned by chat.delete confirming the chat was soft-deleted.",
	},
);
export type ChatDeleteResult = Static<typeof ChatDeleteResultSchema>;

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
 */
export const TurnSubmitResultSchema = TurnSettledResultSchema;
export type TurnSubmitResult = Static<typeof TurnSubmitResultSchema>;

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

export const ChatUpdateResultSchema = Type.Object({
	chat: ChatRecordSchema,
});
export type ChatUpdateResult = Static<typeof ChatUpdateResultSchema>;

export const ChatTasksListResultSchema = Type.Object(
	{
		tasks: Type.Array(ChatTaskSchema, {
			description: "All tasks for the chat, including details.",
		}),
	},
	{ description: "Result of chat.tasks.list." },
);
export type ChatTasksListResult = Static<typeof ChatTasksListResultSchema>;

export const ChatTasksGetResultSchema = Type.Object(
	{
		task: ChatTaskSchema,
	},
	{ description: "Result of chat.tasks.get." },
);
export type ChatTasksGetResult = Static<typeof ChatTasksGetResultSchema>;

export const ToolsEnvRecordSchema = Type.Object({
	envId: Type.String(),
	kind: Type.Union([Type.Literal("just-bash"), Type.Literal("local-daemon")]),
	label: Type.Optional(Type.String()),
	persist: Type.Boolean(),
	confineToWorkspace: Type.Boolean(),
	confinementPolicy: Type.Optional(ConfinementPolicySchema),
	sharedWorkspace: Type.Optional(Type.Boolean()),
	updatedAt: Type.Number(),
	supportsConfinement: Type.Boolean(),
	connection: Type.Optional(
		Type.Object(
			{
				status: Type.Union([
					Type.Literal("connected"),
					Type.Literal("disconnected"),
				]),
				connectedAt: Type.Optional(Type.Number()),
				lastError: Type.Optional(Type.String()),
				workspacePath: Type.Optional(
					Type.String({
						description:
							"Directory reported by the connected daemon. Omitted while disconnected.",
					}),
				),
				confined: Type.Optional(
					Type.Boolean({
						description:
							"Effective confinement state of the active connection.",
					}),
				),
			},
			{ additionalProperties: false },
		),
	),
});
export type ToolsEnvRecord = Static<typeof ToolsEnvRecordSchema>;

export const AccountToolsEnvsListResultSchema = Type.Object({
	default: Type.Union([
		Type.Object({ envId: Type.String() }, { additionalProperties: false }),
		Type.Null(),
	]),
	envs: Type.Array(ToolsEnvRecordSchema),
});
export type AccountToolsEnvsListResult = Static<
	typeof AccountToolsEnvsListResultSchema
>;

export const AccountToolsEnvsCreateResultSchema = Type.Object({
	env: ToolsEnvRecordSchema,
	pairingToken: Type.Optional(Type.String()),
	expiresAt: Type.Optional(Type.Integer({ minimum: 0 })),
	command: Type.Optional(Type.String()),
});
export type AccountToolsEnvsCreateResult = Static<
	typeof AccountToolsEnvsCreateResultSchema
>;

export const AccountToolsEnvsPairResultSchema = Type.Object({
	envId: Type.String(),
	pairingToken: Type.String(),
	expiresAt: Type.Integer({ minimum: 0 }),
	command: Type.String(),
});
export type AccountToolsEnvsPairResult = Static<
	typeof AccountToolsEnvsPairResultSchema
>;

export const AccountToolsEnvsDeregisterResultSchema = Type.Object({
	deregistered: Type.String(),
});
export type AccountToolsEnvsDeregisterResult = Static<
	typeof AccountToolsEnvsDeregisterResultSchema
>;

export const AccountToolsEnvsUpdateResultSchema = Type.Object({
	env: ToolsEnvRecordSchema,
});
export type AccountToolsEnvsUpdateResult = Static<
	typeof AccountToolsEnvsUpdateResultSchema
>;

export const AccountToolsEnvsDeleteResultSchema = Type.Object({
	deleted: Type.String(),
});
export type AccountToolsEnvsDeleteResult = Static<
	typeof AccountToolsEnvsDeleteResultSchema
>;
