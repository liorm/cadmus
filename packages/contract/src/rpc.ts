import type {
	AccountAuditListCommand,
	AccountCredentialsDeleteCommand,
	AccountCredentialsListCommand,
	AccountCredentialsSetCommand,
	AccountGetCommand,
	AccountInvitesListCommand,
	AccountInvitesRevokeCommand,
	AccountMembersInviteCommand,
	AccountMembersListCommand,
	AccountMembersRemoveCommand,
	AccountMembersUpdateCommand,
	AccountModelsListCommand,
	AccountToolsEnvsCreateCommand,
	AccountToolsEnvsDeleteCommand,
	AccountToolsEnvsDeregisterCommand,
	AccountToolsEnvsListCommand,
	AccountToolsEnvsPairCommand,
	AccountToolsEnvsUpdateCommand,
	AccountUpdateCommand,
	AuthElevateCommand,
	AuthElevationEndCommand,
	AuthMembershipsListCommand,
	AuthMethodsDeleteCommand,
	AuthMethodsListCommand,
	AuthSessionsListCommand,
	AuthSessionsRevokeCommand,
	AuthSessionsRevokeOthersCommand,
	AuthTicketCommand,
	AuthWhoamiCommand,
	BotCreateCommand,
	BotDeleteCommand,
	BotGetCommand,
	BotListCommand,
	BotUpdateCommand,
	ChatCloseCommand,
	ChatCreateCommand,
	ChatDeleteCommand,
	ChatEntriesCommand,
	ChatGetCommand,
	ChatListCommand,
	ChatMessagesCommand,
	ChatRenameCommand,
	ChatResetCommand,
	ChatStatusCommand,
	ChatSubscribeCommand,
	ChatTasksGetCommand,
	ChatTasksListCommand,
	ChatUpdateCommand,
	CommandType,
	FamilyCreateCommand,
	FamilyDeleteCommand,
	FamilyGetCommand,
	FamilyListCommand,
	FamilyUpdateCommand,
	FileDeleteCommand,
	FileListCommand,
	FileReadCommand,
	FileWriteCommand,
	KnowledgeSearchCommand,
	ScheduleCreateCommand,
	ScheduleDeleteCommand,
	ScheduleListCommand,
	ScheduleUpdateCommand,
	SystemAccountsCreateCommand,
	SystemAccountsListCommand,
	SystemAccountsRenameCommand,
	SystemAccountsResumeCommand,
	SystemAccountsSuspendCommand,
	SystemAuditListCommand,
	SystemMembersInviteCommand,
	SystemMembersListCommand,
	SystemMembersRemoveCommand,
	SystemMembersUpdateCommand,
	SystemUsersDisableCommand,
	SystemUsersEnableCommand,
	SystemUsersRevokeSessionsCommand,
	TurnAbortCommand,
	TurnInterruptCommand,
	TurnSteerCommand,
	TurnSubmitCommand,
} from "./commands.js";
import type { CommandResultFrame } from "./frames.js";
import type {
	AuthAssumeRoleCommand,
	AuthLoginDevPasswordCommand,
	AuthLoginGoogleStartCommand,
	AuthLoginGoogleStartResult,
	AuthLoginProvidersCommand,
	AuthLoginProvidersResult,
	AuthLoginSessionResult,
	AuthSessionLogoutCommand,
	AuthSessionLogoutResult,
	AuthSessionRefreshCommand,
} from "./login.js";
import type {
	AccountOAuthCancelCommand,
	AccountOAuthCancelResult,
	AccountOAuthProvidersCommand,
	AccountOAuthProvidersResult,
	AccountOAuthStartCommand,
	AccountOAuthStartResult,
	AccountOAuthStatusCommand,
	AccountOAuthStatusResult,
	AccountOAuthSubmitCommand,
	AccountOAuthSubmitResult,
} from "./oauth.js";
import type {
	AccountAuditListResult,
	AccountCredentialsDeleteResult,
	AccountCredentialsListResult,
	AccountCredentialsSetResult,
	AccountGetResult,
	AccountInvitesListResult,
	AccountInvitesRevokeResult,
	AccountMembersInviteResult,
	AccountMembersListResult,
	AccountMembersRemoveResult,
	AccountMembersUpdateResult,
	AccountModelsListResult,
	AccountToolsEnvsCreateResult,
	AccountToolsEnvsDeleteResult,
	AccountToolsEnvsDeregisterResult,
	AccountToolsEnvsListResult,
	AccountToolsEnvsPairResult,
	AccountToolsEnvsUpdateResult,
	AccountUpdateResult,
	AuthElevateResult,
	AuthElevationEndResult,
	AuthMembershipsListResult,
	AuthMethodsDeleteResult,
	AuthMethodsListResult,
	AuthSessionsListResult,
	AuthSessionsRevokeOthersResult,
	AuthSessionsRevokeResult,
	AuthTicketResult,
	AuthWhoamiResult,
	BotCreateResult,
	BotDeleteResult,
	BotGetResult,
	BotListResult,
	BotUpdateResult,
	ChatCloseResult,
	ChatCreateResult,
	ChatDeleteResult,
	ChatEntriesResult,
	ChatGetResult,
	ChatListResult,
	ChatMessagesResult,
	ChatRenameResult,
	ChatResetResult,
	ChatStatusResult,
	ChatSubscribeResult,
	ChatTasksGetResult,
	ChatTasksListResult,
	ChatUpdateResult,
	FamilyCreateResult,
	FamilyDeleteResult,
	FamilyGetResult,
	FamilyListResult,
	FamilyUpdateResult,
	FileDeleteResult,
	FileListResult,
	FileReadResult,
	FileWriteResult,
	KnowledgeSearchResults,
	ScheduleCreateResult,
	ScheduleDeleteResult,
	ScheduleListResult,
	ScheduleUpdateResult,
	SystemAccountsCreateResult,
	SystemAccountsListResult,
	SystemAccountsRenameResult,
	SystemAccountsResumeResult,
	SystemAccountsSuspendResult,
	SystemAuditListResult,
	SystemMembersListResult,
	SystemUsersDisableResult,
	SystemUsersEnableResult,
	SystemUsersRevokeSessionsResult,
	TurnAbortResult,
	TurnInterruptResult,
	TurnSteerResult,
	TurnSubmitResult,
} from "./results.js";

