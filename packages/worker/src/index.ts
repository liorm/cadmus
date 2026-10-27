import {
	apiResponseFromRpc,
	isApiPath,
	prepareApiCommand,
	withPrivateApiCache,
} from "./api-adapter.js";
import { authenticateRequest } from "./auth.js";
import { CALLER_ROLE_HEADER, type CallerMeta } from "./authz.js";
import { type EdgeCache, getEdgeCache } from "./edge-cache.js";
import { CadmusBotFamilyDO } from "./family-do.js";
import { ensureLogger, getLogger, type Logger } from "./log.js";
import {
	type ClientCommand,
	type CommandResultFrame,
	PROTOCOL_JSON_SCHEMA,
	ProtocolValidationError,
	type ServerEvent,
} from "./protocol.js";
import { defaultJsonShim } from "./shim.js";
import { D1AdminStore, resetD1InitializationCache } from "./store/d1-admin.js";
import { handleToolsEnvWebsocket } from "./tools-env/edge-ws.js";
import { CadmusEnvDO } from "./tools-env/env-do.js";
import type { Env } from "./types.js";

export { CadmusBotFamilyDO, CadmusEnvDO };

export function resetEdgeD1InitCache(): void {
	resetD1InitializationCache();
}

export default {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		ensureLogger(env.CADMUS_LOG_LEVEL ?? env.LOG_LEVEL);
		const log = getLogger();
		const url = new URL(request.url);

		if (url.pathname === "/health" && request.method === "GET") {
			return Response.json({
				ok: true,
				service: "cadmus",
				version: 2,
			});
		}

		if (url.pathname === "/protocol/schema" && request.method === "GET") {
			return Response.json(PROTOCOL_JSON_SCHEMA);
		}

		const defaultTimezone = env.CADMUS_DEFAULT_TIMEZONE ?? "UTC";
		const defaultHarvestDelayMs = Number(env.CADMUS_HARVEST_DELAY_MS ?? 60_000);
		const edgeCache = getEdgeCache(env);

		const adminStore = new D1AdminStore({
			db: env.CADMUS_ADMIN_DB,
			encryptionKey: env.CADMUS_ENCRYPTION_KEY,
			defaultTimezone,
			defaultHarvestDelayMs,
			edgeCache,
		});
		await adminStore.initialize();

		if (url.pathname === "/tools-env/ws") {
			return handleToolsEnvWebsocket(request, env, adminStore, url, ctx);
		}

		const apiRequest = isApiPath(url.pathname);
		// /api takes Authorization: Bearer only. /rpc, /ws, and /events still
		// accept the session cookie and ?token=.
		const auth = await authenticateRequest(
			request,
			env,
			adminStore,
			edgeCache,
			apiRequest ? { allowQueryToken: false, allowCookie: false } : {},
		);
		if (!auth.ok) {
			if (
				apiRequest &&
				(auth.code === "query_token_not_allowed" ||
					auth.code === "header_required")
			) {
				// HEAD keeps status and cache headers and omits the body, matching
				// apiJson() in the adapter.
				const headers = new Headers({ "content-type": "application/json" });
				const denied =
					request.method === "HEAD"
						? new Response(null, { status: 401, headers })
						: Response.json(
								{ error: { code: auth.code, message: auth.message } },
								{ status: 401, headers },
							);
				return withPrivateApiCache(denied);
			}
			log.warn("edge request unauthorized", {
				method: request.method,
				path: url.pathname,
			});
			const unauthorized = Response.json(
				{
					type: "protocol.error",
					payload: {
						code: "unauthorized",
						message: "Missing or invalid authentication token",
					},
				} satisfies ServerEvent,
				{ status: 401 },
			);
			// /api/* is marked uncacheable here; /rpc, /ws, and /events stay as they were.
			if (apiRequest) return withPrivateApiCache(unauthorized);
			return unauthorized;
		}
		const scope = auth.scope;

		const { accountId, familyId: requestedFamilyId } = scope;
		const reqLog = log.child({
			account: accountId,
			family: requestedFamilyId,
		});

		if (url.pathname === "/ws") {
			const family = await resolveOrEnsureFamily(
				edgeCache,
				adminStore,
				accountId,
				requestedFamilyId,
				defaultTimezone,
				defaultHarvestDelayMs,
			);
			if (!family) {
				reqLog.warn("websocket upgrade rejected: family not found");
				return Response.json(
					{
						type: "protocol.error",
						payload: {
							code: "family_not_found",
							message: `Bot Family '${requestedFamilyId}' not found in account '${accountId}'`,
						},
					} satisfies ServerEvent,
					{ status: 404 },
				);
			}
			reqLog.debug("forwarding websocket upgrade to family DO", {
				doName: family.doName,
			});
			return forwardToFamilyDO(env, family, scope.role, request, "/ws");
		}

		if (url.pathname === "/events" && request.method === "GET") {
			const family = await resolveOrEnsureFamily(
				edgeCache,
				adminStore,
				accountId,
				requestedFamilyId,
				defaultTimezone,
				defaultHarvestDelayMs,
			);
			if (!family) {
				reqLog.warn("sse stream rejected: family not found");
				return Response.json(
					{
						type: "protocol.error",
						payload: {
							code: "family_not_found",
							message: `Bot Family '${requestedFamilyId}' not found in account '${accountId}'`,
						},
					} satisfies ServerEvent,
					{ status: 404 },
				);
			}
			reqLog.debug("forwarding sse stream to family DO", {
				doName: family.doName,
			});
			return forwardToFamilyDO(env, family, scope.role, request, "/events");
		}

		if (url.pathname === "/rpc" && request.method === "POST") {
			const raw = await request.text();
			let command: ClientCommand;
			try {
				command = defaultJsonShim.decodeCommand(raw);
			} catch (error) {
				reqLog.warn("invalid rpc command frame", { error });
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
				return new Response(defaultJsonShim.encodeFrame(errFrame), {
					status: 400,
					headers: { "Content-Type": defaultJsonShim.contentType },
				});
			}

			return dispatchDecodedCommand(
				request,
				env,
				adminStore,
				edgeCache,
				accountId,
				requestedFamilyId,
				command,
				raw,
				reqLog,
				defaultTimezone,
				defaultHarvestDelayMs,
				scope.role,
			);
		}

		if (isApiPath(url.pathname)) {
			const prepared = await prepareApiCommand(request);
			if (!prepared.ok) return withPrivateApiCache(prepared.response);
			reqLog.debug("dispatching api command", {
				method: prepared.prepared.method,
				command: prepared.prepared.command.type,
			});
			const rpcResponse = await dispatchDecodedCommand(
				request,
				env,
				adminStore,
				edgeCache,
				accountId,
				requestedFamilyId,
				prepared.prepared.command,
				prepared.prepared.raw,
				reqLog,
				defaultTimezone,
				defaultHarvestDelayMs,
				scope.role,
				true,
			);
			return withPrivateApiCache(
				await apiResponseFromRpc(rpcResponse, prepared.prepared.method),
			);
		}

		return Response.json({ error: "Not found" }, { status: 404 });
	},
} satisfies ExportedHandler<Env>;

