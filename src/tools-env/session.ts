import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import { ProtocolValidationError } from "../protocol/validate.js";
import type {
	BotRecord,
	ToolsEnvBinding,
	ToolsEnvSetting,
} from "../protocol.js";
import type { StoredToolsEnv } from "../store/admin-interface.js";
import type { D1AdminStore } from "../store/d1-admin.js";
import type { FamilyStore } from "../store/family-interface.js";
import type { CadmusEnvDO } from "./env-do.js";
import {
	createOfflineExecutionEnv,
	createProxyExecutionEnv,
} from "./proxy-env.js";
import {
	assertDaemonEnvWrite,
	assertJustBashEnvWrite,
	assertToolsEnvWrite,
	CODING_TOOL_NAMES,
	daemonCwd,
	envDoName,
	executionEnvId,
	type ResolvedToolsEnv,
	resolveToolsEnv,
	runtimeToolsEnvOn,
	scopeString,
	storageFamilyId,
	supportsConfinement,
	WORKSPACE_ROOT,
} from "./pure.js";
import type { ConnectionSnapshot } from "./ws-backend.js";

export class ToolsEnvController {
	private catalogCache:
		| { defs: Map<string, StoredToolsEnv>; defaultEnv: ToolsEnvBinding | null }
		| undefined;

	constructor(
		private readonly deps: {
			accountId: () => string;
			familyId: () => string;
			admin: D1AdminStore;
			envs: DurableObjectNamespace<CadmusEnvDO>;
			store: FamilyStore;
		},
	) {}

	invalidate(): void {
		this.catalogCache = undefined;
	}

	private stub(envId: string): DurableObjectStub<CadmusEnvDO> {
		return this.deps.envs.getByName(envDoName(this.deps.accountId(), envId));
	}

	async catalog(): Promise<{
		defs: Map<string, StoredToolsEnv>;
		defaultEnv: ToolsEnvBinding | null;
	}> {
		if (this.catalogCache) return this.catalogCache;
		const account = await this.deps.admin.getAccount(this.deps.accountId());
		const rows = await this.deps.admin.listToolsEnvs(this.deps.accountId());
		const defs = new Map(rows.map((row) => [row.envId, row]));
		this.catalogCache = {
			defs,
			defaultEnv: account?.defaultToolsEnv ?? null,
		};
		return this.catalogCache;
	}

	private lookup(envId: string, defs: Map<string, StoredToolsEnv>) {
		const def = defs.get(envId);
		return def ? { kind: def.kind } : undefined;
	}

	async assertSetting(
		setting: ToolsEnvSetting | null,
		level: "bot" | "chat",
		botSetting?: ToolsEnvSetting | null,
	): Promise<void> {
		const catalog = await this.catalog();
		assertToolsEnvWrite({
			setting,
			level,
			botSetting,
			accountDefault: catalog.defaultEnv,
			lookup: (envId) => this.lookup(envId, catalog.defs),
		});
	}

	async resolvedFor(
		bot: BotRecord,
		chatSetting: ToolsEnvSetting | null | undefined,
	): Promise<{ resolved: ResolvedToolsEnv; def?: StoredToolsEnv }> {
		const catalog = await this.catalog();
		const resolved = resolveToolsEnv({
			chat: chatSetting,
			bot: bot.toolsEnv ?? null,
			account: catalog.defaultEnv,
		});
		const def = resolved.binding
			? catalog.defs.get(resolved.binding.envId)
			: undefined;
		return { resolved, def };
	}

	async willOffer(
		bot: BotRecord,
		chatSetting: ToolsEnvSetting | null,
	): Promise<boolean> {
		if (!bot.tools) return false;
		if (!CODING_TOOL_NAMES.some((name) => bot.tools?.includes(name)))
			return false;
		const { resolved, def } = await this.resolvedFor(bot, chatSetting);
		return (
			runtimeToolsEnvOn(resolved) &&
			(def?.kind === "just-bash" || def?.kind === "local-daemon")
		);
	}