// ─── RPC Contracts & Central Registry ────────────────────────────────────────

/**
 * Generic RPC contract template pairing a command with its expected success result.
 */
export type Rpc<
	TCommand extends { type: string; payload?: unknown },
	TResult,
> = {
	/** Originating command object. */
	command: TCommand;
	/** Command type discriminant string. */
	type: TCommand["type"];
	/** Parameter payload type extracted from the command. */
	payload: TCommand extends { payload?: infer P } ? P : undefined;
	/** Expected success result type. */
	result: TResult;
	/** Result envelope frame wrapping the success result. */
	frame: CommandResultFrame<TResult>;
};

/** RPC contract for `account.get`: retrieves account record, members, families, and configured credentials. */
export type AccountGetRpc = Rpc<AccountGetCommand, AccountGetResult>;

/** RPC contract for `account.update`: updates account display name and default timezone. */
export type AccountUpdateRpc = Rpc<AccountUpdateCommand, AccountUpdateResult>;

/** RPC contract for `account.members.list`: lists all members of the account. */
export type AccountMembersListRpc = Rpc<
	AccountMembersListCommand,
	AccountMembersListResult
>;

export type AccountMembersInviteRpc = Rpc<
	AccountMembersInviteCommand,
	AccountMembersInviteResult
>;
export type AccountMembersUpdateRpc = Rpc<
	AccountMembersUpdateCommand,
	AccountMembersUpdateResult
>;
export type AccountMembersRemoveRpc = Rpc<
	AccountMembersRemoveCommand,
	AccountMembersRemoveResult
>;
export type AccountAuditListRpc = Rpc<
	AccountAuditListCommand,
	AccountAuditListResult
