import type { CadmusAuthLimiterDO } from "./auth-limiter.js";
import type { CadmusBotFamilyDO } from "./family-do.js";
import type { CadmusEnvDO } from "./tools-env/env-do.js";

export interface Env {
	ASSETS?: Fetcher;
	CADMUS_BOT_FAMILY: DurableObjectNamespace<CadmusBotFamilyDO>;
	CADMUS_ENV: DurableObjectNamespace<CadmusEnvDO>;
	CADMUS_AUTH_LIMITER: DurableObjectNamespace<CadmusAuthLimiterDO>;
	/** Per-IP budget on the credential routes (wrangler.jsonc `ratelimits`). */
	CADMUS_AUTH_RATELIMIT: RateLimit;
	CADMUS_AUTH_REFRESH_RATELIMIT: RateLimit;
	/** Per-principal budget on auth.ticket and the passkey commands. */
	CADMUS_AUTH_RPC_RATELIMIT: RateLimit;
	CADMUS_ADMIN_DB: D1Database;
	CADMUS_CACHE_KV?: KVNamespace;
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
	/**
	 * Test-only auth rate-limit window in milliseconds (ignored in production).
	 * Unset uses the Cloudflare RateLimit bindings with a 60s window.
	 */
	CADMUS_AUTH_RATE_LIMIT_WINDOW_MS?: string;
	/**
	 * Test-only boot refresh retry delay cap in milliseconds (ignored in production).
	 * Unset uses the web-app default (10000ms max, 1000ms floor).
	 */
	CADMUS_BOOT_REFRESH_RETRY_MS?: string;
	/**
	 * Test-only boot refresh retry count (ignored in production).
	 * Unset uses the web-app default (3 retries).
	 */
	CADMUS_BOOT_REFRESH_RETRIES?: string;
	CADMUS_LOG_LEVEL?: string;
	LOG_LEVEL?: string;
	IS_PREVIEW?: string;
	/** Google sign-in client. Unset keeps Google sign-in hidden and failing closed. */
	GOOGLE_CLIENT_ID?: string;
	GOOGLE_CLIENT_SECRET?: string;
	/** Email of the first super-admin, who claims the role on first Google sign-in. */
	CADMUS_BOOTSTRAP_SUPER_ADMIN_EMAIL?: string;
	/** Local-only password login. Never set in wrangler.jsonc. See auth/dev-password.ts. */
	CADMUS_DEV_PASSWORD_LOGIN?: string;
	CADMUS_DEV_PASSWORD_HASH?: string;
	/** "production" in the top-level wrangler vars; hard-refuses dev password login. */
	CADMUS_DEPLOY_ENV?: string;
}
