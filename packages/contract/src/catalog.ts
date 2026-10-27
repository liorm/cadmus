import type { CommandType } from "./commands.js";
import {
	AccountCredentialsDeleteCommandSchema,
	AccountCredentialsListCommandSchema,
	AccountCredentialsSetCommandSchema,
	AccountGetCommandSchema,
	AccountMembersAddCommandSchema,
	AccountMembersListCommandSchema,
	AccountModelsListCommandSchema,
	AccountToolsEnvSecretsDeleteCommandSchema,
	AccountToolsEnvSecretsListCommandSchema,
	AccountToolsEnvSecretsSetCommandSchema,
	AccountToolsEnvsCreateCommandSchema,
	AccountToolsEnvsDeleteCommandSchema,
	AccountToolsEnvsDeregisterCommandSchema,
	AccountToolsEnvsListCommandSchema,
	AccountToolsEnvsPairCommandSchema,
	AccountToolsEnvsUpdateCommandSchema,
	AccountUpdateCommandSchema,
	BotCreateCommandSchema,
	BotDeleteCommandSchema,
	BotGetCommandSchema,
	BotListCommandSchema,
	BotUpdateCommandSchema,
	ChatCloseCommandSchema,
	ChatCreateCommandSchema,
	ChatEntriesCommandSchema,
	ChatGetCommandSchema,
	ChatListCommandSchema,
	ChatMessagesCommandSchema,
	ChatRenameCommandSchema,
	ChatResetCommandSchema,
	ChatStatusCommandSchema,
	ChatSubscribeCommandSchema,
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
	TurnAbortCommandSchema,
	TurnCommandCommandSchema,
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
	AccountCredentialsDeleteResultSchema,
	AccountCredentialsListResultSchema,
	AccountCredentialsSetResultSchema,
	AccountGetResultSchema,
	AccountMembersAddResultSchema,
	AccountMembersListResultSchema,
	AccountModelsListResultSchema,
	AccountToolsEnvSecretsDeleteResultSchema,
	AccountToolsEnvSecretsListResultSchema,
	AccountToolsEnvSecretsSetResultSchema,
	AccountToolsEnvsCreateResultSchema,
	AccountToolsEnvsDeleteResultSchema,
	AccountToolsEnvsDeregisterResultSchema,
	AccountToolsEnvsListResultSchema,
	AccountToolsEnvsPairResultSchema,
	AccountToolsEnvsUpdateResultSchema,
	AccountUpdateResultSchema,
	BotCreateResultSchema,
	BotDeleteResultSchema,
	BotGetResultSchema,
	BotListResultSchema,
	BotUpdateResultSchema,
	ChatCloseResultSchema,
	ChatCreateResultSchema,
	ChatGetResultSchema,
	ChatListResultSchema,
	ChatRenameResultSchema,
	ChatResetResultSchema,
	ChatStatusResultSchema,
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
	TurnCommandResultSchema,
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
	"turn.submit": {
		command: TurnSubmitCommandSchema,
		result: TurnSubmitResultSchema,
	},
	"turn.command": {
		command: TurnCommandCommandSchema,
		result: TurnCommandResultSchema,
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
	"account.toolsEnvSecrets.list": {
		command: AccountToolsEnvSecretsListCommandSchema,
		result: AccountToolsEnvSecretsListResultSchema,
	},
	"account.toolsEnvSecrets.set": {
		command: AccountToolsEnvSecretsSetCommandSchema,
		result: AccountToolsEnvSecretsSetResultSchema,
	},
	"account.toolsEnvSecrets.delete": {
		command: AccountToolsEnvSecretsDeleteCommandSchema,
		result: AccountToolsEnvSecretsDeleteResultSchema,
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
