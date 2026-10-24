import { getLogger } from "./log.js";
import {
	allowHeaderForCommand,
	apiPathFromCommandType,
	type ClientCommand,
	type CommandType,
	coerceSearchParamsToPayload,
	commandTypeFromApiPath,
	getCommandSchema,
	httpStatusForProtocolCode,
	isCommandReadOnly,
	ProtocolValidationError,
} from "./protocol.js";
import { defaultJsonShim } from "./shim.js";

/**
 * Translates `/api/*` HTTP requests into `ClientCommand` frames and translates
 * `CommandResultFrame` responses back into REST JSON.
 *
 * Authentication is intentionally not handled here. The edge worker runs
 * `authenticateRequest` before this adapter, so `/api/*` and `/rpc` share one
 * auth path and the same 401 `protocol.error` body.
 */

export type PreparedApiCommand = {
	command: ClientCommand;
	/** JSON command frame forwarded through the `/rpc` pipeline. */
	raw: string;
	method: "GET" | "HEAD" | "POST";
};

const ENVELOPE_KEYS = new Set(["id", "type", "payload"]);

export async function prepareApiCommand(
	request: Request,
): Promise<
	{ ok: true; prepared: PreparedApiCommand } | { ok: false; response: Response }
> {
	const url = new URL(request.url);
	const method = request.method.toUpperCase();
	const commandType = commandTypeFromApiPath(url.pathname);
	if (!commandType || !getCommandSchema(commandType)) {
		getLogger().debug("api path did not match a command", {
			method,
			path: url.pathname,
		});
		return {
			ok: false,
			response: apiError(
				404,
				"not_found",
				`Unknown API command path '${url.pathname}'`,
				method,
			),
		};
	}

	const type = commandType as CommandType;
	const allow = allowHeaderForCommand(type);
	const readOnly = isCommandReadOnly(type);
	if (!methodAllowed(method, readOnly)) {
		getLogger().debug("api method not allowed", { method, command: type });
		return {
			ok: false,
			response: apiError(
				405,
				"method_not_allowed",
				`${method} is not allowed for ${apiPathFromCommandType(type)}. Use ${allow}.`,
				method,
				{ Allow: allow },
			),
		};
	}

	const httpMethod = method as PreparedApiCommand["method"];
	let id: string | undefined;
	let payload: unknown;
	try {
		if (readOnly) {
			payload = coerceSearchParamsToPayload(type, url.searchParams);
		} else {
			const body = parseMutatingBody(await request.text(), type);
			id = body.id;
			payload = body.payload;
		}
	} catch (error) {
		return { ok: false, response: validationResponse(error, httpMethod) };
	}

	const commandId =
		id && id.trim().length > 0 ? id : `api-${crypto.randomUUID().slice(0, 8)}`;
	const raw = JSON.stringify({
		id: commandId,
		type,
		...(payload !== undefined ? { payload } : {}),
	});

	let command: ClientCommand;
	try {
		command = defaultJsonShim.decodeCommand(raw);
	} catch (error) {
		return { ok: false, response: validationResponse(error, httpMethod) };
	}

	return { ok: true, prepared: { command, raw, method: httpMethod } };
}

/**
 * Unwrap a `/rpc` response into a REST body.
 *
 * Success (`ok: true`) returns the `result` value with HTTP 200.
 * Failure returns `{ error: { code, message } }` and the status from
 * `httpStatusForProtocolCode`. `HEAD` keeps the status and headers and omits
 * the body.
 */
export async function apiResponseFromRpc(
	rpcResponse: Response,
	method: string,
): Promise<Response> {
	const text = await rpcResponse.text();
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return apiError(
			500,
			"command_failed",
			"Upstream command response was not JSON",
			method,
		);
	}
	if (!isRecord(parsed) || typeof parsed.type !== "string") {
		return apiError(
			500,
			"command_failed",
			"Upstream command response was not a protocol frame",
			method,
		);
	}

	if (parsed.type === "protocol.error") {
		const payload = isRecord(parsed.payload) ? parsed.payload : {};
		const code =
			typeof payload.code === "string" ? payload.code : "invalid_command";
		const message =
			typeof payload.message === "string" ? payload.message : "Command failed";
		return apiError(httpStatusForProtocolCode(code), code, message, method);
	}

	if (parsed.type !== "command.result") {
		return apiError(
			500,
			"command_failed",
			`Unexpected upstream frame '${parsed.type}'`,
			method,
		);
	}

	if (parsed.ok === true) {
		const result =
			"result" in parsed ? parsed.result : (parsed.payload ?? null);
		return apiJson(200, result, method);
	}

	const error = isRecord(parsed.error) ? parsed.error : {};
	const code = typeof error.code === "string" ? error.code : "command_failed";
	const message =
		typeof error.message === "string" ? error.message : "Command failed";
	return apiError(httpStatusForProtocolCode(code), code, message, method);
}

