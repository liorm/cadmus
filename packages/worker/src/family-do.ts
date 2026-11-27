import { DurableObject } from "cloudflare:workers";
import { grantsForRole } from "@cadmus/contract/grants";
import {
	BASH_TOOL_NAME,
	CODE_EXECUTE_TOOL_NAME,
	effectiveToolNames,
	extractModelProvider,
	isWorkspaceTool,
	readOnlyGroupToolNames,
} from "@cadmus/contract/tools";
import {
	BACKGROUND_CONTEXT,
	type Context,
} from "@earendil-works/chord/context";
import type {
	AssistantMessage,
	Message,
	ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import {
	AgentDoc,
	AssistantEntry,
	CompactionEntry,
	type CompactionFailure,
	type CompactionReason,
	type CompactionStatus,
	type Conversation,
	type ConversationId,
	type ConversationView,
	type ConversationWatch,
	type Cursor,
	createRegistry,
	type EntryId,
	type EntryRecord,
	Harness,
	LiveDoc,
	type LiveState,
	ResetEntry,
	SystemEntry,
	type TaskId,
	type ToolRegistration,
	ToolResultEntry,
	UsageDoc,
	UserEntry,
} from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { StreamSweepDeadline, syncDurableObjectAlarm } from "./alarms.js";
import { withinPrincipalBudget } from "./auth-limiter.js";
import {
	authorize,
	type CallerMeta,
	callerMetaFromAttachment,
	callerMetaFromHeader,
	isElevated,
	PRINCIPAL_HEADER,
	requireSession,
} from "./authz.js";
import { assertBotMetadata, mergeMetadataPatch } from "./bot-metadata.js";
import {
	type CommandHandlerMap,
	callCommandHandler,
} from "./command-handlers.js";
import { type CadmusServices, createCadmusContext } from "./context.js";
import {
	computeInSeconds,
	isValidCron,
	nextCron,
	parseAbsoluteTime,
	parseRelativeDuration,
} from "./cron.js";
import {
	mergeDeadlines,
	resolveDeadlines,
	TurnDeadlineError,
} from "./deadlines.js";
import { getEdgeCache } from "./edge-cache.js";
import { withElevatedAudit } from "./elevated-audit.js";
import {
	cadmusDefaultExtensions,
	cadmusExtensionDescriptors,
	type ExtensionActivationContext,
	resolveConversationExtensionsAndTools,
} from "./extensions/cadmus-tools.js";
import {
	DEFAULT_CADMUS_COMPACTION_POLICY,
	estimateViewContextTokens,
	stripCompactionSummaryWrapper,
} from "./extensions/compaction.js";
import { DEFAULT_SOUL } from "./extensions/identity.js";
import {
	MEMORY_VFS_PATH,
	parseVirtualPath,
	SOUL_VFS_PATH,
	skillVfsPath,
} from "./extensions/vfs.js";
import {
	driveGroupChat,
	GroupReplyTimeout,
	groupWakeText,
	runGroupMessage,
} from "./group-chat/drive.js";
import {
	chatFields,
	ensureLogger,
	familyFields,
	getLogger,
	type Logger,
} from "./log.js";
import {
	AccountCredentialStore,
	checkModel,
	createCadmusModels,
	createWorkerAuthContext,
	getModelTier,
	getSupportedThinkingLevels,
	parseModelRef,
	parseThinkingLevel,
	pickTestModel,
	testProviderCredential,
} from "./models.js";
import { OAuthFlowManager } from "./oauth.js";
import {
	type BotRecord,
	type ChatCompactionSnapshot,
	type ChatKind,
	type ChatRecord,
	type ChatTaskLoop,
	type ClientCommand,
	type CommandResultFrame,
	type CommandType,
	type CompactionTaskView,
	type ModelInfo,
	ProtocolValidationError,
	type RawTranscriptEntry,
	type RpcResult,
	type ScheduleRecord,
	type ScheduleTarget,
	type ServerEvent,
	type ServerFrame,
	type ThinkingLevel,
	type ToolCallResultSummary,
	type ToolsEnvSetting,
	type TranscriptContentBlock,
	type TranscriptMessageView,
	type TranscriptToolCallView,
	type TurnBlock,
} from "./protocol.js";
import {
	DEFAULT_HARVEST_PROMPT,
	harvestScheduleId,
	ScheduleTask,
} from "./schedules.js";
import { defaultJsonShim, type ProtocolShim } from "./shim.js";
import { D1AdminStore, toDoName } from "./store/d1-admin.js";
import {
	type FamilyStore,
	type GroupChatRecord,
	primaryChatKey,
} from "./store/family-interface.js";
import {
	CasConflictError,
	formatSkillMarkdown,
	parseSkillMarkdown,
	SLUG_REGEX,
	SqliteFamilyStore,
} from "./store/sqlite-family.js";
import { resolveTaskMaxRounds } from "./tasks/limits.js";
import {
	formatTasksContinueMessage,
	tasksContinueRequestId,
} from "./tasks/message.js";
import { TaskContinueTask } from "./tasks/task.js";
import { assertValidIanaTimezone } from "./timezone.js";
import {
	chooseToolsEnvIdentity,
	OFFLINE_TOOLS_ENV,
	resolvePublicUrls,
	runtimeToolsEnvOn,
	WORKSPACE_ROOT,
} from "./tools-env/pure.js";
import { ToolsEnvController } from "./tools-env/session.js";
import { completionOutcome } from "./turn-completion.js";
import type { Env } from "./types.js";
import { computeBotUsage, computeChatUsage } from "./usage.js";

export interface FamilyMeta {
	accountId: string;
	familyId: string;
	name: string;
	timezone: string;
	harvestDelayMs: number;
	/** Null when this family has no Team Leader. */
	teamLeaderBotId: string | null;
}

function toToolRegs(
	names: readonly string[] | undefined,
): readonly ToolRegistration[] | null {
	if (names === undefined) return null;
	return names.map((name) => ({ name }) as unknown as ToolRegistration);
}

/** How often open streams are re-validated while idle. */
const STREAM_SWEEP_KEY = "cadmus:streamSweepAt";
const STREAM_SWEEP_MS = 60_000;

/** A session acting in one account: the key authority is swept and gated by. */
function principalKey(
	sessionId: string,
	accountId: string | undefined,
): string {
	return `${sessionId}\u0000${accountId ?? ""}`;
}

/** Marks credentials.manage holders in the per-batch authority sweep set. */
const OAUTH_MANAGER_PREFIX = "oauth-manager\u0000";

export class CadmusBotFamilyDO extends DurableObject<Env> {
	readonly familyStore: FamilyStore;
	readonly adminStore: D1AdminStore;
	readonly credentialStore: AccountCredentialStore;
	readonly shim: ProtocolShim = defaultJsonShim;

	private readonly toolsEnvController: ToolsEnvController;
	private harnessPromise?: Promise<Harness>;
	private harnessInstance?: Harness;
	private cadmusContext?: Context;
	private modelsInstance?: MutableModels;
	private oauthManager: OAuthFlowManager;
	private sseControllers = new Set<
		ReadableStreamDefaultController<Uint8Array>
	>();
	/** Session behind each SSE stream, so a revoked session's stream is closed. */
	private sseSessions = new Map<
		ReadableStreamDefaultController<Uint8Array>,
		{ sessionId: string; accountId: string | undefined }
	>();
	private lastAuthSweepAt = 0;
	private activeWatches = new Map<number, ConversationWatch>();
	private streamedAssistantContent = new Map<number, Map<number, string>>();
	private trackedCompactionTasks = new Set<number>();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		ensureLogger(env.CADMUS_LOG_LEVEL ?? env.LOG_LEVEL);
		this.familyStore = new SqliteFamilyStore(ctx.storage.sql);
		this.familyStore.ensureSchema();
		this.ensureMetaTable();
		const edgeCache = getEdgeCache(env);
		this.adminStore = new D1AdminStore({
			db: env.CADMUS_ADMIN_DB,
			encryptionKey: env.CADMUS_ENCRYPTION_KEY,
			defaultTimezone: env.CADMUS_DEFAULT_TIMEZONE,
			defaultHarvestDelayMs: env.CADMUS_HARVEST_DELAY_MS
				? Number(env.CADMUS_HARVEST_DELAY_MS)
				: 60_000,
			edgeCache,
			bootstrapEmail: env.CADMUS_BOOTSTRAP_SUPER_ADMIN_EMAIL,
			deployEnv: env.CADMUS_DEPLOY_ENV,
		});
		this.credentialStore = new AccountCredentialStore(
			this.adminStore,
			() => this.getFamilyMeta().accountId,
		);
		this.oauthManager = new OAuthFlowManager(
			this.adminStore,
			() => this.ensureModels(),
			(event) => this.broadcastEvent(event),
			(accountId, providerId) =>
				this.bustAccountCredentialCaches(accountId, providerId),
		);
		this.toolsEnvController = new ToolsEnvController({
			accountId: () => this.getFamilyMeta().accountId,
			familyId: () => this.getFamilyMeta().familyId,
			admin: this.adminStore,
			envs: env.CADMUS_ENV,
			store: this.familyStore,
		});
	}

	async invalidateCredentialCache(providerId?: string): Promise<void> {
		this.credentialStore.invalidate(providerId);
		this.log().debug("invalidated local credential cache", { providerId });
	}

	async listConversationRoutes(chatKey: string) {
		return this.familyStore.chats.listConversationRoutes(chatKey);
	}

	/** Tool and message text for one conversation. Forks are not a protocol chat. */
	async conversationToolText(conversationId: number): Promise<string> {
		const { harness, context } = await this.ensureHarness();
		const conv = await harness.conversation(
			conversationId as ConversationId,
			context,
		);
		if (!conv) return "";
		const view = await conv.context(context);
		const parts: string[] = [];
		for (const entry of view.entries) {
			const msg = entry.model?.[0] as
				| { role?: string; content?: unknown }
				| undefined;
			if (!msg) continue;
			if (
				msg.role === "toolResult" ||
				msg.role === "assistant" ||
				msg.role === "user"
			) {
				parts.push(messageContentToText(msg.content));
			}
		}
		return parts.join("\n");
	}

	async invalidateToolsEnvCatalog(input?: {
		previousDefaultEnvId?: string | null;
		nextDefaultEnvId?: string | null;
	}): Promise<void> {
		await this.toolsEnvController.onDefaultChanged(
			input?.previousDefaultEnvId ?? null,
			input?.nextDefaultEnvId ?? null,
		);
	}

	async notifyToolsEnvConnection(
		payload: Extract<
			ServerEvent,
			{ type: "account.toolsEnv.event" }
		>["payload"],
	): Promise<void> {
		this.broadcastEvent({
			type: "account.toolsEnv.event",
			payload,
		});
	}

	async readCredential(providerId: string) {
		return this.credentialStore.read(providerId);
	}

	async hasCachedCredential(providerId: string): Promise<boolean> {
		return this.credentialStore.hasCached(providerId);
	}

	async getCredentialCacheSize(): Promise<number> {
		return this.credentialStore.getCacheSize();
	}

	async bustAccountCredentialCaches(
		accountId: string,
		providerId?: string,
	): Promise<void> {
		this.credentialStore.invalidate(providerId);
		try {
			const families = await this.adminStore.listFamilies(accountId);
			const currentMeta = this.getFamilyMeta();
			const targetFamilies =
				families.length > 0
					? families
					: [
							{
								accountId,
								familyId: "default",
								name: "Default Family",
								doName: toDoName(accountId, "default"),
								timezone: this.env.CADMUS_DEFAULT_TIMEZONE ?? "UTC",
								harvestDelayMs: 60_000,
								createdAt: Date.now(),
							},
						];

			await Promise.allSettled(
				targetFamilies.map(async (family) => {
					if (
						family.accountId === currentMeta.accountId &&
						family.familyId === currentMeta.familyId
					) {
						return;
					}
					try {
						const doId = this.env.CADMUS_BOT_FAMILY.idFromName(family.doName);
						const stub = this.env.CADMUS_BOT_FAMILY.get(doId);
						if (typeof stub.invalidateCredentialCache === "function") {
							await stub.invalidateCredentialCache(providerId);
						} else {
							await stub.fetch(
								"https://cadmus.internal/__internal/credentials/invalidate",
								{
									method: "POST",
									headers: { "Content-Type": "application/json" },
									body: JSON.stringify({ providerId }),
								},
							);
						}
					} catch (err) {
						this.log().warn(
							"failed to invalidate credential cache on family DO",
							{
								targetFamily: family.familyId,
								error: err,
							},
						);
					}
				}),
			);
		} catch (err) {
			this.log().warn("failed to list families for credential cache bust", {
				accountId,
				error: err,
			});
		}
	}

	private async fanOutToolsEnvCatalog(
		previousDefaultEnvId: string | null,
		nextDefaultEnvId: string | null,
	): Promise<void> {
		const accountId = this.getFamilyMeta().accountId;
		try {
			const families = await this.adminStore.listFamilies(accountId);
			const currentMeta = this.getFamilyMeta();
			await Promise.allSettled(
				families.map(async (family) => {
					if (
						family.accountId === currentMeta.accountId &&
						family.familyId === currentMeta.familyId
					) {
						return;
					}
					try {
						const doId = this.env.CADMUS_BOT_FAMILY.idFromName(family.doName);
						const stub = this.env.CADMUS_BOT_FAMILY.get(doId);
						if (typeof stub.invalidateToolsEnvCatalog === "function") {
							await stub.invalidateToolsEnvCatalog({
								previousDefaultEnvId,
								nextDefaultEnvId,
							});
						}
					} catch (err) {
						this.log().warn(
							"failed to invalidate tools env catalog on family DO",
							{
								targetFamily: family.familyId,
								error: err,
							},
						);
					}
				}),
			);
		} catch (err) {
			this.log().warn("failed to list families for tools env catalog fan-out", {
				accountId,
				error: err,
			});
		}
	}

	private ensureModels(): MutableModels {
		if (!this.modelsInstance) {
			const authContext = createWorkerAuthContext(this.env);
			const { models } = createCadmusModels({
				credentials: this.credentialStore,
				authContext,
			});
			this.modelsInstance = models;
		}
		return this.modelsInstance;
	}

	private log(): Logger {
		return getLogger().child(familyFields(this.getFamilyMeta()));
	}

	private ensureMetaTable(): void {
		this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS cadmus_family_meta (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        account_id TEXT NOT NULL,
        family_id TEXT NOT NULL,
        name TEXT NOT NULL,
        timezone TEXT NOT NULL,
        harvest_delay_ms INTEGER NOT NULL,
        team_leader_bot_id TEXT
      );
    `);
		const columns = this.ctx.storage.sql
			.exec<{ name: string }>("PRAGMA table_info(cadmus_family_meta)")
			.toArray();
		if (!columns.some((column) => column.name === "team_leader_bot_id")) {
			this.ctx.storage.sql.exec(
				"ALTER TABLE cadmus_family_meta ADD COLUMN team_leader_bot_id TEXT",
			);
		}
	}

	getFamilyMeta(): FamilyMeta {
		const rows = this.ctx.storage.sql
			.exec<{
				account_id: string;
				family_id: string;
				name: string;
				timezone: string;
				harvest_delay_ms: number;
				team_leader_bot_id: string | null;
			}>(
				`SELECT account_id, family_id, name, timezone, harvest_delay_ms, team_leader_bot_id
         FROM cadmus_family_meta
         WHERE id = 1`,
			)
			.toArray();
		if (rows[0]) {
			return {
				accountId: rows[0].account_id,
				familyId: rows[0].family_id,
				name: rows[0].name,
				timezone: rows[0].timezone,
				harvestDelayMs: Number(rows[0].harvest_delay_ms),
				teamLeaderBotId: rows[0].team_leader_bot_id ?? null,
			};
		}
		return {
			accountId: "default-account",
			familyId: "default",
			name: "Default Family",
			timezone: this.env.CADMUS_DEFAULT_TIMEZONE ?? "UTC",
			harvestDelayMs: Number(this.env.CADMUS_HARVEST_DELAY_MS ?? 60_000),
			teamLeaderBotId: null,
		};
	}

	setFamilyMeta(meta: Partial<FamilyMeta>): FamilyMeta {
		const current = this.getFamilyMeta();
		const updated: FamilyMeta = {
			accountId: meta.accountId ?? current.accountId,
			familyId: meta.familyId ?? current.familyId,
			name: meta.name ?? current.name,
			timezone: meta.timezone ?? current.timezone,
			harvestDelayMs: meta.harvestDelayMs ?? current.harvestDelayMs,
			teamLeaderBotId:
				meta.teamLeaderBotId !== undefined
					? meta.teamLeaderBotId
					: current.teamLeaderBotId,
		};
		this.ctx.storage.sql.exec(
			`INSERT INTO cadmus_family_meta (id, account_id, family_id, name, timezone, harvest_delay_ms, team_leader_bot_id)
       VALUES (1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         account_id = excluded.account_id,
         family_id = excluded.family_id,
         name = excluded.name,
         timezone = excluded.timezone,
         harvest_delay_ms = excluded.harvest_delay_ms,
         team_leader_bot_id = excluded.team_leader_bot_id`,
			updated.accountId,
			updated.familyId,
			updated.name,
			updated.timezone,
			updated.harvestDelayMs,
			updated.teamLeaderBotId,
		);
		return updated;
	}

	async ensureHarness(): Promise<{ harness: Harness; context: Context }> {
		if (this.harnessInstance && this.cadmusContext) {
			return { harness: this.harnessInstance, context: this.cadmusContext };
		}
		if (!this.harnessPromise) {
			this.harnessPromise = this.initHarness();
		}
		const harness = await this.harnessPromise;
		if (!this.cadmusContext) {
			throw new Error(
				"cadmusContext unexpectedly undefined after harness initialization",
			);
		}
		return { harness, context: this.cadmusContext };
	}

	private async initHarness(): Promise<Harness> {
		await this.adminStore.initialize();
		const models = this.ensureModels();

		const registry = createRegistry();
		const descriptors = cadmusExtensionDescriptors();
		for (const desc of descriptors) {
			registry.install(desc.extension);
		}

		const services: CadmusServices = {
			familyStore: this.familyStore,
			harness: undefined as unknown as Harness,
			getTimezone: () => this.getFamilyMeta().timezone,
			getHarvestDelayMs: () => this.getFamilyMeta().harvestDelayMs,
			createBot: (input) => this.createBotInternal(input),
			createChat: (input) => this.createChatInternal(input),
			submitChatTurn: (input) => this.submitChatTurnInternal(input),
			runMessageBot: (input) => this.runMessageBotInternal(input),
			adoptGroupWakeRoot: (chatKey) => this.adoptGroupWakeRoot(chatKey),
			driveGroupChat: (taskId) => this.driveGroupChatInternal(taskId),
			deliverGroupWake: (taskId) => this.deliverGroupWakeInternal(taskId),
			groupWakeHold: (taskId) => this.groupWakeHold(taskId),
			endGroupConversation: (chatKey, response) =>
				this.endGroupConversationInternal(chatKey, response),
			isGroupCallerSession: (chatKey) => this.isGroupCallerSession(chatKey),
			ensureScheduleTask: (scheduleId) =>
				this.ensureScheduleTaskInternal(scheduleId),
			syncAlarm: () => this.syncAlarmInternal(),
			broadcast: (event) => this.broadcastEvent(event),
			broadcastChatTasks: (chatKey) => this.broadcastChatTasksInternal(chatKey),
			deliverTaskContinue: (chatKey, round) =>
				this.deliverTaskContinueInternal(chatKey, round),
			prepareConversationTools: (conversationId) =>
				this.prepareConversationTools(conversationId),
			workspaceEnvEnabled: (conversationId, botId) =>
				this.workspaceEnvEnabled(conversationId, botId),
			describeToolsEnv: (input) => this.describeToolsEnv(input),
		};

		const context = createCadmusContext(services);
		this.cadmusContext = context;

		const sqliteStorage = await openDurableObjectSqliteStorage(
			this.ctx.storage as unknown as Parameters<
				typeof openDurableObjectSqliteStorage
			>[0],
			{ prefix: "cadmus_pi_" },
		);

		const harness = await Harness.open(
			sqliteStorage,
			{
				models,
				registry,
				settings: {
					extensions: cadmusDefaultExtensions(),
					compaction: { ...DEFAULT_CADMUS_COMPACTION_POLICY },
					contextRetentionMs: 0,
					documentRetentionMs: 0,
				},
				env: async (target) => {
					try {
						return await this.toolsEnvController.open(
							target.conversationId as unknown as number,
							target.cwd,
						);
					} catch (error) {
						const message =
							error instanceof Error ? error.message : String(error);
						if (message.includes("env disconnected")) {
							this.log().debug(OFFLINE_TOOLS_ENV);
						}
						throw error;
					}
				},
				conversationCreated: (_tx, conversation) => {
					const parent =
						conversation.parent?.conversationId ??
						conversation.owner?.conversationId;
					if (parent === undefined) return;
					const routeKind = conversation.parent ? "fork" : "search";
					this.familyStore.chats.copyConversationRoute(
						parent as unknown as number,
						conversation.id as unknown as number,
						routeKind,
					);
				},
				onReport: (error) => {
					const message =
						error instanceof Error ? error.message : String(error);
					if (message.includes("env disconnected")) {
						this.log().debug(message);
						return;
					}
					this.log().warn("pi-durable extension report", { error });
				},
			},
			context,
		);

		services.harness = harness;
		this.harnessInstance = harness;

		await harness.root(context);
		harness.resume();

		const bots = this.familyStore.bots.listBots();
		const schedules = this.familyStore.schedules.listSchedules(undefined, true);
		for (const sched of schedules) {
			if (
				(sched.kind === "relative" || sched.kind === "absolute") &&
				!sched.enabled
			) {
				this.familyStore.schedules.deleteSchedule(sched.id);
				continue;
			}
			if (sched.enabled) {
				await this.ensureScheduleTaskInternal(sched.id);
			}
		}
		await this.syncAlarmInternal();

		this.log().info("family harness initialized", {
			bots: bots.length,
			schedules: schedules.filter((s) => s.enabled).length,
		});

		return harness;
	}

	// ─── HTTP & WebSocket Entrypoint inside DO ─────────────────────────────────

	override async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		const headerAccount = request.headers.get("X-Cadmus-Account-Id");
		const headerFamily = request.headers.get("X-Cadmus-Family-Id");
		const headerTz = request.headers.get("X-Cadmus-Timezone");
		const headerHarvestDelay = request.headers.get("X-Cadmus-Harvest-Delay-Ms");
		if (headerAccount || headerFamily || headerTz || headerHarvestDelay) {
			this.setFamilyMeta({
				...(headerAccount ? { accountId: headerAccount } : {}),
				...(headerFamily ? { familyId: headerFamily } : {}),
				...(headerTz ? { timezone: headerTz } : {}),
				...(headerHarvestDelay
					? { harvestDelayMs: Number(headerHarvestDelay) }
					: {}),
			});
		}

		if (url.pathname === "/__internal/configure" && request.method === "POST") {
			const body = (await request.json()) as Partial<FamilyMeta>;
			const updated = this.setFamilyMeta(body);
			await this.ensureHarness();
			this.log().debug("family DO configured", {
				timezone: updated.timezone,
				harvestDelayMs: updated.harvestDelayMs,
			});
			return Response.json({ ok: true, family: updated });
		}

		if (
			url.pathname === "/__internal/credentials/invalidate" &&
			request.method === "POST"
		) {
			let body: { providerId?: string } = {};
			try {
				body = (await request.json()) as { providerId?: string };
			} catch {
				// optional body
			}
			await this.invalidateCredentialCache(body.providerId);
			return Response.json({ ok: true, providerId: body.providerId });
		}

		if (
			url.pathname === "/__internal/tools-env/connection" &&
			request.method === "POST"
		) {
			const payload = (await request.json()) as Extract<
				ServerEvent,
				{ type: "account.toolsEnv.event" }
			>["payload"];
			await this.notifyToolsEnvConnection(payload);
			return Response.json({ ok: true });
		}

		if (url.pathname === "/ws") {
			const pair = new WebSocketPair();
			const client = pair[0];
			const server = pair[1];
			const caller = callerMetaFromHeader(
				request.headers.get(PRINCIPAL_HEADER),
			);
			this.ctx.acceptWebSocket(server);
			server.serializeAttachment(caller);
			if (!caller.sessionId) {
				try {
					server.close(4401, "session ended");
				} catch {
					// already closed
				}
				return new Response(null, { status: 101, webSocket: client });
			}
			this.ensureIdleSweep();
			await this.ensureHarness();
			this.log().debug("websocket client connected");
			return new Response(null, { status: 101, webSocket: client });
		}

		if (url.pathname === "/events" && request.method === "GET") {
			await this.ensureHarness();
			this.log().debug("sse client connected");
			const sseCaller = callerMetaFromHeader(
				request.headers.get(PRINCIPAL_HEADER),
			);
			if (!sseCaller.sessionId) {
				return new Response(null, { status: 401 });
			}
			return this.handleSseStream(
				request.signal,
				sseCaller.sessionId,
				sseCaller.accountId,
			);
		}

		if (url.pathname === "/rpc" && request.method === "POST") {
			const raw = await request.text();
			const caller = callerMetaFromHeader(
				request.headers.get(PRINCIPAL_HEADER),
			);
			return this.handleRpcRequest(raw, caller);
		}

		return Response.json(
			{ error: "Not found inside CadmusBotFamilyDO" },
			{ status: 404 },
		);
	}

	override async webSocketMessage(
		ws: WebSocket,
		message: string | ArrayBuffer,
	): Promise<void> {
		try {
			const raw =
				typeof message === "string"
					? message
					: new TextDecoder().decode(message);
			const command = this.shim.decodeCommand(raw);
			const attached = callerMetaFromAttachment(ws.deserializeAttachment());
			const caller = await this.liveCaller(attached);
			if (!caller) {
				const code = await this.endCode(attached.sessionId, attached.accountId);
				ws.send(
					this.shim.encodeFrame({
						type: "protocol.error",
						payload:
							code === 4403
								? { code: "forbidden", message: "Account or user disabled" }
								: { code: "unauthorized", message: "Session ended" },
					} as ServerEvent),
				);
				ws.close(code, code === 4403 ? "forbidden" : "session ended");
				return;
			}
			const response = await this.executeCommand(command, caller);
			ws.send(this.shim.encodeFrame(response));
		} catch (error) {
			this.log().warn("websocket protocol error", { error });
			const errFrame: ServerEvent = {
				type: "protocol.error",
				payload: {
					code:
						error instanceof ProtocolValidationError
							? error.code
							: "invalid_frame",
					message: (error as Error).message,
				},
			};
			ws.send(this.shim.encodeFrame(errFrame));
		}
	}

	override async webSocketClose(
		ws: WebSocket,
		code: number,
		reason: string,
	): Promise<void> {
		this.log().debug("websocket client closed", { code, reason });
		try {
			ws.close(code, reason);
		} catch {
			// Ignore already closed socket
		}
	}

	override async alarm(): Promise<void> {
		const now = Date.now();
		await this.expireGroupChats(now);
		await this.expireTaskLoops(now);
		const due = this.familyStore.schedules
			.listSchedules(undefined, true)
			.filter((sched) => sched.enabled && sched.nextRun <= now);

		this.log().debug("family DO alarm woke", {
			dueSchedules: due.map((s) => s.id),
		});

		const { harness, context } = await this.ensureHarness();
		harness.resume();

		for (const sched of due) {
			await this.ensureScheduleTaskInternal(sched.id);
		}

		await this.drainDueSchedules(harness, context);
		await this.trackBackgroundCompactions(harness);
		await this.drainDueCompactions(harness, context);

		const staleOneShots = this.familyStore.schedules
			.listSchedules(undefined, true)
			.filter(
				(sched) =>
					(sched.kind === "relative" || sched.kind === "absolute") &&
					!sched.enabled,
			);
		for (const s of staleOneShots) {
			this.familyStore.schedules.deleteSchedule(s.id);
		}

		if (this.streamsOpen()) {
			await this.sweepAuthority(true).catch(() => this.closeAllStreams());
			this.streamSweep.swept();
		}
		await this.syncAlarmInternal();
	}

	private async drainDueSchedules(
		harness: Harness,
		context: Context,
	): Promise<void> {
		for (let i = 0; i < 200; i++) {
			const inspection = await harness.inspect(context);
			const dueOrRunning = inspection.tasks.some((t) => {
				if (t.record.kind !== "cadmus.schedule") return false;
				if (t.record.state.status !== "running") return false;
				const cp = t.record.state.checkpoint as {
					phase?: string;
					nextRun?: number;
				};
				if (cp.phase === "run") return true;
				const input = t.record.input as { scheduleId?: string };
				const sched = input?.scheduleId
					? this.familyStore.schedules.getSchedule(input.scheduleId)
					: undefined;
				return Boolean(sched?.enabled && sched.nextRun <= Date.now());
			});
			if (!dueOrRunning) {
				break;
			}
			await new Promise((r) => setTimeout(r, 25));
		}
		await harness.waitForIdle(context);
	}

	private async trackBackgroundCompactions(harness: Harness): Promise<void> {
		const inspection = await harness.inspect(BACKGROUND_CONTEXT);
		const now = Date.now();
		for (const t of inspection.tasks) {
			if (t.record.kind !== "pi.compaction") continue;
			if (t.record.state.status !== "running") continue;
			const cp = t.record.state.checkpoint as
				| { phase?: string; until?: number }
				| undefined;
			if (
				cp?.phase === "retry" &&
				typeof cp.until === "number" &&
				cp.until > now
			) {
				continue;
			}
			const taskIdNum = Number(t.record.id);
			if (this.trackedCompactionTasks.has(taskIdNum)) continue;
			this.trackedCompactionTasks.add(taskIdNum);
			harness.resume();
			this.ctx.waitUntil(
				harness
					.waitForTask(t.record.id, BACKGROUND_CONTEXT)
					.catch((error) => {
						this.log().warn("background compaction wait failed", {
							taskId: taskIdNum,
							error,
						});
					})
					.finally(() => {
						this.trackedCompactionTasks.delete(taskIdNum);
						void this.syncAlarmInternal().catch(() => {});
					}),
			);
		}
	}

	private async drainDueCompactions(
		harness: Harness,
		context: Context,
	): Promise<void> {
		for (let i = 0; i < 200; i++) {
			const inspection = await harness.inspect(context);
			const now = Date.now();
			const dueOrRunning = inspection.tasks.some((t) => {
				if (t.record.kind !== "pi.compaction") return false;
				if (t.record.state.status !== "running") return false;
				const cp = t.record.state.checkpoint as
					| { phase?: string; until?: number }
					| undefined;
				if (cp?.phase === "retry" && typeof cp.until === "number") {
					return cp.until <= now;
				}
				return true;
			});
			if (!dueOrRunning) {
				break;
			}
			await new Promise((r) => setTimeout(r, 25));
		}
	}

	// ─── RPC & Streaming Event Helpers ─────────────────────────────────────────

	private async handleRpcRequest(
		raw: string,
		caller: CallerMeta,
	): Promise<Response> {
		let command: ClientCommand;
		try {
			command = this.shim.decodeCommand(raw);
		} catch (error) {
			this.log().warn("rpc protocol decode error", { error });
			const errFrame: ServerEvent = {
				type: "protocol.error",
				payload: {
					code:
						error instanceof ProtocolValidationError
							? error.code
							: "invalid_command",
					message: (error as Error).message,
				},
			};
			return new Response(this.shim.encodeFrame(errFrame), {
				status: 400,
				headers: { "Content-Type": this.shim.contentType },
			});
		}

		const resultFrame = await this.executeCommand(command, caller);
		const status = resultFrame.ok ? 200 : 400;
		return new Response(this.shim.encodeFrame(resultFrame), {
			status,
			headers: { "Content-Type": this.shim.contentType },
		});
	}

	private handleSseStream(
		signal: AbortSignal,
		sessionId: string,
		accountId?: string,
	): Response {
		const encoder = new TextEncoder();
		let activeController:
			| ReadableStreamDefaultController<Uint8Array>
			| undefined;

		const stream = new ReadableStream<Uint8Array>({
			start: (controller) => {
				activeController = controller;
				this.sseControllers.add(controller);
				this.sseSessions.set(controller, { sessionId, accountId });
				this.ensureIdleSweep();
				signal.addEventListener(
					"abort",
					() => {
						this.sseControllers.delete(controller);
						this.sseSessions.delete(controller);
						try {
							controller.close();
						} catch {
							// Ignore
						}
					},
					{ once: true },
				);
			},
			cancel: () => {
				if (activeController) {
					this.sseControllers.delete(activeController);
					this.sseSessions.delete(activeController);
				}
			},
		});

		if (activeController) {
			activeController.enqueue(encoder.encode(": connected\n\n"));
		}

		return new Response(stream, {
			headers: {
				"Content-Type": "text/event-stream",
				"Cache-Control": "no-cache",
				Connection: "keep-alive",
			},
		});
	}

	/**
	 * The caller's authority right now. Session-backed callers are re-read from
	 * D1 (the handshake copy can be stale); other callers pass through.
	 */
	/** Close code for a session that no longer resolves: 4403 when its account is suspended or its user disabled, else 4401. */
	private async endCode(
		sessionId: string | undefined,
		accountId?: string,
	): Promise<4401 | 4403> {
		if (!sessionId) return 4401;
		try {
			return (await this.adminStore.sessionRefusalReason(sessionId, accountId))
				? 4403
				: 4401;
		} catch {
			// A failed classification read must still end the denied socket.
			return 4401;
		}
	}

	/** Member commands act on tenants only; the system account is not one. */
	private async requireTenantTarget(accountId: string): Promise<void> {
		const found = await this.adminStore.listAccountMembers(accountId);
		if (!found.ok) {
			throw new ProtocolValidationError(found.message, found.code);
		}
	}

	private async liveCaller(
		attached: CallerMeta,
	): Promise<CallerMeta | undefined> {
		if (!attached.sessionId) return undefined;
		const identity = await this.adminStore.resolveSession(
			attached.sessionId,
			attached.accountId,
		);
		if (!identity) return undefined;
		return {
			...attached,
			userId: identity.userId,
			accountId: identity.accountId,
			role: identity.role,
			elevatedUntil: identity.elevatedUntil,
			...(identity.provisional ? { provisional: true } : {}),
		};
	}

	/**
	 * Closes sockets and streams whose session is no longer valid or no longer
	 * holds chat.use (streams carry live chat content). Returns the sessions
	 * that were live and also hold toolsEnv.read, from this sweep's own
	 * lookups only (callers that deliver use their own sweep's result; a
	 * non-forced skipped sweep returns an empty set, i.e. nobody).
	 * Validation errors propagate: callers must not deliver on an unverified
	 * state.
	 */
	private async sweepAuthority(force = false): Promise<Set<string>> {
		const now = Date.now();
		if (!force && now - this.lastAuthSweepAt < 1_000) return new Set();
		this.lastAuthSweepAt = now;
		// 0 = live, otherwise the close code: 4401 session ended, 4403 no chat.use.
		const live = new Map<string, number>();
		// Sessions that also hold toolsEnv.read: account.toolsEnv.event carries
		// environment identity, workspace path and error text that the list API
		// only gives to that grant, so only these sessions receive it.
		const toolsReaders = new Set<string>();
		const verdict = async (
			sessionId: string,
			accountId: string | undefined,
		): Promise<number> => {
			const key = principalKey(sessionId, accountId);
			const known = live.get(key);
			if (known !== undefined) return known;
			const identity = await this.adminStore.resolveSession(
				sessionId,
				accountId,
			);
			const grants = identity ? grantsForRole(identity.role) : [];
			const code = !identity
				? await this.endCode(sessionId, accountId)
				: grants.includes("chat.use")
					? 0
					: 4403;
			live.set(key, code);
			if (code === 0 && grants.includes("toolsEnv.read")) toolsReaders.add(key);
			// account.credentials.oauth.event carries the device user code and authorization
			// URL of an in-progress provider login: credentials.manage only.
			if (code === 0 && grants.includes("credentials.manage")) {
				toolsReaders.add(`${OAUTH_MANAGER_PREFIX}${key}`);
			}
			return code;
		};
		for (const ws of this.ctx.getWebSockets()) {
			const attached = callerMetaFromAttachment(ws.deserializeAttachment());
			const code = attached.sessionId
				? await verdict(attached.sessionId, attached.accountId)
				: 4401;
			if (code !== 0) {
				try {
					ws.close(code, "session ended");
				} catch {
					// already closed
				}
			}
		}
		for (const [controller, who] of this.sseSessions) {
			if ((await verdict(who.sessionId, who.accountId)) !== 0) {
				this.sseControllers.delete(controller);
				this.sseSessions.delete(controller);
				try {
					controller.close();
				} catch {
					// already closed
				}
			}
		}
		return toolsReaders;
	}

	/**
	 * Idle streams are re-checked from the Durable Object alarm (the repo's one
	 * timer primitive), so an idle socket revoked elsewhere is closed within
	 * STREAM_SWEEP_MS without a live timer that would keep the object awake.
	 */
	private ensureIdleSweep(): void {
		void this.ensureHarness()
			.then(() => this.syncAlarmInternal())
			// No bounded idle check could be set up: end the streams (clients reconnect).
			.catch(() => this.closeAllStreams());
	}

	/** Fail closed: when authority cannot be verified, end every stream; clients reconnect. */
	private closeAllStreams(): void {
		for (const ws of this.ctx.getWebSockets()) {
			try {
				ws.close(1011, "authority check failed");
			} catch {
				// already closed
			}
		}
		for (const controller of this.sseControllers) {
			try {
				controller.close();
			} catch {
				// already closed
			}
		}
		this.sseControllers.clear();
		this.sseSessions.clear();
	}

	private pendingEvents: ServerFrame[] = [];
	private flushing = false;

	/**
	 * Every delivered event follows a live authority check that started after
	 * the event was queued (one check covers a batch). A failed check delivers
	 * nothing and ends the streams. Order is preserved.
	 */
	broadcastEvent(event: ServerFrame): void {
		this.pendingEvents.push(event);
		if (this.flushing) return;
		this.flushing = true;
		void (async () => {
			try {
				while (this.pendingEvents.length > 0) {
					const batch = this.pendingEvents;
					this.pendingEvents = [];
					let toolsReaders: Set<string>;
					try {
						toolsReaders = await this.sweepAuthority(true);
					} catch {
						this.closeAllStreams();
						continue;
					}
					for (const queued of batch) this.deliverEvent(queued, toolsReaders);
				}
			} finally {
				this.flushing = false;
			}
		})();
	}

	private deliverEvent(event: ServerFrame, toolsReaders: Set<string>): void {
		const text = this.shim.encodeFrame(event);
		// account.toolsEnv.event needs toolsEnv.read and account.credentials.oauth.event
		// needs credentials.manage. Session principals come from the sweep that
		// ran for this batch. A socket with no session is closed and receives nothing.
		const oauthEvent = event.type === "account.credentials.oauth.event";
		const gated = event.type === "account.toolsEnv.event" || oauthEvent;
		const prefix = oauthEvent ? OAUTH_MANAGER_PREFIX : "";
		const wsMayReceive = (attached: CallerMeta): boolean =>
			!gated ||
			(!!attached.sessionId &&
				toolsReaders.has(
					`${prefix}${principalKey(attached.sessionId, attached.accountId)}`,
				));
		const sseMayReceive = (
			controller: ReadableStreamDefaultController<Uint8Array>,
		): boolean => {
			if (!gated) return true;
			const who = this.sseSessions.get(controller);
			return (
				!!who &&
				toolsReaders.has(
					`${prefix}${principalKey(who.sessionId, who.accountId)}`,
				)
			);
		};

		for (const ws of this.ctx.getWebSockets()) {
			const attached = callerMetaFromAttachment(ws.deserializeAttachment());
			if (!wsMayReceive(attached)) continue;
			try {
				ws.send(text);
			} catch {
				// Ignore disconnected socket
			}
		}

		if (this.sseControllers.size > 0) {
			const ssePayload = new TextEncoder().encode(
				`event: ${event.type}\ndata: ${text}\n\n`,
			);
			for (const controller of this.sseControllers) {
				if (!sseMayReceive(controller)) continue;
				try {
					controller.enqueue(ssePayload);
				} catch {
					this.sseControllers.delete(controller);
				}
			}
		}
	}

	// ─── Command Dispatcher ────────────────────────────────────────────────────

	async executeCommand(
		command: ClientCommand,
		caller: CallerMeta,
	): Promise<CommandResultFrame> {
		const cmdLog = this.log().child({
			commandId: command.id,
			command: command.type,
		});
		try {
			await this.ensureHarness();
			cmdLog.debug("dispatching protocol command");
			const result = await this.dispatchCommand(command, caller);
			if (/^(auth|account\.members|account\.invites)\./.test(command.type)) {
				// Authority just changed: end streams that lost it before any
				// further event is delivered.
				await this.sweepAuthority(true).catch(() => this.closeAllStreams());
			}
			return {
				id: command.id,
				type: "command.result",
				command: command.type,
				ok: true,
				result,
				payload: result,
			};
		} catch (error) {
			const code =
				error instanceof CasConflictError
					? error.code
					: error instanceof ProtocolValidationError
						? error.code
						: "command_failed";
			cmdLog.warn("protocol command failed", { code, error });
			return {
				id: command.id,
				type: "command.result",
				command: command.type,
				ok: false,
				error: {
					code,
					message: (error as Error).message,
				},
			};
		}
	}

	private async dispatchCommand(
		command: ClientCommand,
		caller: CallerMeta,
	): Promise<RpcResult<CommandType>> {
		const grant = authorize(caller, command.type);
		return withElevatedAudit({
			adminStore: this.adminStore,
			caller,
			grant,
			commandType: command.type,
			familyId: this.getFamilyMeta().familyId,
			warn: (message, fields) => this.log().warn(message, fields),
			run: () => callCommandHandler(this.commandHandlers(caller), command),
		});
	}

	/** Issue #3 phase 8: per-principal budget on auth.ticket and the passkey commands. */
	private async requireAuthBudget(
		command: string,
		caller: CallerMeta,
	): Promise<void> {
		const principal = caller.sessionId ?? caller.userId ?? caller.accountId;
		if (!principal) return;
		if (await withinPrincipalBudget(this.env, command, principal)) return;
		throw new ProtocolValidationError(
			"Too many requests. Try again shortly.",
			"rate_limited",
		);
	}

	private commandHandlers(caller: CallerMeta): CommandHandlerMap {
		const meta = this.getFamilyMeta();
		const readChatSnapshot = async (
			command: Extract<ClientCommand, { type: "chat.get" }>,
		) => {
			const group = this.familyStore.groups.getById(command.payload.chatKey);
			if (group) {
				const raw = Boolean(command.payload.raw);
				return {
					chat: this.groupAsChat(group),
					busy: group.status === "open",
					compacting: false,
					messages: this.familyStore.groups
						.listMessages(group.id)
						.map((message) => ({
							id: message.seq,
							role: "user" as const,
							visibleToUser: true,
							visibleToModel: true,
							text: message.text,
							fromBotId: message.fromBotId,
							timestamp: message.at,
						})),
					...(raw ? { entries: [] } : {}),
					hasMore: false,
					notes: [],
				};
			}
			const chat = this.familyStore.chats.getChat(command.payload.chatKey);
			if (!chat) {
				throw new ProtocolValidationError(
					`Chat '${command.payload.chatKey}' not found`,
					"not_found",
				);
			}
			const raw = Boolean(command.payload.raw);
			const limit = Math.max(1, Math.min(500, command.payload.limit ?? 100));
			const beforeEntryId = command.payload.beforeEntryId;
			const { harness, context } = await this.ensureHarness();
			const conv = await harness.conversation(
				chat.conversationId as ConversationId,
				context,
			);
			if (conv) {
				await this.attachConversationWatch(chat, conv, context);
			}
			const transcript = conv
				? await this.readTranscriptData(conv, context, {
						raw,
						limit,
						beforeEntryId,
					})
				: {
						messages: [],
						entries: [] as RawTranscriptEntry[],
						hasMore: false,
						oldestEntryId: undefined,
						headEntryId: undefined,
						firstKeptEntryId: undefined,
					};
			const authors = this.familyStore.chats.listEntryAuthors(chat.key);
			const messages = transcript.messages.map((message) => {
				const authorUserId =
					message.role === "user" ? authors.get(message.id) : undefined;
				return authorUserId ? { ...message, authorUserId } : message;
			});
			const live = await harness.snapshot(
				LiveDoc,
				chat.conversationId as ConversationId,
				context,
			);
			const compaction = buildCompactionSnapshot(
				live,
				transcript.headEntryId,
				transcript.firstKeptEntryId,
			);
			const notes = this.familyStore.harvest.listNotes(chat.key);
			const bot = this.familyStore.bots.getBot(chat.botId);
			const resolved = bot
				? await this.toolsEnvController.resolvedFields(
						bot,
						chat.toolsEnv ?? null,
					)
				: {};
			return {
				chat: this.decorateChat(chat),
				busy: Boolean(live?.run),
				compacting: compaction.active,
				compaction,
				messages,
				...(raw ? { entries: transcript.entries } : {}),
				hasMore: transcript.hasMore,
				...(transcript.oldestEntryId !== undefined
					? { oldestEntryId: transcript.oldestEntryId }
					: {}),
				notes,
				tasks: this.familyStore.tasks.list(chat.key),
				taskLoop: this.taskLoopSnapshot(chat.key),
				...resolved,
			};
		};
		const abortTurn = async (
			command: Extract<
				ClientCommand,
				{ type: "turn.abort" | "turn.interrupt" }
			>,
		) => {
			const chat = this.familyStore.chats.getChat(command.payload.chatKey);
			if (!chat) {
				throw new ProtocolValidationError(
					`Chat '${command.payload.chatKey}' not found`,
					"not_found",
				);
			}
			const { harness, context } = await this.ensureHarness();
			const conv = await harness.conversation(
				chat.conversationId as ConversationId,
				context,
			);
			if (conv) {
				await conv.abort(context);
			}
			this.pauseTaskLoop(chat.key);
			return { aborted: true as const, chatKey: chat.key };
		};
		return {
			"account.get": async (_command) => {
				const account = await this.adminStore.getAccount(meta.accountId);
				const members = await this.adminStore.listMembers(meta.accountId);
				const families = await this.adminStore.listFamilies(meta.accountId);
				const credentials = await this.adminStore.listCredentials(
					meta.accountId,
				);
				return {
					account: account ?? {
						id: meta.accountId,
						name: `Account ${meta.accountId}`,
						timezone: meta.timezone,
						createdAt: Date.now(),
					},
					members,
					families,
					credentials,
				};
			},
			"account.update": async (command) => {
				const previous = await this.adminStore.getAccount(meta.accountId);
				if (command.payload.defaultToolsEnv?.envId) {
					const def = await this.adminStore.getToolsEnv(
						meta.accountId,
						command.payload.defaultToolsEnv.envId,
					);
					if (!def) {
						throw new ProtocolValidationError(
							`Unknown tools env '${command.payload.defaultToolsEnv.envId}'`,
							"not_found",
						);
					}
					if (def.kind !== "just-bash" && def.kind !== "local-daemon") {
						throw new ProtocolValidationError(
							`Tools env '${def.envId}' kind '${def.kind}' is not available`,
							"unsupported_kind",
						);
					}
				}
				if (command.payload.timezone !== undefined) {
					assertValidIanaTimezone(command.payload.timezone);
				}
				const updated = await this.adminStore.updateAccount(meta.accountId, {
					...(command.payload.name !== undefined
						? { name: command.payload.name }
						: {}),
					...(command.payload.timezone !== undefined
						? { timezone: command.payload.timezone }
						: {}),
					...(Object.hasOwn(command.payload, "defaultToolsEnv")
						? { defaultToolsEnv: command.payload.defaultToolsEnv ?? null }
						: {}),
				});
				if (command.payload.timezone !== undefined) {
					this.setFamilyMeta({ timezone: command.payload.timezone });
				}
				if (Object.hasOwn(command.payload, "defaultToolsEnv")) {
					const previousId = previous?.defaultToolsEnv?.envId ?? null;
					const nextId = updated.defaultToolsEnv?.envId ?? null;
					await this.invalidateToolsEnvCatalog({
						previousDefaultEnvId: previousId,
						nextDefaultEnvId: nextId,
					});
					await this.fanOutToolsEnvCatalog(previousId, nextId);
				}
				return { account: updated };
			},
			"account.toolsEnvs.list": async (_command) => {
				return this.toolsEnvController.listEnvs();
			},
			"account.toolsEnvs.create": async (command) => {
				const env = await this.toolsEnvController.createEnv(command.payload);
				await this.fanOutToolsEnvCatalog(null, null);
				let pairingToken: string | undefined;
				let expiresAt: number | undefined;
				let commandStr: string | undefined;
				if (env.kind === "local-daemon") {
					const urls = resolvePublicUrls(
						this.env,
						undefined,
						command.payload.baseUrl,
					);
					const paired = await this.toolsEnvController.mintPairingToken(
						env.envId,
						urls,
					);
					pairingToken = paired.pairingToken;
					expiresAt = paired.expiresAt;
					commandStr = paired.command;
				}
				return {
					env: await this.toolsEnvController.present(env),
					...(pairingToken
						? {
								pairingToken,
								expiresAt,
								command: commandStr,
							}
						: {}),
				};
			},
			"account.toolsEnvs.pair": async (command) => {
				const urls = resolvePublicUrls(
					this.env,
					undefined,
					command.payload.baseUrl,
				);
				const paired = await this.toolsEnvController.mintPairingToken(
					command.payload.envId,
					urls,
				);
				return {
					envId: command.payload.envId,
					pairingToken: paired.pairingToken,
					expiresAt: paired.expiresAt,
					command: paired.command,
				};
			},
			"account.toolsEnvs.deregister": async (command) => {
				await this.toolsEnvController.deregisterEnv(command.payload.envId);
				await this.fanOutToolsEnvCatalog(null, null);
				return { deregistered: command.payload.envId };
			},
			"account.toolsEnvs.update": async (command) => {
				const env = await this.toolsEnvController.updateEnv(
					command.payload.envId,
					command.payload,
				);
				await this.fanOutToolsEnvCatalog(null, null);
				return { env: await this.toolsEnvController.present(env) };
			},
			"account.toolsEnvs.delete": async (command) => {
				await this.toolsEnvController.deleteEnv(command.payload.envId);
				await this.fanOutToolsEnvCatalog(null, null);
				return { deleted: command.payload.envId };
			},
			"account.members.list": async (_command) => {
				const members = await this.adminStore.listMembers(meta.accountId);
				return { members };
			},
			"account.members.invite": async (command) => {
				const result = await this.adminStore.inviteMember({
					accountId: meta.accountId,
					invitedBy: caller.userId ?? "unknown",
					email: command.payload.email,
					roles: command.payload.roles,
					ttlMs:
						command.payload.ttlDays === undefined
							? undefined
							: command.payload.ttlDays * 86_400_000,
				});
				if (!result.ok) {
					throw new ProtocolValidationError(result.message, result.code);
				}
				return { invite: result.invite };
			},
			"account.members.update": async (command) => {
				const result = await this.adminStore.updateMemberRole({
					accountId: meta.accountId,
					userId: command.payload.userId,
					op: command.payload.op,
					role: command.payload.role,
					actor: caller.userId ?? "unknown",
				});
				if (!result.ok) {
					throw new ProtocolValidationError(result.message, result.code);
				}
				return {
					updated: result.changed,
				};
			},
			"account.members.remove": async (command) => {
				const result = await this.adminStore.removeMember({
					accountId: meta.accountId,
					userId: command.payload.userId,
					actor: caller.userId ?? "unknown",
				});
				if (!result.ok) {
					throw new ProtocolValidationError(result.message, result.code);
				}
				return {
					removed: result.changed,
					sessionsRevoked: result.sessionsRevoked,
				};
			},
			"account.invites.list": async (_command) => {
				return { invites: await this.adminStore.listInvites(meta.accountId) };
			},
			"account.audit.list": async (command) => {
				return {
					events: await this.adminStore.listAccountAudit({
						accountId: meta.accountId,
						limit: command.payload?.limit ?? 50,
						before: command.payload?.before,
						beforeId: command.payload?.beforeId,
					}),
				};
			},
			"account.invites.revoke": async (command) => {
				const revoked = await this.adminStore.revokeInvite({
					accountId: meta.accountId,
					inviteId: command.payload.inviteId,
					actor: caller.userId ?? "unknown",
				});
				return { revoked };
			},
			"account.credentials.list": async (_command) => {
				const credentials = await this.adminStore.listCredentials(
					meta.accountId,
				);
				return { credentials };
			},
			"account.credentials.set": async (command) => {
				const summary = await this.adminStore.setCredential(
					meta.accountId,
					command.payload.providerId,
					command.payload.credential,
				);
				await this.bustAccountCredentialCaches(
					meta.accountId,
					command.payload.providerId,
				);
				this.broadcastEvent({
					type: "account.event",
					payload: {
						accountId: meta.accountId,
						action: "credential.set",
						providerId: command.payload.providerId,
						when: Date.now(),
					},
				});
				return { credential: summary };
			},
			"account.credentials.delete": async (command) => {
				await this.adminStore.deleteCredential(
					meta.accountId,
					command.payload.providerId,
				);
				await this.bustAccountCredentialCaches(
					meta.accountId,
					command.payload.providerId,
				);
				this.broadcastEvent({
					type: "account.event",
					payload: {
						accountId: meta.accountId,
						action: "credential.deleted",
						providerId: command.payload.providerId,
						when: Date.now(),
					},
				});
				return { deleted: command.payload.providerId };
			},
			"account.credentials.test": async (command) => {
				const models = this.ensureModels();
				const { providerId, modelId } = command.payload;
				const model = modelId
					? models.getModel(providerId, modelId)
					: pickTestModel(providerId, models.getModels(providerId));
				if (!model) {
					throw new ProtocolValidationError(
						modelId
							? `Unknown model ${providerId}/${modelId}`
							: `Unknown provider "${providerId}" or no models available`,
						"not_found",
					);
				}
				if (providerId !== "faux") {
					let auth: Awaited<ReturnType<MutableModels["getAuth"]>>;
					try {
						auth = await models.getAuth(providerId);
					} catch (error) {
						throw new ProtocolValidationError(
							`Provider "${providerId}" credentials failed: ${(error as Error).message}`,
							"not_found",
						);
					}
					if (!auth) {
						throw new ProtocolValidationError(
							`Provider "${providerId}" has no credentials configured for this account`,
							"not_found",
						);
					}
				}
				return testProviderCredential(models, model);
			},
			"account.models.list": async (command) => {
				const models = this.ensureModels();
				const targetProvider = command.payload?.provider;
				const providers = targetProvider
					? [targetProvider]
					: models.getProviders().map((p) => p.id);

				const result: ModelInfo[] = [];
				for (const providerId of providers) {
					let isAuth = providerId === "faux";
					if (!isAuth) {
						try {
							const auth = await models.getAuth(providerId);
							isAuth = !!auth;
						} catch {
							isAuth = false;
						}
					}
					if (command.payload?.onlyAuthenticated && !isAuth) {
						continue;
					}
					const providerModels = models.getModels(providerId);
					for (const m of providerModels) {
						const supportedLevels = getSupportedThinkingLevels(m);
						const tier = getModelTier(providerId, m.id);
						result.push({
							id: m.id,
							provider: providerId,
							name: m.name ?? m.id,
							...(tier ? { tier } : {}),
							...(m.contextWindow !== undefined
								? { contextWindow: m.contextWindow }
								: {}),
							...(m.maxTokens !== undefined ? { maxTokens: m.maxTokens } : {}),
							...(m.reasoning !== undefined ? { reasoning: m.reasoning } : {}),
							...(supportedLevels.length > 0
								? { thinkingLevels: supportedLevels }
								: {}),
							...(m.input ? { input: [...m.input] } : {}),
							authenticated: isAuth,
							credentialConfigured: isAuth,
						});
					}
				}
				return { models: result };
			},
			"account.credentials.oauth.providers": async (_command) => {
				const providers = this.oauthManager.listProviders();
				return { providers };
			},
			"account.credentials.oauth.start": async (command) => {
				const { record, backgroundPromise } = await this.oauthManager.startFlow(
					{
						accountId: meta.accountId,
						providerId: command.payload.providerId,
						redirectUri: command.payload.redirectUri,
					},
				);
				this.ctx.waitUntil(backgroundPromise);
				return { flow: record };
			},
			"account.credentials.oauth.status": async (command) => {
				const flow = this.oauthManager.getStatus(command.payload.flowId);
				return { flow };
			},
			"account.credentials.oauth.submit": async (command) => {
				const flow = this.oauthManager.submitInput(
					command.payload.flowId,
					command.payload.input,
				);
				return { flow };
			},
			"account.credentials.oauth.cancel": async (command) => {
				const flow = this.oauthManager.cancelFlow(command.payload.flowId);
				return { flow, cancelled: true };
			},
			"auth.ticket": async (command) => {
				await this.requireAuthBudget("auth.ticket", caller);
				const sessionId = requireSession(caller);
				return this.adminStore.createTicket(
					sessionId,
					command.payload.target,
					caller.accountId,
				);
			},
			"auth.sessions.list": async (_command) => {
				const sessionId = requireSession(caller);
				const sessions = await this.adminStore.listSessions(
					caller.userId ?? "",
				);
				return {
					sessions: sessions
						.map((session) => ({
							...session,
							current: session.id === sessionId,
						}))
						.sort((a, b) => {
							if (a.current !== b.current) return a.current ? -1 : 1;
							return b.lastUsedAt - a.lastUsedAt;
						}),
				};
			},
			"auth.sessions.revoke": async (command) => {
				requireSession(caller);
				const revoked = await this.adminStore.revokeOwnSession(
					caller.userId ?? "",
					command.payload.sessionId,
				);
				return { revoked };
			},
			"system.accounts.list": async (_command) => {
				return { accounts: await this.adminStore.listSystemAccounts() };
			},
			"system.accounts.create": async (command) => {
				const result = await this.adminStore.createSystemAccount({
					name: command.payload.name,
					timezone: command.payload.timezone,
					actor: caller.userId ?? "unknown",
					ownerEmail: command.payload.ownerEmail,
				});
				if (!result.ok) {
					throw new ProtocolValidationError(result.message, result.code);
				}
				return { account: result.account };
			},
			"system.accounts.suspend": async (command) => {
				const result = await this.adminStore.setSystemAccountStatus({
					accountId: command.payload.accountId,
					status: "suspended",
					actor: caller.userId ?? "unknown",
				});
				if (!result.ok) {
					throw new ProtocolValidationError(result.message, result.code);
				}
				return { account: result.account, changed: result.changed };
			},
			"system.accounts.resume": async (command) => {
				const result = await this.adminStore.setSystemAccountStatus({
					accountId: command.payload.accountId,
					status: "active",
					actor: caller.userId ?? "unknown",
				});
				if (!result.ok) {
					throw new ProtocolValidationError(result.message, result.code);
				}
				return { account: result.account, changed: result.changed };
			},
			"system.accounts.rename": async (command) => {
				const result = await this.adminStore.renameSystemAccount({
					accountId: command.payload.accountId,
					name: command.payload.name,
					actor: caller.userId ?? "unknown",
				});
				if (!result.ok) {
					throw new ProtocolValidationError(result.message, result.code);
				}
				return { account: result.account, changed: result.changed };
			},
			"system.members.list": async (command) => {
				const result = await this.adminStore.listAccountMembers(
					command.payload.accountId,
				);
				if (!result.ok) {
					throw new ProtocolValidationError(result.message, result.code);
				}
				return { members: result.members };
			},
			"system.members.invite": async (command) => {
				await this.requireTenantTarget(command.payload.accountId);
				const result = await this.adminStore.inviteMember({
					accountId: command.payload.accountId,
					invitedBy: caller.userId ?? "unknown",
					email: command.payload.email,
					roles: command.payload.roles,
					ttlMs:
						command.payload.ttlDays === undefined
							? undefined
							: command.payload.ttlDays * 86_400_000,
					actorKind: "super-admin",
				});
				if (!result.ok) {
					throw new ProtocolValidationError(result.message, result.code);
				}
				return { invite: result.invite };
			},
			"system.members.update": async (command) => {
				await this.requireTenantTarget(command.payload.accountId);
				const result = await this.adminStore.updateMemberRole({
					accountId: command.payload.accountId,
					userId: command.payload.userId,
					op: command.payload.op,
					role: command.payload.role,
					actor: caller.userId ?? "unknown",
					actorKind: "super-admin",
				});
				if (!result.ok) {
					throw new ProtocolValidationError(result.message, result.code);
				}
				return {
					updated: result.changed,
				};
			},
			"system.members.remove": async (command) => {
				await this.requireTenantTarget(command.payload.accountId);
				const result = await this.adminStore.removeMember({
					accountId: command.payload.accountId,
					userId: command.payload.userId,
					actor: caller.userId ?? "unknown",
					actorKind: "super-admin",
				});
				if (!result.ok) {
					throw new ProtocolValidationError(result.message, result.code);
				}
				return {
					removed: result.changed,
					sessionsRevoked: result.sessionsRevoked,
				};
			},
			"system.users.disable": async (command) => {
				const result = await this.adminStore.setUserDisabled({
					userId: command.payload.userId,
					disabled: true,
					actor: caller.userId ?? "unknown",
				});
				if (!result.ok) {
					throw new ProtocolValidationError(result.message, result.code);
				}
				return { changed: result.changed };
			},
			"system.users.enable": async (command) => {
				const result = await this.adminStore.setUserDisabled({
					userId: command.payload.userId,
					disabled: false,
					actor: caller.userId ?? "unknown",
				});
				if (!result.ok) {
					throw new ProtocolValidationError(result.message, result.code);
				}
				return { changed: result.changed };
			},
			"system.users.revokeSessions": async (command) => {
				const result = await this.adminStore.revokeUserSessions({
					userId: command.payload.userId,
					actor: caller.userId ?? "unknown",
				});
				if (!result.ok) {
					throw new ProtocolValidationError(result.message, result.code);
				}
				return { revoked: result.revoked };
			},
			"system.audit.list": async (command) => {
				return {
					events: await this.adminStore.listSystemAudit({
						limit: command.payload?.limit ?? 50,
						accountId: command.payload?.accountId,
						before: command.payload?.before,
						beforeId: command.payload?.beforeId,
					}),
				};
			},
			"system.metrics": async () => {
				return this.adminStore.getSystemMetrics();
			},
			"system.accounts.get": async (command) => {
				const result = await this.adminStore.getSystemAccountDetail(
					command.payload.accountId,
				);
				if (!result.ok) {
					throw new ProtocolValidationError(result.message, result.code);
				}
				return {
					account: result.account,
					familyCount: result.familyCount,
					pendingInviteCount: result.pendingInviteCount,
					activeSessionCount: result.activeSessionCount,
					connectedProviders: result.connectedProviders,
					auditEvents24h: result.auditEvents24h,
					activeSessions: result.activeSessions,
				};
			},
			"system.sessions.revoke": async (command) => {
				const result = await this.adminStore.revokeSystemSession({
					sessionId: command.payload.sessionId,
					accountId: command.payload.accountId,
					actor: caller.userId ?? "unknown",
				});
				if (!result.ok) {
					throw new ProtocolValidationError(result.message, result.code);
				}
				return {
					revoked: result.revoked,
					sessionId: result.sessionId,
				};
			},
			"auth.elevate": async (_command) => {
				const sessionId = requireSession(caller);
				const elevatedUntil = await this.adminStore.startElevation(
					sessionId,
					caller.accountId,
				);
				if (elevatedUntil === undefined) {
					throw new ProtocolValidationError(
						"Admin mode needs a signed-in user session in this account.",
						"forbidden",
					);
				}
				return { elevatedUntil };
			},
			"auth.login.providers": async () => {
				throw new ProtocolValidationError(
					"Public login commands run on /api",
					"unsupported_command",
				);
			},
			"auth.login.devPassword": async () => {
				throw new ProtocolValidationError(
					"Public login commands run on /api",
					"unsupported_command",
				);
			},
			"auth.assumeRole": async () => {
				throw new ProtocolValidationError(
					"Public login commands run on /api",
					"unsupported_command",
				);
			},
			"auth.login.google.start": async () => {
				throw new ProtocolValidationError(
					"Public login commands run on /api",
					"unsupported_command",
				);
			},
			"auth.login.device.start": async () => {
				throw new ProtocolValidationError(
					"Public login commands run on /api",
					"unsupported_command",
				);
			},
			"auth.login.device.poll": async () => {
				throw new ProtocolValidationError(
					"Public login commands run on /api",
					"unsupported_command",
				);
			},
			"auth.login.device.approve": async () => {
				throw new ProtocolValidationError(
					"Public login commands run on /api",
					"unsupported_command",
				);
			},
			"auth.login.device.deny": async () => {
				throw new ProtocolValidationError(
					"Public login commands run on /api",
					"unsupported_command",
				);
			},
			"auth.session.refresh": async () => {
				throw new ProtocolValidationError(
					"Public login commands run on /api",
					"unsupported_command",
				);
			},
			"auth.session.logout": async () => {
				throw new ProtocolValidationError(
					"Public login commands run on /api",
					"unsupported_command",
				);
			},
			"auth.methods.delete": async (command) => {
				requireSession(caller);
				const result = await this.adminStore.revokeLoginMethod(
					caller.userId ?? "",
					command.payload.methodId,
				);
				if (!result.ok) {
					throw new ProtocolValidationError(
						"last_login_method: the last active login method cannot be deleted",
						"conflict",
					);
				}
				return {
					deleted: result.revoked,
					sessionsRevoked: result.sessionsRevoked,
				};
			},
			"auth.elevation.end": async (_command) => {
				const sessionId = requireSession(caller);
				return { ended: await this.adminStore.endElevation(sessionId) };
			},
			"auth.sessions.revokeOthers": async (_command) => {
				const sessionId = requireSession(caller);
				const revoked = await this.adminStore.revokeOtherSessions(
					caller.userId ?? "",
					sessionId,
				);
				return { revoked };
			},
			"auth.memberships.list": async (_command) => {
				requireSession(caller);
				return {
					memberships: await this.adminStore.listMemberships(
						caller.userId ?? "",
					),
				};
			},
			"auth.methods.list": async (_command) => {
				requireSession(caller);
				return {
					methods: await this.adminStore.listLoginMethods(caller.userId ?? ""),
				};
			},
			"auth.whoami": async (_command) => {
				const profile = caller.userId
					? await this.adminStore.userProfile(caller.userId)
					: undefined;
				return {
					principal: {
						kind: caller.kind ?? "user",
						...(caller.userId ? { userId: caller.userId } : {}),
						...(profile?.name ? { name: profile.name } : {}),
						...(profile?.email ? { email: profile.email } : {}),
						accountId: caller.accountId ?? meta.accountId,
						role: caller.role ?? "user",
						...(caller.provisional ? { provisional: true } : {}),
						...(isElevated(caller) && caller.elevatedUntil
							? { elevatedUntil: caller.elevatedUntil }
							: {}),
					},
				};
			},
			"family.list": async (_command) => {
				const families = await this.adminStore.listFamilies(meta.accountId);
				return { families };
			},
			"family.create": async (command) => {
				const family = await this.adminStore.createFamily(meta.accountId, {
					familyId: command.payload.familyId,
					name: command.payload.name,
					timezone: command.payload.timezone ?? meta.timezone,
					harvestDelayMs: command.payload.harvestDelayMs ?? meta.harvestDelayMs,
				});
				return { family };
			},
			"family.delete": async (command) => {
				await this.adminStore.deleteFamily(
					meta.accountId,
					command.payload.familyId,
				);
				return { deleted: command.payload.familyId };
			},
			"family.get": async () => {
				const record = await this.adminStore.getFamily(
					meta.accountId,
					meta.familyId,
				);
				if (!record) {
					throw new ProtocolValidationError(
						`Bot Family '${meta.familyId}' not found in account '${meta.accountId}'`,
						"family_not_found",
					);
				}
				return { family: record };
			},
			"family.update": async (command) => {
				if (command.payload.timezone !== undefined) {
					assertValidIanaTimezone(command.payload.timezone);
				}
				if (command.payload.teamLeaderBotId) {
					const leader = this.familyStore.bots.getBot(
						command.payload.teamLeaderBotId,
					);
					if (!leader) {
						throw new ProtocolValidationError(
							`Bot '${command.payload.teamLeaderBotId}' not found`,
							"not_found",
						);
					}
				}
				const updated = this.setFamilyMeta({
					...(command.payload.name !== undefined
						? { name: command.payload.name }
						: {}),
					...(command.payload.timezone !== undefined
						? { timezone: command.payload.timezone }
						: {}),
					...(command.payload.harvestDelayMs !== undefined
						? { harvestDelayMs: command.payload.harvestDelayMs }
						: {}),
					...(command.payload.teamLeaderBotId !== undefined
						? { teamLeaderBotId: command.payload.teamLeaderBotId }
						: {}),
				});
				const record = await this.adminStore.updateFamily(
					meta.accountId,
					updated.familyId,
					{
						name: updated.name,
						timezone: updated.timezone,
						harvestDelayMs: updated.harvestDelayMs,
						teamLeaderBotId: updated.teamLeaderBotId,
					},
				);
				if (!record) {
					throw new ProtocolValidationError(
						`Bot Family '${updated.familyId}' not found in account '${meta.accountId}'`,
						"family_not_found",
					);
				}
				return { family: record };
			},
			"bot.list": async (_command) => {
				return { bots: this.familyStore.bots.listBots() };
			},
			"bot.create": async (command) => {
				const bot = await this.createBotInternal(command.payload);
				return { bot };
			},
			"bot.get": async (command) => {
				const bot = this.familyStore.bots.getBot(command.payload.botId);
				if (!bot) {
					throw new ProtocolValidationError(
						`Bot '${command.payload.botId}' not found`,
						"not_found",
					);
				}
				const soul = this.familyStore.files.getSoul(bot.id);
				const memory = this.familyStore.files.getMemory(bot.id);
				const skills = this.familyStore.files.listSkills(bot.id);
				const resolved = await this.toolsEnvController.resolvedFields(
					bot,
					null,
				);
				return { bot, soul, memory, skills, ...resolved };
			},
			"bot.update": async (command) => {
				const existing = this.familyStore.bots.getBot(command.payload.botId);
				if (!existing) {
					throw new ProtocolValidationError(
						`Bot '${command.payload.botId}' not found`,
						"not_found",
					);
				}
				const modelStr = command.payload.model ?? existing.model;
				const modelRef = parseModelRef(modelStr);
				if (this.modelsInstance) {
					await checkModel(this.modelsInstance, modelRef);
				}
				const thinkingStr = command.payload.thinking ?? existing.thinking;
				if (command.payload.timezone !== undefined) {
					assertValidIanaTimezone(command.payload.timezone);
				}
				let metadata = existing.metadata;
				if (command.payload.metadata !== undefined) {
					assertBotMetadata(command.payload.metadata);
					metadata = mergeMetadataPatch(
						existing.metadata,
						command.payload.metadata,
					);
					assertBotMetadata(metadata);
				}
				const updated: BotRecord = {
					...existing,
					name: command.payload.name ?? existing.name,
					model: modelStr,
					thinking: thinkingStr,
					timezone: command.payload.timezone ?? existing.timezone,
				};
				if (metadata !== undefined) updated.metadata = metadata;
				else delete updated.metadata;
				// Omitted leaves the allowlist unchanged. null clears it (all catalog tools).
				// An array, including [], replaces it. pi-durable treats configure
				// tools: null as "delete the filter" (every registered tool). [] must
				// stay an array so the filter is empty instead of deleted.
				if (command.payload.tools === null) {
					delete updated.tools;
				} else if (Array.isArray(command.payload.tools)) {
					updated.tools = command.payload.tools;
				}
				const agentTools =
					command.payload.tools === null
						? { tools: null }
						: Array.isArray(command.payload.tools)
							? { tools: toToolRegs(command.payload.tools) }
							: {};
				if (Object.hasOwn(command.payload, "toolsEnv")) {
					const next = command.payload.toolsEnv ?? null;
					await this.toolsEnvController.assertSetting(next, "bot");
					await this.toolsEnvController.dropPreviousBinding({
						previous: existing.toolsEnv ?? null,
						next,
						level: "bot",
						bot: existing,
					});
					if (next) updated.toolsEnv = next;
					else delete updated.toolsEnv;
				}
				this.familyStore.bots.upsertBot(updated);
				if (updated.name !== existing.name) {
					const primary = this.familyStore.chats.getChat(
						primaryChatKey(updated.id),
					);
					if (primary) {
						this.familyStore.chats.upsertChat({
							...primary,
							title: updated.name,
						});
					}
				}
				if (
					command.payload.timezone !== undefined &&
					command.payload.timezone !== existing.timezone
				) {
					for (const sched of this.familyStore.schedules.listSchedules(
						updated.id,
						true,
					)) {
						if (sched.kind !== "cron" || !sched.enabled) continue;
						const cronNext = nextCron(
							String(sched.input),
							Date.now(),
							updated.timezone,
						);
						if (cronNext !== undefined) {
							this.familyStore.schedules.upsertSchedule({
								...sched,
								nextRun: cronNext,
							});
						}
					}
					await this.syncAlarmInternal();
				}
				if (command.payload.soul !== undefined) {
					this.familyStore.files.setSoul(updated.id, command.payload.soul);
				}

				const { harness, context } = await this.ensureHarness();
				const configuredConvs = new Set<number>();
				const rootConv = await harness.conversation(
					updated.rootConversationId as ConversationId,
					context,
				);
				if (rootConv) {
					configuredConvs.add(updated.rootConversationId);
					await rootConv.configure(
						{
							model: modelRef,
							thinkingLevel: parseThinkingLevel(thinkingStr) ?? null,
							...agentTools,
						},
						context,
					);
				}
				for (const chat of this.familyStore.chats.listChats(updated.id)) {
					if (configuredConvs.has(chat.conversationId)) continue;
					configuredConvs.add(chat.conversationId);
					const conv = await harness.conversation(
						chat.conversationId as ConversationId,
						context,
					);
					if (conv) {
						await conv.configure(
							{
								model: modelRef,
								thinkingLevel:
									parseThinkingLevel(chat.thinking ?? thinkingStr) ?? null,
								...agentTools,
							},
							context,
						);
					}
				}
				return { bot: updated };
			},
			"bot.delete": async (command) => {
				const botId = command.payload.botId;
				const existing = this.familyStore.bots.getBot(botId);
				if (!existing) {
					throw new ProtocolValidationError(
						`Bot '${botId}' not found`,
						"not_found",
					);
				}
				const groupChatKeys: string[] = [];
				for (const group of this.familyStore.groups.list()) {
					if (group.creatorBotId === botId || group.members.includes(botId)) {
						groupChatKeys.push(
							...this.familyStore.groups.memberChatKeys(group.id),
						);
						this.familyStore.groups.delete(group.id);
					}
				}
				const peerPrefix = `peer:${botId}:`;
				const chatsToDelete = [
					...this.familyStore.chats
						.listChats()
						.filter(
							(chat) => chat.botId === botId || chat.key.startsWith(peerPrefix),
						),
					...groupChatKeys.flatMap((key) => {
						const chat = this.familyStore.chats.getChat(key);
						return chat ? [chat] : [];
					}),
				];
				const scheduleIds = new Set(
					this.familyStore.schedules
						.listSchedules(botId, true)
						.map((s) => s.id),
				);
				for (const chat of chatsToDelete) {
					scheduleIds.add(harvestScheduleId(chat.key));
				}

				const { harness, context } = await this.ensureHarness();
				const conversationIds = [
					...new Set([
						existing.rootConversationId,
						...chatsToDelete.map((chat) => chat.conversationId),
					]),
				];
				for (const convId of conversationIds) {
					const watch = this.activeWatches.get(convId);
					if (watch) {
						this.activeWatches.delete(convId);
						await watch.stop().catch(() => {});
					}
					this.streamedAssistantContent.delete(convId);
					const conv = await harness.conversation(
						convId as ConversationId,
						context,
					);
					if (conv) {
						await conv.abort(context).catch(() => {});
					}
				}

				await this.toolsEnvController.deleteScopesForBot(botId);
				for (const chat of chatsToDelete) {
					this.familyStore.chats.deleteConversationRoutesForChat(chat.key);
					this.familyStore.chats.deleteChat(chat.key);
				}
				this.familyStore.bots.deleteBot(botId);
				if (meta.teamLeaderBotId === botId) {
					this.setFamilyMeta({ teamLeaderBotId: null });
					await this.adminStore.updateFamily(meta.accountId, meta.familyId, {
						teamLeaderBotId: null,
					});
				}
				await this.abortScheduleTasksInternal(scheduleIds);
				await this.syncAlarmInternal();
				return { deleted: botId };
			},
			"chat.list": async (command) => {
				const botId = command.payload?.botId;
				const requestedKinds =
					command.payload?.kinds && command.payload.kinds.length > 0
						? new Set<ChatKind>(command.payload.kinds)
						: new Set<ChatKind>(["direct"]);

				const chats: ChatRecord[] = [];
				const storeKinds = Array.from(requestedKinds).filter(
					(k): k is "direct" | "group-member" | "scheduled" => k !== "group",
				);
				if (storeKinds.length > 0) {
					chats.push(
						...this.familyStore.chats.listChats({
							botId,
							kinds: storeKinds,
						}),
					);
				}
				if (requestedKinds.has("group")) {
					const groups = this.familyStore.groups
						.list()
						.filter((group) => !botId || group.members.includes(botId))
						.map((group) => this.groupAsChat(group));
					chats.push(...groups);
				}
				return { chats: chats.map((chat) => this.decorateChat(chat)) };
			},
			"chat.update": async (command) => {
				const chat = this.familyStore.chats.getChat(command.payload.chatKey);
				if (!chat) {
					throw new ProtocolValidationError(
						`Chat '${command.payload.chatKey}' not found`,
						"not_found",
					);
				}
				const bot = this.familyStore.bots.getBot(chat.botId);
				if (!bot) {
					throw new ProtocolValidationError(
						`Bot '${chat.botId}' not found`,
						"not_found",
					);
				}
				const updated: ChatRecord = { ...chat };
				if (command.payload.toolsEnv !== undefined) {
					const next = command.payload.toolsEnv;
					await this.toolsEnvController.assertSetting(
						next,
						"chat",
						bot.toolsEnv ?? null,
					);
					if (next === null) {
						await this.toolsEnvController.dropChatNamespace(chat.key, bot);
					} else {
						await this.toolsEnvController.dropPreviousBinding({
							previous: chat.toolsEnv ?? null,
							next,
							level: "chat",
							bot,
							chatKey: chat.key,
						});
					}
					if (next) updated.toolsEnv = next;
					else delete updated.toolsEnv;
				}
				if (command.payload.harvest !== undefined) {
					updated.harvest = command.payload.harvest;
				}
				if (command.payload.deadlines === null) {
					delete updated.deadlines;
					this.familyStore.chats.setDeadlines(chat.key, null);
				} else if (command.payload.deadlines !== undefined) {
					const merged = mergeDeadlines(
						chat.deadlines,
						command.payload.deadlines,
					);
					updated.deadlines = merged;
					this.familyStore.chats.setDeadlines(chat.key, merged);
				}
				this.familyStore.chats.upsertChat(updated);
				if (updated.harvest === false) {
					const harvestId = harvestScheduleId(chat.key);
					this.familyStore.schedules.deleteSchedule(harvestId);
					await this.abortScheduleTasksInternal(new Set([harvestId]));
					await this.syncAlarmInternal();
				}
				return { chat: this.decorateChat(updated) };
			},
			"chat.get": readChatSnapshot,
			"chat.status": async (command) => {
				return this.readChatStatus(command.payload.chatKey);
			},
			"chat.tasks.list": async (command) => {
				const chat = this.requireChat(command.payload.chatKey);
				return { tasks: this.familyStore.tasks.list(chat.key) };
			},
			"chat.tasks.get": async (command) => {
				const chat = this.requireChat(command.payload.chatKey);
				const task = this.familyStore.tasks.get(
					chat.key,
					command.payload.index,
				);
				if (!task) {
					throw new ProtocolValidationError(
						`Task #${command.payload.index} was not found`,
						"not_found",
					);
				}
				return { task };
			},
			"chat.reset": async (command) => {
				const chat = this.familyStore.chats.getChat(command.payload.chatKey);
				if (!chat) {
					throw new ProtocolValidationError(
						`Chat '${command.payload.chatKey}' not found`,
						"not_found",
					);
				}
				const { harness, context } = await this.ensureHarness();
				const conv = await harness.conversation(
					chat.conversationId as ConversationId,
					context,
				);
				if (conv) {
					await conv.reset(command.payload.handoff, context);
				}
				this.familyStore.tasks.clear(chat.key);
				this.broadcastChatTasksInternal(chat.key);
				return { chat: this.decorateChat(chat), reset: true };
			},
			"turn.submit": async (command) => {
				this.rejectUserPost(command.payload.chatKey);
				const trimmed = command.payload.text.trim();
				if (trimmed.startsWith("/")) {
					const cmdName = trimmed.split(/\s+/)[0];
					throw new ProtocolValidationError(
						`Slash command '${cmdName}' is not supported.`,
						"unsupported_command",
					);
				}
				return this.submitChatTurnInternal({
					chatKey: command.payload.chatKey,
					text: command.payload.text,
					requestId: command.payload.requestId ?? command.payload.clientMsgId,
					whenBusy: command.payload.whenBusy,
					authorUserId: caller.userId,
				});
			},
			"turn.steer": async (command) => {
				this.rejectUserPost(command.payload.chatKey);
				return this.submitChatTurnInternal({
					chatKey: command.payload.chatKey,
					text: command.payload.text,
					requestId: command.payload.requestId ?? command.payload.clientMsgId,
					whenBusy: "steer",
					authorUserId: caller.userId,
				});
			},
			"turn.abort": abortTurn,
			"turn.interrupt": abortTurn,
			"file.list": async (command) => {
				return this.listBotFiles(
					command.payload?.botId,
					command.payload?.category,
				);
			},
			"file.read": async (command) => {
				const { botId, path } = command.payload;
				if (!path) {
					return this.listBotFiles(botId);
				}
				const parsed = parseVirtualPath(path);
				if (!parsed || parsed.kind === "invalid") {
					throw new ProtocolValidationError(
						parsed?.kind === "invalid"
							? parsed.error
							: `Unsupported virtual file path '${path}'. Expected /.cadmus/SOUL.md, /.cadmus/MEMORY.md, /.cadmus/skills/bot/<slug>/SKILL.md, or /.cadmus/skills/family/<slug>/SKILL.md`,
						"invalid_path",
					);
				}
				if (parsed.kind === "skill" && parsed.scope === "family") {
					if (botId) {
						const bot = this.familyStore.bots.getBot(botId);
						if (!bot) {
							throw new ProtocolValidationError(
								`Bot '${botId}' not found`,
								"not_found",
							);
						}
					}
					const doc = this.familyStore.files.getFamilySkill(parsed.slug);
					if (!doc) {
						throw new ProtocolValidationError(
							`Skill file '${parsed.canonicalPath}' not found`,
							"not_found",
						);
					}
					const formatted = formatSkillMarkdown(doc);
					return {
						path: parsed.canonicalPath,
						scope: "family" as const,
						slug: doc.slug,
						description: doc.description,
						...(doc.category ? { category: doc.category } : {}),
						version: doc.version,
						body: doc.body,
						content: formatted,
						text: formatted,
					};
				}
				if (!botId) {
					throw new ProtocolValidationError(
						`botId is required to read '${parsed.canonicalPath}'`,
						"invalid_request",
					);
				}
				const bot = this.familyStore.bots.getBot(botId);
				if (!bot) {
					throw new ProtocolValidationError(
						`Bot '${botId}' not found`,
						"not_found",
					);
				}
				if (parsed.kind === "soul") {
					const content = this.familyStore.files.getSoul(botId);
					return { path: SOUL_VFS_PATH, content, text: content, version: 1 };
				}
				if (parsed.kind === "memory") {
					const mem = this.familyStore.files.getMemory(botId);
					return {
						path: MEMORY_VFS_PATH,
						content: mem.content,
						text: mem.content,
						version: mem.version,
					};
				}
				const doc = this.familyStore.files.getSkill(botId, parsed.slug);
				if (!doc) {
					throw new ProtocolValidationError(
						`Skill file '${parsed.canonicalPath}' not found`,
						"not_found",
					);
				}
				const formatted = formatSkillMarkdown(doc);
				return {
					path: parsed.canonicalPath,
					scope: "bot" as const,
					slug: doc.slug,
					description: doc.description,
					...(doc.category ? { category: doc.category } : {}),
					version: doc.version,
					body: doc.body,
					content: formatted,
					text: formatted,
				};
			},
			"file.write": async (command) => {
				const {
					botId,
					path,
					content: rawContent,
					text: rawText,
					body: rawBody,
					expectedVersion: rawExpectedVersion,
					version: rawVersion,
					description,
					category,
					delete: isDelete,
				} = command.payload;

				const expectedVersion = rawExpectedVersion ?? rawVersion;
				const content = rawContent ?? rawText ?? rawBody ?? "";

				const parsed = parseVirtualPath(path);
				if (!parsed || parsed.kind === "invalid") {
					throw new ProtocolValidationError(
						parsed?.kind === "invalid"
							? parsed.error
							: `Unsupported virtual file path '${path}'. Expected /.cadmus/SOUL.md, /.cadmus/MEMORY.md, /.cadmus/skills/bot/<slug>/SKILL.md, or /.cadmus/skills/family/<slug>/SKILL.md`,
						"invalid_path",
					);
				}

				const isFamilySkill =
					parsed.kind === "skill" && parsed.scope === "family";
				if (isFamilySkill) {
					if (botId) {
						const bot = this.familyStore.bots.getBot(botId);
						if (!bot) {
							throw new ProtocolValidationError(
								`Bot '${botId}' not found`,
								"not_found",
							);
						}
					}
				} else {
					if (!botId) {
						throw new ProtocolValidationError(
							`botId is required to write '${parsed.canonicalPath}'`,
							"invalid_request",
						);
					}
					const bot = this.familyStore.bots.getBot(botId);
					if (!bot) {
						throw new ProtocolValidationError(
							`Bot '${botId}' not found`,
							"not_found",
						);
					}
				}

				if (isDelete) {
					if (parsed.kind !== "skill") {
						throw new ProtocolValidationError(
							`Only /.cadmus/skills/{bot,family}/<slug>/SKILL.md files can be deleted (got '${path}')`,
							"invalid_path",
						);
					}
					if (parsed.scope === "family") {
						const existing = this.familyStore.files.getFamilySkill(parsed.slug);
						if (!existing) {
							throw new ProtocolValidationError(
								`Skill file '${parsed.canonicalPath}' not found`,
								"not_found",
							);
						}
						this.familyStore.files.deleteFamilySkill(
							parsed.slug,
							expectedVersion ?? existing.version,
						);
						return { deleted: parsed.canonicalPath };
					}
					const existing = this.familyStore.files.getSkill(
						botId as string,
						parsed.slug,
					);
					if (!existing) {
						throw new ProtocolValidationError(
							`Skill file '${parsed.canonicalPath}' not found`,
							"not_found",
						);
					}
					this.familyStore.files.deleteSkill(
						botId as string,
						parsed.slug,
						expectedVersion ?? existing.version,
					);
					return { deleted: parsed.canonicalPath };
				}

				if (parsed.kind === "soul") {
					this.familyStore.files.setSoul(botId as string, content);
					return { path: SOUL_VFS_PATH, version: 1, content };
				}
				if (parsed.kind === "memory") {
					const updated = this.familyStore.files.updateMemory(
						botId as string,
						content,
						expectedVersion ?? 0,
					);
					return {
						path: MEMORY_VFS_PATH,
						version: updated.version,
						content: updated.content,
					};
				}
				const slug = parsed.slug;
				let desc = description;
				let cat = category;
				let body = rawBody ?? rawContent ?? rawText ?? "";
				let expVer = expectedVersion;

				if (desc === undefined && body.trimStart().startsWith("---")) {
					const parsedMd = parseSkillMarkdown(body);
					if (parsedMd.name && parsedMd.name !== slug) {
						throw new ProtocolValidationError(
							`Skill frontmatter name '${parsedMd.name}' does not match path slug '${slug}'`,
							"invalid_skill",
						);
					}
					desc = parsedMd.description;
					cat = parsedMd.category;
					body = parsedMd.body;
					if (expVer === undefined && parsedMd.version !== undefined) {
						expVer = parsedMd.version;
					}
				}
				if (!desc) {
					throw new ProtocolValidationError(
						"Skill write requires a description (either in payload.description or YAML frontmatter)",
						"invalid_skill",
					);
				}
				const updated =
					parsed.scope === "family"
						? this.familyStore.files.updateFamilySkill({
								slug,
								description: desc,
								category: cat,
								body,
								expectedVersion: expVer ?? 0,
							})
						: this.familyStore.files.updateSkill(botId as string, {
								slug,
								description: desc,
								category: cat,
								body,
								expectedVersion: expVer ?? 0,
							});
				return {
					path: parsed.canonicalPath,
					scope: parsed.scope,
					slug: updated.slug,
					description: updated.description,
					...(updated.category ? { category: updated.category } : {}),
					version: updated.version,
					body: updated.body,
				};
			},
			"file.delete": async (command) => {
				const { botId, path, expectedVersion, version } = command.payload;
				const parsed = parseVirtualPath(path);
				if (parsed?.kind !== "skill") {
					throw new ProtocolValidationError(
						`Only /.cadmus/skills/{bot,family}/<slug>/SKILL.md files can be deleted (got '${path}')`,
						"invalid_path",
					);
				}
				if (parsed.scope === "family") {
					if (botId) {
						const bot = this.familyStore.bots.getBot(botId);
						if (!bot) {
							throw new ProtocolValidationError(
								`Bot '${botId}' not found`,
								"not_found",
							);
						}
					}
					const existing = this.familyStore.files.getFamilySkill(parsed.slug);
					if (!existing) {
						throw new ProtocolValidationError(
							`Skill file '${parsed.canonicalPath}' not found`,
							"not_found",
						);
					}
					this.familyStore.files.deleteFamilySkill(
						parsed.slug,
						expectedVersion ?? version ?? existing.version,
					);
					return { deleted: parsed.canonicalPath };
				}
				if (!botId) {
					throw new ProtocolValidationError(
						`botId is required to delete '${parsed.canonicalPath}'`,
						"invalid_request",
					);
				}
				const bot = this.familyStore.bots.getBot(botId);
				if (!bot) {
					throw new ProtocolValidationError(
						`Bot '${botId}' not found`,
						"not_found",
					);
				}
				const existing = this.familyStore.files.getSkill(botId, parsed.slug);
				if (!existing) {
					throw new ProtocolValidationError(
						`Skill file '${parsed.canonicalPath}' not found`,
						"not_found",
					);
				}
				this.familyStore.files.deleteSkill(
					botId,
					parsed.slug,
					expectedVersion ?? version ?? existing.version,
				);
				return { deleted: parsed.canonicalPath };
			},
			"schedule.list": async (command) => {
				const schedules = this.familyStore.schedules.listSchedules(
					command.payload?.botId,
					command.payload?.includeInternal ?? false,
				);
				return { schedules };
			},
			"schedule.create": async (command) => {
				const {
					id: customId,
					botId,
					name,
					kind,
					input,
					text,
					target,
					thinking,
					enabled,
				} = command.payload;
				const bot = this.familyStore.bots.getBot(botId);
				if (!bot) {
					throw new ProtocolValidationError(
						`Bot '${botId}' not found`,
						"not_found",
					);
				}
				const resolvedTarget: ScheduleTarget =
					!target || target.mode === "chat"
						? {
								mode: "chat",
								chatKey:
									target?.mode === "chat" && target.chatKey
										? target.chatKey
										: primaryChatKey(botId),
							}
						: target;
				this.assertScheduleTargetOwnership(botId, resolvedTarget);
				const timezone = bot.timezone ?? this.getFamilyMeta().timezone;

				let nextRun: number;
				if (kind === "cron") {
					const cronStr = String(input);
					if (!cronStr || !isValidCron(cronStr)) {
						throw new ProtocolValidationError(
							`Invalid cron expression '${cronStr}'`,
							"invalid_schedule",
						);
					}
					const computed = nextCron(cronStr, Date.now(), timezone);
					if (computed === undefined) {
						throw new ProtocolValidationError(
							`Cron '${cronStr}' has no upcoming occurrence`,
							"invalid_schedule",
						);
					}
					nextRun = computed;
				} else if (kind === "relative") {
					try {
						nextRun = parseRelativeDuration(input, Date.now());
					} catch (err) {
						throw new ProtocolValidationError(
							(err as Error).message,
							"invalid_schedule",
						);
					}
				} else if (kind === "absolute") {
					try {
						nextRun = parseAbsoluteTime(input, Date.now(), timezone);
					} catch (err) {
						throw new ProtocolValidationError(
							(err as Error).message,
							"invalid_schedule",
						);
					}
				} else {
					throw new ProtocolValidationError(
						`Invalid schedule kind '${kind}'`,
						"invalid_schedule",
					);
				}

				const inSeconds = computeInSeconds(nextRun, Date.now());
				const schedule: ScheduleRecord = {
					id: customId ?? `sched-${crypto.randomUUID().slice(0, 8)}`,
					botId,
					...(name ? { name } : {}),
					kind,
					input,
					nextRun,
					inSeconds,
					recurring: kind === "cron",
					text,
					target: resolvedTarget,
					...(thinking ? { thinking } : {}),
					enabled: enabled ?? true,
				};
				this.familyStore.schedules.upsertSchedule(schedule);
				if (schedule.enabled) {
					await this.ensureScheduleTaskInternal(schedule.id);
				}
				await this.syncAlarmInternal();
				this.log().debug("schedule created", {
					schedule: schedule.id,
					kind: schedule.kind,
					nextRun: schedule.nextRun,
					inSeconds: schedule.inSeconds,
				});
				return { schedule };
			},
			"schedule.update": async (command) => {
				const existing = this.familyStore.schedules.getSchedule(
					command.payload.id,
				);
				if (!existing) {
					throw new ProtocolValidationError(
						`Schedule '${command.payload.id}' not found`,
						"not_found",
					);
				}
				const bot = this.familyStore.bots.getBot(existing.botId);
				const timezone = bot?.timezone ?? this.getFamilyMeta().timezone;

				const targetKind = command.payload.kind ?? existing.kind;
				const targetInput =
					command.payload.input !== undefined
						? command.payload.input
						: existing.input;
				let nextRun = existing.nextRun;

				if (
					command.payload.input !== undefined ||
					(command.payload.kind !== undefined &&
						command.payload.kind !== existing.kind)
				) {
					if (targetKind === "cron") {
						const cronStr = String(targetInput);
						if (!cronStr || !isValidCron(cronStr)) {
							throw new ProtocolValidationError(
								`Invalid cron expression '${cronStr}'`,
								"invalid_schedule",
							);
						}
						const computed = nextCron(cronStr, Date.now(), timezone);
						if (computed === undefined) {
							throw new ProtocolValidationError(
								`Cron '${cronStr}' has no upcoming occurrence`,
								"invalid_schedule",
							);
						}
						nextRun = computed;
					} else if (targetKind === "relative") {
						try {
							nextRun = parseRelativeDuration(targetInput, Date.now());
						} catch (err) {
							throw new ProtocolValidationError(
								(err as Error).message,
								"invalid_schedule",
							);
						}
					} else if (targetKind === "absolute") {
						try {
							nextRun = parseAbsoluteTime(targetInput, Date.now(), timezone);
						} catch (err) {
							throw new ProtocolValidationError(
								(err as Error).message,
								"invalid_schedule",
							);
						}
					}
				}

				if (command.payload.target) {
					this.assertScheduleTargetOwnership(
						existing.botId,
						command.payload.target,
					);
				}
				const inSeconds = computeInSeconds(nextRun, Date.now());
				const updated: ScheduleRecord = {
					...existing,
					...(command.payload.name !== undefined
						? { name: command.payload.name }
						: {}),
					kind: targetKind,
					input: targetInput,
					nextRun,
					inSeconds,
					recurring: targetKind === "cron",
					text: command.payload.text ?? existing.text,
					target: command.payload.target ?? existing.target,
					...(command.payload.thinking !== undefined
						? { thinking: command.payload.thinking }
						: {}),
					enabled: command.payload.enabled ?? existing.enabled,
				};
				this.familyStore.schedules.upsertSchedule(updated);
				if (updated.enabled) {
					await this.ensureScheduleTaskInternal(updated.id);
				}
				await this.syncAlarmInternal();
				this.log().debug("schedule updated", {
					schedule: updated.id,
					enabled: updated.enabled,
					nextRun: updated.nextRun,
					inSeconds: updated.inSeconds,
				});
				return { schedule: updated };
			},
			"schedule.delete": async (command) => {
				const existing = this.familyStore.schedules.getSchedule(
					command.payload.id,
				);
				if (!existing) {
					throw new ProtocolValidationError(
						`Schedule '${command.payload.id}' not found`,
						"not_found",
					);
				}
				this.familyStore.schedules.deleteSchedule(command.payload.id);
				await this.abortScheduleTasksInternal(new Set([command.payload.id]));
				await this.syncAlarmInternal();
				this.log().debug("schedule deleted", { schedule: command.payload.id });
				return { deleted: command.payload.id };
			},
		};
	}

	private assertScheduleTargetOwnership(
		botId: string,
		target: ScheduleTarget,
	): void {
		if (target.mode === "chat" || target.mode === "fork") {
			const chat = this.familyStore.chats.getChat(target.chatKey);
			if (chat && chat.botId !== botId) {
				throw new ProtocolValidationError(
					`Chat '${target.chatKey}' belongs to bot '${chat.botId}', not '${botId}'`,
					"conflict",
				);
			}
		}
	}

	private listBotFiles(botId?: string, category?: string) {
		const encoder = new TextEncoder();
		const familySkills = this.familyStore.files.listFamilySkills(category);
		const familyItems = familySkills.map((doc) => ({
			path: skillVfsPath("family", doc.slug),
			kind: "skill" as const,
			scope: "family" as const,
			slug: doc.slug,
			description: doc.description,
			...(doc.category ? { category: doc.category } : {}),
			version: doc.version,
			size: encoder.encode(doc.body).byteLength,
		}));
		if (!botId) {
			return { files: familyItems };
		}
		const bot = this.familyStore.bots.getBot(botId);
		if (!bot) {
			throw new ProtocolValidationError(
				`Bot '${botId}' not found`,
				"not_found",
			);
		}
		const soul = this.familyStore.files.getSoul(botId);
		const memory = this.familyStore.files.getMemory(botId);
		const botSkills = this.familyStore.files.listSkills(botId, category);
		const files = [
			{
				path: SOUL_VFS_PATH,
				kind: "soul" as const,
				size: encoder.encode(soul).byteLength,
			},
			{
				path: MEMORY_VFS_PATH,
				kind: "memory" as const,
				version: memory.version,
				size: encoder.encode(memory.content).byteLength,
			},
			...botSkills.map((doc) => ({
				path: skillVfsPath("bot", doc.slug),
				kind: "skill" as const,
				scope: "bot" as const,
				slug: doc.slug,
				description: doc.description,
				...(doc.category ? { category: doc.category } : {}),
				version: doc.version,
				size: encoder.encode(doc.body).byteLength,
			})),
			...familyItems,
		];
		return { files };
	}

	private async prepareConversationTools(
		conversationId: number,
	): Promise<void> {
		const { harness, context } = await this.ensureHarness();
		const agent = await harness.snapshot(
			AgentDoc,
			conversationId as ConversationId,
			context,
		);
		if (!agent?.cwd?.trim()) return;
		const bot = this.familyStore.bots.getBot(agent.cwd.trim());
		if (!bot) return;
		const chat = this.familyStore.chats.getChatByConversationId(conversationId);
		const workspaceEnvEnabled =
			await this.toolsEnvController.workspaceEnvEnabled(conversationId, bot);
		const groupSession =
			chat?.kind === "group" ||
			chat?.kind === "group-member" ||
			Boolean(chat?.key.startsWith("gmem:"));
		const isGroupCaller = chat ? this.isGroupCallerSession(chat.key) : false;
		const member = chat
			? this.familyStore.groups.findByMemberKey(chat.key)
			: undefined;
		const isConsultMember =
			member?.role === "member" && member.group.toolsReadOnly === true;
		const hasActiveTasks = chat
			? this.familyStore.tasks.openCount(chat.key) > 0
			: false;
		const provider = agent.model?.provider ?? extractModelProvider(bot.model);
		const route = this.familyStore.chats.getConversationRoute(conversationId);
		const actCtx: ExtensionActivationContext = {
			bot,
			chat,
			workspaceEnvEnabled,
			isGroupSession: groupSession,
			isGroupCaller,
			isConsultMember,
			isHarvest: route?.kind === "harvest",
			hasActiveTasks,
			provider,
		};
		const resolved = resolveConversationExtensionsAndTools(actCtx);

		const currentExt = agent.extensions;
		const currentAdd = new Set(
			Array.isArray(currentExt) ? currentExt : (currentExt?.add ?? []),
		);
		const currentRemove = new Set(
			Array.isArray(currentExt) ? [] : (currentExt?.remove ?? []),
		);
		const nextAdd = new Set(resolved.extensions.add.map((e) => e.name));
		const nextRemove = new Set(resolved.extensions.remove.map((e) => e.name));

		const extMatches =
			currentAdd.size === nextAdd.size &&
			[...currentAdd].every((name) => nextAdd.has(name)) &&
			currentRemove.size === nextRemove.size &&
			[...currentRemove].every((name) => nextRemove.has(name));

		const currentTools = agent.tools;
		const currentToolNames: readonly string[] = Array.isArray(currentTools)
			? currentTools
			: [];
		const nextToolNames = resolved.tools.map((t) => t.name);

		const toolsMatch =
			currentToolNames.length === nextToolNames.length &&
			currentToolNames.every(
				(name: string, i: number) => name === nextToolNames[i],
			);

		if (extMatches && toolsMatch) return;

		const conv = await harness.conversation(
			conversationId as ConversationId,
			context,
		);
		if (!conv) return;
		await conv.configure(
			{
				extensions: {
					add: resolved.extensions.add,
					remove: resolved.extensions.remove,
				},
				tools: resolved.tools,
			},
			context,
		);
	}

	private async workspaceEnvEnabled(
		conversationId: number,
		botId: string,
	): Promise<boolean> {
		const bot = this.familyStore.bots.getBot(botId);
		if (!bot) return false;
		return this.toolsEnvController.workspaceEnvEnabled(conversationId, bot);
	}

	private async describeToolsEnv(input: {
		conversationId: number;
		botId: string;
		toolNames: readonly string[];
		provider?: string | null;
	}): Promise<
		{ name: "tools-env" | "tools-env-unavailable"; text: string } | undefined
	> {
		const bot = this.familyStore.bots.getBot(input.botId);
		if (!bot) return undefined;
		const route = this.familyStore.chats.getConversationRoute(
			input.conversationId,
		);
		if (route?.kind === "harvest" || (route && !route.toolsEnvEnabled)) {
			return undefined;
		}
		const chat = route
			? this.familyStore.chats.getChat(route.chatKey)
			: this.familyStore.chats.getChatByConversationId(input.conversationId);
		const member = chat
			? this.familyStore.groups.findByMemberKey(chat.key)
			: undefined;
		if (member?.role === "member" && member.group.toolsReadOnly === true) {
			return undefined;
		}
		const workspaceTools = input.toolNames.filter(isWorkspaceTool);
		if (workspaceTools.length === 0) return undefined;
		const bashOffered = workspaceTools.includes(BASH_TOOL_NAME);
		const effectiveProvider = input.provider ?? extractModelProvider(bot.model);
		const codeExecuteOffered =
			(bot.tools === undefined || bot.tools.includes(CODE_EXECUTE_TOOL_NAME)) &&
			(effectiveProvider === null ||
				effectiveProvider === "xai" ||
				effectiveProvider === "google" ||
				effectiveProvider === "faux");
		const { resolved, def } = await this.toolsEnvController.resolvedFor(
			bot,
			chat?.toolsEnv ?? null,
		);
		if (
			!runtimeToolsEnvOn(resolved) ||
			!def ||
			(def.kind !== "just-bash" && def.kind !== "local-daemon")
		) {
			return chooseToolsEnvIdentity({
				enabled: false,
				connected: false,
				toolsOffered: true,
				bashOffered,
				codeExecuteOffered,
				harvest: false,
				enabledSource: resolved.enabledSource,
				provider: input.provider,
			});
		}
		const botLevel = await this.toolsEnvController.resolvedFor(bot, null);
		const botDef = botLevel.resolved.binding
			? (await this.toolsEnvController.catalog()).defs.get(
					botLevel.resolved.binding.envId,
				)
			: undefined;
		const connection = await this.toolsEnvController.connectionFor(def);
		const connected = connection.status === "connected";
		const root =
			def.kind === "just-bash"
				? WORKSPACE_ROOT
				: connected
					? connection.workspacePath
					: undefined;
		return chooseToolsEnvIdentity({
			enabled: true,
			connected: connected && root !== undefined,
			toolsOffered: true,
			bashOffered,
			codeExecuteOffered,
			harvest: false,
			kind: def.kind,
			envId: def.envId,
			enabledSource: resolved.enabledSource,
			bindingSource: resolved.bindingSource,
			persist: def.persist,
			confineToWorkspace: def.confineToWorkspace,
			confinementPolicy: def.confinementPolicy,
			confined: def.kind === "just-bash" ? true : connection.confined,
			sharedWorkspace: def.sharedWorkspace,
			scopeKind: resolved.scopeKind,
			botDefaultKind: botDef?.kind,
			provider: input.provider,
			...(root ? { root } : {}),
		});
	}

	// ─── Live chat.status ──────────────────────────────────────────────────────

	private async readChatStatus(chatKey: string) {
		const chat = this.familyStore.chats.getChat(chatKey);
		if (!chat) {
			throw new ProtocolValidationError(
				`Chat '${chatKey}' not found`,
				"not_found",
			);
		}
		const bot = this.familyStore.bots.getBot(chat.botId);
		if (!bot) {
			throw new ProtocolValidationError(
				`Bot '${chat.botId}' not found`,
				"not_found",
			);
		}

		const { harness, context } = await this.ensureHarness();
		const convId = chat.conversationId as ConversationId;
		const conv = await harness.conversation(convId, context);
		const live = await harness.snapshot(LiveDoc, convId, context);
		const chatUsage = await computeChatUsage(chat, this.familyStore, (id) =>
			harness.snapshot(UsageDoc, id as unknown as ConversationId, context),
		);
		const botUsage = await computeBotUsage(bot.id, this.familyStore, (id) =>
			harness.snapshot(UsageDoc, id as unknown as ConversationId, context),
		);
		const ctxView = conv ? await conv.context(context) : undefined;
		const entryCount = ctxView ? ctxView.entries.length : 0;
		const totalEntryCount = conv
			? await this.countConversationEntries(conv, context)
			: 0;
		const contextTokens = ctxView ? estimateViewContextTokens(ctxView) : 0;
		const modelRef = parseModelRef(bot.model);
		const modelInfo =
			modelRef && this.modelsInstance
				? this.modelsInstance.getModel(modelRef.provider, modelRef.modelId)
				: undefined;
		const contextWindow = modelInfo?.contextWindow ?? 128_000;
		const headEntryId =
			ctxView?.head && CompactionEntry.is(ctxView.head)
				? Number(ctxView.head.id)
				: undefined;
		const firstKeptEntryId =
			ctxView?.head && CompactionEntry.is(ctxView.head)
				? Number(ctxView.head.head)
				: undefined;
		const compactionSnapshot = buildCompactionSnapshot(
			live,
			headEntryId,
			firstKeptEntryId,
		);
		const compaction = {
			...compactionSnapshot,
			contextTokens,
			contextWindow,
			policy: { ...DEFAULT_CADMUS_COMPACTION_POLICY },
		};
		const watermark = this.familyStore.harvest.getWatermark(chatKey);

		const allSchedules = this.familyStore.schedules
			.listSchedules(bot.id, true)
			.filter((s) => s.enabled);
		let nextWakeAt: number | null = null;
		for (const s of allSchedules) {
			if (nextWakeAt === null || s.nextRun < nextWakeAt) {
				nextWakeAt = s.nextRun;
			}
		}

		const effectiveThinking = chat.thinking ?? bot.thinking;
		const workspaceEnvEnabled =
			await this.toolsEnvController.workspaceEnvEnabled(
				chat.conversationId,
				bot,
			);
		const member = this.familyStore.groups.findByMemberKey(chat.key);
		const consult =
			member?.role === "member" && member.group.toolsReadOnly === true;
		const effectiveTools = consult
			? readOnlyGroupToolNames(bot.tools)
			: effectiveToolNames(bot.tools, {
					workspaceEnvEnabled,
					model: bot.model,
				});
		const toolsEnvNest = await this.toolsEnvController.statusForChat(chat.key);
		const toolsEnv = toolsEnvNest.enabled
			? {
					enabled: true,
					enabledSource: toolsEnvNest.enabledSource,
					...(toolsEnvNest.kind ? { kind: toolsEnvNest.kind } : {}),
					...(toolsEnvNest.envId ? { envId: toolsEnvNest.envId } : {}),
					...(toolsEnvNest.bindingSource
						? { bindingSource: toolsEnvNest.bindingSource }
						: {}),
					...(toolsEnvNest.status ? { status: toolsEnvNest.status } : {}),
					...(toolsEnvNest.connectedAt !== undefined
						? { connectedAt: toolsEnvNest.connectedAt }
						: {}),
					...(toolsEnvNest.lastError
						? { lastError: toolsEnvNest.lastError }
						: {}),
				}
			: {
					enabled: false,
					enabledSource: toolsEnvNest.enabledSource,
					...(toolsEnvNest.bindingSource
						? { bindingSource: toolsEnvNest.bindingSource }
						: {}),
					...(toolsEnvNest.envId ? { envId: toolsEnvNest.envId } : {}),
				};
		const status = {
			chatKey: chat.key,
			conversationId: chat.conversationId,
			botId: bot.id,
			botName: bot.name,
			model: bot.model,
			thinking: effectiveThinking,
			tools: effectiveTools ? [...effectiveTools] : ("all" as const),
			busy: Boolean(live?.run),
			entryCount,
			totalEntryCount,
			compaction,
			harvestWatermark: watermark,
			nextWakeAt,
			usage: chatUsage,
			botUsage,
			tasks: this.taskStatusCounts(chat.key),
			toolsEnv,
		};

		this.log().child(chatFields(chat)).debug("command", { name: "status" });

		return { status };
	}

	// ─── Internal Bot, Chat, Turn, and Schedule Operations ─────────────────────

	private async createBotInternal(input: {
		slug?: string;
		name: string;
		model?: string;
		thinking?: ThinkingLevel;
		tools?: string[];
		soul?: string;
		memory?: string;
		toolsEnv?: ToolsEnvSetting | null;
		timezone?: string;
		metadata?: BotRecord["metadata"];
		skills?: {
			slug: string;
			description: string;
			category?: string;
			body: string;
		}[];
	}): Promise<BotRecord> {
		const slug =
			input.slug?.trim() ||
			input.name
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, "-")
				.replace(/^-+|-+$/g, "")
				.slice(0, 32) ||
			`bot-${crypto.randomUUID().slice(0, 6)}`;

		if (!SLUG_REGEX.test(slug)) {
			throw new ProtocolValidationError(
				`Invalid bot slug '${slug}': must match /^[a-z0-9][a-z0-9-]{0,63}$/`,
				"invalid_slug",
			);
		}

		if (this.familyStore.bots.getBot(slug)) {
			throw new ProtocolValidationError(
				`Bot '${slug}' already exists in this family`,
				"already_exists",
			);
		}

		const toolsEnv = input.toolsEnv ?? null;
		if (toolsEnv) {
			await this.toolsEnvController.assertSetting(toolsEnv, "bot");
		}

		const modelStr = input.model ?? "faux/echo";
		const modelRef = parseModelRef(modelStr);
		if (this.modelsInstance) {
			const source = await checkModel(this.modelsInstance, modelRef);
			this.log().info(`Model auth for ${slug} (${modelStr}): ${source}`, {
				bot: slug,
				model: modelStr,
				source,
			});
		}
		const thinkingStr: ThinkingLevel = input.thinking ?? "off";

		const createdAt = Date.now();
		const preview: BotRecord = {
			id: slug,
			name: input.name,
			model: modelStr,
			thinking: thinkingStr,
			timezone: "UTC",
			...(input.tools !== undefined ? { tools: input.tools } : {}),
			...(toolsEnv ? { toolsEnv } : {}),
			rootConversationId: 0,
			primaryChatKey: primaryChatKey(slug),
			createdAt,
		};
		const workspaceEnvEnabled = await this.toolsEnvController.isWorkspaceEnvOn(
			preview,
			null,
		);

		const { harness, context } = await this.ensureHarness();
		const initialTools = resolveConversationExtensionsAndTools({
			bot: preview,
			workspaceEnvEnabled,
			isGroupSession: false,
			isGroupCaller: false,
			isConsultMember: false,
			hasActiveTasks: false,
			provider: modelRef?.provider ?? extractModelProvider(modelStr),
		});
		const rootConv = await harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: {
					model: modelRef,
					thinkingLevel: parseThinkingLevel(thinkingStr) ?? null,
					cwd: slug,
					extensions: {
						add: initialTools.extensions.add,
						remove: initialTools.extensions.remove,
					},
					tools: initialTools.tools,
				},
			},
			context,
		);

		const meta = this.getFamilyMeta();
		const botTimezone = input.timezone ?? meta.timezone;
		assertValidIanaTimezone(botTimezone);
		if (input.metadata !== undefined) {
			assertBotMetadata(input.metadata);
		}

		const bot: BotRecord = {
			id: slug,
			name: input.name,
			model: modelStr,
			thinking: thinkingStr,
			timezone: botTimezone,
			...(input.tools !== undefined ? { tools: input.tools } : {}),
			...(toolsEnv ? { toolsEnv } : {}),
			...(input.metadata !== undefined && Object.keys(input.metadata).length > 0
				? { metadata: input.metadata }
				: {}),
			rootConversationId: rootConv.id as unknown as number,
			primaryChatKey: primaryChatKey(slug),
			createdAt,
		};

		this.familyStore.bots.upsertBot(bot);
		const primaryChat: ChatRecord = {
			key: bot.primaryChatKey,
			botId: bot.id,
			conversationId: bot.rootConversationId,
			title: bot.name,
			kind: "direct",
			createdAt,
		};
		this.familyStore.chats.upsertChat(primaryChat);
		this.familyStore.chats.recordConversationRoute({
			conversationId: bot.rootConversationId,
			chatKey: primaryChat.key,
			botId: bot.id,
			toolsEnvEnabled: true,
			kind: "direct",
		});
		await this.attachConversationWatch(primaryChat, rootConv, context);
		this.familyStore.files.setSoul(slug, input.soul ?? DEFAULT_SOUL);

		if (input.memory !== undefined && input.memory !== "") {
			this.familyStore.files.updateMemory(slug, input.memory, 0);
		}
		if (input.skills) {
			for (const s of input.skills) {
				this.familyStore.files.updateSkill(slug, {
					slug: s.slug,
					description: s.description,
					category: s.category,
					body: s.body,
					expectedVersion: 0,
				});
			}
		}

		this.log().info("bot created", {
			bot: bot.id,
			model: bot.model,
			session: bot.rootConversationId,
		});

		return bot;
	}

	private rejectUserPost(chatKey: string): void {
		const group = this.familyStore.groups.getById(chatKey);
		const chat = this.familyStore.chats.getChat(chatKey);
		if (group || chat?.readOnly || chat?.kind === "group-member") {
			throw new ProtocolValidationError(
				`Chat '${chatKey}' is read-only.`,
				"forbidden",
			);
		}
	}

	private groupAsChat(group: GroupChatRecord): ChatRecord {
		return this.decorateChat({
			key: group.id,
			botId: group.creatorBotId,
			conversationId: 0,
			title: group.topic,
			createdAt: group.createdAt,
			kind: "group",
			members: group.members,
			topic: group.topic,
			readOnly: true,
			...(group.toolsReadOnly === true ? { toolsReadOnly: true } : {}),
			harvest: false,
			groupStatus: group.status,
			...(group.status !== "open" ? { closed: true } : {}),
		});
	}

	private isGroupCallerSession(chatKey: string): boolean {
		const member = this.familyStore.groups.findByMemberKey(chatKey);
		return Boolean(
			member && member.role === "caller" && member.group.status === "open",
		);
	}

	private endGroupConversationInternal(
		chatKey: string,
		response: string,
	): boolean {
		const member = this.familyStore.groups.findByMemberKey(chatKey);
		if (member?.role !== "caller" || member.group.status !== "open") {
			return false;
		}
		member.group.endResponse = response;
		member.group.updatedAt = Date.now();
		this.familyStore.groups.save(member.group);
		return true;
	}

	private groupTimeouts(): { replyMs: number; overallMs: number } {
		const resolved = resolveDeadlines({ kind: "group" }, this.env);
		return { replyMs: resolved.turnMs, overallMs: resolved.runMs };
	}

	private groupDeps() {
		const timeouts = this.groupTimeouts();
		return {
			store: this.familyStore,
			now: () => Date.now(),
			replyMs: timeouts.replyMs,
			overallMs: timeouts.overallMs,
			createChat: async (chat: {
				botId: string;
				key: string;
				title: string;
				harvest: false;
				kind: "group-member";
				originChatKey?: string;
			}) =>
				this.createChatInternal({
					botId: chat.botId,
					key: chat.key,
					title: chat.title,
					harvest: false,
					kind: "group-member",
					originChatKey: chat.originChatKey,
				}),
			submitTurn: async (turn: {
				chatKey: string;
				text: string;
				requestId: string;
				replyTimeoutMs: number;
			}) => {
				try {
					return await this.submitChatTurnInternal(turn);
				} catch (error) {
					if (
						error instanceof GroupReplyTimeout ||
						error instanceof TurnDeadlineError
					) {
						await this.abortChatInternal(turn.chatKey);
					}
					throw error;
				}
			},
			abortChat: (chatKey: string) => this.abortChatInternal(chatKey),
			syncAlarm: async () => {
				await this.syncAlarmInternal();
			},
			log: (message: string, fields?: Record<string, unknown>) => {
				this.log().info(message, fields);
			},
		};
	}

	private async adoptGroupWakeRoot(chatKey: string): Promise<void> {
		const chat = this.familyStore.chats.getChat(chatKey);
		if (!chat || chat.key.startsWith("gmem:")) return;
		const { harness, context } = await this.ensureHarness();
		const conv = await harness.conversation(
			chat.conversationId as ConversationId,
			context,
		);
		if (!conv) return;
		const view = await conv.context(context);
		let text = "";
		for (const entry of view.entries) {
			if (!UserEntry.is(entry)) continue;
			const msg = entry.model?.[0];
			if (!msg) continue;
			text = messageContentToText((msg as { content?: unknown }).content);
		}
		const match = /· chat ([^\]\s]+)\]/.exec(text);
		if (!match?.[1]) return;
		const requestId = `group-wake:${match[1]}`;
		if (!this.familyStore.groups.hopContext(requestId)) return;
		this.familyStore.chats.setTurnRoot(chat.key, requestId);
	}

	private groupWakeHold(taskId: string): number | undefined {
		const group = this.familyStore.groups.getByTaskId(taskId);
		if (!group) return undefined;
		return this.familyStore.groups.wakeHold(group.id);
	}

	private async driveGroupChatInternal(taskId: string): Promise<void> {
		await driveGroupChat(this.groupDeps(), taskId);
		await this.syncAlarmInternal();
	}

	/**
	 * Admit the fire-and-forget result into the originating chat.
	 * Request id `group-wake:<groupId>` is stable, so a replay of this method
	 * after a crash attaches to the same submission instead of posting twice.
	 * `wake_admitted` is set only after that submission has been waited, so a
	 * restart before admission retries and a restart after it does not wait
	 * again. The wake turn stores the group hop chain and uses a new root
	 * request id, which starts a fresh 5-action peer budget.
	 */
	private async deliverGroupWakeInternal(taskId: string): Promise<void> {
		const group = this.familyStore.groups.getByTaskId(taskId);
		if (group?.mode !== "forget" || group?.status === "open") return;
		if (!group) return;
		if (this.familyStore.groups.wakeAdmitted(group.id)) return;
		const requestId = `group-wake:${group.id}`;
		const text = groupWakeText({ store: this.familyStore }, group);
		await this.submitChatTurnInternal({
			chatKey: group.originChatKey,
			text,
			requestId,
			whenBusy: "queue",
			hopChain: group.hopChain,
		});
		this.familyStore.groups.markWakeAdmitted(group.id);
		const reply =
			group.endResponse ??
			this.familyStore.groups
				.listMessages(group.id)
				.map((line) => `@${line.fromBotId}: ${line.text}`)
				.join("\n");
		const peer =
			group.members.find((id) => id !== group.creatorBotId) ??
			group.creatorBotId;
		this.broadcastEvent({
			type: "bot.message",
			payload: {
				fromBotId: group.creatorBotId,
				toBotId: peer,
				chatKey: group.originChatKey,
				text: group.openingText,
				reply: group.status === "ended" ? reply : `${group.status}\n${reply}`,
				when: Date.now(),
				groupChatKey: group.id,
			},
		});
	}

	private async runMessageBotInternal(input: {
		taskId: string;
		callerBotId: string;
		targetBotId?: string;
		targetBotIds?: readonly string[];
		topic: string;
		text: string;
		originChatKey: string;
		wait?: boolean;
		readOnly?: boolean;
	}) {
		const result = await runGroupMessage(this.groupDeps(), input);
		if (result.ok && result.status !== "pending") {
			const reply =
				result.response ??
				result.transcript
					.map((line) => `@${line.fromBotId}: ${line.text}`)
					.join("\n");
			const toBotId =
				input.targetBotIds?.find((id) => id.trim())?.trim() ||
				input.targetBotId ||
				input.callerBotId;
			this.broadcastEvent({
				type: "bot.message",
				payload: {
					fromBotId: input.callerBotId,
					toBotId,
					chatKey: result.groupId
						? (this.familyStore.groups.getById(result.groupId)?.originChatKey ??
							input.originChatKey)
						: input.originChatKey,
					text: input.text,
					reply:
						result.status === "ended" ? reply : `${result.status}\n${reply}`,
					when: Date.now(),
					groupChatKey: result.groupId,
				},
			});
		}
		await this.syncAlarmInternal();
		return result;
	}

	private async abortChatInternal(chatKey: string): Promise<void> {
		const chat = this.familyStore.chats.getChat(chatKey);
		if (!chat) return;
		const { harness, context } = await this.ensureHarness();
		const conv = await harness.conversation(
			chat.conversationId as ConversationId,
			context,
		);
		await conv?.abort(context).catch(() => {});
	}

	private async expireGroupChats(now: number): Promise<void> {
		for (const group of this.familyStore.groups.listOpen()) {
			const replyDue =
				group.replyDeadline !== undefined && now >= group.replyDeadline;
			const overallDue =
				group.overallDeadline > 0 && now >= group.overallDeadline;
			if (!replyDue && !overallDue) continue;
			// Run deadline expires as capped. timed_out is only the per-turn reply watchdog.
			group.status = overallDue ? "capped" : "timed_out";
			group.replyDeadline = undefined;
			group.updatedAt = now;
			this.familyStore.groups.save(group);
			for (const botId of group.members) {
				await this.abortChatInternal(`gmem:${group.id}:${botId}`);
			}
			this.log().info("group chat watchdog fired", {
				group: group.id,
				chargedTo: group.creatorBotId,
			});
		}
	}

	private async createChatInternal(input: {
		botId: string;
		key?: string;
		title?: string;
		thinking?: ThinkingLevel;
		toolsEnv?: ToolsEnvSetting | null;
		harvest?: boolean;
		kind?: ChatKind;
		originChatKey?: string;
	}): Promise<ChatRecord> {
		const bot = this.familyStore.bots.getBot(input.botId);
		if (!bot) {
			throw new ProtocolValidationError(
				`Bot '${input.botId}' not found`,
				"not_found",
			);
		}

		const key =
			input.key?.trim() || `${bot.id}:${crypto.randomUUID().slice(0, 8)}`;
		const existing = this.familyStore.chats.getChat(key);
		if (existing) {
			if (existing.botId !== bot.id) {
				throw new ProtocolValidationError(
					`Chat '${key}' already exists and belongs to bot '${existing.botId}'`,
					"conflict",
				);
			}
			return existing;
		}

		const toolsEnv = input.toolsEnv ?? null;
		if (toolsEnv) {
			await this.toolsEnvController.assertSetting(
				toolsEnv,
				"chat",
				bot.toolsEnv ?? null,
			);
		}
		const workspaceEnvEnabled = await this.toolsEnvController.isWorkspaceEnvOn(
			bot,
			toolsEnv,
		);

		const { harness, context } = await this.ensureHarness();
		const modelRef = parseModelRef(bot.model);
		const effectiveThinking = input.thinking ?? bot.thinking;
		const groupSession =
			input.kind === "group" ||
			input.kind === "group-member" ||
			Boolean(key.startsWith("gmem:"));
		const isGroupCaller = this.isGroupCallerSession(key);
		const initialTools = resolveConversationExtensionsAndTools({
			bot,
			workspaceEnvEnabled,
			isGroupSession: groupSession,
			isGroupCaller,
			isConsultMember: false,
			hasActiveTasks: false,
			provider: modelRef?.provider ?? extractModelProvider(bot.model),
		});
		const conv = await harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: {
					model: modelRef,
					thinkingLevel: parseThinkingLevel(effectiveThinking) ?? null,
					cwd: bot.id,
					extensions: {
						add: initialTools.extensions.add,
						remove: initialTools.extensions.remove,
					},
					tools: initialTools.tools,
				},
			},
			context,
		);

		const chat: ChatRecord = {
			key,
			botId: bot.id,
			conversationId: conv.id as unknown as number,
			...(input.title ? { title: input.title } : {}),
			...(input.thinking ? { thinking: input.thinking } : {}),
			...(toolsEnv ? { toolsEnv } : {}),
			...(input.harvest === false ? { harvest: false } : {}),
			...(input.originChatKey ? { originChatKey: input.originChatKey } : {}),
			kind: input.kind ?? "direct",
			createdAt: Date.now(),
		};
		this.familyStore.chats.upsertChat(chat);
		this.familyStore.chats.recordConversationRoute({
			conversationId: chat.conversationId,
			chatKey: chat.key,
			botId: chat.botId,
			toolsEnvEnabled: true,
		});
		await this.attachConversationWatch(chat, conv, context);
		this.log().info("chat created", chatFields(chat));
		return this.decorateChat(chat);
	}

	private async attachConversationWatch(
		chat: ChatRecord,
		conv: Conversation,
		context: Context,
	): Promise<void> {
		if (this.activeWatches.has(chat.conversationId)) return;
		const watch = await conv.watch(context);
		this.activeWatches.set(chat.conversationId, watch);

		const initialLive = watch.value.docs["pi.live"] as LiveState | undefined;
		const state: ConversationWatchState = {
			lastBusy: Boolean(initialLive?.run),
			lastRunTaskId: initialLive?.run?.taskId,
			lastEntryId:
				watch.value.entries.length > 0
					? Number(watch.value.entries[watch.value.entries.length - 1]?.id ?? 0)
					: 0,
			emittedToolCalls: new Set(
				(initialLive?.tools ?? []).map((slot) => slot.callId),
			),
			emittedToolResults: new Set(
				(initialLive?.tools ?? [])
					.filter((slot) => slot.status === "done")
					.map((slot) => slot.callId),
			),
			activeCompactions: new Map(
				(initialLive?.compactions ?? []).map((c) => [
					Number(c.taskId),
					{ trigger: c.trigger, blocking: c.blocking },
				]),
			),
		};

		watch.start(async (call) => {
			if (call.kind === "value") {
				this.handleConversationView(chat, call.value, state);
			}
		});
	}

	private handleConversationView(
		chat: ChatRecord,
		view: ConversationView,
		state: ConversationWatchState,
	): void {
		const live = view.docs["pi.live"] as LiveState | undefined;
		const busy = Boolean(live?.run);

		if (busy && !state.lastBusy) {
			this.streamedAssistantContent.set(chat.conversationId, new Map());
			this.broadcastEvent({
				type: "chat.state",
				payload: {
					chatKey: chat.key,
					botId: chat.botId,
					conversationId: chat.conversationId,
					busy: true,
				},
			});
		} else if (busy && live?.run?.taskId !== state.lastRunTaskId) {
			this.streamedAssistantContent.set(chat.conversationId, new Map());
		}
		state.lastRunTaskId = live?.run?.taskId;

		const partialMsg = live?.generation?.message;
		if (partialMsg && Array.isArray(partialMsg.content)) {
			let streamedMap = this.streamedAssistantContent.get(chat.conversationId);
			if (!streamedMap) {
				streamedMap = new Map();
				this.streamedAssistantContent.set(chat.conversationId, streamedMap);
			}
			for (let i = 0; i < partialMsg.content.length; i++) {
				const part = partialMsg.content[i];
				if (part && typeof part === "object" && "type" in part) {
					const p = part as {
						type: string;
						text?: string;
						thinking?: string;
					};
					if (p.type === "text" && typeof p.text === "string" && p.text) {
						const prev = streamedMap.get(i) ?? "";
						if (p.text.length > prev.length && p.text.startsWith(prev)) {
							const delta = p.text.slice(prev.length);
							streamedMap.set(i, p.text);
							this.broadcastEvent({
								type: "turn.delta",
								payload: {
									chatKey: chat.key,
									kind: "text",
									delta,
								},
							});
						}
					} else if (
						p.type === "thinking" &&
						typeof p.thinking === "string" &&
						p.thinking
					) {
						const prev = streamedMap.get(i) ?? "";
						if (
							p.thinking.length > prev.length &&
							p.thinking.startsWith(prev)
						) {
							const delta = p.thinking.slice(prev.length);
							streamedMap.set(i, p.thinking);
							this.broadcastEvent({
								type: "turn.delta",
								payload: {
									chatKey: chat.key,
									kind: "thinking",
									delta,
								},
							});
						}
					}
				}
			}
		}

		for (const entry of view.entries) {
			const entryId = Number(entry.id);
			if (entryId <= state.lastEntryId) continue;
			state.lastEntryId = entryId;

			if (AssistantEntry.is(entry)) {
				const streamedMap = this.streamedAssistantContent.get(
					chat.conversationId,
				);
				const msg = entry.model?.[0];
				if (msg && msg.role === "assistant" && Array.isArray(msg.content)) {
					for (let i = 0; i < msg.content.length; i++) {
						const block = msg.content[i];
						if (block && typeof block === "object" && "type" in block) {
							if (block.type === "text" && typeof block.text === "string") {
								const already = streamedMap?.get(i) ?? "";
								if (
									block.text.length > already.length &&
									block.text.startsWith(already)
								) {
									const remaining = block.text.slice(already.length);
									streamedMap?.set(i, block.text);
									this.broadcastEvent({
										type: "turn.delta",
										payload: {
											chatKey: chat.key,
											kind: "text",
											delta: remaining,
										},
									});
								}
							} else if (
								block.type === "thinking" &&
								typeof block.thinking === "string"
							) {
								const already = streamedMap?.get(i) ?? "";
								if (
									block.thinking.length > already.length &&
									block.thinking.startsWith(already)
								) {
									const remaining = block.thinking.slice(already.length);
									streamedMap?.set(i, block.thinking);
									this.broadcastEvent({
										type: "turn.delta",
										payload: {
											chatKey: chat.key,
											kind: "thinking",
											delta: remaining,
										},
									});
								}
							}
						}
					}
				}
				this.streamedAssistantContent.set(chat.conversationId, new Map());
			} else if (ToolResultEntry.is(entry)) {
				const msg = entry.model?.[0] as ToolResultMessage | undefined;
				if (
					msg &&
					msg.role === "toolResult" &&
					!state.emittedToolResults.has(msg.toolCallId)
				) {
					state.emittedToolResults.add(msg.toolCallId);
					const isError = Boolean(msg.isError);
					const content =
						typeof msg.content === "string"
							? msg.content
							: messageContentToText(msg.content) ||
								JSON.stringify(msg.content ?? "");
					this.log().child(chatFields(chat)).debug("tool execution ended", {
						tool: msg.toolName,
						toolCallId: msg.toolCallId,
						isError,
					});
					this.broadcastEvent({
						type: "turn.tool_result",
						payload: {
							chatKey: chat.key,
							toolCallId: msg.toolCallId,
							toolName: msg.toolName,
							content,
							isError,
						},
					});
				}
			}
		}

		for (const slot of live?.tools ?? []) {
			if (!state.emittedToolCalls.has(slot.callId)) {
				state.emittedToolCalls.add(slot.callId);
				const args = findToolCallArgs(view.entries, partialMsg, slot.callId);
				this.log().child(chatFields(chat)).debug("tool execution started", {
					tool: slot.name,
					toolCallId: slot.callId,
				});
				this.broadcastEvent({
					type: "turn.tool_call",
					payload: {
						chatKey: chat.key,
						toolCallId: slot.callId,
						toolName: slot.name,
						args,
					},
				});
			}
			if (
				slot.status === "done" &&
				!slot.entry &&
				!state.emittedToolResults.has(slot.callId)
			) {
				state.emittedToolResults.add(slot.callId);
				this.log().child(chatFields(chat)).debug("tool execution ended", {
					tool: slot.name,
					toolCallId: slot.callId,
					isError: true,
				});
				this.broadcastEvent({
					type: "turn.tool_result",
					payload: {
						chatKey: chat.key,
						toolCallId: slot.callId,
						toolName: slot.name,
						content: slot.output ?? "",
						isError: true,
					},
				});
			}
		}

		const compactions = live?.compactions ?? [];
		const currentCompactionIds = new Set(
			compactions.map((c) => Number(c.taskId)),
		);
		for (const c of compactions) {
			const taskId = Number(c.taskId);
			if (!state.activeCompactions.has(taskId)) {
				state.activeCompactions.set(taskId, {
					trigger: c.trigger,
					blocking: c.blocking,
				});
				this.broadcastEvent({
					type: "chat.compaction",
					payload: {
						chatKey: chat.key,
						botId: chat.botId,
						conversationId: chat.conversationId,
						phase: "started",
						taskId,
						reason: c.trigger,
						blocking: c.blocking,
					},
				});
				if (!c.blocking && this.harnessInstance) {
					void this.trackBackgroundCompactions(this.harnessInstance);
				}
			}
		}
		for (const [taskId, prev] of [...state.activeCompactions.entries()]) {
			if (!currentCompactionIds.has(taskId)) {
				state.activeCompactions.delete(taskId);
				const failed =
					live?.compactionFailure &&
					Number(live.compactionFailure.taskId) === taskId
						? live.compactionFailure
						: undefined;
				this.broadcastEvent({
					type: "chat.compaction",
					payload: {
						chatKey: chat.key,
						botId: chat.botId,
						conversationId: chat.conversationId,
						phase: failed ? "failed" : "completed",
						taskId,
						reason: failed ? failed.trigger : prev.trigger,
						...(failed ? { error: failed.error } : {}),
					},
				});
				void this.syncAlarmInternal().catch(() => {});
			}
		}

		if (!busy && state.lastBusy) {
			this.streamedAssistantContent.delete(chat.conversationId);
			state.emittedToolCalls.clear();
			state.emittedToolResults.clear();
			this.broadcastEvent({
				type: "chat.state",
				payload: {
					chatKey: chat.key,
					botId: chat.botId,
					conversationId: chat.conversationId,
					busy: false,
				},
			});
		}
		state.lastBusy = busy;
	}

	private async waitForSubmission<T>(
		pending: Promise<T>,
		timeoutMs: number | undefined,
		abort: () => Promise<unknown>,
	): Promise<T> {
		if (!timeoutMs) return pending;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new TurnDeadlineError()), timeoutMs);
		});
		try {
			return await Promise.race([pending, timeout]);
		} catch (error) {
			if (
				error instanceof TurnDeadlineError ||
				error instanceof GroupReplyTimeout
			) {
				pending.catch(() => {});
				await abort().catch(() => {});
			}
			throw error;
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	private async submitChatTurnInternal(input: {
		chatKey: string;
		text: string;
		requestId?: string;
		whenBusy?: "queue" | "steer" | "reject";
		replyTimeoutMs?: number;
		hopChain?: readonly string[];
		/** Trusted author from the edge principal. Absent for bot-originated turns. */
		authorUserId?: string;
	}): Promise<{
		chatKey: string;
		conversationId: number;
		reply: string;
		entryId?: number;
		blocks?: TurnBlock[];
	}> {
		const chat = this.familyStore.chats.getChat(input.chatKey);
		if (!chat) {
			throw new ProtocolValidationError(
				`Chat '${input.chatKey}' not found`,
				"not_found",
			);
		}
		if (chat.closed) {
			throw new ProtocolValidationError(
				`Chat '${input.chatKey}' is closed`,
				"chat_closed",
			);
		}

		const { harness, context } = await this.ensureHarness();
		const conv = await harness.conversation(
			chat.conversationId as ConversationId,
			context,
		);
		if (!conv) {
			throw new ProtocolValidationError(
				`Conversation #${chat.conversationId} not found`,
				"not_found",
			);
		}

		await this.attachConversationWatch(chat, conv, context);

		const lastEntryBefore = input.authorUserId
			? (await conv.context(context)).entries.reduce(
					(max, entry) => Math.max(max, Number(entry.id)),
					0,
				)
			: 0;

		const requestId =
			input.requestId ?? `turn:${chat.key}:${crypto.randomUUID().slice(0, 8)}`;
		const continueTurn = requestId.startsWith("tasks-continue:");
		const harvestTurn = input.text.startsWith("[HARVEST]");
		if (!continueTurn && !harvestTurn) {
			this.resetTaskLoopForUser(chat.key);
		}
		const loopAtStart = this.familyStore.tasks.getLoop(chat.key);
		const resolved = resolveDeadlines(chat, this.env);
		const replyTimeoutMs = input.replyTimeoutMs ?? resolved.turnMs;
		if (input.hopChain) {
			// Stored under the wake request id. The root pointer stays on the
			// turn that is running now; adoptGroupWakeRoot moves it when the
			// wake turn itself calls message_bot.
			this.familyStore.groups.setHopContext(requestId, input.hopChain);
		} else if (!chat.key.startsWith("gmem:")) {
			this.familyStore.chats.setTurnRoot(chat.key, requestId);
		}
		const log = this.log().child(chatFields(chat, { requestId }));

		const harvestId = harvestScheduleId(chat.key);
		const existingHarvest = this.familyStore.schedules.getSchedule(harvestId);
		if (existingHarvest) {
			this.familyStore.schedules.deleteSchedule(harvestId);
		}

		const whenBusyMode =
			!input.whenBusy || input.whenBusy === "queue"
				? "followUp"
				: input.whenBusy;

		log.debug("chat input admitted", { chars: input.text.length });

		await this.prepareConversationTools(chat.conversationId);

		const submission = await conv.submit(
			{
				type: "input",
				content: input.text,
				requestId,
				whenBusy: whenBusyMode,
			},
			context,
		);

		let settled: { status: string };
		try {
			settled = await this.waitForSubmission(
				submission.wait(context),
				replyTimeoutMs,
				() => conv.abort(context),
			);
		} catch (error) {
			this.pauseTaskLoopIfSame(chat.key, loopAtStart);
			throw error;
		}
		await conv.waitForIdle(context);
		await this.trackBackgroundCompactions(harness);

		log.debug("chat turn settled", { status: settled.status });

		const view = await conv.context(context);
		if (input.authorUserId) {
			for (const entry of view.entries) {
				const entryId = Number(entry.id);
				if (entryId > lastEntryBefore && UserEntry.is(entry)) {
					this.familyStore.chats.setEntryAuthor(
						chat.key,
						entryId,
						input.authorUserId,
					);
				}
			}
		}
		const reply = extractLatestAssistantReply(view.messages);
		const blocks = extractTurnBlocks(view.messages);
		const latestEntry = view.entries[view.entries.length - 1];
		const latestEntryId = latestEntry
			? (latestEntry.id as unknown as number)
			: undefined;

		this.broadcastEvent({
			type: "turn.completed",
			payload: {
				chatKey: chat.key,
				...(latestEntryId !== undefined ? { entryId: latestEntryId } : {}),
				...completionOutcome(settled),
				text: reply,
				blocks,
			},
		});

		await this.maybeContinueTasks(
			chat,
			settled,
			continueTurn,
			harvestTurn,
			loopAtStart,
		);

		const delayMs = this.getFamilyMeta().harvestDelayMs;
		const currentChat = this.familyStore.chats.getChat(chat.key);
		const currentBot = this.familyStore.bots.getBot(chat.botId);
		if (
			delayMs > 0 &&
			currentChat?.harvest !== false &&
			latestEntryId !== undefined &&
			currentChat?.conversationId === chat.conversationId &&
			currentBot
		) {
			const nextRun = Date.now() + delayMs;
			const harvestTarget: ScheduleTarget = {
				mode: "fork",
				chatKey: chat.key,
				at: latestEntryId,
				harvest: true,
			};
			const harvestSched: ScheduleRecord = {
				id: harvestId,
				botId: chat.botId,
				name: `Idle harvest for ${chat.key}`,
				kind: "relative",
				input: `${delayMs}ms`,
				nextRun,
				inSeconds: computeInSeconds(nextRun, Date.now()),
				recurring: false,
				text: DEFAULT_HARVEST_PROMPT,
				target: harvestTarget,
				enabled: true,
				internal: true,
			};
			this.familyStore.schedules.upsertSchedule(harvestSched);
			await this.ensureScheduleTaskInternal(harvestId);
			await this.syncAlarmInternal();
			if (!existingHarvest) {
				log.debug("harvest armed", {
					schedule: harvestId,
					at: latestEntryId,
					nextRun,
				});
			}
		}

		return {
			chatKey: chat.key,
			conversationId: chat.conversationId,
			reply,
			...(latestEntryId !== undefined ? { entryId: latestEntryId } : {}),
			blocks,
		};
	}

	private requireChat(chatKey: string): ChatRecord {
		const chat = this.familyStore.chats.getChat(chatKey);
		if (!chat) {
			throw new ProtocolValidationError(
				`Chat '${chatKey}' not found`,
				"not_found",
			);
		}
		return chat;
	}

	private decorateChat(chat: ChatRecord): ChatRecord {
		return {
			...chat,
			effectiveDeadlines: resolveDeadlines(chat, this.env),
		};
	}

	private maxTaskRounds(): number {
		return resolveTaskMaxRounds(this.env.CADMUS_TASK_MAX_ROUNDS);
	}

	private taskLoopSnapshot(
		chatKey: string,
		state?: ChatTaskLoop["state"],
	): ChatTaskLoop {
		const loop = this.familyStore.tasks.getLoop(chatKey);
		const max = this.maxTaskRounds();
		const resolved =
			state ??
			(loop.capped
				? "capped"
				: loop.paused
					? "paused"
					: loop.round > 0 && this.familyStore.tasks.openCount(chatKey) > 0
						? "running"
						: "idle");
		return { round: loop.round, max, state: resolved };
	}

	private taskStatusCounts(chatKey: string): {
		open: number;
		done: number;
		loopRound: number;
	} {
		const tasks = this.familyStore.tasks.list(chatKey);
		return {
			open: tasks.filter((task) => task.status !== "done").length,
			done: tasks.filter((task) => task.status === "done").length,
			loopRound: this.familyStore.tasks.getLoop(chatKey).round,
		};
	}

	private broadcastChatTasksInternal(
		chatKey: string,
		state?: ChatTaskLoop["state"],
	): void {
		const tasks = this.familyStore.tasks.list(chatKey).map((task) => ({
			index: task.index,
			title: task.title,
			status: task.status,
		}));
		this.broadcastEvent({
			type: "chat.tasks",
			payload: {
				chatKey,
				tasks,
				loop: this.taskLoopSnapshot(chatKey, state),
			},
		});
	}

	private pauseTaskLoop(chatKey: string): void {
		const loop = this.familyStore.tasks.getLoop(chatKey);
		this.familyStore.tasks.setLoop(chatKey, { ...loop, paused: true });
		this.broadcastChatTasksInternal(chatKey, "paused");
	}

	/** Pause only if this turn's loop was not replaced by a newer user message. */
	private pauseTaskLoopIfSame(
		chatKey: string,
		stamp: { round: number; startedAt?: number },
	): void {
		if (stamp.round <= 0) return;
		const loop = this.familyStore.tasks.getLoop(chatKey);
		if (loop.paused || loop.capped) return;
		if (loop.round !== stamp.round || loop.startedAt !== stamp.startedAt)
			return;
		this.pauseTaskLoop(chatKey);
	}

	private resetTaskLoopForUser(chatKey: string): void {
		const loop = this.familyStore.tasks.getLoop(chatKey);
		this.familyStore.tasks.setLoop(chatKey, {
			...loop,
			round: 0,
			paused: false,
			capped: false,
			stuckRounds: 0,
			startedAt: undefined,
			runDeadline: undefined,
			continueAdmittedRound: undefined,
		});
	}

	private capTaskLoop(chatKey: string): void {
		const loop = this.familyStore.tasks.getLoop(chatKey);
		this.familyStore.tasks.setLoop(chatKey, {
			...loop,
			paused: true,
			capped: true,
			runDeadline: undefined,
		});
		this.broadcastChatTasksInternal(chatKey, "capped");
	}

	private async expireTaskLoops(now: number): Promise<void> {
		for (const row of this.familyStore.tasks.listRunDeadlines()) {
			if (row.runDeadline > now) continue;
			this.capTaskLoop(row.chatKey);
			await this.abortChatInternal(row.chatKey);
		}
	}

	private async maybeContinueTasks(
		chat: ChatRecord,
		settled: { status: string },
		continueTurn: boolean,
		harvestTurn: boolean,
		loopAtStart: { round: number; startedAt?: number },
	): Promise<void> {
		if (harvestTurn) return;
		// `unanswered` is also how a tool-only faux turn and an abort settle.
		// Abort already pauses. Pausing here too stops the next healthy round.
		if (
			settled.status === "error" ||
			settled.status === "aborted" ||
			settled.status === "failed"
		) {
			if (continueTurn) this.pauseTaskLoopIfSame(chat.key, loopAtStart);
			return;
		}
		if (settled.status !== "done") return;
		if (!continueTurn) {
			const loop = this.familyStore.tasks.getLoop(chat.key);
			if (
				loop.paused ||
				loop.capped ||
				loop.round !== 0 ||
				loop.runDeadline !== undefined ||
				loop.startedAt !== undefined
			) {
				this.familyStore.tasks.setLoop(chat.key, {
					round: 0,
					paused: false,
					capped: false,
					stuckRounds: 0,
				});
			}
		}
		if (chat.closed) return;
		if (chat.kind === "group" || chat.kind === "group-member") return;
		if (chat.key.startsWith("gmem:")) return;
		const member = this.familyStore.groups.findByMemberKey(chat.key);
		if (member?.group.toolsReadOnly) return;
		const bot = this.familyStore.bots.getBot(chat.botId);
		if (
			bot?.tools !== undefined &&
			!bot.tools.some((name) => name.startsWith("task_"))
		) {
			return;
		}
		const open = this.familyStore.tasks.openCount(chat.key);
		if (open <= 0) {
			const loop = this.familyStore.tasks.getLoop(chat.key);
			const armed =
				loop.round !== 0 ||
				loop.paused ||
				loop.capped ||
				loop.stuckRounds !== 0 ||
				loop.startedAt !== undefined ||
				loop.runDeadline !== undefined ||
				loop.continueAdmittedRound !== undefined;
			if (armed) {
				this.familyStore.tasks.setLoop(chat.key, {
					round: 0,
					paused: false,
					capped: false,
					stuckRounds: 0,
				});
				await this.syncAlarmInternal();
			}
			this.broadcastChatTasksInternal(chat.key, "idle");
			return;
		}
		const loop = this.familyStore.tasks.getLoop(chat.key);
		if (loop.paused || loop.capped) return;
		if (continueTurn && loop.stuckRounds >= 2) {
			this.capTaskLoop(chat.key);
			return;
		}
		const max = this.maxTaskRounds();
		if (loop.round >= max) {
			this.capTaskLoop(chat.key);
			return;
		}
		const resolved = resolveDeadlines(chat, this.env);
		const now = Date.now();
		if (
			loop.runDeadline !== undefined &&
			loop.runDeadline > 0 &&
			now >= loop.runDeadline
		) {
			this.capTaskLoop(chat.key);
			return;
		}
		const nextRound = loop.round + 1;
		const startedAt = loop.startedAt ?? now;
		const runDeadline =
			loop.runDeadline ??
			(resolved.runMs > 0 ? startedAt + resolved.runMs : undefined);
		this.familyStore.tasks.setLoop(chat.key, {
			...loop,
			round: nextRound,
			startedAt,
			runDeadline,
			paused: false,
			capped: false,
		});
		this.broadcastChatTasksInternal(chat.key, "running");
		await this.ensureTaskContinueTask(chat.key, nextRound);
		await this.syncAlarmInternal();
	}

	private async ensureTaskContinueTask(
		chatKey: string,
		round: number,
	): Promise<void> {
		const { harness, context } = await this.ensureHarness();
		const rootConv = await harness.root(context);
		await rootConv.commit(async (tx) => {
			let cursor: Cursor | undefined;
			for (;;) {
				const page = await tx.scanTasks(
					{ kind: TaskContinueTask.definition.name },
					50,
					cursor,
				);
				const active = page.items.find((item) => {
					if (item.state.status === "terminal") return false;
					const inp = item.input as { chatKey?: string; round?: number };
					return inp.chatKey === chatKey && inp.round === round;
				});
				if (active) return active.id;
				if (!page.next) break;
				cursor = page.next;
			}
			return tx.createTask(
				TaskContinueTask,
				{ chatKey, round },
				{
					ownership: { kind: "conversation" },
					conversationId: rootConv.id,
					background: true,
				},
			);
		}, context);
	}

	private async deliverTaskContinueInternal(
		chatKey: string,
		round: number,
	): Promise<void> {
		const chat = this.familyStore.chats.getChat(chatKey);
		if (!chat || chat.closed) return;
		const loop = this.familyStore.tasks.getLoop(chatKey);
		if (loop.paused || loop.capped) return;
		if (loop.continueAdmittedRound === round) return;
		if (this.familyStore.tasks.openCount(chatKey) <= 0) return;
		this.familyStore.tasks.setLoop(chatKey, {
			...loop,
			stuckRounds: loop.stuckRounds + 1,
		});
		const text = formatTasksContinueMessage({
			round,
			max: this.maxTaskRounds(),
			tasks: this.familyStore.tasks.list(chatKey),
		});
		const requestId = tasksContinueRequestId(chatKey, round);
		await this.submitChatTurnInternal({
			chatKey,
			text,
			requestId,
			whenBusy: "queue",
		});
		const after = this.familyStore.tasks.getLoop(chatKey);
		if (after.round === round && !after.paused && !after.capped) {
			this.familyStore.tasks.setLoop(chatKey, {
				...after,
				continueAdmittedRound: round,
			});
		}
	}

	private async ensureScheduleTaskInternal(scheduleId: string): Promise<void> {
		const { harness, context } = await this.ensureHarness();
		const sched = this.familyStore.schedules.getSchedule(scheduleId);
		if (!sched?.enabled) return;

		const rootConv = await harness.root(context);
		const inspection = await harness.inspect(context);

		for (const item of inspection.tasks) {
			if (item.record.kind !== ScheduleTask.definition.name) continue;
			const input = item.record.input as { scheduleId?: string } | undefined;
			if (input?.scheduleId !== scheduleId) continue;

			const cp = item.record.state.checkpoint as
				| { phase?: string; nextRun?: number }
				| undefined;
			if (
				cp?.phase === "wait" &&
				cp.nextRun !== undefined &&
				cp.nextRun !== sched.nextRun
			) {
				await harness.abortTask(item.record.id as TaskId, context);
			} else {
				return;
			}
		}

		await rootConv.commit(async (tx) => {
			let cursor: Cursor | undefined;
			for (;;) {
				const page = await tx.scanTasks(
					{ kind: ScheduleTask.definition.name },
					50,
					cursor,
				);
				const active = page.items.find((t) => {
					if (t.state.status === "terminal") return false;
					const inp = t.input as { scheduleId?: string } | undefined;
					return inp?.scheduleId === scheduleId;
				});
				if (active) return active.id;
				if (!page.next) break;
				cursor = page.next;
			}
			const taskId = await tx.createTask(
				ScheduleTask,
				{ scheduleId },
				{
					ownership: { kind: "conversation" },
					conversationId: rootConv.id,
					background: true,
				},
			);
			this.log().debug("schedule task created", {
				schedule: scheduleId,
				taskId: String(taskId),
				nextRun: sched.nextRun,
				kind: sched.kind,
			});
			return taskId;
		}, context);
	}

	private async abortScheduleTasksInternal(
		scheduleIds: ReadonlySet<string>,
	): Promise<void> {
		if (scheduleIds.size === 0) return;
		const { harness, context } = await this.ensureHarness();
		const inspection = await harness.inspect(context);
		for (const item of inspection.tasks) {
			if (item.record.kind !== ScheduleTask.definition.name) continue;
			const input = item.record.input as { scheduleId?: string } | undefined;
			if (!input?.scheduleId || !scheduleIds.has(input.scheduleId)) continue;
			await harness
				.abortTask(item.record.id as TaskId, context)
				.catch(() => {});
		}
	}

	private async syncAlarmInternal(): Promise<number | undefined> {
		if (!this.harnessInstance) return undefined;
		// The sweep deadline must survive hibernation and recreation, so it is
		// restored from storage before it can be re-anchored.
		if (!this.streamSweepLoaded) {
			const stored = await this.ctx.storage.get<number>(STREAM_SWEEP_KEY);
			this.streamSweep.restore(stored);
			this.streamSweepPersisted = stored;
			this.streamSweepLoaded = true;
		}
		const wake = this.streamSweepWake();
		if (wake !== undefined) {
			if (wake !== this.streamSweepPersisted) {
				await this.ctx.storage.put(STREAM_SWEEP_KEY, wake);
				this.streamSweepPersisted = wake;
			}
		} else if (this.streamSweepPersisted !== undefined) {
			await this.ctx.storage.delete(STREAM_SWEEP_KEY);
			this.streamSweepPersisted = undefined;
		}
		return syncDurableObjectAlarm(
			this.ctx.storage,
			this.harnessInstance,
			this.familyStore,
			wake,
		);
	}

	private streamSweepLoaded = false;
	private streamSweepPersisted: number | undefined;

	private readonly streamSweep = new StreamSweepDeadline(STREAM_SWEEP_MS);

	private streamSweepWake(): number | undefined {
		return this.streamSweep.wake(this.streamsOpen(), Date.now());
	}

	private streamsOpen(): boolean {
		return this.ctx.getWebSockets().length + this.sseControllers.size > 0;
	}

	private async countConversationEntries(
		conv: Conversation,
		context: Context,
	): Promise<number> {
		let total = 0;
		let cursor: Cursor | undefined;
		for (;;) {
			const page = await conv.entries(
				{ order: "descending" },
				500,
				cursor,
				context,
			);
			total += page.items.length;
			if (page.next === undefined) return total;
			cursor = page.next;
		}
	}

	private async readTranscriptData(
		conv: Conversation,
		context: Context,
		options: { raw: boolean; limit: number; beforeEntryId?: number },
	): Promise<{
		messages: TranscriptMessageView[];
		entries: RawTranscriptEntry[];
		hasMore: boolean;
		oldestEntryId?: number;
		headEntryId?: number;
		firstKeptEntryId?: number;
	}> {
		const activeView = await conv.context(context);
		const activeModelEntryIds = new Set<number>();
		for (let i = 0; i < activeView.entries.length; i++) {
			const entry = activeView.entries[i];
			const contribs = activeView.contributions[i];
			if (entry && contribs && contribs.length > 0) {
				activeModelEntryIds.add(Number(entry.id));
			}
		}
		if (activeView.head?.model && activeView.head.model.length > 0) {
			activeModelEntryIds.add(Number(activeView.head.id));
		}
		const headEntryId =
			activeView.head && CompactionEntry.is(activeView.head)
				? Number(activeView.head.id)
				: undefined;
		const firstKeptEntryId =
			activeView.head && CompactionEntry.is(activeView.head)
				? Number(activeView.head.head)
				: undefined;

		const toolResults = new Map<string, ToolCallResultSummary>();
		const collected: EntryRecord[] = [];
		const batchSize = Math.min(200, Math.max(50, options.limit + 1));
		let cursor: Cursor | undefined;
		for (;;) {
			const page = await conv.entries(
				{
					order: "descending",
					...(options.beforeEntryId !== undefined
						? { maxEntryId: (options.beforeEntryId - 1) as EntryId }
						: {}),
				},
				batchSize,
				cursor,
				context,
			);
			for (const entry of page.items) {
				if (ToolResultEntry.is(entry)) {
					const toolResultMsg = entry.model?.[0] as
						| ToolResultMessage
						| undefined;
					if (toolResultMsg) {
						toolResults.set(toolResultMsg.toolCallId, {
							content: messageContentToText(toolResultMsg.content),
							isError: Boolean(toolResultMsg.isError),
							...(typeof toolResultMsg.durationMs === "number"
								? { durationMs: toolResultMsg.durationMs }
								: {}),
						});
					}
				}
				const userVisible =
					UserEntry.is(entry) ||
					AssistantEntry.is(entry) ||
					ToolResultEntry.is(entry) ||
					CompactionEntry.is(entry) ||
					ResetEntry.is(entry);
				if (options.raw || userVisible) {
					collected.push(entry);
					if (collected.length >= options.limit + 1) break;
				}
			}
			if (collected.length >= options.limit + 1 || page.next === undefined) {
				break;
			}
			cursor = page.next;
		}

		const hasMore = collected.length > options.limit;
		const pageEntries = collected.slice(0, options.limit).reverse();
		const oldestEntryId =
			pageEntries.length > 0 ? Number(pageEntries[0]?.id) : undefined;

		let lastUserEntryId: number | undefined;
		const messages: TranscriptMessageView[] = [];

		for (const entry of pageEntries) {
			const id = Number(entry.id);
			const visibleToModel = activeModelEntryIds.has(id);

			if (UserEntry.is(entry)) {
				const msg = entry.model?.[0];
				if (!msg) continue;
				lastUserEntryId = id;
				const blocks = extractUserBlocks(msg.content);
				messages.push({
					id,
					role: "user",
					entryKind: entry.kind,
					visibleToUser: true,
					visibleToModel,
					text: messageContentToText(msg.content),
					...(blocks.length > 0 ? { blocks } : {}),
					...(typeof msg.timestamp === "number"
						? { timestamp: msg.timestamp }
						: {}),
				});
			} else if (AssistantEntry.is(entry)) {
				const assistant = entry.model?.[0] as AssistantMessage | undefined;
				if (!assistant) continue;
				const blocks: TranscriptContentBlock[] = [];
				const toolCalls: TranscriptToolCallView[] = [];
				const thinkingParts: string[] = [];

				if (typeof assistant.content === "string") {
					blocks.push({ type: "text", text: assistant.content });
				} else if (Array.isArray(assistant.content)) {
					for (const part of assistant.content) {
						if (!part || typeof part !== "object" || !("type" in part))
							continue;
						const p = part as {
							type: string;
							text?: string;
							thinking?: string;
							redacted?: boolean;
							id?: string;
							name?: string;
							arguments?: unknown;
							mimeType?: string;
							data?: string;
						};
						if (p.type === "thinking" && typeof p.thinking === "string") {
							thinkingParts.push(p.thinking);
							blocks.push({
								type: "thinking",
								thinking: p.thinking,
								...(p.redacted ? { redacted: true } : {}),
							});
						} else if (p.type === "toolCall" && p.id && p.name) {
							const boundResult = toolResults.get(p.id);
							const callView: TranscriptToolCallView = {
								id: p.id,
								name: p.name,
								arguments: p.arguments ?? {},
								...(boundResult ? { result: boundResult } : {}),
							};
							toolCalls.push(callView);
							blocks.push({
								type: "toolCall",
								id: p.id,
								name: p.name,
								arguments: p.arguments ?? {},
								...(boundResult ? { result: boundResult } : {}),
							});
						} else if (p.type === "text" && typeof p.text === "string") {
							blocks.push({
								type: "text",
								text: p.text,
							});
						} else if (
							p.type === "image" &&
							typeof p.mimeType === "string" &&
							typeof p.data === "string"
						) {
							blocks.push({
								type: "image",
								mimeType: p.mimeType,
								data: p.data,
							});
						}
					}
				}

				const thinkingText =
					thinkingParts.length > 0 ? thinkingParts.join("\n") : undefined;

				messages.push({
					id,
					role: "assistant",
					entryKind: entry.kind,
					visibleToUser: true,
					visibleToModel,
					text: messageContentToText(assistant.content),
					...(lastUserEntryId !== undefined
						? { replyToEntryId: lastUserEntryId }
						: {}),
					...(thinkingText ? { thinking: thinkingText } : {}),
					...(toolCalls.length > 0 ? { toolCalls } : {}),
					...(blocks.length > 0 ? { blocks } : {}),
					...(assistant.model ? { model: assistant.model } : {}),
					...(assistant.provider ? { provider: assistant.provider } : {}),
					...(assistant.stopReason ? { stopReason: assistant.stopReason } : {}),
					...(assistant.errorMessage
						? { errorMessage: assistant.errorMessage }
						: {}),
					...(assistant.usage
						? { usage: assistant.usage as unknown as Record<string, unknown> }
						: {}),
					...(typeof assistant.timestamp === "number"
						? { timestamp: assistant.timestamp }
						: {}),
					...(assistant.durationMs !== undefined
						? { durationMs: assistant.durationMs }
						: {}),
				});
			} else if (ToolResultEntry.is(entry)) {
				const toolResultMsg = entry.model?.[0] as ToolResultMessage | undefined;
				if (!toolResultMsg) continue;
				messages.push({
					id,
					role: "toolResult",
					entryKind: entry.kind,
					visibleToUser: true,
					visibleToModel,
					text: messageContentToText(toolResultMsg.content),
					...(lastUserEntryId !== undefined
						? { replyToEntryId: lastUserEntryId }
						: {}),
					toolCallId: toolResultMsg.toolCallId,
					toolName: toolResultMsg.toolName,
					isError: Boolean(toolResultMsg.isError),
					...(typeof toolResultMsg.timestamp === "number"
						? { timestamp: toolResultMsg.timestamp }
						: {}),
					...(toolResultMsg.durationMs !== undefined
						? { durationMs: toolResultMsg.durationMs }
						: {}),
				});
			} else if (CompactionEntry.is(entry)) {
				const msg = entry.model?.[0] as { content?: unknown } | undefined;
				messages.push({
					id,
					role: "compaction",
					entryKind: entry.kind,
					visibleToUser: true,
					visibleToModel,
					text: stripCompactionSummaryWrapper(
						messageContentToText(msg?.content),
					),
					...(entry.data?.reason
						? { compactionReason: entry.data.reason }
						: {}),
					firstKeptEntryId: Number(entry.head),
				});
			} else if (ResetEntry.is(entry)) {
				const msg = entry.model?.[0] as { content?: unknown } | undefined;
				messages.push({
					id,
					role: "reset",
					entryKind: entry.kind,
					visibleToUser: true,
					visibleToModel,
					text: messageContentToText(msg?.content),
				});
			} else if (SystemEntry.is(entry)) {
				const msg = entry.model?.[0] as { content?: unknown } | undefined;
				messages.push({
					id,
					role: "system",
					entryKind: entry.kind,
					visibleToUser: false,
					visibleToModel,
					text: messageContentToText(msg?.content),
				});
			}
		}

		const entries: RawTranscriptEntry[] = options.raw
			? pageEntries.map((entry) => ({
					id: Number(entry.id),
					conversationId: Number(entry.conversationId),
					kind: entry.kind,
					...(entry.model !== undefined
						? { model: entry.model as unknown[] }
						: {}),
					...(entry.data !== undefined ? { data: entry.data } : {}),
					...(entry.head !== undefined ? { head: Number(entry.head) } : {}),
					...(entry.edits !== undefined
						? { edits: entry.edits as unknown[] }
						: {}),
					...(entry.byTaskId !== undefined
						? { byTaskId: Number(entry.byTaskId) }
						: {}),
				}))
			: [];

		return {
			messages,
			entries,
			hasMore,
			...(oldestEntryId !== undefined ? { oldestEntryId } : {}),
			...(headEntryId !== undefined ? { headEntryId } : {}),
			...(firstKeptEntryId !== undefined ? { firstKeptEntryId } : {}),
		};
	}
}

