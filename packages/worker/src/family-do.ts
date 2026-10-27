import { DurableObject } from "cloudflare:workers";
import type { Context } from "@earendil-works/chord/context";
import type {
	AssistantMessage,
	Message,
	ToolResultMessage,
} from "@earendil-works/pi-ai";
import type { MutableModels } from "@earendil-works/pi-ai/models";
import {
	AgentDoc,
	type AgentEvent,
	type AgentEventStream,
	type AgentState,
	type Conversation,
	type ConversationId,
	type Cursor,
	createRegistry,
	Harness,
	LiveDoc,
	type TaskId,
	type ToolRegistration,
	UsageDoc,
	watchEvents,
} from "@earendil-works/pi-durable";
import { openDurableObjectSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/cloudflare";
import { syncDurableObjectAlarm } from "./alarms.js";
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
import { getEdgeCache } from "./edge-cache.js";
import { createCadmusCodingTools } from "./extensions/coding-tools.js";
import { DEFAULT_SOUL, identityExtension } from "./extensions/identity.js";
import { internalToolsExtension } from "./extensions/internal-tools.js";
import { knowledgeExtension } from "./extensions/knowledge-tools.js";
import { schedulesToolsExtension } from "./extensions/schedules-tools.js";
import { toolGateExtension } from "./extensions/tool-gate.js";
import { webToolsExtension } from "./extensions/web-tools.js";
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
	getSupportedThinkingLevels,
	parseModelRef,
	parseThinkingLevel,
} from "./models.js";
import { OAuthFlowManager } from "./oauth.js";
import {
	type BotRecord,
	type ChatRecord,
	type ClientCommand,
	type CommandResultFrame,
	type CommandType,
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
	scheduleExtension,
} from "./schedules.js";
import { defaultJsonShim, type ProtocolShim } from "./shim.js";
import { D1AdminStore, toDoName } from "./store/d1-admin.js";
import type { FamilyStore } from "./store/family-interface.js";
import {
	CasConflictError,
	formatKnowledgeMarkdown,
	parseKnowledgeMarkdown,
	SLUG_REGEX,
	SqliteFamilyStore,
} from "./store/sqlite-family.js";
import {
	chooseToolsEnvIdentity,
	daemonCwd,
	envDoName,
	isCodingTool,
	OFFLINE_TOOLS_ENV,
	WORKSPACE_ROOT,
} from "./tools-env/pure.js";
import { ToolsEnvController } from "./tools-env/session.js";
import type { Env } from "./types.js";

export interface FamilyMeta {
	accountId: string;
	familyId: string;
	name: string;
	timezone: string;
	harvestDelayMs: number;
}

const SEQUENTIAL_TOOLS = new Set([
	"write",
	"edit",
	"bash",
	"knowledge_update",
	"knowledge_delete",
	"memory_update",
	"schedule_create",
	"schedule_update",
	"schedule_delete",
	"create_bot",
	"message_bot",
]);

function toToolRegs(
	names: readonly string[] | undefined,
): readonly ToolRegistration[] | null {
	if (names === undefined) return null;
	return names.map(
		(name) =>
			({
				name,
				...(SEQUENTIAL_TOOLS.has(name)
					? { executionMode: "sequential" as const }
					: {}),
			}) as unknown as ToolRegistration,
	);
}

export class CadmusBotFamilyDO extends DurableObject<Env> {
	readonly familyStore: FamilyStore;
	readonly adminStore: D1AdminStore;
	readonly credentialStore: AccountCredentialStore;
	readonly shim: ProtocolShim = defaultJsonShim;