function methodAllowed(method: string, readOnly: boolean): boolean {
	if (readOnly) return method === "GET" || method === "HEAD";
	return method === "POST";
}

/**
 * POST body is the payload object, or an envelope `{ payload, id?, type? }`
 * whose only keys are `payload`, `id`, and `type`.
 */
function parseMutatingBody(
	raw: string,
	commandType: string,
): { id?: string; payload: unknown } {
	if (raw.trim().length === 0) return { payload: {} };
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new ProtocolValidationError(
			"Malformed JSON in request body",
			"invalid_json",
		);
	}
	if (!isRecord(parsed)) {
		throw new ProtocolValidationError(
			"POST body must be a JSON object",
			"invalid_command",
		);
	}
	const keys = Object.keys(parsed);
	if ("payload" in parsed && keys.every((key) => ENVELOPE_KEYS.has(key))) {
		if (typeof parsed.type === "string" && parsed.type !== commandType) {
			throw new ProtocolValidationError(
				`Body type '${parsed.type}' does not match '${commandType}'`,
				"invalid_command",
			);
		}
		if (parsed.id !== undefined && typeof parsed.id !== "string") {
			throw new ProtocolValidationError(
				"Envelope 'id' must be a string",
				"invalid_command",
			);
		}
		return {
			...(typeof parsed.id === "string" ? { id: parsed.id } : {}),
			payload: parsed.payload,
		};
	}
	return { payload: parsed };
}

function validationResponse(error: unknown, method: string): Response {
	const code =
		error instanceof ProtocolValidationError ? error.code : "invalid_command";
	const message = error instanceof Error ? error.message : "Invalid request";
	getLogger().debug("api request failed validation", { code, message });
	return apiError(httpStatusForProtocolCode(code), code, message, method);
}

function apiError(
	status: number,
	code: string,
	message: string,
	method: string,
	extraHeaders?: HeadersInit,
): Response {
	return apiJson(status, { error: { code, message } }, method, extraHeaders);
}

function apiJson(
	status: number,
	body: unknown,
	method: string,
	extraHeaders?: HeadersInit,
): Response {
	const headers = new Headers(extraHeaders);
	headers.set("content-type", "application/json");
	if (method === "HEAD") {
		return new Response(null, { status, headers });
	}
	return Response.json(body, { status, headers });
}

const PRIVATE_API_VARY = ["Authorization", "Cookie", "X-Cadmus-Family-Id"];

export function isApiPath(pathname: string): boolean {
	return pathname === "/api" || pathname.startsWith("/api/");
}

/**
 * `/api/*` bodies are per-tenant. Cookie and `?token=` auth send no
 * `Authorization` header, so a shared cache must not store the response.
 * Existing `Vary` tokens are kept and the three auth inputs are added.
 */
export function withPrivateApiCache(response: Response): Response {
	const headers = new Headers(response.headers);
	headers.set("Cache-Control", "private, no-store");
	headers.set("Vary", mergeVary(headers.get("Vary")));
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

function mergeVary(existing: string | null): string {
	const seen = new Set<string>();
	const tokens: string[] = [];
	const push = (token: string) => {
		const key = token.toLowerCase();
		if (seen.has(key)) return;
		seen.add(key);
		tokens.push(token);
	};
	for (const token of PRIVATE_API_VARY) push(token);
	if (existing) {
		for (const part of existing.split(",")) {
			const token = part.trim();
			if (token.length > 0) push(token);
		}
	}
	return tokens.join(", ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