type ConversationWatchState = {
	lastBusy: boolean;
	lastRunTaskId: TaskId | undefined;
	lastEntryId: number;
	emittedToolCalls: Set<string>;
	emittedToolResults: Set<string>;
	activeCompactions: Map<
		number,
		{ trigger: CompactionReason; blocking: boolean }
	>;
};

function findToolCallArgs(
	entries: readonly EntryRecord[],
	partialMsg: { readonly content?: readonly unknown[] } | undefined,
	callId: string,
): Record<string, unknown> {
	if (partialMsg && Array.isArray(partialMsg.content)) {
		for (const block of partialMsg.content) {
			if (
				block &&
				typeof block === "object" &&
				(block as { type?: string }).type === "toolCall" &&
				(block as { id?: string }).id === callId
			) {
				return ((block as { arguments?: Record<string, unknown> }).arguments ??
					{}) as Record<string, unknown>;
			}
		}
	}
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!entry || !AssistantEntry.is(entry)) continue;
		const msg = entry.model?.[0];
		if (!msg || msg.role !== "assistant" || !Array.isArray(msg.content)) {
			continue;
		}
		for (const block of msg.content) {
			if (
				block &&
				typeof block === "object" &&
				(block as { type?: string }).type === "toolCall" &&
				(block as { id?: string }).id === callId
			) {
				return ((block as { arguments?: Record<string, unknown> }).arguments ??
					{}) as Record<string, unknown>;
			}
		}
	}
	return {};
}

