/**
 * Pure argv and payload helpers. Flags override `--payload`, which overrides
 * a positional JSON argument. Dotted flag names nest. A flag value that is
 * valid JSON takes that type; anything else stays a string.
 */

export interface ParsedArgv {
	command?: string;
	positionals: string[];
	help: boolean;
	version: boolean;
	skill: boolean;
	pretty: boolean;
	stream: boolean;
	url?: string;
	token?: string;
	account?: string;
	family?: string;
	payloadSource?: string;
	timeout?: string;
	chat?: string;
	types?: string;
	/** Flag values that belong to the command payload, in order. */
	payloadFlags: [string, string][];
}

const BOOLEAN_FLAGS = new Set(["help", "version", "skill", "pretty", "stream"]);

const FORBIDDEN_PATH_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function parseArgv(argv: string[]): ParsedArgv {
	const parsed: ParsedArgv = {
		positionals: [],
		help: false,
		version: false,
		skill: false,
		pretty: false,
		stream: false,
		payloadFlags: [],
	};
	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i] ?? "";
		if (token === "--") {
			parsed.positionals.push(...argv.slice(i + 1));
			break;
		}
		if (!token.startsWith("--")) {
			parsed.positionals.push(token);
			continue;
		}
		const body = token.slice(2);
		const eq = body.indexOf("=");
		const name = eq === -1 ? body : body.slice(0, eq);
		const inline = eq === -1 ? undefined : body.slice(eq + 1);
		if (BOOLEAN_FLAGS.has(name) && inline === undefined) {
			assignBoolean(parsed, name);
			continue;
		}
		const value = inline ?? argv[i + 1];
		if (
			value === undefined ||
			(inline === undefined && value.startsWith("--"))
		) {
			throw new Error(`missing value for --${name}`);
		}
		if (inline === undefined) i += 1;
		assignValue(parsed, name, value);
	}
	const [command, ...rest] = parsed.positionals;
	if (command !== undefined) {
		parsed.command = command;
		parsed.positionals = rest;
	}
	return parsed;
}

function assignBoolean(parsed: ParsedArgv, name: string): void {
	if (name === "help") parsed.help = true;
	else if (name === "version") parsed.version = true;
	else if (name === "skill") parsed.skill = true;
	else if (name === "pretty") parsed.pretty = true;
	else if (name === "stream") parsed.stream = true;
}

function assignValue(parsed: ParsedArgv, name: string, value: string): void {
	if (name === "url") parsed.url = value;
	else if (name === "token") parsed.token = value;
	else if (name === "account") parsed.account = value;
	else if (name === "family") parsed.family = value;
	else if (name === "payload") parsed.payloadSource = value;
	else if (name === "timeout") parsed.timeout = value;
	else if (name === "chat") parsed.chat = value;
	else if (name === "types") parsed.types = value;
	else parsed.payloadFlags.push([name, value]);
}

export function parseFlagValue(raw: string): unknown {
	try {
		return JSON.parse(raw);
	} catch {
		return raw;
	}
}

export function assignPath(
	target: Record<string, unknown>,
	path: string,
	value: unknown,
): void {
	const parts = path.split(".").filter((part) => part.length > 0);
	if (parts.length === 0) return;
	if (parts.some((part) => FORBIDDEN_PATH_KEYS.has(part))) return;
	let cursor = target;
	for (let i = 0; i < parts.length - 1; i += 1) {
		const key = parts[i] ?? "";
		const next = cursor[key];
		if (typeof next !== "object" || next === null || Array.isArray(next)) {
			cursor[key] = {};
		}
		cursor = cursor[key] as Record<string, unknown>;
	}
	const leaf = parts[parts.length - 1] ?? "";
	cursor[leaf] = value;
}

export function mergePayload(input: {
	positional?: string;
	payloadText?: string;
	flags: [string, string][];
}): Record<string, unknown> {
	const merged: Record<string, unknown> = {};
	if (input.positional !== undefined && input.positional.trim().length > 0) {
		Object.assign(merged, parseJsonObject(input.positional, "positional JSON"));
	}
	if (input.payloadText !== undefined && input.payloadText.trim().length > 0) {
		Object.assign(merged, parseJsonObject(input.payloadText, "--payload"));
	}
	for (const [key, raw] of input.flags) {
		assignPath(merged, key, parseFlagValue(raw));
	}
	return merged;
}

function parseJsonObject(text: string, label: string): Record<string, unknown> {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		throw new Error(`${label} is not valid JSON`);
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${label} must be a JSON object`);
	}
	return value as Record<string, unknown>;
}