>;
export type AccountInvitesListRpc = Rpc<
	AccountInvitesListCommand,
	AccountInvitesListResult
>;
export type AccountInvitesRevokeRpc = Rpc<
	AccountInvitesRevokeCommand,
	AccountInvitesRevokeResult
>;
/** RPC contract for `account.credentials.list`: lists sanitized AI provider credential summaries. */
export type AccountCredentialsListRpc = Rpc<
	AccountCredentialsListCommand,
	AccountCredentialsListResult
>;

/** RPC contract for `account.credentials.set`: stores encrypted BYOK credentials (API key or OAuth token). */
export type AccountCredentialsSetRpc = Rpc<
	AccountCredentialsSetCommand,
	AccountCredentialsSetResult
>;

/** RPC contract for `account.credentials.delete`: removes credentials for a provider. */
export type AccountCredentialsDeleteRpc = Rpc<
	AccountCredentialsDeleteCommand,
	AccountCredentialsDeleteResult
>;

/** RPC contract for `account.models.list`: lists available models and capability metadata. */
export type AccountModelsListRpc = Rpc<
	AccountModelsListCommand,
	AccountModelsListResult
>;

/** RPC contract for `account.credentials.oauth.providers`: lists supported OAuth providers and flow mechanisms. */
export type AccountOAuthProvidersRpc = Rpc<
	AccountOAuthProvidersCommand,
	AccountOAuthProvidersResult
>;

/** RPC contract for `account.credentials.oauth.start`: begins an OAuth authentication flow. */
export type AccountOAuthStartRpc = Rpc<
	AccountOAuthStartCommand,
	AccountOAuthStartResult
>;

/** RPC contract for `account.credentials.oauth.status`: queries active OAuth flow state. */
export type AccountOAuthStatusRpc = Rpc<
	AccountOAuthStatusCommand,
	AccountOAuthStatusResult
>;

/** RPC contract for `account.credentials.oauth.submit`: advances an OAuth flow with user-supplied input. */
export type AccountOAuthSubmitRpc = Rpc<
	AccountOAuthSubmitCommand,
	AccountOAuthSubmitResult
>;

/** RPC contract for `account.credentials.oauth.cancel`: cancels an active OAuth flow. */
export type AccountOAuthCancelRpc = Rpc<
	AccountOAuthCancelCommand,
	AccountOAuthCancelResult
>;

/** RPC contract for `family.list`: lists all bot families belonging to the account. */
export type AuthWhoamiRpc = Rpc<AuthWhoamiCommand, AuthWhoamiResult>;
export type AuthTicketRpc = Rpc<AuthTicketCommand, AuthTicketResult>;
export type AuthSessionsListRpc = Rpc<
	AuthSessionsListCommand,
	AuthSessionsListResult
>;
export type AuthSessionsRevokeRpc = Rpc<
	AuthSessionsRevokeCommand,
	AuthSessionsRevokeResult
>;
export type SystemAccountsListRpc = Rpc<
	SystemAccountsListCommand,
	SystemAccountsListResult
>;
export type SystemAccountsCreateRpc = Rpc<
	SystemAccountsCreateCommand,
	SystemAccountsCreateResult
>;
export type SystemAccountsSuspendRpc = Rpc<
	SystemAccountsSuspendCommand,
	SystemAccountsSuspendResult
>;
export type SystemAccountsResumeRpc = Rpc<
	SystemAccountsResumeCommand,
	SystemAccountsResumeResult
>;
export type SystemAccountsRenameRpc = Rpc<
	SystemAccountsRenameCommand,
	SystemAccountsRenameResult
>;
export type SystemAuditListRpc = Rpc<
	SystemAuditListCommand,
	SystemAuditListResult
>;
export type SystemMembersListRpc = Rpc<
	SystemMembersListCommand,
	SystemMembersListResult
>;
export type SystemMembersInviteRpc = Rpc<
	SystemMembersInviteCommand,
	AccountMembersInviteResult