async function dispatchDecodedCommand(
	request: Request,
	env: Env,
	adminStore: D1AdminStore,
	edgeCache: EdgeCache,
	accountId: string,
	requestedFamilyId: string,
	command: ClientCommand,
	raw: string,
	reqLog: Logger,
	defaultTimezone: string,
	defaultHarvestDelayMs: number,
	callerRole: CallerMeta["role"],
	ensureJsonContentType = false,
): Promise<Response> {
	const payloadFamilyId =
		command.payload &&
		typeof command.payload === "object" &&
		"familyId" in command.payload &&
		typeof (command.payload as { familyId?: unknown }).familyId === "string"
			? (command.payload as { familyId: string }).familyId || requestedFamilyId
			: requestedFamilyId;

	if (command.type === "family.create") {
		const created = await adminStore.createFamily(accountId, {
			familyId: command.payload.familyId,
			name: command.payload.name,
			timezone: command.payload.timezone ?? defaultTimezone,
			harvestDelayMs: command.payload.harvestDelayMs ?? defaultHarvestDelayMs,
		});
		reqLog.info("created bot family", {
			family: created.familyId,
			doName: created.doName,
			timezone: created.timezone,
		});
		const doId = env.CADMUS_BOT_FAMILY.idFromName(created.doName);
		const stub = env.CADMUS_BOT_FAMILY.get(doId);
		await stub.fetch("https://cadmus.internal/__internal/configure", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				accountId: created.accountId,
				familyId: created.familyId,
				name: created.name,
				timezone: created.timezone,
				harvestDelayMs: created.harvestDelayMs,
			}),
		});
		const frame: CommandResultFrame = {
			id: command.id,
			type: "command.result",
			command: command.type,
			ok: true,
			result: { family: created },
			payload: { family: created },
		};
		return new Response(defaultJsonShim.encodeFrame(frame), {
			status: 200,
			headers: { "Content-Type": defaultJsonShim.contentType },
		});
	}

	const family = await resolveOrEnsureFamily(
		edgeCache,
		adminStore,
		accountId,
		payloadFamilyId,
		defaultTimezone,
		defaultHarvestDelayMs,
	);
	if (!family) {
		reqLog.warn("rpc command rejected: family not found", {
			command: command.type,
			targetFamily: payloadFamilyId,
		});
		const errFrame: CommandResultFrame = {
			id: command.id,
			type: "command.result",
			command: command.type,
			ok: false,
			error: {
				code: "family_not_found",
				message: `Bot Family '${payloadFamilyId}' not found in account '${accountId}'`,
			},
		};
		return new Response(defaultJsonShim.encodeFrame(errFrame), {
			status: 404,
			headers: { "Content-Type": defaultJsonShim.contentType },
		});
	}

	return forwardToFamilyDO(
		env,
		family,
		callerRole,
		request,
		"/rpc",
		raw,
		"POST",
		ensureJsonContentType,
	);
}