	async offerCodingTools(
		conversationId: number,
		bot: BotRecord,
	): Promise<boolean> {
		const route = this.deps.store.chats.getConversationRoute(conversationId);
		if (route && !route.toolsEnvEnabled) return false;
		const chat = route
			? this.deps.store.chats.getChat(route.chatKey)
			: undefined;
		return this.willOffer(bot, chat?.toolsEnv ?? null);
	}

	async codingToolAllowed(
		conversationId: number,
		bot: BotRecord,
		toolName: string,
	): Promise<boolean> {
		if (!bot.tools?.includes(toolName)) return false;
		return this.offerCodingTools(conversationId, bot);
	}

	async open(
		conversationId: number,
		cwd: string | undefined,
	): Promise<ExecutionEnv | undefined> {
		const botId = cwd?.trim();
		if (!botId) return undefined;
		const bot = this.deps.store.bots.getBot(botId);
		if (!bot) return undefined;
		const route = this.deps.store.chats.getConversationRoute(conversationId);
		if (route && !route.toolsEnvEnabled) return undefined;
		const chat = route
			? this.deps.store.chats.getChat(route.chatKey)
			: undefined;
		const { resolved, def } = await this.resolvedFor(
			bot,
			chat?.toolsEnv ?? null,
		);
		if (!runtimeToolsEnvOn(resolved) || !resolved.binding || !def) {
			return undefined;
		}
		if (def.kind !== "just-bash" && def.kind !== "local-daemon") {
			return undefined;
		}
		const connection = await this.stub(def.envId).getConnection(
			def.kind === "local-daemon" ? "local-daemon" : "just-bash",
		);
		if (connection.status !== "connected") {
			return createOfflineExecutionEnv(
				executionEnvId({
					kind: "daemon",
					accountId: this.deps.accountId(),
					envId: def.envId,
				}),
				daemonCwd(def),
			);
		}
		const scopeId = bot.id;
		const scope = scopeString("bot", scopeId);
		const familyId = this.deps.familyId();
		if (def.kind === "local-daemon") {
			return createProxyExecutionEnv({
				stub: this.stub(def.envId),
				id: executionEnvId({
					kind: "daemon",
					accountId: this.deps.accountId(),
					envId: def.envId,
				}),
				cwd: daemonCwd(def),
				pathMode: "host",
				call: {
					storageFamilyId: "",
					scope: "",
					botId: bot.id,
					chatKey: "",
					usageFamilyId: familyId,
					persist: def.persist,
					backend: "ws-remote",
				},
			});
		}
		return createProxyExecutionEnv({
			stub: this.stub(def.envId),
			id: executionEnvId({
				kind: "just-bash",
				accountId: this.deps.accountId(),
				envId: def.envId,
				sharedWorkspace: def.sharedWorkspace,
				familyId,
				scope,
			}),
			call: {
				storageFamilyId: storageFamilyId(def.sharedWorkspace, familyId),
				scope,
				botId: bot.id,
				chatKey: "",
				usageFamilyId: familyId,
				persist: def.persist,
			},
		});
	}

	async statusForChat(chatKey: string): Promise<{
		enabled: boolean;
		enabledSource: string;
		kind?: string;
		envId?: string;
		bindingSource?: string;
		status?: "connected" | "disconnected";
		connectedAt?: number;
		lastError?: string;
	}> {
		const chat = this.deps.store.chats.getChat(chatKey);
		const bot = chat ? this.deps.store.bots.getBot(chat.botId) : undefined;
		if (!chat || !bot) {
			return { enabled: false, enabledSource: "unbound" };
		}
		const { resolved, def } = await this.resolvedFor(
			bot,
			chat.toolsEnv ?? null,
		);
		if (!runtimeToolsEnvOn(resolved) || !def) {
			return {
				enabled: false,
				enabledSource: resolved.enabledSource,
				bindingSource: resolved.bindingSource,
				envId: resolved.binding?.envId,
			};
		}
		const connection = await this.connectionFor(def);
		return {
			enabled: true,
			enabledSource: resolved.enabledSource,
			bindingSource: resolved.bindingSource,
			kind: def.kind,
			envId: def.envId,
			status: connection.status,
			...(connection.connectedAt !== undefined
				? { connectedAt: connection.connectedAt }
				: {}),
			...(connection.lastError ? { lastError: connection.lastError } : {}),
		};
	}

