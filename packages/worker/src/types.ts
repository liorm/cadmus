import type { CadmusBotFamilyDO } from "./family-do.js";
import type { CadmusEnvDO } from "./tools-env/env-do.js";

export interface Env {
	CADMUS_BOT_FAMILY: DurableObjectNamespace<CadmusBotFamilyDO>;
	CADMUS_ENV: DurableObjectNamespace<CadmusEnvDO>;
	CADMUS_ADMIN_DB: D1Database;
	CADMUS_CACHE_KV?: KVNamespace;
	CADMUS_AUTH_SECRET?: string;
	CADMUS_PUBLIC_URL?: string;
	CADMUS_ENCRYPTION_KEY?: string;
	CADMUS_DEFAULT_TIMEZONE?: string;
	CADMUS_HARVEST_DELAY_MS?: string;
	/** Per-reply group-chat watchdog. Unset means 120000. */
	CADMUS_GROUP_REPLY_MS?: string;
	/** Overall group-chat watchdog. Unset means 600000. */
	CADMUS_GROUP_OVERALL_MS?: string;
	/**
	 * Daemon heartbeat interval in milliseconds. Unset means 30000.
	 * See `resolveHeartbeatMs`.
	 */
	CADMUS_HEARTBEAT_MS?: string;
	CADMUS_LOG_LEVEL?: string;
	LOG_LEVEL?: string;
	IS_PREVIEW?: string;
}