>;
export type SystemMembersUpdateRpc = Rpc<
	SystemMembersUpdateCommand,
	AccountMembersUpdateResult
>;
export type SystemMembersRemoveRpc = Rpc<
	SystemMembersRemoveCommand,
	AccountMembersRemoveResult
>;
export type SystemUsersDisableRpc = Rpc<
	SystemUsersDisableCommand,
	SystemUsersDisableResult
>;
export type SystemUsersEnableRpc = Rpc<
	SystemUsersEnableCommand,
	SystemUsersEnableResult
>;
export type SystemUsersRevokeSessionsRpc = Rpc<
	SystemUsersRevokeSessionsCommand,
	SystemUsersRevokeSessionsResult
>;
export type AuthElevateRpc = Rpc<AuthElevateCommand, AuthElevateResult>;
export type AuthElevationEndRpc = Rpc<
	AuthElevationEndCommand,
	AuthElevationEndResult
>;
export type AuthSessionsRevokeOthersRpc = Rpc<
	AuthSessionsRevokeOthersCommand,
	AuthSessionsRevokeOthersResult
>;
export type AuthMembershipsListRpc = Rpc<
	AuthMembershipsListCommand,
	AuthMembershipsListResult
>;
export type AuthMethodsListRpc = Rpc<
	AuthMethodsListCommand,
	AuthMethodsListResult
>;
export type AuthMethodsDeleteRpc = Rpc<
	AuthMethodsDeleteCommand,
	AuthMethodsDeleteResult
>;
export type AuthLoginProvidersRpc = Rpc<
	AuthLoginProvidersCommand,
	AuthLoginProvidersResult
>;
export type AuthAssumeRoleRpc = Rpc<
	AuthAssumeRoleCommand,
	AuthLoginSessionResult
>;
export type AuthLoginDevPasswordRpc = Rpc<
	AuthLoginDevPasswordCommand,
	AuthLoginSessionResult
>;
export type AuthLoginGoogleStartRpc = Rpc<
	AuthLoginGoogleStartCommand,
	AuthLoginGoogleStartResult
>;
export type AuthSessionRefreshRpc = Rpc<
	AuthSessionRefreshCommand,
	AuthLoginSessionResult
>;
export type AuthSessionLogoutRpc = Rpc<
	AuthSessionLogoutCommand,
	AuthSessionLogoutResult
>;
export type FamilyListRpc = Rpc<FamilyListCommand, FamilyListResult>;

/** RPC contract for `family.create`: registers and provisions a new bot family Durable Object instance. */
export type FamilyCreateRpc = Rpc<FamilyCreateCommand, FamilyCreateResult>;

/** RPC contract for `family.get`: retrieves metadata for a bot family. */
export type FamilyGetRpc = Rpc<FamilyGetCommand, FamilyGetResult>;

/** RPC contract for `family.update`: updates bot family settings (name, timezone, harvest delay). */
export type FamilyUpdateRpc = Rpc<FamilyUpdateCommand, FamilyUpdateResult>;

/** RPC contract for `family.delete`: permanently deletes a bot family. */
export type FamilyDeleteRpc = Rpc<FamilyDeleteCommand, FamilyDeleteResult>;

/** RPC contract for `bot.list`: lists all bot personas in the family. */
export type BotListRpc = Rpc<BotListCommand, BotListResult>;

/** RPC contract for `bot.create`: provisions a new bot persona with initial virtual files, optional timezone, and optional metadata. */
export type BotCreateRpc = Rpc<BotCreateCommand, BotCreateResult>;

/** RPC contract for `bot.get`: retrieves bot record (including metadata), SOUL.md prompt, memory, and knowledge base. */
export type BotGetRpc = Rpc<BotGetCommand, BotGetResult>;

/** RPC contract for `bot.update`: updates bot configuration, model, thinking budget, tools, soul, timezone, or metadata. Omitted `tools` is unchanged. `null` clears the allowlist back to the default set. An array, including `[]`, replaces the allowlist. `metadata` is a patch (`null` deletes a key). */
export type BotUpdateRpc = Rpc<BotUpdateCommand, BotUpdateResult>;