	async connectionFor(def: StoredToolsEnv): Promise<ConnectionSnapshot> {
		if (def.kind !== "local-daemon") return { status: "connected" };
		const connection = await this.stub(def.envId).getConnection("local-daemon");
		if (!connection.lastError && def.secretMissing) {
			return { ...connection, lastError: "secret_missing" };
		}
		return connection;
	}

	async resolvedFields(bot: BotRecord, chatSetting?: ToolsEnvSetting | null) {
		const { resolved, def } = await this.resolvedFor(bot, chatSetting);
		const on = runtimeToolsEnvOn(resolved) && Boolean(def);
		const connection = on && def ? await this.connectionFor(def) : undefined;
		return {
			toolsEnvEnabled: resolved.enabled && Boolean(resolved.binding),
			toolsEnvEnabledSource: resolved.enabledSource,
			toolsEnvBindingSource: resolved.bindingSource,
			effectiveToolsEnv:
				on && def && resolved.binding
					? {
							envId: def.envId,
							kind: def.kind,
							persist: def.persist,
							confineToWorkspace: def.confineToWorkspace,
							sharedWorkspace: def.sharedWorkspace,
							...(def.workspacePath
								? { workspacePath: def.workspacePath }
								: {}),
							root:
								def.kind === "local-daemon" ? daemonCwd(def) : WORKSPACE_ROOT,
						}
					: null,
			toolsEnvStatus: connection?.status,
			toolsEnvConnectedAt: connection?.connectedAt ?? null,
			toolsEnvLastError: connection?.lastError ?? null,
		};
	}

	toPublic(
		def: StoredToolsEnv,
		connection?: ConnectionSnapshot,
	): StoredToolsEnv & {
		supportsConfinement: boolean;
		secretMissing?: boolean;
		connection?: {
			status: "connected" | "disconnected";
			connectedAt?: number;
			lastError?: string;
		};
	} {
		const { secretMissing, ...rest } = def;
		const snap =
			def.kind === "local-daemon"
				? (connection ?? { status: "disconnected" as const })
				: { status: "connected" as const };
		const lastError =
			snap.lastError ??
			(def.kind === "local-daemon" && secretMissing
				? "secret_missing"
				: undefined);
		return {
			...rest,
			supportsConfinement: supportsConfinement(def.kind),
			...(secretMissing ? { secretMissing: true } : {}),
			connection: {
				status: snap.status,
				...(def.kind === "local-daemon" && snap.connectedAt !== undefined
					? { connectedAt: snap.connectedAt }
					: {}),
				...(def.kind === "local-daemon" && lastError ? { lastError } : {}),
			},
		};
	}

	async present(def: StoredToolsEnv) {
		if (def.kind !== "local-daemon") return this.toPublic(def);
		return this.toPublic(def, await this.connectionFor(def));
	}

	async createEnv(input: {
		kind: string;
		label?: string;
		persist?: boolean;
		confineToWorkspace?: boolean;
		sharedWorkspace?: boolean;
		secretId?: string;
		workspacePath?: string;
	}): Promise<StoredToolsEnv> {
		if (input.kind === "local-daemon") {
			assertDaemonEnvWrite(input);
			const secret = await this.deps.admin.getToolsEnvSecretMeta(
				this.deps.accountId(),
				input.secretId?.trim() ?? "",
			);
			if (secret?.kind !== "daemon_token") {
				throw new ProtocolValidationError(
					`Unknown tools env secret '${input.secretId ?? ""}'`,
					"not_found",
				);
			}
			const envId = `ld_${crypto.randomUUID()}`;
			const created = await this.deps.admin.createToolsEnv(
				this.deps.accountId(),
				{
					envId,
					kind: "local-daemon",
					label: input.label,
					persist: input.persist ?? true,
					confineToWorkspace: input.confineToWorkspace === true,
					sharedWorkspace: false,
					workspacePath: input.workspacePath?.trim(),
					secretId: secret.secretId,
				},
			);
			this.invalidate();
			return created;
		}
		assertJustBashEnvWrite(input);
		const envId = `jb_${crypto.randomUUID()}`;
		const created = await this.deps.admin.createToolsEnv(
			this.deps.accountId(),
			{
				envId,
				kind: "just-bash",
				label: input.label,
				persist: input.persist ?? true,
				confineToWorkspace: true,
				sharedWorkspace: input.sharedWorkspace ?? false,
			},
		);
		this.invalidate();
		return created;
	}

