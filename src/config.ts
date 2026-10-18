import { resolve } from "node:path";
import { parseLogLevel } from "./log.ts";

export type WebConfig = {
	readonly host: string;
	readonly port: number;
	/** Shared bearer / cookie value. Never logged and never returned by the API. */
	readonly token: string;
	/** `bun run dev`: rebuild the page when UI sources change. */
	readonly dev: boolean;
};

export type Config = {
	/** Directory holding durable.sqlite, owner.lock, schedules.sqlite, and bots/. */
	readonly home: string;
	/** Absent when `WEB_TOKEN` is unset. The page does not listen. */
	readonly web?: WebConfig;
	readonly timeZone: string;
	readonly logLevel: string;
	/** Idle time before a chat is forked to improve knowledge. Default 60 seconds. Not stored on the bot. */
	readonly harvestDelayMs: number;
	/** `PI_BOT_DEV=1` (`bun run dev`): wait for / signal a leftover owner.lock. */
	readonly dev: boolean;
};

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
	return {
		host: env.WEB_HOST || "127.0.0.1",
		port,
		token,
		dev: env.PI_BOT_DEV === "1",
	};
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): Config {
	const web = webConfigFromEnv(env);
	return {
		home: resolve(env.PI_BOT_HOME ?? "./data"),
		...(web ? { web } : {}),
		timeZone: env.PI_BOT_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
		logLevel: parseLogLevel(env.LOG_LEVEL),
		harvestDelayMs: harvestDelayFromEnv(env),
		dev: env.PI_BOT_DEV === "1",
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
