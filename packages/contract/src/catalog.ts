import type { CommandType } from "./commands.js";
import {
	AccountAuditListCommandSchema,
	AccountCredentialsDeleteCommandSchema,
	AccountCredentialsListCommandSchema,
	AccountCredentialsSetCommandSchema,
	AccountGetCommandSchema,
	AccountInvitesListCommandSchema,
	AccountInvitesRevokeCommandSchema,
	AccountMembersAddCommandSchema,
	AccountMembersInviteCommandSchema,
	AccountMembersListCommandSchema,
	AccountMembersRemoveCommandSchema,
	AccountMembersUpdateCommandSchema,
	AccountModelsListCommandSchema,
	AccountToolsEnvsCreateCommandSchema,
	AccountToolsEnvsDeleteCommandSchema,
	AccountToolsEnvsDeregisterCommandSchema,
	AccountToolsEnvsListCommandSchema,
	AccountToolsEnvsPairCommandSchema,
	AccountToolsEnvsUpdateCommandSchema,
	AccountUpdateCommandSchema,
	AuthElevateCommandSchema,
	AuthElevationEndCommandSchema,
	AuthMembershipsListCommandSchema,
	AuthMethodsLinkStartCommandSchema,
	AuthMethodsListCommandSchema,
	AuthMethodsRevokeCommandSchema,
	AuthPasskeysBeginCommandSchema,
	AuthPasskeysFinishCommandSchema,
	AuthSessionsListCommandSchema,
	AuthSessionsRevokeCommandSchema,
	AuthSessionsRevokeOthersCommandSchema,
	AuthTicketCommandSchema,
	AuthTokensCreateCommandSchema,
	AuthTokensListCommandSchema,
	AuthTokensRevokeCommandSchema,
	AuthWhoamiCommandSchema,
	BotCreateCommandSchema,
	BotDeleteCommandSchema,
	BotGetCommandSchema,
	BotListCommandSchema,
	BotUpdateCommandSchema,
	ChatCloseCommandSchema,
	ChatCreateCommandSchema,
	ChatDeleteCommandSchema,
	ChatEntriesCommandSchema,
	ChatGetCommandSchema,
	ChatListCommandSchema,
	ChatMessagesCommandSchema,
	ChatRenameCommandSchema,
	ChatResetCommandSchema,
	ChatStatusCommandSchema,
	ChatSubscribeCommandSchema,
	ChatTasksGetCommandSchema,
	ChatTasksListCommandSchema,
	ChatUpdateCommandSchema,
	FamilyCreateCommandSchema,
	FamilyDeleteCommandSchema,
	FamilyGetCommandSchema,
	FamilyListCommandSchema,
	FamilyUpdateCommandSchema,
	FileDeleteCommandSchema,
	FileListCommandSchema,
	FileReadCommandSchema,
	FileWriteCommandSchema,
	KnowledgeSearchCommandSchema,
	ScheduleCreateCommandSchema,
	ScheduleDeleteCommandSchema,
	ScheduleListCommandSchema,
	ScheduleUpdateCommandSchema,
	SystemAccountsCreateCommandSchema,
	SystemAccountsListCommandSchema,
	SystemAccountsRenameCommandSchema,
	SystemAccountsResumeCommandSchema,
	SystemAccountsSuspendCommandSchema,
	SystemAuditListCommandSchema,
	SystemMembersInviteCommandSchema,
	SystemMembersListCommandSchema,
	SystemMembersRemoveCommandSchema,
	SystemMembersUpdateCommandSchema,
	SystemUsersDisableCommandSchema,
	SystemUsersEnableCommandSchema,
	SystemUsersResetPasskeysCommandSchema,
	SystemUsersRevokeSessionsCommandSchema,
	TurnAbortCommandSchema,
	TurnInterruptCommandSchema,
	TurnSteerCommandSchema,
	TurnSubmitCommandSchema,
} from "./commands.js";
import {
	AccountOAuthCancelCommandSchema,
	AccountOAuthCancelResultSchema,
	AccountOAuthProvidersCommandSchema,
	AccountOAuthProvidersResultSchema,
	AccountOAuthStartCommandSchema,
	AccountOAuthStartResultSchema,
	AccountOAuthStatusCommandSchema,
	AccountOAuthStatusResultSchema,
	AccountOAuthSubmitCommandSchema,
	AccountOAuthSubmitResultSchema,
} from "./oauth.js";
import {
	AccountAuditListResultSchema,
	AccountCredentialsDeleteResultSchema,
	AccountCredentialsListResultSchema,
	AccountCredentialsSetResultSchema,
	AccountGetResultSchema,
	AccountInvitesListResultSchema,
	AccountInvitesRevokeResultSchema,
	AccountMembersAddResultSchema,
	AccountMembersInviteResultSchema,
	AccountMembersListResultSchema,
	AccountMembersRemoveResultSchema,
	AccountMembersUpdateResultSchema,
	AccountModelsListResultSchema,
	AccountToolsEnvsCreateResultSchema,
	AccountToolsEnvsDeleteResultSchema,
	AccountToolsEnvsDeregisterResultSchema,
	AccountToolsEnvsListResultSchema,
	AccountToolsEnvsPairResultSchema,
	AccountToolsEnvsUpdateResultSchema,
	AccountUpdateResultSchema,
	AuthElevateResultSchema,
	AuthElevationEndResultSchema,
	AuthMembershipsListResultSchema,
	AuthMethodsLinkStartResultSchema,
	AuthMethodsListResultSchema,
	AuthMethodsRevokeResultSchema,
	AuthPasskeysBeginResultSchema,
	AuthPasskeysFinishResultSchema,
	AuthSessionsListResultSchema,
	AuthSessionsRevokeOthersResultSchema,
	AuthSessionsRevokeResultSchema,
	AuthTicketResultSchema,
	AuthTokensCreateResultSchema,
	AuthTokensListResultSchema,
	AuthTokensRevokeResultSchema,
	AuthWhoamiResultSchema,
	BotCreateResultSchema,
	BotDeleteResultSchema,
	BotGetResultSchema,
	BotListResultSchema,
	BotUpdateResultSchema,
	ChatCloseResultSchema,
	ChatCreateResultSchema,
	ChatDeleteResultSchema,
	ChatGetResultSchema,
	ChatListResultSchema,
	ChatRenameResultSchema,
	ChatResetResultSchema,
	ChatStatusResultSchema,
	ChatTasksGetResultSchema,
	ChatTasksListResultSchema,
	ChatUpdateResultSchema,
	FamilyCreateResultSchema,
	FamilyDeleteResultSchema,
	FamilyGetResultSchema,
	FamilyListResultSchema,
	FamilyUpdateResultSchema,
	FileDeleteResultSchema,
	FileListResultSchema,
	FileReadResultSchema,
	FileWriteResultSchema,
	KnowledgeSearchResultsSchema,
	ScheduleCreateResultSchema,
	ScheduleDeleteResultSchema,
	ScheduleListResultSchema,
	ScheduleUpdateResultSchema,
	SystemAccountsCreateResultSchema,
	SystemAccountsListResultSchema,
	SystemAccountsRenameResultSchema,
	SystemAccountsResumeResultSchema,
	SystemAccountsSuspendResultSchema,
	SystemAuditListResultSchema,
	SystemMembersListResultSchema,
	SystemUsersDisableResultSchema,
	SystemUsersEnableResultSchema,
	SystemUsersResetPasskeysResultSchema,
	SystemUsersRevokeSessionsResultSchema,
	TurnInterruptResultSchema,
	TurnSteerResultSchema,
	TurnSubmitResultSchema,
} from "./results.js";

