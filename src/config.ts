import { resolve } from "node:path";
import { type ModelConfig, modelConfigFromEnv } from "./harness/models.ts";

export type TelegramConfig = {
	/** Absent only in tests that inject their own transport. */
	readonly token?: string;
	/** Bot API root, e.g. a local Bot API server; default https://api.telegram.org. */
	readonly apiRoot?: string;
	/** Numeric Telegram user IDs allowed to talk to the bot. Empty means nobody. */
	readonly allowedUsers: ReadonlySet<number>;
	readonly pollTimeoutSec: number;
};

export type Config = {
	/** Directory holding durable.sqlite, owner.lock, SOUL.md, AGENTS.md and workspace/. */
	readonly home: string;
	readonly telegram: TelegramConfig;
	readonly model: ModelConfig;
	readonly timeZone: string;
	readonly logLevel: string;
	/** How often every chat is swept for undelivered final answers (safety net; ms). */
	readonly deliverySweepMs: number;
};

export function parseUserIds(raw: string | undefined): Set<number> {
	const ids = new Set<number>();
	for (const part of (raw ?? "").split(/[,\s]+/)) {
		if (!part) continue;
		const id = Number(part);
		if (!Number.isSafeInteger(id)) throw new Error(`TELEGRAM_ALLOWED_USERS: not a numeric user id: ${part}`);
		ids.add(id);
	}
	return ids;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
	const timeout = Number(env.TELEGRAM_POLL_TIMEOUT_SEC ?? 30);
	return {
		home: resolve(env.PI_BOT_HOME ?? "./data"),
		telegram: {
			token: env.TELEGRAM_BOT_TOKEN || undefined,
			...(env.TELEGRAM_API_ROOT ? { apiRoot: env.TELEGRAM_API_ROOT } : {}),
			allowedUsers: parseUserIds(env.TELEGRAM_ALLOWED_USERS),
			pollTimeoutSec: Number.isFinite(timeout) && timeout >= 0 ? timeout : 30,
		},
		model: modelConfigFromEnv(env),
		timeZone: env.PI_BOT_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
		logLevel: env.LOG_LEVEL ?? "info",
		deliverySweepMs: Number(env.PI_BOT_DELIVERY_SWEEP_MS ?? 15_000),
	};
}
