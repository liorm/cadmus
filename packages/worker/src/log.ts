import { stderr } from "node:process";
import type { Writable } from "node:stream";

/** Structured fields printed after the message. Errors are fine as values. */
export type LogFields = Record<string, unknown>;

export type Logger = {
	debug(message: string, fields?: LogFields): void;
	info(message: string, fields?: LogFields): void;
	warn(message: string, fields?: LogFields): void;
	error(message: string, fields?: LogFields): void;
	/** Bind fields onto every later line (account, family, bot, chat, session, requestId). */
	child(fields: LogFields): Logger;
};

const LEVELS = ["debug", "info", "warn", "error"] as const;
export type Level = (typeof LEVELS)[number];

/** `LOG_LEVEL` / `CADMUS_LOG_LEVEL` value. Unknown or empty becomes `debug`. */
export function parseLogLevel(raw: string | undefined): Level {
	const level = (raw ?? "debug").trim().toLowerCase();
	return LEVELS.includes(level as Level) ? (level as Level) : "debug";
}

export type LogStream = Pick<Writable, "write"> & { isTTY?: boolean };

export type LoggerSetup =
	| { type: "console"; level?: string; stream?: LogStream; colors?: boolean }
	| { type: "custom"; logger: Logger }
	| { type: "silent" };

const silentLogger: Logger = {
	debug() {},
	info() {},
	warn() {},
	error() {},
	child() {
		return silentLogger;
	},
};

/** Fields that identify a chat turn. `session` is the conversation id. */
export function chatFields(
	chat: { key: string; conversationId: unknown; botId?: string },
	extra?: LogFields,
): LogFields {
	return {
		chat: chat.key,
		session: chat.conversationId,
		...(chat.botId ? { bot: chat.botId } : {}),
		...extra,
	};
}

/** Fields that identify a Bot Family Durable Object scope. */
export function familyFields(
	meta: { accountId: string; familyId: string },
	extra?: LogFields,
): LogFields {
	return {
		account: meta.accountId,
		family: meta.familyId,
		...extra,
	};
}

let active: Logger = silentLogger;
let installed = false;

/** Install the process/worker logger. Call once at startup; later calls replace it. */
export function setupLogger(options: LoggerSetup): Logger {
	if (options.type === "silent") {
		active = silentLogger;
	} else if (options.type === "custom") {
		active = options.logger;
	} else {
		active = consoleSink(options);
	}
	installed = true;
	return active;
}

/** Ensure a default logger is installed if none has been configured yet. */
export function ensureLogger(level?: string): Logger {
	if (!installed) {
		if ((level ?? "").trim().toLowerCase() === "silent") {
			setupLogger({ type: "silent" });
		} else {
			setupLogger({ type: "console", level });
		}
	}
	return active;
}

/** The logger installed by `setupLogger`. Silent until then. */
export function getLogger(): Logger {
	return active;
}

export function loggerInstalled(): boolean {
	return installed;
}

function consoleSink(
	options: Extract<LoggerSetup, { type: "console" }>,
): Logger {
	const stream = options.stream ?? stderr;
	const min = levelRank(parseLogLevel(options.level));
	// Enable ANSI colors by default for the built-in stderr sink (including inside workerd/wrangler dev where isTTY is undefined)
	const colors =
		options.colors ?? (options.stream ? Boolean(options.stream.isTTY) : true);
	let streamWriteFailed = false;
	const write = (level: Level) => (message: string, fields?: LogFields) => {
		if (levelRank(level) < min) return;
		const line = formatLine(level, message, fields, colors);
		if (!streamWriteFailed) {
			try {
				stream.write(line);
				return;
			} catch {
				streamWriteFailed = true;
			}
		}
		const trimmed = line.endsWith("\n") ? line.slice(0, -1) : line;
		if (level === "error") {
			console.error(trimmed);
		} else if (level === "warn") {
			console.warn(trimmed);
		} else if (level === "debug") {
			console.debug(trimmed);
		} else {
			console.info(trimmed);
		}
	};
	const logger: Logger = {
		debug: write("debug"),
		info: write("info"),
		warn: write("warn"),
		error: write("error"),
		child(fields) {
			return withFields(logger, fields);
		},
	};
	return logger;
}

function withFields(base: Logger, bound: LogFields): Logger {
	const merge = (fields?: LogFields): LogFields =>
		fields ? { ...bound, ...fields } : bound;
	return {
		debug: (message, fields) => base.debug(message, merge(fields)),
		info: (message, fields) => base.info(message, merge(fields)),
		warn: (message, fields) => base.warn(message, merge(fields)),
		error: (message, fields) => base.error(message, merge(fields)),
		child: (fields) => withFields(base, merge(fields)),
	};
}

function levelRank(level: Level): number {
	return LEVELS.indexOf(level);
}

const ANSI = {
	reset: "\x1b[0m",
	dim: "\x1b[2m",
	debug: "\x1b[90m",
	info: "\x1b[36m",
	warn: "\x1b[33m",
	error: "\x1b[31m",
	key: "\x1b[35m",
};

function formatLine(
	level: Level,
	message: string,
	fields: LogFields | undefined,
	colors: boolean,
): string {
	const stamp = new Date().toISOString().replace("T", " ").replace("Z", "");
	const head = `${stamp} ${level.toUpperCase().padEnd(5)}`;
	const body = fields
		? ` ${formatFields(fields, level === "error", colors)}`
		: "";
	const text = `${head} ${message}${body}\n`;
	if (!colors) return text;
	return `${ANSI.dim}${stamp}${ANSI.reset} ${ANSI[level]}${level.toUpperCase().padEnd(5)}${ANSI.reset} ${message}${body}\n`;
}

function formatFields(
	fields: LogFields,
	withStack: boolean,
	colors: boolean,
): string {
	const parts: string[] = [];
	const stacks: string[] = [];
	for (const [key, value] of Object.entries(fields)) {
		const formattedVal =
			value instanceof Error ? formatValue(value.message) : formatValue(value);
		if (colors) {
			parts.push(
				`${ANSI.dim}${key}=${ANSI.reset}${ANSI.key}${formattedVal}${ANSI.reset}`,
			);
		} else {
			parts.push(`${key}=${formattedVal}`);
		}
		if (value instanceof Error && withStack && value.stack) {
			stacks.push(
				colors ? `${ANSI.dim}${value.stack}${ANSI.reset}` : value.stack,
			);
		}
	}
	return parts.join(" ") + (stacks.length ? `\n${stacks.join("\n")}` : "");
}

function formatValue(value: unknown): string {
	if (typeof value === "string")
		return /[\s"]/.test(value) ? JSON.stringify(value) : value;
	if (typeof value === "number" || typeof value === "boolean" || value === null)
		return String(value);
	if (value instanceof Error) return formatValue(value.message);
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}