	async updateEnv(
		envId: string,
		patch: {
			label?: string;
			persist?: boolean;
			confineToWorkspace?: boolean;
			sharedWorkspace?: boolean;
			workspacePath?: string;
			secretId?: string;
		},
	): Promise<StoredToolsEnv> {
		const existing = await this.deps.admin.getToolsEnv(
			this.deps.accountId(),
			envId,
		);
		if (!existing) {
			throw new ProtocolValidationError(
				`Unknown tools env '${envId}'`,
				"not_found",
			);
		}
		if (existing.kind === "local-daemon") {
			const secretId = patch.secretId ?? existing.secretId;
			const workspacePath = patch.workspacePath ?? existing.workspacePath;
			assertDaemonEnvWrite({
				secretId,
				workspacePath,
				confineToWorkspace:
					patch.confineToWorkspace ?? existing.confineToWorkspace,
				sharedWorkspace: patch.sharedWorkspace ?? false,
			});
			let storedSecretId = patch.secretId;
			if (patch.secretId !== undefined) {
				const secret = await this.deps.admin.getToolsEnvSecretMeta(
					this.deps.accountId(),
					patch.secretId.trim(),
				);
				if (secret?.kind !== "daemon_token") {
					throw new ProtocolValidationError(
						`Unknown tools env secret '${patch.secretId}'`,
						"not_found",
					);
				}
				storedSecretId = secret.secretId;
			}
			const updated = await this.deps.admin.updateToolsEnv(
				this.deps.accountId(),
				envId,
				{
					...patch,
					...(storedSecretId !== undefined ? { secretId: storedSecretId } : {}),
					sharedWorkspace: false,
					...(patch.secretId !== undefined ? { secretMissing: false } : {}),
				},
			);
			if (!updated) {
				throw new ProtocolValidationError(
					`Unknown tools env '${envId}'`,
					"not_found",
				);
			}
			this.invalidate();
			const persistChanged =
				patch.persist !== undefined && patch.persist !== existing.persist;
			if (persistChanged) {
				await this.stub(envId).closeForConfig({
					deleteEphemeral: existing.persist === false,
				});
			}
			return updated;
		}
		if (existing.kind !== "just-bash") {
			throw new ProtocolValidationError(
				`Tools env '${envId}' kind '${existing.kind}' is not available`,
				"unsupported_kind",
			);
		}
		assertJustBashEnvWrite({
			kind: existing.kind,
			confineToWorkspace: patch.confineToWorkspace,
			sharedWorkspace: patch.sharedWorkspace,
			secretId: patch.secretId,
			workspacePath: patch.workspacePath,
		});
		const updated = await this.deps.admin.updateToolsEnv(
			this.deps.accountId(),
			envId,
			{
				...patch,
				confineToWorkspace:
					patch.confineToWorkspace === undefined ? undefined : true,
			},
		);
		if (!updated) {
			throw new ProtocolValidationError(
				`Unknown tools env '${envId}'`,
				"not_found",
			);
		}
		const persistChanged =
			patch.persist !== undefined && patch.persist !== existing.persist;
		const sharedChanged =
			patch.sharedWorkspace !== undefined &&
			patch.sharedWorkspace !== existing.sharedWorkspace;
		if (persistChanged || sharedChanged) {
			await this.stub(envId).applyConfig({
				persist: updated.persist,
				dropSqlite: sharedChanged || (persistChanged && !updated.persist),
				dropMemory: true,
			});
		}
		this.invalidate();
		return updated;
	}