function buildCompactionSnapshot(
	live:
		| {
				compactions?: readonly CompactionStatus[];
				compactionFailure?: CompactionFailure;
		  }
		| undefined,
	headEntryId: number | undefined,
	firstKeptEntryId: number | undefined,
): ChatCompactionSnapshot {
	const tasks: CompactionTaskView[] = (live?.compactions ?? []).map((c) => ({
		taskId: Number(c.taskId),
		reason: c.trigger,
		blocking: c.blocking,
		attempt: c.attempt,
		...(c.retry ? { retryAt: c.retry.at, retryError: c.retry.error } : {}),
	}));
	return {
		active: tasks.length > 0,
		tasks,
		...(live?.compactionFailure
			? {
					lastFailure: {
						taskId: Number(live.compactionFailure.taskId),
						reason: live.compactionFailure.trigger,
						error: live.compactionFailure.error,
					},
				}
			: {}),
		...(headEntryId !== undefined ? { headEntryId } : {}),
		...(firstKeptEntryId !== undefined ? { firstKeptEntryId } : {}),
	};
}

function extractUserBlocks(content: unknown): TranscriptContentBlock[] {
	if (typeof content === "string") {
		return [{ type: "text", text: content }];
	}
	if (!Array.isArray(content)) return [];
	const blocks: TranscriptContentBlock[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		if ("type" in part) {
			const p = part as {
				type: string;
				text?: string;
				mimeType?: string;
				data?: string;
			};
			if (p.type === "text" && typeof p.text === "string") {
				blocks.push({ type: "text", text: p.text });
			} else if (
				p.type === "image" &&
				typeof p.mimeType === "string" &&
				typeof p.data === "string"
			) {
				blocks.push({
					type: "image",
					mimeType: p.mimeType,
					data: p.data,
				});
			}
		}
	}
	return blocks;
}

