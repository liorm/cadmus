import {
	apiResponseFromRpc,
	isApiPath,
	prepareApiCommand,
	withPrivateApiCache,
} from "./api-adapter.js";
import { authenticateRequest, type ResolvedRequestScope } from "./auth.js";
import { CadmusAuthLimiterDO, limitByIp } from "./auth-limiter.js";
import { handleAuthRoute, isAuthRoute } from "./auth-routes.js";
import {
	authorize,
	encodePrincipal,
	isClientIdentityHeader,
	PRINCIPAL_HEADER,
	type Principal,
} from "./authz.js";
import { type EdgeCache, getEdgeCache } from "./edge-cache.js";
import { withElevatedAudit } from "./elevated-audit.js";
import { CadmusBotFamilyDO } from "./family-do.js";
import { ensureLogger, getLogger, type Logger } from "./log.js";
import { httpStatusForProtocolCode } from "./protocol/rest.js";
import {
	type ClientCommand,
	type CommandResultFrame,
	PROTOCOL_JSON_SCHEMA,
	ProtocolValidationError,
	type ServerEvent,
} from "./protocol.js";
import { defaultJsonShim } from "./shim.js";
import { D1AdminStore, resetD1InitializationCache } from "./store/d1-admin.js";
import { handleToolsEnvPair } from "./tools-env/edge-pair.js";
import { handleToolsEnvWebsocket } from "./tools-env/edge-ws.js";
import { CadmusEnvDO } from "./tools-env/env-do.js";
import type { Env } from "./types.js";
import { handleWebRoute } from "./web-routes.js";

export { CadmusAuthLimiterDO, CadmusBotFamilyDO, CadmusEnvDO };

export function resetEdgeD1InitCache(): void {
	resetD1InitializationCache();
}

/** Top-level browser navigations: a refused budget redirects back to the app. */
const NAVIGATION_AUTH_PATHS = new Set([
	"/api/auth/login/google/start",
	"/api/auth/login/google/callback",
]);

/** Credential routes with a per-IP budget. providers and logout carry no secret to guess. */
export const IP_LIMITED_AUTH_PATHS = new Set([
	"/api/auth/session/refresh",
	"/api/auth/login/devPassword",
	"/api/auth/login/google/start",
	"/api/auth/login/google/callback",
	"/api/auth/login/device/start",
	"/api/auth/login/device/poll",
	"/api/auth/login/device/approve",
	"/api/auth/login/device/deny",
]);

/**
 * Strict same-origin: a browser sends `Origin` on every cross-origin write and
 * on every WebSocket handshake. No route here allows another origin, and no
 * CORS allow headers exist, so a request that names a different origin is
 * refused before it reaches auth or a handler. Safe methods (the OAuth
 * callback is a top-level GET navigation) and non-browser clients (no Origin
 * header) are untouched.
 */
export function refuseCrossOrigin(request: Request, url: URL): Response | null {
	const origin = request.headers.get("origin");
	if (origin === null || origin === url.origin) return null;
	const upgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket";
	const safe = request.method === "GET" || request.method === "HEAD";
	if (safe && !upgrade) return null;
	return Response.json(
		{ error: { code: "forbidden", message: "Cross-origin request refused" } },
		{ status: 403, headers: { "cache-control": "no-store" } },
	);
}

/**
 * Production is served on the custom domain. A `*.workers.dev` host is not a
 * second entry, even if the route is turned back on. Preview version URLs are
 * also `*.workers.dev` (`IS_PREVIEW`), and local tests are not production.
 */
export function refuseWorkersDev(
	url: URL,
	env: { CADMUS_DEPLOY_ENV?: string; IS_PREVIEW?: string },
): Response | null {
	if (env.IS_PREVIEW === "true") return null;
	if (env.CADMUS_DEPLOY_ENV !== "production") return null;
	const host = url.hostname.toLowerCase();
	if (host !== "workers.dev" && !host.endsWith(".workers.dev")) return null;
	return new Response(null, {
		status: 404,
		headers: { "cache-control": "no-store" },
	});
}

