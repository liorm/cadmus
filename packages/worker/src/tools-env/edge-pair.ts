import { getLogger } from "../log.js";
import type { D1AdminStore } from "../store/d1-admin.js";
import type { Env } from "../types.js";
import { decodePairingToken, envDoName } from "./pure.js";

/**
 * Handle daemon registration via POST /tools-env/pair.
 * Routes directly to CadmusEnvDO based on accountId and envId in the token.
 */
export async function handleToolsEnvPair(
	request: Request,
	env: Env,
	_adminStore: D1AdminStore,
	_url: URL,
	_ctx: ExecutionContext,
): Promise<Response> {
	if (request.method !== "POST") {
		return Response.json(
			{ error: { code: "method_not_allowed", message: "Method not allowed" } },
			{ status: 405 },
		);
	}
	let body: { pairingToken?: unknown; name?: unknown };
	try {
		body = (await request.json()) as { pairingToken?: unknown; name?: unknown };
	} catch {
		return Response.json(
			{ error: { code: "invalid_body", message: "Malformed JSON body" } },
			{ status: 400 },
		);
	}
	const pairingToken =
		typeof body.pairingToken === "string" ? body.pairingToken.trim() : "";
	if (!pairingToken) {
		return Response.json(
			{ error: { code: "missing_token", message: "Missing pairingToken" } },
			{ status: 400 },
		);
	}
	let payload: ReturnType<typeof decodePairingToken>;
	try {
		payload = decodePairingToken(pairingToken);
	} catch (err) {
		return Response.json(
			{
				error: {
					code: "invalid_pairing_token",
					message: err instanceof Error ? err.message : "Invalid pairing token",
				},
			},
			{ status: 400 },
		);
	}
	if (Date.now() >= payload.exp) {
		return Response.json(
			{
				error: {
					code: "pairing_expired",
					message: "Pairing token has expired",
				},
			},
			{ status: 400 },
		);
	}
	const name =
		typeof body.name === "string" && body.name.trim()
			? body.name.trim()
			: undefined;
	const doName = envDoName(payload.accountId, payload.envId);
	const stub = env.CADMUS_ENV.getByName(doName);
	try {
		const result = await stub.redeemPairing({
			nonce: payload.nonce,
			secret: payload.secret,
			name,
		});
		if (!result.ok) {
			getLogger().warn("daemon pairing failed", {
				accountId: payload.accountId,
				envId: payload.envId,
				error: result.error.message,
			});
			return Response.json(result, { status: 400 });
		}
		getLogger().info("daemon paired successfully", {
			accountId: payload.accountId,
			envId: payload.envId,
			name: result.name,
		});
		return Response.json(result);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		getLogger().warn("daemon pairing failed", {
			accountId: payload.accountId,
			envId: payload.envId,
			error: message,
		});
		return Response.json(
			{ error: { code: "pairing_failed", message } },
			{ status: 400 },
		);
	}
}
