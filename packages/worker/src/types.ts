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
	/** Per-turn deadline in ms. Unset uses kind defaults. 0 means no limit. */
	CADMUS_TURN_MS?: string;
	/** Autonomous run deadline in ms. Unset uses kind defaults. 0 means no limit. */
	CADMUS_RUN_MS?: string;
	/** Auto-continue round cap. Unset means 20. */
	CADMUS_TASK_MAX_ROUNDS?: string;
	/**
	 * Daemon heartbeat interval in milliseconds. Unset means 30000.
	 * See `resolveHeartbeatMs`.
	 */
	CADMUS_HEARTBEAT_MS?: string;
	CADMUS_LOG_LEVEL?: string;
	LOG_LEVEL?: string;
	IS_PREVIEW?: string;
}