	async deleteEnv(envId: string): Promise<void> {
		const existing = await this.deps.admin.getToolsEnv(
			this.deps.accountId(),
			envId,
		);
		if (!existing) {
			throw new ProtocolValidationError(
				`Unknown tools env '${envId}'`,
				"not_found",
			);
		}
		if (existing.kind === "local-daemon") {
			await this.stub(envId).closeForConfig({
				deleteEphemeral: existing.persist === false,
			});
		} else if (existing.kind === "just-bash") {
			await this.stub(envId).wipeEnv();
		}
		await this.deps.admin.deleteToolsEnv(this.deps.accountId(), envId);
		this.invalidate();
	}

	async listEnvs(): Promise<{
		default: ToolsEnvBinding | null;
		envs: Array<
			StoredToolsEnv & {
				supportsConfinement: boolean;
				connection?: {
					status: "connected" | "disconnected";
					connectedAt?: number;
					lastError?: string;
				};
			}
		>;
	}> {
		const catalog = await this.catalog();
		const envs = [];
		for (const def of catalog.defs.values()) {
			envs.push(await this.present(def));
		}
		return { default: catalog.defaultEnv, envs };
	}

	async deleteScopesForBot(botId: string): Promise<void> {
		const bot = this.deps.store.bots.getBot(botId);
		const catalog = await this.catalog();
		const chats = this.deps.store.chats.listChats(botId);
		const chatKeys = chats.map((chat) => chat.key);
		const envIds = new Set<string>();
		if (bot?.toolsEnv?.binding?.envId) envIds.add(bot.toolsEnv.binding.envId);
		if (catalog.defaultEnv?.envId) envIds.add(catalog.defaultEnv.envId);
		for (const chat of chats) {
			if (chat.toolsEnv?.binding?.envId)
				envIds.add(chat.toolsEnv.binding.envId);
		}
		for (const envId of envIds) {
			const def = catalog.defs.get(envId);
			if (def?.kind !== "just-bash") continue;
			await this.stub(envId).deleteNamespacesForBot(
				this.deps.familyId(),
				botId,
				def.sharedWorkspace,
				chatKeys,
			);
		}
		this.deps.store.chats.deleteConversationRoutesForBot(botId);
	}

	async dropChatNamespace(_chatKey: string, _bot: BotRecord): Promise<void> {
		// Persistent filesystem is always scoped to the bot; chats do not own an isolated namespace.
		return;
	}

	async dropPreviousBinding(input: {
		previous?: ToolsEnvSetting | null;
		next?: ToolsEnvSetting | null;
		level: "bot" | "chat";
		bot: BotRecord;
		chatKey?: string;
	}): Promise<void> {
		// Only bot-level binding changes drop the previous namespace.
		// Chat pins do not own a private namespace.
		if (input.level !== "bot") return;
		const catalog = await this.catalog();
		const previous = resolveToolsEnv({
			bot: input.previous ?? null,
			account: catalog.defaultEnv,
		});
		if (!previous.binding) return;
		const next = resolveToolsEnv({
			bot: input.next ?? null,
			account: catalog.defaultEnv,
		});
		if (next.binding?.envId === previous.binding.envId) {
			return;
		}
		const def = catalog.defs.get(previous.binding.envId);
		if (def?.kind !== "just-bash") return;
		await this.stub(def.envId).deleteNamespace(
			storageFamilyId(def.sharedWorkspace, this.deps.familyId()),
			scopeString("bot", input.bot.id),
		);
	}

	async onDefaultChanged(
		previousEnvId: string | null,
		nextEnvId: string | null,
	): Promise<void> {
		const previous = previousEnvId
			? await this.deps.admin.getToolsEnv(this.deps.accountId(), previousEnvId)
			: undefined;
		this.invalidate();
		if (!previousEnvId || previousEnvId === nextEnvId || !previous) return;
		if (previous.kind !== "just-bash") return;
		for (const bot of this.deps.store.bots.listBots()) {
			if (bot.toolsEnv?.enabled === false) continue;
			if (bot.toolsEnv?.binding?.envId) continue;
			await this.stub(previousEnvId).deleteNamespace(
				storageFamilyId(previous.sharedWorkspace, this.deps.familyId()),
				scopeString("bot", bot.id),
			);
		}
	}
}