const routes = {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		ensureLogger(env.CADMUS_LOG_LEVEL ?? env.LOG_LEVEL);
		const log = getLogger();
		const url = new URL(request.url);
		const workersDev = refuseWorkersDev(url, env);
		if (workersDev) return workersDev;

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

		const crossOrigin = refuseCrossOrigin(request, url);
		if (crossOrigin) return crossOrigin;

		const webResponse = await handleWebRoute(request, url, env);
		if (webResponse) return webResponse;

		const defaultTimezone = env.CADMUS_DEFAULT_TIMEZONE ?? "UTC";
		const defaultHarvestDelayMs = Number(env.CADMUS_HARVEST_DELAY_MS ?? 60_000);
		const edgeCache = getEdgeCache(env);

		const adminStore = new D1AdminStore({
			db: env.CADMUS_ADMIN_DB,
			encryptionKey: env.CADMUS_ENCRYPTION_KEY,
			defaultTimezone,
			defaultHarvestDelayMs,
			edgeCache,
			bootstrapEmail: env.CADMUS_BOOTSTRAP_SUPER_ADMIN_EMAIL,
			deployEnv: env.CADMUS_DEPLOY_ENV,
		});
		await adminStore.initialize();

		if (isAuthRoute(url.pathname)) {
			if (IP_LIMITED_AUTH_PATHS.has(url.pathname)) {
				const limited = await limitByIp(
					env,
					request,
					url.pathname,
					NAVIGATION_AUTH_PATHS.has(url.pathname) ? "navigation" : "api",
				);
				if (limited) return limited;
			}
			return handleAuthRoute(request, env, adminStore);
		}

		if (url.pathname === "/tools-env/ws") {
			return handleToolsEnvWebsocket(request, env, adminStore, url);
		}

		if (url.pathname === "/tools-env/pair") {
			return handleToolsEnvPair(request, env, adminStore, url, ctx);
		}

		const apiRequest = isApiPath(url.pathname);
		// Every credential is Authorization: Bearer. /api, /rpc, /ws and /events
		// refuse the cookie and ?token=. Streams open with a ticket from
		// auth.ticket. /api rejects those forms up front.
		const auth = await authenticateRequest(
			request,
			env,
			adminStore,
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
				{ status: 401, headers: { "cache-control": "no-store" } },
			);
			// An authentication refusal is an auth response (issue #3: no-store on
			// auth responses), so /rpc, /ws and /events refusals carry it too; their
			// success responses are not auth responses and are left as they were.
			// /api/* gets the stricter private,no-store from withPrivateApiCache.
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
			return forwardToFamilyDO(
				env,
				family,
				principalFromScope(scope),
				request,
				"/ws",
			);
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
			return forwardToFamilyDO(
				env,
				family,
				principalFromScope(scope),
				request,
				"/events",
			);
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
				principalFromScope(scope),
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
				principalFromScope(scope),
				true,
			);
			return withPrivateApiCache(
				await apiResponseFromRpc(rpcResponse, prepared.prepared.method),
			);
		}

		return Response.json({ error: "Not found" }, { status: 404 });
	},
} satisfies ExportedHandler<Env>;

const SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
	["X-Content-Type-Options", "nosniff"],
	["Referrer-Policy", "no-referrer"],
	["X-Frame-Options", "DENY"],
];

/**
 * Headers the static-assets `_headers` file cannot reach: it applies to asset
 * responses only, not to Worker-generated ones. Sets each header only when the
 * handler did not set it. An upgrade response keeps its socket because the
 * response is passed as init, which carries webSocket (the real handshake test
 * covers this).
 */
export function withSecurityHeaders(response: Response): Response {
	// Passing the response as init keeps status, statusText, every header
	// (repeated Set-Cookie included) and the non-standard fields (cf, encodeBody)
	// while the body stream passes through unread.
	const out = new Response(response.body, response);
	for (const [name, value] of SECURITY_HEADERS) {
		if (!out.headers.has(name)) out.headers.set(name, value);
	}
	return out;
}

export default {
	async fetch(
		request: Request,
		env: Env,
		ctx: ExecutionContext,
	): Promise<Response> {
		return withSecurityHeaders(await routes.fetch(request, env, ctx));
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
	principal: Principal,
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
		let grant: ReturnType<typeof authorize>;
		try {
			grant = authorize(principal, command.type);
		} catch (error) {
			if (!(error instanceof ProtocolValidationError)) throw error;
			const denied: CommandResultFrame = {
				id: command.id,
				type: "command.result",
				command: command.type,
				ok: false,
				error: { code: error.code, message: error.message },
			};
			return new Response(defaultJsonShim.encodeFrame(denied), {
				status: httpStatusForProtocolCode(error.code),
				headers: { "Content-Type": defaultJsonShim.contentType },
			});
		}
		const created = await withElevatedAudit({
			adminStore,
			caller: principal,
			grant,
			commandType: command.type,
			familyId: command.payload.familyId,
			warn: (message, fields) => reqLog.warn(message, fields),
			run: async () => {
				const family = await adminStore.createFamily(accountId, {
					familyId: command.payload.familyId,
					name: command.payload.name,
					timezone: command.payload.timezone ?? defaultTimezone,
					harvestDelayMs:
						command.payload.harvestDelayMs ?? defaultHarvestDelayMs,
				});
				reqLog.info("created bot family", {
					family: family.familyId,
					doName: family.doName,
					timezone: family.timezone,
				});
				const doId = env.CADMUS_BOT_FAMILY.idFromName(family.doName);
				const stub = env.CADMUS_BOT_FAMILY.get(doId);
				await stub.fetch("https://cadmus.internal/__internal/configure", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						accountId: family.accountId,
						familyId: family.familyId,
						name: family.name,
						timezone: family.timezone,
						harvestDelayMs: family.harvestDelayMs,
					}),
				});
				return family;
			},
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
		principal,
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
	principal: Principal,
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
	for (const name of [...headers.keys()]) {
		if (isClientIdentityHeader(name)) headers.delete(name);
	}
	headers.set(PRINCIPAL_HEADER, encodePrincipal(principal));
	headers.set("X-Cadmus-Account-Id", family.accountId);
	headers.set("X-Cadmus-Family-Id", family.familyId);
	headers.set("X-Cadmus-Timezone", family.timezone);
	headers.set("X-Cadmus-Harvest-Delay-Ms", String(family.harvestDelayMs));
	const originHeader = originalRequest.headers.get("origin");
	if (originHeader) {
		headers.set("X-Cadmus-Origin", originHeader);
	} else {
		try {
			headers.set("X-Cadmus-Origin", new URL(originalRequest.url).origin);
		} catch {
			// ignore
		}
	}
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

function principalFromScope(scope: ResolvedRequestScope): Principal {
	return {
		kind: "user",
		userId: scope.userId,
		accountId: scope.accountId,
		role: scope.role,
		...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
		...(scope.elevatedUntil ? { elevatedUntil: scope.elevatedUntil } : {}),
		...(scope.provisional ? { provisional: true } : {}),
	};
}
