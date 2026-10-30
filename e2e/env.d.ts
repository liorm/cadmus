import type { CadmusBotFamilyDO } from "../packages/worker/src/family-do.js";
import type { CadmusEnvDO } from "../packages/worker/src/tools-env/env-do.js";

declare module "vitest" {
	interface ProvidedContext {
		daemonBridgeHost: string;
		daemonBridgePort: number;
		daemonBridgeEventPort: number;
		cliBridgePort: number;
	}
}

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
			CADMUS_GROUP_REPLY_MS?: string;
			CADMUS_GROUP_OVERALL_MS?: string;
			CADMUS_HEARTBEAT_MS?: string;
			CADMUS_DAEMON_BRIDGE_HOST?: string;
			CADMUS_DAEMON_BRIDGE_PORT?: string;
			CADMUS_DAEMON_BRIDGE_EVENT_PORT?: string;
			CADMUS_CLI_BRIDGE_PORT?: string;
		}
	}
}