	private readonly codingTools = createCadmusCodingTools();
	private readonly toolsEnvController: ToolsEnvController;
	private harnessPromise?: Promise<Harness>;
	private harnessInstance?: Harness;
	private cadmusContext?: Context;
	private modelsInstance?: MutableModels;
	private oauthManager: OAuthFlowManager;
	private sseControllers = new Set<
		ReadableStreamDefaultController<Uint8Array>
	>();
	private activeWatches = new Map<number, AgentEventStream>();
	private streamedAssistantContent = new Map<number, Map<number, string>>();

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
        harvest_delay_ms INTEGER NOT NULL
      );
    `);
	}

	getFamilyMeta(): FamilyMeta {
		const rows = this.ctx.storage.sql
			.exec<{
				account_id: string;
				family_id: string;
				name: string;
				timezone: string;
				harvest_delay_ms: number;
			}>(
				`SELECT account_id, family_id, name, timezone, harvest_delay_ms
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
			};
		}
		return {
			accountId: "default-account",
			familyId: "default",
			name: "Default Family",
			timezone: this.env.CADMUS_DEFAULT_TIMEZONE ?? "UTC",
			harvestDelayMs: Number(this.env.CADMUS_HARVEST_DELAY_MS ?? 60_000),
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
		};
		this.ctx.storage.sql.exec(
			`INSERT INTO cadmus_family_meta (id, account_id, family_id, name, timezone, harvest_delay_ms)
       VALUES (1, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         account_id = excluded.account_id,
         family_id = excluded.family_id,
         name = excluded.name,
         timezone = excluded.timezone,
         harvest_delay_ms = excluded.harvest_delay_ms`,
			updated.accountId,
			updated.familyId,
			updated.name,
			updated.timezone,
			updated.harvestDelayMs,
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
		const extensions = [
			identityExtension(),
			knowledgeExtension(),
			schedulesToolsExtension(),
			internalToolsExtension(),
			toolGateExtension(),
			webToolsExtension(),
			scheduleExtension(),
		];
		registry.install(this.codingTools);
		for (const ext of extensions) {
			registry.install(ext);
		}

		const services: CadmusServices = {
			familyStore: this.familyStore,
			harness: undefined as unknown as Harness,
			getTimezone: () => this.getFamilyMeta().timezone,
			getHarvestDelayMs: () => this.getFamilyMeta().harvestDelayMs,
			createBot: (input) => this.createBotInternal(input),
			createChat: (input) => this.createChatInternal(input),
			submitChatTurn: (input) => this.submitChatTurnInternal(input),
			ensureScheduleTask: (scheduleId) =>
				this.ensureScheduleTaskInternal(scheduleId),
			syncAlarm: () => this.syncAlarmInternal(),
			broadcast: (event) => this.broadcastEvent(event),
			prepareCodingTools: (conversationId) =>
				this.prepareCodingTools(conversationId),
			codingToolAllowed: (conversationId, botId, toolName) =>
				this.codingToolAllowed(conversationId, botId, toolName),
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
					extensions,
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
					const parent = conversation.parent?.conversationId;
					if (parent === undefined) return;
					this.familyStore.chats.copyConversationRoute(
						parent as unknown as number,
						conversation.id as unknown as number,
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

		if (url.pathname === "/ws") {
			const pair = new WebSocketPair();
			const client = pair[0];
			const server = pair[1];
			this.ctx.acceptWebSocket(server);
			await this.ensureHarness();
			this.log().debug("websocket client connected");
			return new Response(null, { status: 101, webSocket: client });
		}

		if (url.pathname === "/events" && request.method === "GET") {
			await this.ensureHarness();
			this.log().debug("sse client connected");
			return this.handleSseStream(request.signal);
		}

		if (url.pathname === "/rpc" && request.method === "POST") {
			const raw = await request.text();
			return this.handleRpcRequest(raw);
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
			const response = await this.executeCommand(command);
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

	// ─── RPC & Streaming Event Helpers ─────────────────────────────────────────

	private async handleRpcRequest(raw: string): Promise<Response> {
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

		const resultFrame = await this.executeCommand(command);
		const status = resultFrame.ok ? 200 : 400;
		return new Response(this.shim.encodeFrame(resultFrame), {
			status,
			headers: { "Content-Type": this.shim.contentType },
		});
	}

	private handleSseStream(signal: AbortSignal): Response {
		const encoder = new TextEncoder();
		let activeController:
			| ReadableStreamDefaultController<Uint8Array>
			| undefined;

		const stream = new ReadableStream<Uint8Array>({
			start: (controller) => {
				activeController = controller;
				this.sseControllers.add(controller);
				signal.addEventListener(
					"abort",
					() => {
						this.sseControllers.delete(controller);
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

	broadcastEvent(event: ServerFrame): void {
		const text = this.shim.encodeFrame(event);

		for (const ws of this.ctx.getWebSockets()) {
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
				try {
					controller.enqueue(ssePayload);
				} catch {
					this.sseControllers.delete(controller);
				}
			}
		}
	}

	// ─── Command Dispatcher ────────────────────────────────────────────────────

	async executeCommand(command: ClientCommand): Promise<CommandResultFrame> {
		const cmdLog = this.log().child({
			commandId: command.id,
			command: command.type,
		});
		try {
			await this.ensureHarness();
			cmdLog.debug("dispatching protocol command");
			const result = await this.dispatchCommand(command);
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
	): Promise<RpcResult<CommandType>> {
		return callCommandHandler(this.commandHandlers(), command);
	}

	private commandHandlers(): CommandHandlerMap {
		const meta = this.getFamilyMeta();
		const readChatSnapshot = async (
			command: Extract<
				ClientCommand,
				{
					type:
						| "chat.get"
						| "chat.messages"
						| "chat.entries"
						| "chat.subscribe";
				}
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
				await this.attachConversationWatch(chat, conv, context);
			}
			const { messages, entries } = conv
				? await this.readTranscriptData(conv, context)
				: { messages: [], entries: [] };
			const live = await harness.snapshot(
				LiveDoc,
				chat.conversationId as ConversationId,
				context,
			);
			const notes = this.familyStore.harvest.listNotes(chat.key);
			const bot = this.familyStore.bots.getBot(chat.botId);
			const resolved =
				command.type === "chat.get" && bot
					? await this.toolsEnvController.resolvedFields(
							bot,
							chat.toolsEnv ?? null,
						)
					: {};
			return {
				chat,
				busy: Boolean(live?.run),
				messages,
				entries,
				notes,
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
				return { env: await this.toolsEnvController.present(env) };
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
			"account.toolsEnvSecrets.list": async (_command) => {
				const secrets = await this.adminStore.listToolsEnvSecrets(
					meta.accountId,
				);
				return { secrets };
			},
			"account.toolsEnvSecrets.set": async (command) => {
				const created = await this.adminStore.setToolsEnvSecret(
					meta.accountId,
					command.payload?.label !== undefined
						? { label: command.payload.label }
						: undefined,
				);
				this.broadcastEvent({
					type: "account.tools_env_secret",
					payload: {
						accountId: meta.accountId,
						secretId: created.secret.secretId,
						action: "set",
						when: created.secret.updatedAt,
					},
				});
				this.log().info("tools env secret minted", {
					secretId: created.secret.secretId,
				});
				return created;
			},
			"account.toolsEnvSecrets.delete": async (command) => {
				const outcome = await this.adminStore.deleteToolsEnvSecret(
					meta.accountId,
					command.payload.secretId,
				);
				if (!outcome.deleted) {
					throw new ProtocolValidationError(
						`Unknown tools env secret '${command.payload.secretId}'`,
						"not_found",
					);
				}
				for (const envId of outcome.flaggedEnvIds) {
					await this.env.CADMUS_ENV.getByName(
						envDoName(meta.accountId, envId),
					).revokePairing();
				}
				const previousDefault = outcome.clearedDefaultEnvId;
				await this.invalidateToolsEnvCatalog({
					previousDefaultEnvId: previousDefault,
					nextDefaultEnvId: null,
				});
				await this.fanOutToolsEnvCatalog(previousDefault, null);
				this.broadcastEvent({
					type: "account.tools_env_secret",
					payload: {
						accountId: meta.accountId,
						secretId: command.payload.secretId,
						action: "deleted",
						when: Date.now(),
					},
				});
				return { deleted: command.payload.secretId };
			},
			"account.members.list": async (_command) => {
				const members = await this.adminStore.listMembers(meta.accountId);
				return { members };
			},
			"account.members.add": async (command) => {
				const member = await this.adminStore.addMember({
					accountId: meta.accountId,
					userId: command.payload.userId,
					name: command.payload.name,
					email: command.payload.email,
					role: command.payload.role,
					rawToken: command.payload.token,
				});
				return { member };
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
						result.push({
							id: m.id,
							provider: providerId,
							name: m.name ?? m.id,
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
			"account.oauth.providers": async (_command) => {
				const providers = this.oauthManager.listProviders();
				return { providers };
			},
			"account.oauth.start": async (command) => {
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
			"account.oauth.status": async (command) => {
				const flow = this.oauthManager.getStatus(command.payload.flowId);
				return { flow };
			},
			"account.oauth.submit": async (command) => {
				const flow = this.oauthManager.submitInput(
					command.payload.flowId,
					command.payload.input,
				);
				return { flow };
			},
			"account.oauth.cancel": async (command) => {
				const flow = this.oauthManager.cancelFlow(command.payload.flowId);
				return { flow, cancelled: true };
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
				});
				const record = await this.adminStore.updateFamily(
					meta.accountId,
					updated.familyId,
					{
						name: updated.name,
						timezone: updated.timezone,
						harvestDelayMs: updated.harvestDelayMs,
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
				const knowledge = this.familyStore.files.listKnowledge(bot.id);
				const resolved = await this.toolsEnvController.resolvedFields(
					bot,
					null,
				);
				return { bot, soul, memory, knowledge, ...resolved };
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
				const updated: BotRecord = {
					...existing,
					name: command.payload.name ?? existing.name,
					model: modelStr,
					thinking: thinkingStr,
				};
				// Missing or null leaves the allowlist unchanged. An array replaces it.
				// [] is an explicit allowlist of zero tools (configure must not see null:
				// pi-durable deletes the filter on null, which offers every tool).
				if (Array.isArray(command.payload.tools)) {
					updated.tools = command.payload.tools;
				}
				const agentTools = Array.isArray(command.payload.tools)
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
				if (command.payload.soul !== undefined) {
					this.familyStore.files.setSoul(updated.id, command.payload.soul);
				}

				const { harness, context } = await this.ensureHarness();
				const rootConv = await harness.conversation(
					updated.rootConversationId as ConversationId,
					context,
				);
				if (rootConv) {
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
				const existing = this.familyStore.bots.getBot(command.payload.botId);
				if (!existing) {
					throw new ProtocolValidationError(
						`Bot '${command.payload.botId}' not found`,
						"not_found",
					);
				}
				await this.toolsEnvController.deleteScopesForBot(command.payload.botId);
				this.familyStore.bots.deleteBot(command.payload.botId);
				await this.syncAlarmInternal();
				return { deleted: command.payload.botId };
			},
			"chat.list": async (command) => {
				return {
					chats: this.familyStore.chats.listChats(command.payload?.botId),
				};
			},
			"chat.create": async (command) => {
				const chat = await this.createChatInternal({
					botId: command.payload.botId,
					key: command.payload.key ?? command.payload.chatId,
					title: command.payload.title,
					thinking: command.payload.thinking,
					toolsEnv: command.payload.toolsEnv,
				});
				return { chat };
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
				const updated: ChatRecord = { ...chat };
				if (next) updated.toolsEnv = next;
				else delete updated.toolsEnv;
				this.familyStore.chats.upsertChat(updated);
				return { chat: updated };
			},
			"chat.get": readChatSnapshot,
			"chat.messages": readChatSnapshot,
			"chat.entries": readChatSnapshot,
			"chat.subscribe": readChatSnapshot,
			"chat.status": async (command) => {
				return this.handleOutOfBandStatus(command.payload.chatKey);
			},
			"chat.rename": async (command) => {
				const chat = this.familyStore.chats.getChat(command.payload.chatKey);
				if (!chat) {
					throw new ProtocolValidationError(
						`Chat '${command.payload.chatKey}' not found`,
						"not_found",
					);
				}
				const updated: ChatRecord = {
					...chat,
					title: command.payload.title,
				};
				this.familyStore.chats.upsertChat(updated);
				return { chat: updated };
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
				return { chat, reset: true };
			},
			"chat.close": async (command) => {
				const chat = this.familyStore.chats.getChat(command.payload.chatKey);
				if (!chat) {
					throw new ProtocolValidationError(
						`Chat '${command.payload.chatKey}' not found`,
						"not_found",
					);
				}
				const updated: ChatRecord = { ...chat, closed: true };
				this.familyStore.chats.upsertChat(updated);
				return { chat: updated };
			},
			"turn.submit": async (command) => {
				const trimmed = command.payload.text.trim();
				if (trimmed === "/status") {
					return this.handleOutOfBandStatus(command.payload.chatKey);
				}
				if (trimmed.startsWith("/")) {
					const cmdName = trimmed.split(/\s+/)[0];
					throw new ProtocolValidationError(
						`Slash command '${cmdName}' is not supported. Only '/status' is supported out-of-band.`,
						"unsupported_command",
					);
				}
				return this.submitChatTurnInternal({
					chatKey: command.payload.chatKey,
					text: command.payload.text,
					requestId: command.payload.requestId ?? command.payload.clientMsgId,
					whenBusy: command.payload.whenBusy,
				});
			},
			"turn.command": async (command) => {
				const cmd = command.payload.command.trim();
				if (cmd === "/status" || cmd === "status") {
					return this.handleOutOfBandStatus(command.payload.chatKey);
				}
				throw new ProtocolValidationError(
					`Slash command '${cmd}' is not supported. Only '/status' is supported out-of-band.`,
					"unsupported_command",
				);
			},
			"turn.steer": async (command) => {
				return this.submitChatTurnInternal({
					chatKey: command.payload.chatKey,
					text: command.payload.text,
					requestId: command.payload.requestId ?? command.payload.clientMsgId,
					whenBusy: "steer",
				});
			},
			"turn.abort": abortTurn,
			"turn.interrupt": abortTurn,
			"file.list": async (command) => {
				return this.listBotFiles(
					command.payload.botId,
					command.payload.category,
				);
			},
			"file.read": async (command) => {
				const { botId, path } = command.payload;
				if (!path) {
					return this.listBotFiles(botId);
				}
				const bot = this.familyStore.bots.getBot(botId);
				if (!bot) {
					throw new ProtocolValidationError(
						`Bot '${botId}' not found`,
						"not_found",
					);
				}
				if (path === "SOUL.md") {
					const content = this.familyStore.files.getSoul(botId);
					return { path: "SOUL.md", content, text: content, version: 1 };
				}
				if (path === "MEMORY.md") {
					const mem = this.familyStore.files.getMemory(botId);
					return {
						path: "MEMORY.md",
						content: mem.content,
						text: mem.content,
						version: mem.version,
					};
				}
				const kMatch = /^knowledge\/([a-z0-9-]+)\.md$/.exec(path);
				if (kMatch?.[1]) {
					const doc = this.familyStore.files.getKnowledge(botId, kMatch[1]);
					if (!doc) {
						throw new ProtocolValidationError(
							`Knowledge file '${path}' not found`,
							"not_found",
						);
					}
					const formatted = formatKnowledgeMarkdown(doc);
					return {
						path,
						slug: doc.slug,
						description: doc.description,
						...(doc.category ? { category: doc.category } : {}),
						version: doc.version,
						body: doc.body,
						content: formatted,
						text: formatted,
					};
				}
				throw new ProtocolValidationError(
					`Unsupported virtual file path '${path}'. Expected SOUL.md, MEMORY.md, or knowledge/<slug>.md`,
					"invalid_path",
				);
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

				const bot = this.familyStore.bots.getBot(botId);
				if (!bot) {
					throw new ProtocolValidationError(
						`Bot '${botId}' not found`,
						"not_found",
					);
				}

				if (isDelete) {
					const kMatch = /^knowledge\/([a-z0-9-]+)\.md$/.exec(path);
					if (!kMatch?.[1]) {
						throw new ProtocolValidationError(
							`Only knowledge/<slug>.md files can be deleted (got '${path}')`,
							"invalid_path",
						);
					}
					const slug = kMatch[1];
					const existing = this.familyStore.files.getKnowledge(botId, slug);
					if (!existing) {
						throw new ProtocolValidationError(
							`Knowledge file '${path}' not found`,
							"not_found",
						);
					}
					this.familyStore.files.deleteKnowledge(
						botId,
						slug,
						expectedVersion ?? existing.version,
					);
					return { deleted: path };
				}

				if (path === "SOUL.md") {
					this.familyStore.files.setSoul(botId, content);
					return { path: "SOUL.md", version: 1, content };
				}
				if (path === "MEMORY.md") {
					const updated = this.familyStore.files.updateMemory(
						botId,
						content,
						expectedVersion ?? 0,
					);
					return {
						path: "MEMORY.md",
						version: updated.version,
						content: updated.content,
					};
				}
				const kMatch = /^knowledge\/([a-z0-9-]+)\.md$/.exec(path);
				if (kMatch?.[1]) {
					const slug = kMatch[1];
					let desc = description;
					let cat = category;
					let body = rawBody ?? rawContent ?? rawText ?? "";
					let expVer = expectedVersion;

					if (desc === undefined && body.trimStart().startsWith("---")) {
						const parsed = parseKnowledgeMarkdown(body);
						desc = parsed.description;
						cat = parsed.category;
						body = parsed.body;
						if (expVer === undefined && parsed.version !== undefined) {
							expVer = parsed.version;
						}
					}
					if (!desc) {
						throw new ProtocolValidationError(
							"Knowledge write requires a description (either in payload.description or YAML frontmatter)",
							"invalid_knowledge",
						);
					}
					const updated = this.familyStore.files.updateKnowledge(botId, {
						slug,
						description: desc,
						category: cat,
						body,
						expectedVersion: expVer ?? 0,
					});
					return {
						path,
						slug: updated.slug,
						description: updated.description,
						...(updated.category ? { category: updated.category } : {}),
						version: updated.version,
						body: updated.body,
					};
				}
				throw new ProtocolValidationError(
					`Unsupported virtual file path '${path}'`,
					"invalid_path",
				);
			},
			"file.delete": async (command) => {
				const { botId, path, expectedVersion, version } = command.payload;
				const kMatch = /^knowledge\/([a-z0-9-]+)\.md$/.exec(path);
				if (!kMatch?.[1]) {
					throw new ProtocolValidationError(
						`Only knowledge/<slug>.md files can be deleted (got '${path}')`,
						"invalid_path",
					);
				}
				const slug = kMatch[1];
				const existing = this.familyStore.files.getKnowledge(botId, slug);
				if (!existing) {
					throw new ProtocolValidationError(
						`Knowledge file '${path}' not found`,
						"not_found",
					);
				}
				this.familyStore.files.deleteKnowledge(
					botId,
					slug,
					expectedVersion ?? version ?? existing.version,
				);
				return { deleted: path };
			},
			"knowledge.search": async (command) => {
				const results = this.familyStore.files.searchKnowledge(
					command.payload.botId,
					command.payload.query ?? "",
					command.payload.category,
				);
				return { results };
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
					target,
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
				await this.syncAlarmInternal();
				this.log().debug("schedule deleted", { schedule: command.payload.id });
				return { deleted: command.payload.id };
			},
		};
	}

	private listBotFiles(botId: string, category?: string) {
		const bot = this.familyStore.bots.getBot(botId);
		if (!bot) {
			throw new ProtocolValidationError(
				`Bot '${botId}' not found`,
				"not_found",
			);
		}
		const soul = this.familyStore.files.getSoul(botId);
		const memory = this.familyStore.files.getMemory(botId);
		const knowledge = this.familyStore.files.listKnowledge(botId, category);
		const files = [
			{
				path: "SOUL.md",
				kind: "soul" as const,
				size: new TextEncoder().encode(soul).byteLength,
			},
			{
				path: "MEMORY.md",
				kind: "memory" as const,
				version: memory.version,
				size: new TextEncoder().encode(memory.content).byteLength,
			},
			...knowledge.map((doc) => ({
				path: `knowledge/${doc.slug}.md`,
				kind: "knowledge" as const,
				slug: doc.slug,
				description: doc.description,
				...(doc.category ? { category: doc.category } : {}),
				version: doc.version,
				size: new TextEncoder().encode(doc.body).byteLength,
			})),
		];
		return { files };
	}

	private codingToolsSelected(extensions: AgentState["extensions"]): boolean {
		if (!extensions) return false;
		if (Array.isArray(extensions)) return extensions.includes("coding-tools");
		if (extensions.remove?.includes("coding-tools")) return false;
		return extensions.add?.includes("coding-tools") ?? false;
	}

	private async prepareCodingTools(conversationId: number): Promise<void> {
		const { harness, context } = await this.ensureHarness();
		const agent = await harness.snapshot(
			AgentDoc,
			conversationId as ConversationId,
			context,
		);
		if (!agent?.cwd?.trim()) return;
		const bot = this.familyStore.bots.getBot(agent.cwd.trim());
		if (!bot) return;
		const offer = await this.toolsEnvController.offerCodingTools(
			conversationId,
			bot,
		);
		if (offer === this.codingToolsSelected(agent.extensions)) return;
		const conv = await harness.conversation(
			conversationId as ConversationId,
			context,
		);
		if (!conv) return;
		await conv.configure(
			{
				extensions: offer
					? { add: [this.codingTools] }
					: { remove: [this.codingTools] },
			},
			context,
		);
	}

	private async codingToolAllowed(
		conversationId: number,
		botId: string,
		toolName: string,
	): Promise<boolean> {
		const bot = this.familyStore.bots.getBot(botId);
		if (!bot) return false;
		return this.toolsEnvController.codingToolAllowed(
			conversationId,
			bot,
			toolName,
		);
	}

	private async describeToolsEnv(input: {
		conversationId: number;
		botId: string;
		toolNames: readonly string[];
	}): Promise<
		{ name: "tools-env" | "tools-env-unavailable"; text: string } | undefined
	> {
		const bot = this.familyStore.bots.getBot(input.botId);
		if (!bot?.tools) return undefined;
		if (!bot.tools.some((name) => isCodingTool(name))) return undefined;
		const route = this.familyStore.chats.getConversationRoute(
			input.conversationId,
		);
		if (route && !route.toolsEnvEnabled) return undefined;
		const chat = route
			? this.familyStore.chats.getChat(route.chatKey)
			: undefined;
		const { resolved, def } = await this.toolsEnvController.resolvedFor(
			bot,
			chat?.toolsEnv ?? null,
		);
		if (!resolved.enabled || !resolved.binding) return undefined;
		const botLevel = await this.toolsEnvController.resolvedFor(bot, null);
		const botDef = botLevel.resolved.binding
			? (await this.toolsEnvController.catalog()).defs.get(
					botLevel.resolved.binding.envId,
				)
			: undefined;
		const connected = def
			? (await this.toolsEnvController.connectionFor(def)).status ===
				"connected"
			: false;
		return chooseToolsEnvIdentity({
			enabled: true,
			connected,
			toolsOffered: input.toolNames.some((name) => isCodingTool(name)),
			harvest: false,
			kind: def?.kind,
			envId: def?.envId ?? resolved.binding.envId,
			enabledSource: resolved.enabledSource,
			bindingSource: resolved.bindingSource,
			persist: def?.persist,
			confineToWorkspace: def?.confineToWorkspace,
			sharedWorkspace: def?.sharedWorkspace,
			scopeKind: resolved.scopeKind,
			botDefaultKind: botDef?.kind,
			root: def?.kind === "local-daemon" ? daemonCwd(def) : WORKSPACE_ROOT,
		});
	}

	// ─── Out-of-Band `/status` Implementation ──────────────────────────────────

	private async handleOutOfBandStatus(chatKey: string) {
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
		const usage = await harness.snapshot(UsageDoc, convId, context);
		const ctxView = conv ? await conv.context(context) : undefined;
		const entryCount = ctxView ? ctxView.entries.length : 0;
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
			tools: bot.tools ?? ("all" as const),
			busy: Boolean(live?.run),
			entryCount,
			harvestWatermark: watermark,
			nextWakeAt,
			usage: usage ?? {},
			toolsEnv,
		};

		const text = [
			`Bot: ${bot.name} (${bot.id})`,
			`Model: ${bot.model} (thinking: ${effectiveThinking})`,
			`Chat: ${chat.key} (conversation #${chat.conversationId}, entries: ${entryCount}, busy: ${status.busy})`,
			`Tools: ${Array.isArray(status.tools) ? status.tools.join(", ") : "all"}`,
			`Harvest watermark: entry #${watermark}`,
			`Next scheduled wake: ${nextWakeAt ? new Date(nextWakeAt).toISOString() : "none"}`,
			`Tools env: ${
				toolsEnv.enabled
					? `${toolsEnvNest.kind} (${toolsEnvNest.envId}, ${toolsEnvNest.status}${
							toolsEnvNest.connectedAt !== undefined
								? `, connectedAt ${new Date(toolsEnvNest.connectedAt).toISOString()}`
								: ""
						}${
							toolsEnvNest.lastError ? `, error: ${toolsEnvNest.lastError}` : ""
						})`
					: "off"
			}`,
		].join("\n");

		this.log().child(chatFields(chat)).debug("command", { name: "status" });

		return {
			outOfBand: true as const,
			command: "/status" as const,
			status,
			text,
		};
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
		knowledge?: {
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

		const preview: BotRecord = {
			id: slug,
			name: input.name,
			model: modelStr,
			thinking: thinkingStr,
			timezone: "UTC",
			...(input.tools !== undefined ? { tools: input.tools } : {}),
			...(toolsEnv ? { toolsEnv } : {}),
			rootConversationId: 0,
			createdAt: Date.now(),
		};
		const offerCoding = await this.toolsEnvController.willOffer(preview, null);

		const { harness, context } = await this.ensureHarness();
		const rootConv = await harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: {
					model: modelRef,
					thinkingLevel: parseThinkingLevel(thinkingStr) ?? null,
					cwd: slug,
					extensions: offerCoding
						? { add: [this.codingTools] }
						: { remove: [this.codingTools] },
					...(input.tools !== undefined
						? { tools: toToolRegs(input.tools) }
						: {}),
				},
			},
			context,
		);

		const meta = this.getFamilyMeta();
		const account = await this.adminStore.getAccount(meta.accountId);
		const botTimezone = account?.timezone ?? meta.timezone;

		const bot: BotRecord = {
			id: slug,
			name: input.name,
			model: modelStr,
			thinking: thinkingStr,
			timezone: botTimezone,
			...(input.tools !== undefined ? { tools: input.tools } : {}),
			...(toolsEnv ? { toolsEnv } : {}),
			rootConversationId: rootConv.id as unknown as number,
			createdAt: Date.now(),
		};

		this.familyStore.bots.upsertBot(bot);
		this.familyStore.files.setSoul(slug, input.soul ?? DEFAULT_SOUL);

		if (input.memory !== undefined && input.memory !== "") {
			this.familyStore.files.updateMemory(slug, input.memory, 0);
		}
		if (input.knowledge) {
			for (const k of input.knowledge) {
				this.familyStore.files.updateKnowledge(slug, {
					slug: k.slug,
					description: k.description,
					category: k.category,
					body: k.body,
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

	private async createChatInternal(input: {
		botId: string;
		key?: string;
		title?: string;
		thinking?: ThinkingLevel;
		toolsEnv?: ToolsEnvSetting | null;
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
		const offerCoding = await this.toolsEnvController.willOffer(bot, toolsEnv);

		const { harness, context } = await this.ensureHarness();
		const modelRef = parseModelRef(bot.model);
		const effectiveThinking = input.thinking ?? bot.thinking;
		const conv = await harness.createConversation(
			{
				ownership: { kind: "ownerless" },
				agent: {
					model: modelRef,
					thinkingLevel: parseThinkingLevel(effectiveThinking) ?? null,
					cwd: bot.id,
					extensions: offerCoding
						? { add: [this.codingTools] }
						: { remove: [this.codingTools] },
					...(bot.tools !== undefined ? { tools: toToolRegs(bot.tools) } : {}),
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
		return chat;
	}

	private async attachConversationWatch(
		chat: ChatRecord,
		conv: Conversation,
		context: Context,
	): Promise<void> {
		if (this.activeWatches.has(chat.conversationId)) return;
		const harness = this.harnessInstance;
		if (!harness) return;
		const stream = await watchEvents(harness, conv.id, context);
		this.activeWatches.set(chat.conversationId, stream);

		stream.start(async (events: readonly AgentEvent[]) => {
			for (const ev of events) {
				this.handleAgentEvent(chat, ev);
			}
		});
	}

	private handleAgentEvent(chat: ChatRecord, ev: AgentEvent): void {
		switch (ev.type) {
			case "run_start": {
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
				break;
			}
			case "message_start": {
				if (
					ev.message.role === "assistant" &&
					Array.isArray(ev.message.content)
				) {
					let streamedMap = this.streamedAssistantContent.get(
						chat.conversationId,
					);
					if (!streamedMap) {
						streamedMap = new Map();
						this.streamedAssistantContent.set(chat.conversationId, streamedMap);
					}
					for (let i = 0; i < ev.message.content.length; i++) {
						const part = ev.message.content[i];
						if (part && typeof part === "object" && "type" in part) {
							const p = part as {
								type: string;
								text?: string;
								thinking?: string;
							};
							if (p.type === "text" && typeof p.text === "string" && p.text) {
								streamedMap.set(i, p.text);
								this.broadcastEvent({
									type: "turn.delta",
									payload: {
										chatKey: chat.key,
										kind: "text",
										delta: p.text,
									},
								});
							} else if (
								p.type === "thinking" &&
								typeof p.thinking === "string" &&
								p.thinking
							) {
								streamedMap.set(i, p.thinking);
								this.broadcastEvent({
									type: "turn.delta",
									payload: {
										chatKey: chat.key,
										kind: "thinking",
										delta: p.thinking,
									},
								});
							}
						}
					}
				}
				break;
			}
			case "message_update": {
				let streamedMap = this.streamedAssistantContent.get(
					chat.conversationId,
				);
				if (!streamedMap) {
					streamedMap = new Map();
					this.streamedAssistantContent.set(chat.conversationId, streamedMap);
				}
				for (const change of ev.changes) {
					if (change.type === "text_start") {
						const block = change.block;
						if (
							block.type === "text" &&
							typeof block.text === "string" &&
							block.text
						) {
							streamedMap.set(change.contentIndex, block.text);
							this.broadcastEvent({
								type: "turn.delta",
								payload: {
									chatKey: chat.key,
									kind: "text",
									delta: block.text,
								},
							});
						}
					} else if (change.type === "thinking_start") {
						const block = change.block;
						if (
							block.type === "thinking" &&
							typeof block.thinking === "string" &&
							block.thinking
						) {
							streamedMap.set(change.contentIndex, block.thinking);
							this.broadcastEvent({
								type: "turn.delta",
								payload: {
									chatKey: chat.key,
									kind: "thinking",
									delta: block.thinking,
								},
							});
						}
					} else if (change.type === "text_delta") {
						const prev = streamedMap.get(change.contentIndex) ?? "";
						streamedMap.set(change.contentIndex, prev + change.delta);
						this.broadcastEvent({
							type: "turn.delta",
							payload: {
								chatKey: chat.key,
								kind: "text",
								delta: change.delta,
							},
						});
					} else if (change.type === "thinking_delta") {
						const prev = streamedMap.get(change.contentIndex) ?? "";
						streamedMap.set(change.contentIndex, prev + change.delta);
						this.broadcastEvent({
							type: "turn.delta",
							payload: {
								chatKey: chat.key,
								kind: "thinking",
								delta: change.delta,
							},
						});
					}
				}
				break;
			}
			case "tool_execution_start": {
				this.log().child(chatFields(chat)).debug("tool execution started", {
					tool: ev.toolName,
					toolCallId: ev.toolCallId,
				});
				this.broadcastEvent({
					type: "turn.tool_call",
					payload: {
						chatKey: chat.key,
						toolCallId: ev.toolCallId,
						toolName: ev.toolName,
						args: (ev.args ?? {}) as Record<string, unknown>,
					},
				});
				break;
			}
			case "tool_execution_end": {
				const isError = Boolean(
					ev.result?.isError ||
						(ev.entry?.model?.[0]?.role === "toolResult" &&
							(ev.entry.model[0] as { isError?: boolean }).isError),
				);
				const rawOut =
					(ev.result as { output?: unknown } | undefined)?.output ??
					(ev.entry?.model?.[0]?.role === "toolResult"
						? ev.entry.model[0].content
						: undefined);
				const content =
					typeof rawOut === "string"
						? rawOut
						: messageContentToText(rawOut) || JSON.stringify(rawOut ?? "");
				this.log().child(chatFields(chat)).debug("tool execution ended", {
					tool: ev.toolName,
					toolCallId: ev.toolCallId,
					isError,
				});
				this.broadcastEvent({
					type: "turn.tool_result",
					payload: {
						chatKey: chat.key,
						toolCallId: ev.toolCallId,
						toolName: ev.toolName,
						content,
						isError,
					},
				});
				break;
			}
			case "message_end": {
				const streamedMap = this.streamedAssistantContent.get(
					chat.conversationId,
				);
				const msg = ev.entry?.model?.[0];
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
				break;
			}
			case "run_end": {
				this.streamedAssistantContent.delete(chat.conversationId);
				this.broadcastEvent({
					type: "chat.state",
					payload: {
						chatKey: chat.key,
						botId: chat.botId,
						conversationId: chat.conversationId,
						busy: false,
					},
				});
				break;
			}
		}
	}

	private async submitChatTurnInternal(input: {
		chatKey: string;
		text: string;
		requestId?: string;
		whenBusy?: "queue" | "steer" | "reject";
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

		const requestId =
			input.requestId ?? `turn:${chat.key}:${crypto.randomUUID().slice(0, 8)}`;
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

		await this.prepareCodingTools(chat.conversationId);

		const submission = await conv.submit(
			{
				type: "input",
				content: input.text,
				requestId,
				whenBusy: whenBusyMode,
			},
			context,
		);

		const settled = await submission.wait(context);
		await conv.waitForIdle(context);

		log.debug("chat turn settled", { status: settled.status });

		const view = await conv.context(context);
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
				status: "done",
				text: reply,
				blocks,
			},
		});

		const delayMs = this.getFamilyMeta().harvestDelayMs;
		if (delayMs > 0 && latestEntryId !== undefined) {
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

	private async syncAlarmInternal(): Promise<number | undefined> {
		if (!this.harnessInstance) return undefined;
		return syncDurableObjectAlarm(
			this.ctx.storage,
			this.harnessInstance,
			this.familyStore,
		);
	}

	private async readTranscriptData(
		conv: Conversation,
		context: Context,
	): Promise<{
		messages: TranscriptMessageView[];
		entries: RawTranscriptEntry[];
	}> {
		const view = await conv.context(context);
		const toolResults = new Map<string, ToolCallResultSummary>();
		for (const entry of view.entries) {
			const msg = entry.model?.[0];
			if (msg && msg.role === "toolResult") {
				const toolResultMsg = msg as ToolResultMessage;
				toolResults.set(toolResultMsg.toolCallId, {
					content: messageContentToText(toolResultMsg.content),
					isError: Boolean(toolResultMsg.isError),
					...(typeof toolResultMsg.durationMs === "number"
						? { durationMs: toolResultMsg.durationMs }
						: {}),
				});
			}
		}

		let lastUserEntryId: number | undefined;
		const messages: TranscriptMessageView[] = [];

		for (const entry of view.entries) {
			const msg = entry.model?.[0];
			if (!msg) continue;
			const id = Number(entry.id);

			if (msg.role === "user") {
				lastUserEntryId = id;
				const blocks = extractUserBlocks(msg.content);
				messages.push({
					id,
					role: "user",
					text: messageContentToText(msg.content),
					...(blocks.length > 0 ? { blocks } : {}),
					...(typeof msg.timestamp === "number"
						? { timestamp: msg.timestamp }
						: {}),
				});
			} else if (msg.role === "assistant") {
				const assistant = msg as AssistantMessage;
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
			} else if (msg.role === "toolResult") {
				const toolResultMsg = msg as ToolResultMessage;
				messages.push({
					id,
					role: "toolResult",
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
			}
		}

		const entries: RawTranscriptEntry[] = view.entries.map((entry) => ({
			id: Number(entry.id),
			conversationId: Number(entry.conversationId),
			kind: entry.kind,
			...(entry.model !== undefined ? { model: entry.model as unknown[] } : {}),
			...(entry.data !== undefined ? { data: entry.data } : {}),
			...(entry.head !== undefined ? { head: Number(entry.head) } : {}),
			...(entry.edits !== undefined ? { edits: entry.edits as unknown[] } : {}),
			...(entry.byTaskId !== undefined
				? { byTaskId: Number(entry.byTaskId) }
				: {}),
		}));

		return { messages, entries };
	}
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