/** RPC contract for `bot.delete`: deletes a bot persona. */
export type BotDeleteRpc = Rpc<BotDeleteCommand, BotDeleteResult>;

/** RPC contract for `chat.create`: creates a new conversation thread with a bot. */
export type ChatCreateRpc = Rpc<ChatCreateCommand, ChatCreateResult>;

/** RPC contract for `chat.list`: lists conversation threads in the family. */
export type ChatListRpc = Rpc<ChatListCommand, ChatListResult>;

/** RPC contract for `chat.get`: retrieves full chat state, busy flag, messages, entries, and harvest notes. */
export type ChatGetRpc = Rpc<ChatGetCommand, ChatGetResult>;

/** RPC contract for `chat.rename`: renames a chat conversation title. */
export type ChatRenameRpc = Rpc<ChatRenameCommand, ChatRenameResult>;

/** RPC contract for `chat.close`: closes and archives a chat conversation. */
export type ChatCloseRpc = Rpc<ChatCloseCommand, ChatCloseResult>;

/** RPC contract for `chat.delete`: soft-deletes a chat conversation. */
export type ChatDeleteRpc = Rpc<ChatDeleteCommand, ChatDeleteResult>;

/** RPC contract for `chat.reset`: resets conversation history while keeping the routing key. */
export type ChatResetRpc = Rpc<ChatResetCommand, ChatResetResult>;

/** RPC contract for `chat.messages`: retrieves the message history of a chat. */
export type ChatMessagesRpc = Rpc<ChatMessagesCommand, ChatMessagesResult>;

/** RPC contract for `chat.entries`: retrieves transcript entries of a chat. */
export type ChatEntriesRpc = Rpc<ChatEntriesCommand, ChatEntriesResult>;

/** RPC contract for `chat.status`: retrieves live runtime execution status. */
export type ChatStatusRpc = Rpc<ChatStatusCommand, ChatStatusResult>;

/** RPC contract for `chat.subscribe`: subscribes the active connection to real-time chat events. */
export type ChatSubscribeRpc = Rpc<ChatSubscribeCommand, ChatSubscribeResult>;

/** RPC contract for `turn.submit`: submits a user message turn to run through the model. */
export type TurnSubmitRpc = Rpc<TurnSubmitCommand, TurnSubmitResult>;

/** RPC contract for `turn.steer`: steers an in-progress model turn with guidance. */
export type TurnSteerRpc = Rpc<TurnSteerCommand, TurnSteerResult>;

/** RPC contract for `turn.interrupt`: interrupts and cancels the active model turn. */
export type TurnInterruptRpc = Rpc<TurnInterruptCommand, TurnInterruptResult>;

/** RPC contract for `turn.abort`: aborts the active model turn (synonym for turn.interrupt). */
export type TurnAbortRpc = Rpc<TurnAbortCommand, TurnAbortResult>;

/** RPC contract for `file.list`: lists virtual workspace files for a bot. */
export type FileListRpc = Rpc<FileListCommand, FileListResult>;

/** RPC contract for `file.read`: reads a virtual workspace file's content and version. */
export type FileReadRpc = Rpc<FileReadCommand, FileReadResult>;

/** RPC contract for `file.write`: writes or deletes a virtual workspace file with optimistic concurrency. */
export type FileWriteRpc = Rpc<FileWriteCommand, FileWriteResult>;

/** RPC contract for `file.delete`: deletes a virtual workspace file. */
export type FileDeleteRpc = Rpc<FileDeleteCommand, FileDeleteResult>;

/** RPC contract for `knowledge.search`: searches knowledge documents for a bot. */
export type KnowledgeSearchRpc = Rpc<
	KnowledgeSearchCommand,
	KnowledgeSearchResults
>;

/** RPC contract for `schedule.create`: schedules a recurring cron job or delayed timer. */
export type ScheduleCreateRpc = Rpc<
	ScheduleCreateCommand,
	ScheduleCreateResult
>;

