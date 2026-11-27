import type { CommandType } from "./commands.js";
import {
	AccountAuditListCommandSchema,
	AccountCredentialsDeleteCommandSchema,
	AccountCredentialsListCommandSchema,
	AccountCredentialsSetCommandSchema,
	AccountCredentialsTestCommandSchema,
	AccountGetCommandSchema,
	AccountInvitesListCommandSchema,
	AccountInvitesRevokeCommandSchema,
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
	AuthMethodsDeleteCommandSchema,
	AuthMethodsListCommandSchema,
	AuthSessionsListCommandSchema,
	AuthSessionsRevokeCommandSchema,
	AuthSessionsRevokeOthersCommandSchema,
	AuthTicketCommandSchema,
	AuthWhoamiCommandSchema,
	BotCreateCommandSchema,
	BotDeleteCommandSchema,
	BotGetCommandSchema,
	BotListCommandSchema,
	BotUpdateCommandSchema,
	ChatGetCommandSchema,
	ChatListCommandSchema,
	ChatResetCommandSchema,
	ChatStatusCommandSchema,
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
	ScheduleCreateCommandSchema,
	ScheduleDeleteCommandSchema,
	ScheduleListCommandSchema,
	ScheduleUpdateCommandSchema,
	SystemAccountsCreateCommandSchema,
	SystemAccountsGetCommandSchema,
	SystemAccountsListCommandSchema,
	SystemAccountsRenameCommandSchema,
	SystemAccountsResumeCommandSchema,
	SystemAccountsSuspendCommandSchema,
	SystemAuditListCommandSchema,
	SystemMembersInviteCommandSchema,
	SystemMembersListCommandSchema,
	SystemMembersRemoveCommandSchema,
	SystemMembersUpdateCommandSchema,
	SystemMetricsCommandSchema,
	SystemSessionsRevokeCommandSchema,
	SystemUsersDisableCommandSchema,
	SystemUsersEnableCommandSchema,
	SystemUsersRevokeSessionsCommandSchema,
	TurnAbortCommandSchema,
	TurnInterruptCommandSchema,
	TurnSteerCommandSchema,
	TurnSubmitCommandSchema,
} from "./commands.js";
import {
	AuthAssumeRoleCommandSchema,
	AuthLoginDeviceApproveCommandSchema,
	AuthLoginDeviceApproveResultSchema,
	AuthLoginDeviceDenyCommandSchema,
	AuthLoginDeviceDenyResultSchema,
	AuthLoginDevicePollCommandSchema,
	AuthLoginDevicePollResultSchema,
	AuthLoginDeviceStartCommandSchema,
	AuthLoginDeviceStartResultSchema,
	AuthLoginDevPasswordCommandSchema,
	AuthLoginGoogleStartCommandSchema,
	AuthLoginGoogleStartResultSchema,
	AuthLoginProvidersCommandSchema,
	AuthLoginProvidersResultSchema,
	AuthLoginSessionResultSchema,
	AuthSessionLogoutCommandSchema,
	AuthSessionLogoutResultSchema,
	AuthSessionRefreshCommandSchema,
} from "./login.js";
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
	AccountCredentialsTestResultSchema,
	AccountGetResultSchema,
	AccountInvitesListResultSchema,
	AccountInvitesRevokeResultSchema,
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
	AuthMethodsDeleteResultSchema,
	AuthMethodsListResultSchema,
	AuthSessionsListResultSchema,
	AuthSessionsRevokeOthersResultSchema,
	AuthSessionsRevokeResultSchema,
	AuthTicketResultSchema,
	AuthWhoamiResultSchema,
	BotCreateResultSchema,
	BotDeleteResultSchema,
	BotGetResultSchema,
	BotListResultSchema,
	BotUpdateResultSchema,
	ChatGetResultSchema,
	ChatListResultSchema,
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
	ScheduleCreateResultSchema,
	ScheduleDeleteResultSchema,
	ScheduleListResultSchema,
	ScheduleUpdateResultSchema,
	SystemAccountsCreateResultSchema,
	SystemAccountsGetResultSchema,
	SystemAccountsListResultSchema,
	SystemAccountsRenameResultSchema,
	SystemAccountsResumeResultSchema,
	SystemAccountsSuspendResultSchema,
	SystemAuditListResultSchema,
	SystemMembersListResultSchema,
	SystemMetricsResultSchema,
	SystemSessionsRevokeResultSchema,
	SystemUsersDisableResultSchema,
	SystemUsersEnableResultSchema,
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
	"account.credentials.test": {
		command: AccountCredentialsTestCommandSchema,
		result: AccountCredentialsTestResultSchema,
	},
	"account.models.list": {
		command: AccountModelsListCommandSchema,
		result: AccountModelsListResultSchema,
	},
	"account.credentials.oauth.providers": {
		command: AccountOAuthProvidersCommandSchema,
		result: AccountOAuthProvidersResultSchema,
	},
	"account.credentials.oauth.start": {
		command: AccountOAuthStartCommandSchema,
		result: AccountOAuthStartResultSchema,
	},
	"account.credentials.oauth.status": {
		command: AccountOAuthStatusCommandSchema,
		result: AccountOAuthStatusResultSchema,
	},
	"account.credentials.oauth.submit": {
		command: AccountOAuthSubmitCommandSchema,
		result: AccountOAuthSubmitResultSchema,
	},
	"account.credentials.oauth.cancel": {
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
	"system.metrics": {
		command: SystemMetricsCommandSchema,
		result: SystemMetricsResultSchema,
	},
	"system.accounts.get": {
		command: SystemAccountsGetCommandSchema,
		result: SystemAccountsGetResultSchema,
	},
	"system.sessions.revoke": {
		command: SystemSessionsRevokeCommandSchema,
		result: SystemSessionsRevokeResultSchema,
	},
	"auth.elevate": {
		command: AuthElevateCommandSchema,
		result: AuthElevateResultSchema,
	},
	"auth.elevation.end": {
		command: AuthElevationEndCommandSchema,
		result: AuthElevationEndResultSchema,
	},
	"auth.memberships.list": {
		command: AuthMembershipsListCommandSchema,
		result: AuthMembershipsListResultSchema,
	},
	"auth.methods.list": {
		command: AuthMethodsListCommandSchema,
		result: AuthMethodsListResultSchema,
	},
	"auth.methods.delete": {
		command: AuthMethodsDeleteCommandSchema,
		result: AuthMethodsDeleteResultSchema,
	},
	"auth.login.providers": {
		command: AuthLoginProvidersCommandSchema,
		result: AuthLoginProvidersResultSchema,
	},
	"auth.assumeRole": {
		command: AuthAssumeRoleCommandSchema,
		result: AuthLoginSessionResultSchema,
	},
	"auth.login.devPassword": {
		command: AuthLoginDevPasswordCommandSchema,
		result: AuthLoginSessionResultSchema,
	},
	"auth.login.google.start": {
		command: AuthLoginGoogleStartCommandSchema,
		result: AuthLoginGoogleStartResultSchema,
	},
	"auth.login.device.start": {
		command: AuthLoginDeviceStartCommandSchema,
		result: AuthLoginDeviceStartResultSchema,
	},
	"auth.login.device.poll": {
		command: AuthLoginDevicePollCommandSchema,
		result: AuthLoginDevicePollResultSchema,
	},
	"auth.login.device.approve": {
		command: AuthLoginDeviceApproveCommandSchema,
		result: AuthLoginDeviceApproveResultSchema,
	},
	"auth.login.device.deny": {
		command: AuthLoginDeviceDenyCommandSchema,
		result: AuthLoginDeviceDenyResultSchema,
	},
	"auth.session.refresh": {
		command: AuthSessionRefreshCommandSchema,
		result: AuthLoginSessionResultSchema,
	},
	"auth.session.logout": {
		command: AuthSessionLogoutCommandSchema,
		result: AuthSessionLogoutResultSchema,
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
	"chat.list": {
		command: ChatListCommandSchema,
		result: ChatListResultSchema,
	},
	"chat.get": {
		command: ChatGetCommandSchema,
		result: ChatGetResultSchema,
	},
	"chat.reset": {
		command: ChatResetCommandSchema,
		result: ChatResetResultSchema,
	},
	"chat.status": {
		command: ChatStatusCommandSchema,
		result: ChatStatusResultSchema,
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
