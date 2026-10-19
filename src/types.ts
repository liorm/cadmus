import type { CadmusBotFamilyDO } from "./family-do.js";

export interface Env {
	CADMUS_BOT_FAMILY: DurableObjectNamespace<CadmusBotFamilyDO>;
	CADMUS_ADMIN_DB: D1Database;
	CADMUS_AUTH_SECRET?: string;
	CADMUS_ENCRYPTION_KEY?: string;
	CADMUS_DEFAULT_TIMEZONE?: string;
	CADMUS_HARVEST_DELAY_MS?: string;
	CADMUS_LOG_LEVEL?: string;
	LOG_LEVEL?: string;
}
