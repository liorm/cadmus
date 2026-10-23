import type { CadmusBotFamilyDO } from "../src/family-do.js";
import type { CadmusEnvDO } from "../src/tools-env/env-do.js";

declare global {
	namespace Cloudflare {
		interface Env {
			CADMUS_BOT_FAMILY: DurableObjectNamespace<CadmusBotFamilyDO>;
			CADMUS_ENV: DurableObjectNamespace<CadmusEnvDO>;
			CADMUS_ADMIN_DB: D1Database;
			CADMUS_AUTH_SECRET?: string;
			CADMUS_ENCRYPTION_KEY?: string;
			CADMUS_DEFAULT_TIMEZONE?: string;
			CADMUS_HARVEST_DELAY_MS?: string;
		}
	}
}
