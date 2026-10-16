import { stderr } from "node:process";
import type { Writable } from "node:stream";

/** Structured fields printed after the message. Errors are fine as values. */
export type LogFields = Record<string, unknown>;

export type Logger = {
	debug(message: string, fields?: LogFields): void;
	info(message: string, fields?: LogFields): void;
	warn(message: string, fields?: LogFields): void;
	error(message: string, fields?: LogFields): void;
	/** Bind fields onto every later line (chat, session, requestId). */
	child(fields: LogFields): Logger;
};

const LEVELS = ["debug", "info", "warn", "error"] as const;
type Level = (typeof LEVELS)[number];

/** `LOG_LEVEL` value. Unknown or empty becomes `info`. */
export function parseLogLevel(raw: string | undefined): Level {
	const level = (raw ?? "info").trim().toLowerCase();
	return LEVELS.includes(level as Level) ? (level as Level) : "info";
}

export type LoggerSetup =
	| { type: "console"; level?: string; stream?: Writable; colors?: boolean }
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
	chat: { key: string; conversationId: unknown },
	extra?: LogFields,
): LogFields {
	return {
		chat: chat.key,
		session: chat.conversationId,
		...extra,
	};
}

let active: Logger = silentLogger;
let installed = false;

/** Install the process logger. Call once at startup; later calls replace it. */
export function setupLogger(options: LoggerSetup): Logger {
	active = options.type === "silent" ? silentLogger : consoleSink(options);
	installed = true;
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
	const colors =
		options.colors ?? Boolean((stream as { isTTY?: boolean }).isTTY);
	const write = (level: Level) => (message: string, fields?: LogFields) => {
		if (levelRank(level) < min) return;
		stream.write(formatLine(level, message, fields, colors));
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
};

function formatLine(
	level: Level,
	message: string,
	fields: LogFields | undefined,
	colors: boolean,
): string {
	const stamp = new Date().toISOString().replace("T", " ").replace("Z", "");
	const head = `${stamp} ${level.toUpperCase().padEnd(5)}`;
	const body = fields ? ` ${formatFields(fields, level === "error")}` : "";
	const text = `${head} ${message}${body}\n`;
	if (!colors) return text;
	return `${ANSI.dim}${stamp}${ANSI.reset} ${ANSI[level]}${level.toUpperCase().padEnd(5)}${ANSI.reset} ${message}${body ? `${ANSI.dim}${body}${ANSI.reset}` : ""}\n`;
}

function formatFields(fields: LogFields, withStack: boolean): string {
	const parts: string[] = [];
	const stacks: string[] = [];
	for (const [key, value] of Object.entries(fields)) {
		if (value instanceof Error) {
			parts.push(`${key}=${formatValue(value.message)}`);
			if (withStack && value.stack) stacks.push(value.stack);
		} else {
			parts.push(`${key}=${formatValue(value)}`);
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
