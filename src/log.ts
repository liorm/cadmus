export type Logger = {
	debug(message: string, ...rest: unknown[]): void;
	info(message: string, ...rest: unknown[]): void;
	warn(message: string, ...rest: unknown[]): void;
	error(message: string, ...rest: unknown[]): void;
};

const LEVELS = ["debug", "info", "warn", "error"] as const;
type Level = (typeof LEVELS)[number];

export function consoleLogger(level: string = "info"): Logger {
	const min = Math.max(0, LEVELS.indexOf(level as Level));
	const at =
		(name: Level, write: (...args: unknown[]) => void) =>
		(message: string, ...rest: unknown[]) => {
			if (LEVELS.indexOf(name) >= min) write(`${new Date().toISOString()} ${name.toUpperCase()} ${message}`, ...rest);
		};
	return {
		debug: at("debug", console.debug),
		info: at("info", console.info),
		warn: at("warn", console.warn),
		error: at("error", console.error),
	};
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