/**
 * Every command paired with its payload (on the command schema) and result schema.
 * `readOnly` stays on the command schema itself; this object does not copy it.
 */
export const commandCatalog = {
	"account.get": {
		command: AccountGetCommandSchema,
		result: AccountGetResultSchema,
	},
	"account.update": {
		command: AccountUpdateCommandSchema,
		result: AccountUpdateResultSchema,
	},
	"account.members.list": {
		command: AccountMembersListCommandSchema,
		result: AccountMembersListResultSchema,
	},
	"account.members.invite": {
		command: AccountMembersInviteCommandSchema,
		result: AccountMembersInviteResultSchema,
	},
	"account.members.update": {
		command: AccountMembersUpdateCommandSchema,
		result: AccountMembersUpdateResultSchema,
	},
	"account.members.remove": {
		command: AccountMembersRemoveCommandSchema,
		result: AccountMembersRemoveResultSchema,
	},
	"account.invites.list": {
		command: AccountInvitesListCommandSchema,
		result: AccountInvitesListResultSchema,
	},
	"account.invites.revoke": {
		command: AccountInvitesRevokeCommandSchema,
		result: AccountInvitesRevokeResultSchema,
	},
	"account.members.add": {
		command: AccountMembersAddCommandSchema,
		result: AccountMembersAddResultSchema,
	},
	"account.credentials.list": {
		command: AccountCredentialsListCommandSchema,
		result: AccountCredentialsListResultSchema,
	},
	"account.credentials.set": {
		command: AccountCredentialsSetCommandSchema,
		result: AccountCredentialsSetResultSchema,
	},
	"account.credentials.delete": {
		command: AccountCredentialsDeleteCommandSchema,
		result: AccountCredentialsDeleteResultSchema,
	},
	"account.models.list": {
		command: AccountModelsListCommandSchema,
		result: AccountModelsListResultSchema,
	},
	"account.oauth.providers": {
		command: AccountOAuthProvidersCommandSchema,
		result: AccountOAuthProvidersResultSchema,
	},
	"account.oauth.start": {
		command: AccountOAuthStartCommandSchema,
		result: AccountOAuthStartResultSchema,
	},
	"account.oauth.status": {
		command: AccountOAuthStatusCommandSchema,
		result: AccountOAuthStatusResultSchema,
	},
	"account.oauth.submit": {
		command: AccountOAuthSubmitCommandSchema,
		result: AccountOAuthSubmitResultSchema,
	},
	"account.oauth.cancel": {
		command: AccountOAuthCancelCommandSchema,
		result: AccountOAuthCancelResultSchema,
	},
	"auth.whoami": {
		command: AuthWhoamiCommandSchema,
		result: AuthWhoamiResultSchema,
	},
	"auth.ticket": {
		command: AuthTicketCommandSchema,
		result: AuthTicketResultSchema,
	},
	"auth.sessions.list": {
		command: AuthSessionsListCommandSchema,
		result: AuthSessionsListResultSchema,
	},
	"auth.sessions.revoke": {
		command: AuthSessionsRevokeCommandSchema,
		result: AuthSessionsRevokeResultSchema,
	},
	"auth.sessions.revokeOthers": {
		command: AuthSessionsRevokeOthersCommandSchema,
		result: AuthSessionsRevokeOthersResultSchema,
	},
	"system.accounts.list": {
		command: SystemAccountsListCommandSchema,
		result: SystemAccountsListResultSchema,
	},
	"system.accounts.create": {
		command: SystemAccountsCreateCommandSchema,
		result: SystemAccountsCreateResultSchema,
	},
	"system.accounts.suspend": {
		command: SystemAccountsSuspendCommandSchema,
		result: SystemAccountsSuspendResultSchema,
	},
	"system.accounts.resume": {
		command: SystemAccountsResumeCommandSchema,
		result: SystemAccountsResumeResultSchema,
	},
	"system.accounts.rename": {
		command: SystemAccountsRenameCommandSchema,
		result: SystemAccountsRenameResultSchema,
	},
	"account.audit.list": {
		command: AccountAuditListCommandSchema,
		result: AccountAuditListResultSchema,
	},
	"system.audit.list": {
		command: SystemAuditListCommandSchema,
		result: SystemAuditListResultSchema,
	},
	"system.members.list": {
		command: SystemMembersListCommandSchema,
		result: SystemMembersListResultSchema,
	},
	"system.members.invite": {
		command: SystemMembersInviteCommandSchema,
		result: AccountMembersInviteResultSchema,
	},
	"system.members.update": {
		command: SystemMembersUpdateCommandSchema,
		result: AccountMembersUpdateResultSchema,
	},
	"system.members.remove": {
		command: SystemMembersRemoveCommandSchema,
		result: AccountMembersRemoveResultSchema,
	},
	"system.users.disable": {
		command: SystemUsersDisableCommandSchema,
		result: SystemUsersDisableResultSchema,
	},
	"system.users.enable": {
		command: SystemUsersEnableCommandSchema,
		result: SystemUsersEnableResultSchema,
	},
	"system.users.revokeSessions": {
		command: SystemUsersRevokeSessionsCommandSchema,
		result: SystemUsersRevokeSessionsResultSchema,
	},
	"system.users.resetPasskeys": {
		command: SystemUsersResetPasskeysCommandSchema,
		result: SystemUsersResetPasskeysResultSchema,
	},
	"auth.elevate": {
		command: AuthElevateCommandSchema,
		result: AuthElevateResultSchema,
	},
	"auth.passkeys.begin": {
		command: AuthPasskeysBeginCommandSchema,
		result: AuthPasskeysBeginResultSchema,
	},
	"auth.passkeys.finish": {
		command: AuthPasskeysFinishCommandSchema,
		result: AuthPasskeysFinishResultSchema,
	},
	"auth.elevation.end": {
		command: AuthElevationEndCommandSchema,
		result: AuthElevationEndResultSchema,
	},
	"auth.tokens.list": {
		command: AuthTokensListCommandSchema,
		result: AuthTokensListResultSchema,
	},
	"auth.tokens.create": {
		command: AuthTokensCreateCommandSchema,
		result: AuthTokensCreateResultSchema,
	},
	"auth.tokens.revoke": {
		command: AuthTokensRevokeCommandSchema,
		result: AuthTokensRevokeResultSchema,
	},
	"auth.memberships.list": {
		command: AuthMembershipsListCommandSchema,
		result: AuthMembershipsListResultSchema,
	},
	"auth.methods.list": {
		command: AuthMethodsListCommandSchema,
		result: AuthMethodsListResultSchema,
	},
	"auth.methods.link.start": {
		command: AuthMethodsLinkStartCommandSchema,
		result: AuthMethodsLinkStartResultSchema,
	},
	"auth.methods.revoke": {
		command: AuthMethodsRevokeCommandSchema,
		result: AuthMethodsRevokeResultSchema,
	},
	"family.list": {
		command: FamilyListCommandSchema,
		result: FamilyListResultSchema,
	},
	"family.create": {
		command: FamilyCreateCommandSchema,
		result: FamilyCreateResultSchema,
	},
	"family.get": {
		command: FamilyGetCommandSchema,
		result: FamilyGetResultSchema,
	},
	"family.update": {
		command: FamilyUpdateCommandSchema,
		result: FamilyUpdateResultSchema,
	},
	"family.delete": {
		command: FamilyDeleteCommandSchema,
		result: FamilyDeleteResultSchema,
	},
	"bot.list": {
		command: BotListCommandSchema,
		result: BotListResultSchema,
	},
	"bot.create": {
		command: BotCreateCommandSchema,
		result: BotCreateResultSchema,
	},
	"bot.get": {
		command: BotGetCommandSchema,
		result: BotGetResultSchema,
	},
	"bot.update": {
		command: BotUpdateCommandSchema,
		result: BotUpdateResultSchema,
	},
	"bot.delete": {
		command: BotDeleteCommandSchema,
		result: BotDeleteResultSchema,
	},
	"chat.create": {
		command: ChatCreateCommandSchema,
		result: ChatCreateResultSchema,
	},
	"chat.list": {
		command: ChatListCommandSchema,
		result: ChatListResultSchema,
	},
	"chat.get": {
		command: ChatGetCommandSchema,
		result: ChatGetResultSchema,
	},
	"chat.rename": {
		command: ChatRenameCommandSchema,
		result: ChatRenameResultSchema,
	},
	"chat.close": {
		command: ChatCloseCommandSchema,
		result: ChatCloseResultSchema,
	},
	"chat.delete": {
		command: ChatDeleteCommandSchema,
		result: ChatDeleteResultSchema,
	},
	"chat.reset": {
		command: ChatResetCommandSchema,
		result: ChatResetResultSchema,
	},
	"chat.messages": {
		command: ChatMessagesCommandSchema,
		result: ChatGetResultSchema,
	},
	"chat.entries": {
		command: ChatEntriesCommandSchema,
		result: ChatGetResultSchema,
	},
	"chat.status": {
		command: ChatStatusCommandSchema,
		result: ChatStatusResultSchema,
	},
	"chat.subscribe": {
		command: ChatSubscribeCommandSchema,
		result: ChatGetResultSchema,
	},
	"chat.update": {
		command: ChatUpdateCommandSchema,
		result: ChatUpdateResultSchema,
	},
	"chat.tasks.list": {
		command: ChatTasksListCommandSchema,
		result: ChatTasksListResultSchema,
	},
	"chat.tasks.get": {
		command: ChatTasksGetCommandSchema,
		result: ChatTasksGetResultSchema,
	},
	"turn.submit": {
		command: TurnSubmitCommandSchema,
		result: TurnSubmitResultSchema,
	},
	"turn.steer": {
		command: TurnSteerCommandSchema,
		result: TurnSteerResultSchema,
	},
	"turn.interrupt": {
		command: TurnInterruptCommandSchema,
		result: TurnInterruptResultSchema,
	},
	"turn.abort": {
		command: TurnAbortCommandSchema,
		result: TurnInterruptResultSchema,
	},
	"file.list": {
		command: FileListCommandSchema,
		result: FileListResultSchema,
	},
	"file.read": {
		command: FileReadCommandSchema,
		result: FileReadResultSchema,
	},
	"file.write": {
		command: FileWriteCommandSchema,
		result: FileWriteResultSchema,
	},
	"file.delete": {
		command: FileDeleteCommandSchema,
		result: FileDeleteResultSchema,
	},
	"knowledge.search": {
		command: KnowledgeSearchCommandSchema,
		result: KnowledgeSearchResultsSchema,
	},
	"schedule.create": {
		command: ScheduleCreateCommandSchema,
		result: ScheduleCreateResultSchema,
	},
	"schedule.list": {
		command: ScheduleListCommandSchema,
		result: ScheduleListResultSchema,
	},
	"schedule.update": {
		command: ScheduleUpdateCommandSchema,
		result: ScheduleUpdateResultSchema,
	},
	"schedule.delete": {
		command: ScheduleDeleteCommandSchema,
		result: ScheduleDeleteResultSchema,
	},
	"account.toolsEnvs.list": {
		command: AccountToolsEnvsListCommandSchema,
		result: AccountToolsEnvsListResultSchema,
	},
	"account.toolsEnvs.create": {
		command: AccountToolsEnvsCreateCommandSchema,
		result: AccountToolsEnvsCreateResultSchema,
	},
	"account.toolsEnvs.update": {
		command: AccountToolsEnvsUpdateCommandSchema,
		result: AccountToolsEnvsUpdateResultSchema,
	},
	"account.toolsEnvs.delete": {
		command: AccountToolsEnvsDeleteCommandSchema,
		result: AccountToolsEnvsDeleteResultSchema,
	},
	"account.toolsEnvs.pair": {
		command: AccountToolsEnvsPairCommandSchema,
		result: AccountToolsEnvsPairResultSchema,
	},
	"account.toolsEnvs.deregister": {
		command: AccountToolsEnvsDeregisterCommandSchema,
		result: AccountToolsEnvsDeregisterResultSchema,
	},
} as const;

type _CatalogMismatch =
	| Exclude<CommandType, keyof typeof commandCatalog>
	| Exclude<keyof typeof commandCatalog, CommandType>;
type _AssertCatalog<_T extends true> = _T;
type _CatalogMatches = _AssertCatalog<
	[_CatalogMismatch] extends [never] ? true : never
>;

export type CommandCatalog = typeof commandCatalog;