async function resolveOrEnsureFamily(
	edgeCache: EdgeCache,
	adminStore: D1AdminStore,
	accountId: string,
	familyId: string,
	_defaultTimezone: string,
	defaultHarvestDelayMs: number,
) {
	const cached = await edgeCache.getFamily(accountId, familyId);
	if (cached) return cached;

	const existing = await adminStore.getFamily(accountId, familyId);
	if (existing) {
		await edgeCache.setFamily(accountId, familyId, existing);
		return existing;
	}
	if (familyId === "default" || familyId === "default-family") {
		const ensured = await adminStore.ensureFamily(accountId, familyId, {
			name: "Default Family",
			harvestDelayMs: defaultHarvestDelayMs,
		});
		await edgeCache.setFamily(accountId, familyId, ensured);
		return ensured;
	}
	return undefined;
}

async function forwardToFamilyDO(
	env: Env,
	family: {
		accountId: string;
		familyId: string;
		name: string;
		doName: string;
		timezone: string;
		harvestDelayMs: number;
	},
	callerRole: CallerMeta["role"],
	originalRequest: Request,
	pathname: string,
	bodyOverride?: string,
	methodOverride?: string,
	ensureJsonContentType = false,
): Promise<Response> {
	const doId = env.CADMUS_BOT_FAMILY.idFromName(family.doName);
	const stub = env.CADMUS_BOT_FAMILY.get(doId);

	const method = methodOverride ?? originalRequest.method;
	const headers = new Headers(originalRequest.headers);
	headers.set("X-Cadmus-Account-Id", family.accountId);
	headers.set("X-Cadmus-Family-Id", family.familyId);
	headers.set("X-Cadmus-Timezone", family.timezone);
	headers.set("X-Cadmus-Harvest-Delay-Ms", String(family.harvestDelayMs));
	// Drop any client-supplied role, then set the membership role authentication resolved.
	headers.delete(CALLER_ROLE_HEADER);
	if (callerRole) headers.set(CALLER_ROLE_HEADER, callerRole);
	if (ensureJsonContentType && !headers.has("content-type")) {
		headers.set("content-type", "application/json");
	}

	const targetUrl = new URL(originalRequest.url);
	targetUrl.pathname = pathname;

	const init: RequestInit = {
		method,
		headers,
		...(bodyOverride !== undefined
			? { body: bodyOverride }
			: method !== "GET" && method !== "HEAD"
				? { body: originalRequest.body }
				: {}),
	};

	return stub.fetch(new Request(targetUrl.toString(), init));
}
