import { stderr } from "node:process";
import type { Writable } from "node:stream";

export type DaemonLogFields = Record<string, unknown>;

export interface DaemonLogger {
	debug(message: string, fields?: DaemonLogFields): void;
	info(message: string, fields?: DaemonLogFields): void;
	warn(message: string, fields?: DaemonLogFields): void;
	error(message: string, fields?: DaemonLogFields): void;
	child(fields: DaemonLogFields): DaemonLogger;
}

const LEVELS = ["debug", "info", "warn", "error"] as const;
export type DaemonLogLevel = (typeof LEVELS)[number];

export function parseDaemonLogLevel(raw: string | undefined): DaemonLogLevel {
	const level = (raw ?? "info").trim().toLowerCase();
	return LEVELS.includes(level as DaemonLogLevel)
		? (level as DaemonLogLevel)
		: "info";
}

export type DaemonLogStream = Pick<Writable, "write"> & { isTTY?: boolean };

export type DaemonLoggerSetup =
	| {
			type: "console";
			level?: string;
			stream?: DaemonLogStream;
			colors?: boolean;
	  }
	| { type: "custom"; logger: DaemonLogger }
	| { type: "silent" };

const silentLogger: DaemonLogger = {
	debug() {},
	info() {},
	warn() {},
	error() {},
	child() {
		return silentLogger;
	},
};

const ANSI = {
	reset: "\x1b[0m",
	dim: "\x1b[2m",
	debug: "\x1b[90m",
	info: "\x1b[36m",
	warn: "\x1b[33m",
	error: "\x1b[31m",
	key: "\x1b[35m",
};

function levelRank(level: DaemonLogLevel): number {
	return LEVELS.indexOf(level);
}

function formatValue(value: unknown): string {
	if (typeof value === "string") {
		return /[\s"]/.test(value) ? JSON.stringify(value) : value;
	}
	if (
		typeof value === "number" ||
		typeof value === "boolean" ||
		value === null
	) {
		return String(value);
	}
	if (value instanceof Error) return formatValue(value.message);
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

function formatFields(
	fields: DaemonLogFields,
	withStack: boolean,
	colors: boolean,
): string {
	const parts: string[] = [];
	const stacks: string[] = [];
	for (const [key, value] of Object.entries(fields)) {
		if (value === undefined) continue;
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

function formatLine(
	level: DaemonLogLevel,
	message: string,
	fields: DaemonLogFields | undefined,
	colors: boolean,
): string {
	const stamp = new Date().toISOString().replace("T", " ").replace("Z", "");
	const head = `${stamp} ${level.toUpperCase().padEnd(5)}`;
	const formattedFields = fields
		? formatFields(fields, level === "error", colors)
		: "";
	const body = formattedFields ? ` ${formattedFields}` : "";
	if (!colors) return `${head} ${message}${body}\n`;
	return `${ANSI.dim}${stamp}${ANSI.reset} ${ANSI[level]}${level.toUpperCase().padEnd(5)}${ANSI.reset} ${message}${body}\n`;
}

function withFields(base: DaemonLogger, bound: DaemonLogFields): DaemonLogger {
	const merge = (fields?: DaemonLogFields): DaemonLogFields =>
		fields ? { ...bound, ...fields } : bound;
	return {
		debug: (message, fields) => base.debug(message, merge(fields)),
		info: (message, fields) => base.info(message, merge(fields)),
		warn: (message, fields) => base.warn(message, merge(fields)),
		error: (message, fields) => base.error(message, merge(fields)),
		child: (fields) => withFields(base, merge(fields)),
	};
}

function createConsoleLogger(
	options: Extract<DaemonLoggerSetup, { type: "console" }>,
): DaemonLogger {
	const stream = options.stream ?? stderr;
	const min = levelRank(parseDaemonLogLevel(options.level));
	const colors =
		options.colors ?? (options.stream ? Boolean(options.stream.isTTY) : true);

	const write =
		(level: DaemonLogLevel) => (message: string, fields?: DaemonLogFields) => {
			if (levelRank(level) < min) return;
			const line = formatLine(level, message, fields, colors);
			try {
				stream.write(line);
			} catch {
				// Fallback if stream was closed
			}
		};

	const logger: DaemonLogger = {
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

let activeLogger: DaemonLogger = createConsoleLogger({
	type: "console",
	level: process.env.CADMUS_LOG_LEVEL ?? process.env.LOG_LEVEL ?? "info",
});

export function setupDaemonLogger(options: DaemonLoggerSetup): DaemonLogger {
	if (options.type === "silent") {
		activeLogger = silentLogger;
	} else if (options.type === "custom") {
		activeLogger = options.logger;
	} else {
		activeLogger = createConsoleLogger(options);
	}
	return activeLogger;
}

export function getDaemonLogger(): DaemonLogger {
	return activeLogger;
}

export function setDaemonLogger(logger: DaemonLogger): void {
	activeLogger = logger;
}

export function createSilentLogger(): DaemonLogger {
	return silentLogger;
}
