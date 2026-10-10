import { resolve } from "node:path";
import { type ModelConfig, modelConfigFromEnv } from "./harness/models.ts";

export type TelegramConfig = {
	/** Absent when `TELEGRAM_BOT_TOKEN` is unset. The general door stays off; per-bot tokens still poll. */
	readonly token?: string;
	/** Bot API root, e.g. a local Bot API server; default https://api.telegram.org. */
	readonly apiRoot?: string;
	/** Numeric Telegram user IDs allowed to talk to the bot. Empty means nobody. */
	readonly allowedUsers: ReadonlySet<number>;
	readonly pollTimeoutSec: number;
};

export type WebConfig = {
	readonly host: string;
	readonly port: number;
	/** Shared bearer / cookie value. Never logged and never returned by the API. */
	readonly token: string;
};

export type Config = {
	/** Directory holding durable.sqlite, owner.lock, bots/, and workspace/. */
	readonly home: string;
	readonly telegram: TelegramConfig;
	/** Absent when `WEB_TOKEN` is unset. The page does not listen. */
	readonly web?: WebConfig;
	readonly model: ModelConfig;
	readonly timeZone: string;
	readonly logLevel: string;
	/** How often every chat is swept for undelivered final answers (safety net; ms). */
	readonly deliverySweepMs: number;
	/** Idle time before a chat is forked to improve knowledge. Default 60 seconds. Not stored on the bot. */
	readonly harvestDelayMs: number;
};

export function parseUserIds(raw: string | undefined): Set<number> {
	const ids = new Set<number>();
	for (const part of (raw ?? "").split(/[,\s]+/)) {
		if (!part) continue;
		const id = Number(part);
		if (!Number.isSafeInteger(id))
			throw new Error(`TELEGRAM_ALLOWED_USERS: not a numeric user id: ${part}`);
		ids.add(id);
	}
	return ids;
}

/** `WEB_TOKEN` set means the page listens. An empty token leaves the web channel off. */
export function webConfigFromEnv(
	env: NodeJS.ProcessEnv,
): WebConfig | undefined {
	const token = env.WEB_TOKEN;
	if (!token) return undefined;
	const raw = env.WEB_PORT;
	const port = raw === undefined || raw === "" ? 8787 : Number(raw);
	if (!Number.isInteger(port) || port < 0 || port > 65535)
		throw new Error(`WEB_PORT: expected a port, got "${raw}"`);
	return { host: env.WEB_HOST || "127.0.0.1", port, token };
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
	const timeout = Number(env.TELEGRAM_POLL_TIMEOUT_SEC ?? 30);
	const web = webConfigFromEnv(env);
	return {
		home: resolve(env.PI_BOT_HOME ?? "./data"),
		telegram: {
			token: env.TELEGRAM_BOT_TOKEN?.trim() || undefined,
			...(env.TELEGRAM_API_ROOT ? { apiRoot: env.TELEGRAM_API_ROOT } : {}),
			allowedUsers: parseUserIds(env.TELEGRAM_ALLOWED_USERS),
			pollTimeoutSec: Number.isFinite(timeout) && timeout >= 0 ? timeout : 30,
		},
		...(web ? { web } : {}),
		model: modelConfigFromEnv(env),
		timeZone: env.PI_BOT_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
		logLevel: env.LOG_LEVEL ?? "info",
		deliverySweepMs: Number(env.PI_BOT_DELIVERY_SWEEP_MS ?? 15_000),
		harvestDelayMs: harvestDelayFromEnv(env),
	};
}

function harvestDelayFromEnv(env: NodeJS.ProcessEnv): number {
	const raw = env.PI_BOT_HARVEST_DELAY_MS;
	if (raw === undefined || raw === "") return 60_000;
	const delay = Number(raw);
	if (!Number.isFinite(delay) || delay < 0)
		throw new Error(
			`PI_BOT_HARVEST_DELAY_MS: expected milliseconds, got "${raw}"`,
		);
	return delay;
}