/** RPC contract for `schedule.list`: lists scheduled tasks for a bot. */
export type ScheduleListRpc = Rpc<ScheduleListCommand, ScheduleListResult>;

/** RPC contract for `schedule.update`: updates a scheduled task's timing, prompt, or enabled state. */
export type ScheduleUpdateRpc = Rpc<
	ScheduleUpdateCommand,
	ScheduleUpdateResult
>;

/** RPC contract for `schedule.delete`: deletes a scheduled task. */
export type ScheduleDeleteRpc = Rpc<
	ScheduleDeleteCommand,
	ScheduleDeleteResult
>;

export type ChatUpdateRpc = Rpc<ChatUpdateCommand, ChatUpdateResult>;

export type ChatTasksListRpc = Rpc<ChatTasksListCommand, ChatTasksListResult>;

export type ChatTasksGetRpc = Rpc<ChatTasksGetCommand, ChatTasksGetResult>;
export type AccountToolsEnvsListRpc = Rpc<
	AccountToolsEnvsListCommand,
	AccountToolsEnvsListResult
>;
export type AccountToolsEnvsCreateRpc = Rpc<
	AccountToolsEnvsCreateCommand,
	AccountToolsEnvsCreateResult
>;
export type AccountToolsEnvsUpdateRpc = Rpc<
	AccountToolsEnvsUpdateCommand,
	AccountToolsEnvsUpdateResult
>;
export type AccountToolsEnvsDeleteRpc = Rpc<
	AccountToolsEnvsDeleteCommand,
	AccountToolsEnvsDeleteResult
>;
export type AccountToolsEnvsPairRpc = Rpc<
	AccountToolsEnvsPairCommand,
	AccountToolsEnvsPairResult
>;
export type AccountToolsEnvsDeregisterRpc = Rpc<
	AccountToolsEnvsDeregisterCommand,
	AccountToolsEnvsDeregisterResult
>;

