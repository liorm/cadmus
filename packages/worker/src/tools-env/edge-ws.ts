import { getLogger } from "../log.js";
import type { D1AdminStore } from "../store/d1-admin.js";
import { sha256Hex } from "../store/d1-admin.js";
import type { Env } from "../types.js";
import { envDoName } from "./pure.js";
import { isDaemonBearerToken } from "./wire.js";

/**
 * Daemon upgrade. Runs before authenticateRequest so a user token cannot
 * land on the family /ws handler. 409 is decided by CadmusEnvDO so the
 * connection row can record confinement_unavailable.
 */
export async function handleToolsEnvWebsocket(
	request: Request,
	env: Env,
	adminStore: D1AdminStore,
	url: URL,
): Promise<Response> {
	if (
		request.method !== "GET" ||
		request.headers.get("Upgrade")?.toLowerCase() !== "websocket"
	) {
		return new Response("upgrade required", {
			status: 426,
			headers: { Upgrade: "websocket" },
		});
	}
	const header = request.headers.get("Authorization") ?? "";
	const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
	const token = match?.[1] ?? "";
	if (!isDaemonBearerToken(token)) {
		getLogger().warn("tools env websocket rejected", {
			path: url.pathname,
			reason: "bearer_shape",
		});
		return Response.json({ error: "unauthorized" }, { status: 401 });
	}
	const tokenHash = await sha256Hex(token);
	const resolved = await adminStore.resolveToolsEnvDaemonToken(tokenHash);
	if (!resolved) {
		getLogger().warn("tools env websocket rejected", {
			path: url.pathname,
			reason: "unknown_token",
		});
		return Response.json({ error: "unauthorized" }, { status: 401 });
	}
	const envId = url.searchParams.get("envId")?.trim() ?? "";
	const definition = envId
		? await adminStore.getToolsEnv(resolved.accountId, envId)
		: undefined;
	if (definition?.kind !== "local-daemon") {
		return new Response("unknown env", { status: 404 });
	}
	if (definition.envId !== resolved.envId) {
		return new Response("token mismatch", { status: 403 });
	}
	const headers = new Headers();
	for (const [key, value] of request.headers) {
		if (key.toLowerCase().startsWith("x-cadmus-")) continue;
		headers.set(key, value);
	}
	headers.set("X-Cadmus-Account-Id", resolved.accountId);
	headers.set("X-Cadmus-Daemon-Token-Hash", tokenHash);
	const capabilities = request.headers.get("X-Cadmus-Env-Capabilities") ?? "";
	if (capabilities.split(",").some((part) => part.trim() === "confinement")) {
		headers.set("X-Cadmus-Env-Capabilities", "confinement");
	}
	const forward = new URL(request.url);
	forward.pathname = "/tools-env/ws";
	forward.search = `?envId=${encodeURIComponent(envId)}`;
	getLogger()
		.child({ envId, account: resolved.accountId })
		.debug("forwarding tools env websocket", {
			doName: envDoName(resolved.accountId, envId),
		});
	return env.CADMUS_ENV.getByName(envDoName(resolved.accountId, envId)).fetch(
		new Request(forward.toString(), { method: "GET", headers }),
	);
}