function extractLatestAssistantReply(messages: readonly Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg?.role !== "assistant") continue;
		return messageContentToText(msg.content);
	}
	return "";
}

function extractTurnBlocks(messages: readonly Message[]): TurnBlock[] {
	const lastUserIdx = messages.findLastIndex((m) => m.role === "user");
	const messagesSinceUser =
		lastUserIdx >= 0 ? messages.slice(lastUserIdx + 1) : messages;
	const blocks: TurnBlock[] = [];
	for (const msg of messagesSinceUser) {
		if (msg.role !== "assistant") continue;
		if (!Array.isArray(msg.content)) continue;
		for (const part of msg.content) {
			if (!part || typeof part !== "object" || !("type" in part)) continue;
			const p = part as { type: string; name?: string; text?: string };
			if (p.type === "thinking") {
				blocks.push({ type: "thinking" });
			} else if (p.type === "toolCall" && typeof p.name === "string") {
				blocks.push({ type: "tool_call", toolName: p.name });
			} else if (p.type === "text" && typeof p.text === "string") {
				blocks.push({ type: "text", text: p.text });
			}
		}
	}
	return blocks;
}

function messageContentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (part && typeof part === "object" && "type" in part) {
				const p = part as { type: string; text?: string };
				if (p.type === "text" && typeof p.text === "string") return p.text;
			}
			return "";
		})
		.join("");
}
