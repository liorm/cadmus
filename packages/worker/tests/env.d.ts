import type { CadmusAuthLimiterDO } from "../src/auth-limiter.js";
import type { CadmusBotFamilyDO } from "../src/family-do.js";
import type { CadmusEnvDO } from "../src/tools-env/env-do.js";

declare module "vitest" {
	interface ProvidedContext {
		daemonBridgeHost: string;
		daemonBridgePort: number;
		daemonBridgeEventPort: number;
		cliBridgePort: number;
	}
}

declare global {
	// Vite's `import.meta.glob`, as the tests call it (query ?raw, eager). The
	// root `bun check` project has no Vite client types.
	interface ImportMeta {
		glob(
			pattern: string,
			options: { query: string; import: string; eager: true },
		): Record<string, string>;
	}
	namespace Cloudflare {
		interface Env {
			CADMUS_BOT_FAMILY: DurableObjectNamespace<CadmusBotFamilyDO>;
			CADMUS_ENV: DurableObjectNamespace<CadmusEnvDO>;
			CADMUS_AUTH_LIMITER: DurableObjectNamespace<CadmusAuthLimiterDO>;
			CADMUS_AUTH_RATELIMIT: RateLimit;
			CADMUS_AUTH_REFRESH_RATELIMIT: RateLimit;
			CADMUS_AUTH_RPC_RATELIMIT: RateLimit;
			CADMUS_ADMIN_DB: D1Database;
			CADMUS_AUTH_SECRET?: string;
			CADMUS_ENCRYPTION_KEY?: string;
			CADMUS_DEFAULT_TIMEZONE?: string;
			CADMUS_HARVEST_DELAY_MS?: string;
			CADMUS_TURN_MS?: string;
			CADMUS_RUN_MS?: string;
			CADMUS_TASK_MAX_ROUNDS?: string;
			CADMUS_HEARTBEAT_MS?: string;
			CADMUS_DAEMON_BRIDGE_HOST?: string;
			CADMUS_DAEMON_BRIDGE_PORT?: string;
			CADMUS_DAEMON_BRIDGE_EVENT_PORT?: string;
			CADMUS_CLI_BRIDGE_PORT?: string;
		}
	}
}