/** Central registry mapping every protocol command type to its RPC contract. */
export interface RpcMap {
	"account.get": AccountGetRpc;
	"account.update": AccountUpdateRpc;
	"account.members.list": AccountMembersListRpc;
	"account.members.invite": AccountMembersInviteRpc;
	"account.members.update": AccountMembersUpdateRpc;
	"account.members.remove": AccountMembersRemoveRpc;
	"account.invites.list": AccountInvitesListRpc;
	"account.audit.list": AccountAuditListRpc;
	"account.invites.revoke": AccountInvitesRevokeRpc;
	"account.credentials.list": AccountCredentialsListRpc;
	"account.credentials.set": AccountCredentialsSetRpc;
	"account.credentials.delete": AccountCredentialsDeleteRpc;
	"account.models.list": AccountModelsListRpc;
	"account.credentials.oauth.providers": AccountOAuthProvidersRpc;
	"account.credentials.oauth.start": AccountOAuthStartRpc;
	"account.credentials.oauth.status": AccountOAuthStatusRpc;
	"account.credentials.oauth.submit": AccountOAuthSubmitRpc;
	"account.credentials.oauth.cancel": AccountOAuthCancelRpc;
	"auth.whoami": AuthWhoamiRpc;
	"auth.ticket": AuthTicketRpc;
	"auth.sessions.list": AuthSessionsListRpc;
	"auth.sessions.revoke": AuthSessionsRevokeRpc;
	"auth.sessions.revokeOthers": AuthSessionsRevokeOthersRpc;
	"auth.elevate": AuthElevateRpc;
	"system.accounts.list": SystemAccountsListRpc;
	"system.accounts.create": SystemAccountsCreateRpc;
	"system.accounts.suspend": SystemAccountsSuspendRpc;
	"system.accounts.resume": SystemAccountsResumeRpc;
	"system.accounts.rename": SystemAccountsRenameRpc;
	"system.audit.list": SystemAuditListRpc;
	"system.members.list": SystemMembersListRpc;
	"system.members.invite": SystemMembersInviteRpc;
	"system.members.update": SystemMembersUpdateRpc;
	"system.members.remove": SystemMembersRemoveRpc;
	"system.users.disable": SystemUsersDisableRpc;
	"system.users.enable": SystemUsersEnableRpc;
	"system.users.revokeSessions": SystemUsersRevokeSessionsRpc;
	"auth.elevation.end": AuthElevationEndRpc;
	"auth.memberships.list": AuthMembershipsListRpc;
	"auth.methods.list": AuthMethodsListRpc;
	"auth.methods.delete": AuthMethodsDeleteRpc;
	"auth.login.providers": AuthLoginProvidersRpc;
	"auth.assumeRole": AuthAssumeRoleRpc;
	"auth.login.devPassword": AuthLoginDevPasswordRpc;
	"auth.login.google.start": AuthLoginGoogleStartRpc;
	"auth.session.refresh": AuthSessionRefreshRpc;
	"auth.session.logout": AuthSessionLogoutRpc;
	"family.list": FamilyListRpc;
	"family.create": FamilyCreateRpc;
	"family.get": FamilyGetRpc;
	"family.update": FamilyUpdateRpc;
	"family.delete": FamilyDeleteRpc;
	"bot.list": BotListRpc;
	"bot.create": BotCreateRpc;
	"bot.get": BotGetRpc;
	"bot.update": BotUpdateRpc;
	"bot.delete": BotDeleteRpc;
	"chat.create": ChatCreateRpc;
	"chat.list": ChatListRpc;
	"chat.get": ChatGetRpc;
	"chat.rename": ChatRenameRpc;
	"chat.close": ChatCloseRpc;
	"chat.delete": ChatDeleteRpc;
	"chat.reset": ChatResetRpc;
	"chat.messages": ChatMessagesRpc;
	"chat.entries": ChatEntriesRpc;
	"chat.status": ChatStatusRpc;
	"chat.subscribe": ChatSubscribeRpc;
	"turn.submit": TurnSubmitRpc;
	"turn.steer": TurnSteerRpc;
	"turn.interrupt": TurnInterruptRpc;
	"turn.abort": TurnAbortRpc;
	"file.list": FileListRpc;
	"file.read": FileReadRpc;
	"file.write": FileWriteRpc;
	"file.delete": FileDeleteRpc;
	"knowledge.search": KnowledgeSearchRpc;
	"schedule.create": ScheduleCreateRpc;
	"schedule.list": ScheduleListRpc;
	"schedule.update": ScheduleUpdateRpc;
	"schedule.delete": ScheduleDeleteRpc;
	"chat.update": ChatUpdateRpc;
	"chat.tasks.list": ChatTasksListRpc;
	"chat.tasks.get": ChatTasksGetRpc;
	"account.toolsEnvs.list": AccountToolsEnvsListRpc;
	"account.toolsEnvs.create": AccountToolsEnvsCreateRpc;
	"account.toolsEnvs.update": AccountToolsEnvsUpdateRpc;
	"account.toolsEnvs.delete": AccountToolsEnvsDeleteRpc;
	"account.toolsEnvs.pair": AccountToolsEnvsPairRpc;
	"account.toolsEnvs.deregister": AccountToolsEnvsDeregisterRpc;
}

/** Union of all recognized command type strings in the RPC registry. */
export type RpcType = keyof RpcMap;

/** Extracts the payload type for a specific command type K. */
export type RpcPayload<K extends RpcType> = RpcMap[K]["payload"];

/** Extracts the success result type for a specific command type K. */
export type RpcResult<K extends RpcType> = RpcMap[K]["result"];

/** Result frame envelope wrapping the success result type for command type K. */
export type RpcFrame<K extends RpcType> = CommandResultFrame<RpcResult<K>>;

type _RpcCommandMismatch =
	| Exclude<CommandType, RpcType>
	| Exclude<RpcType, CommandType>;
type _AssertRpcKeys<_T extends true> = _T;
type _RpcKeysMatch = _AssertRpcKeys<
	[_RpcCommandMismatch] extends [never] ? true : never
>;
