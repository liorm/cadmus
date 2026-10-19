import { authenticateRequest } from "./auth.js";
import { CadmusBotFamilyDO } from "./family-do.js";
import { ensureLogger, getLogger } from "./log.js";
import {
	type ClientCommand,
	type CommandResultFrame,
	PROTOCOL_JSON_SCHEMA,
	ProtocolValidationError,
	type ServerEvent,
} from "./protocol.js";
import { defaultJsonShim } from "./shim.js";
import { D1AdminStore } from "./store/d1-admin.js";
import type { Env } from "./types.js";

export { CadmusBotFamilyDO };

export default {
	async fetch(
		request: Request,
		env: Env,
		_ctx: ExecutionContext,
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

		const adminStore = new D1AdminStore({
			db: env.CADMUS_ADMIN_DB,
			encryptionKey: env.CADMUS_ENCRYPTION_KEY,
			defaultTimezone,
			defaultHarvestDelayMs,
		});
		await adminStore.initialize();

		const scope = await authenticateRequest(request, env, adminStore);
		if (!scope) {
			log.warn("edge request unauthorized", {
				method: request.method,
				path: url.pathname,
			});
			return Response.json(
				{
					type: "protocol.error",
					payload: {
						code: "unauthorized",
						message: "Missing or invalid authentication token",
					},
				} satisfies ServerEvent,
				{ status: 401 },
			);
		}

		const { accountId, familyId: requestedFamilyId } = scope;
		const reqLog = log.child({
			account: accountId,
			family: requestedFamilyId,
		});

		if (
			url.pathname === "/ws" ||
			request.headers.get("Upgrade") === "websocket"
		) {
			const family = await resolveOrEnsureFamily(
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
			return forwardToFamilyDO(env, family, request, "/ws");
		}

		if (url.pathname === "/events" && request.method === "GET") {
			const family = await resolveOrEnsureFamily(
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
			return forwardToFamilyDO(env, family, request, "/events");
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

			const payloadFamilyId =
				command.payload &&
				typeof command.payload === "object" &&
				"familyId" in command.payload &&
				typeof (command.payload as { familyId?: unknown }).familyId === "string"
					? (command.payload as { familyId: string }).familyId ||
						requestedFamilyId
					: requestedFamilyId;

			if (command.type === "family.create") {
				const created = await adminStore.createFamily(accountId, {
					familyId: command.payload.familyId,
					name: command.payload.name,
					timezone: command.payload.timezone ?? defaultTimezone,
					harvestDelayMs:
						command.payload.harvestDelayMs ?? defaultHarvestDelayMs,
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

			return forwardToFamilyDO(env, family, request, "/rpc", raw);
		}

		return Response.json({ error: "Not found" }, { status: 404 });
	},
} satisfies ExportedHandler<Env>;

async function resolveOrEnsureFamily(
	adminStore: D1AdminStore,
	accountId: string,
	familyId: string,
	_defaultTimezone: string,
	defaultHarvestDelayMs: number,
) {
	const existing = await adminStore.getFamily(accountId, familyId);
	if (existing) return existing;
	if (familyId === "default" || familyId === "default-family") {
		return adminStore.ensureFamily(accountId, familyId, {
			name: "Default Family",
			harvestDelayMs: defaultHarvestDelayMs,
		});
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
	originalRequest: Request,
	pathname: string,
	bodyOverride?: string,
): Promise<Response> {
	const doId = env.CADMUS_BOT_FAMILY.idFromName(family.doName);
	const stub = env.CADMUS_BOT_FAMILY.get(doId);

	const headers = new Headers(originalRequest.headers);
	headers.set("X-Cadmus-Account-Id", family.accountId);
	headers.set("X-Cadmus-Family-Id", family.familyId);
	headers.set("X-Cadmus-Timezone", family.timezone);
	headers.set("X-Cadmus-Harvest-Delay-Ms", String(family.harvestDelayMs));

	const targetUrl = new URL(originalRequest.url);
	targetUrl.pathname = pathname;

	const init: RequestInit = {
		method: originalRequest.method,
		headers,
		...(bodyOverride !== undefined
			? { body: bodyOverride }
			: originalRequest.method !== "GET" && originalRequest.method !== "HEAD"
				? { body: originalRequest.body }
				: {}),
	};

	return stub.fetch(new Request(targetUrl.toString(), init));
}
