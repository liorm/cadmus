/**
 * Daemon wire frames. Mirrors ExecutionEnv plus heartbeat. No probe method.
 * Kept off src/protocol.ts so UI schemas stay client-facing.
 */

export const MAX_FRAME_BYTES = 6 * 1024 * 1024;
export const HEARTBEAT_MS = 30_000;
export const FILE_CALL_TIMEOUT_MS = 2_000;
export const TRANSPORT_PREFIX = "tools-env transport:";
export const TRANSPORT_DISCONNECTED = `${TRANSPORT_PREFIX} env disconnected`;

export const FILE_ERROR_CODES = [
	"aborted",
	"not_found",
	"permission_denied",
	"not_directory",
	"is_directory",
	"invalid",
	"not_supported",
	"unknown",
] as const;

export const EXEC_ERROR_CODES = [
	"aborted",
	"timeout",
	"shell_unavailable",
	"spawn_error",
	"callback_error",
	"unknown",
] as const;

export type FileErrorCode = (typeof FILE_ERROR_CODES)[number];
export type ExecErrorCode = (typeof EXEC_ERROR_CODES)[number];

const FILE_CODE_SET = new Set<string>(FILE_ERROR_CODES);
const EXEC_CODE_SET = new Set<string>(EXEC_ERROR_CODES);

export interface WireError {
	kind: "file" | "exec";
	code: string;
	message: string;
	path?: string;
	spillPath?: string;
}

export interface WireSuccess {
	id: string;
	ok: true;
	value?: unknown;
}

export interface WireFailure {
	id: string;
	ok: false;
	error: WireError;
}

export interface WireOutputEvent {
	id: string;
	event: "output";
	text: string;
	stream: "stdout" | "stderr";
	skipped?: {
		bytes: number;
		newlines: number;
		endsWithNewline: boolean;
	};
}

export interface WireWatchEvent {
	id: string;
	event: "watch";
	change: unknown;
}

export type ParsedDaemonFrame =
	| { action: "too-large" }
	| { action: "client-command" }
	| { action: "invalid" }
	| { action: "result"; frame: WireSuccess | WireFailure }
	| { action: "output"; frame: WireOutputEvent }
	| { action: "watch"; frame: WireWatchEvent };

/** Pairing bearer shape. Callers reject anything else before SHA-256 or D1. */
export function isDaemonBearerToken(token: string): boolean {
	return /^cadmus_dt_[0-9a-f]{64}$/.test(token);
}

export interface WireRequest {
	id: string;
	method: string;
	args: unknown;
}

export type ParsedWireRequest =
	| { action: "too-large" }
	| { action: "client-command" }
	| { action: "invalid" }
	| { action: "request"; request: WireRequest };

export function parseWireRequest(text: string): ParsedWireRequest {
	if (
		text.length > MAX_FRAME_BYTES ||
		frameByteLength(text) > MAX_FRAME_BYTES
	) {
		return { action: "too-large" };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { action: "invalid" };
	}
	if (isClientCommandFrame(parsed)) return { action: "client-command" };
	if (!parsed || typeof parsed !== "object") return { action: "invalid" };
	const record = parsed as Record<string, unknown>;
	if (typeof record.id !== "string" || record.id.length === 0) {
		return { action: "invalid" };
	}
	if (typeof record.method !== "string" || record.method.length === 0) {
		return { action: "invalid" };
	}
	if (record.method === "probe") return { action: "invalid" };
	return {
		action: "request",
		request: { id: record.id, method: record.method, args: record.args },
	};
}

export function frameByteLength(text: string): number {
	return new TextEncoder().encode(text).byteLength;
}

export function isClientCommandFrame(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	if (typeof record.type !== "string" || !record.type.includes("."))
		return false;
	if ("method" in record || "ok" in record || "event" in record) return false;
	return true;
}

export function parseDaemonFrame(text: string): ParsedDaemonFrame {
	if (
		text.length > MAX_FRAME_BYTES ||
		frameByteLength(text) > MAX_FRAME_BYTES
	) {
		return { action: "too-large" };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { action: "invalid" };
	}
	if (isClientCommandFrame(parsed)) return { action: "client-command" };
	if (!parsed || typeof parsed !== "object") return { action: "invalid" };
	const record = parsed as Record<string, unknown>;
	if (typeof record.id !== "string" || record.id.length === 0) {
		return { action: "invalid" };
	}
	if (record.event === "output") {
		if (typeof record.text !== "string") return { action: "invalid" };
		if (record.stream !== "stdout" && record.stream !== "stderr") {
			return { action: "invalid" };
		}
		const frame: WireOutputEvent = {
			id: record.id,
			event: "output",
			text: record.text,
			stream: record.stream,
		};
		if (record.skipped !== undefined) {
			if (!isSkip(record.skipped)) return { action: "invalid" };
			frame.skipped = record.skipped;
		}
		return { action: "output", frame };
	}
	if (record.event === "watch") {
		if (!("change" in record)) return { action: "invalid" };
		return {
			action: "watch",
			frame: { id: record.id, event: "watch", change: record.change },
		};
	}
	if (record.ok === true) {
		return {
			action: "result",
			frame: { id: record.id, ok: true, value: record.value },
		};
	}
	if (record.ok === false) {
		const error = normalizeError(record.error);
		if (!error) return { action: "invalid" };
		return { action: "result", frame: { id: record.id, ok: false, error } };
	}
	return { action: "invalid" };
}

function isSkip(value: unknown): value is WireOutputEvent["skipped"] & object {
	if (!value || typeof value !== "object") return false;
	const skip = value as Record<string, unknown>;
	return (
		typeof skip.bytes === "number" &&
		typeof skip.newlines === "number" &&
		typeof skip.endsWithNewline === "boolean"
	);
}

export function normalizeError(value: unknown): WireError | undefined {
	if (!value || typeof value !== "object") return undefined;
	const error = value as Record<string, unknown>;
	if (error.kind !== "file" && error.kind !== "exec") return undefined;
	if (typeof error.code !== "string" || typeof error.message !== "string") {
		return undefined;
	}
	if (error.kind === "file" && !FILE_CODE_SET.has(error.code)) return undefined;
	if (error.kind === "exec" && !EXEC_CODE_SET.has(error.code)) return undefined;
	const normalized: WireError = {
		kind: error.kind,
		code: error.code,
		message: peerErrorMessage(error.message),
	};
	if (typeof error.path === "string") normalized.path = error.path;
	if (typeof error.spillPath === "string")
		normalized.spillPath = error.spillPath;
	return normalized;
}

/** A peer that copied the transport prefix stays an application result. */
export function peerErrorMessage(message: string): string {
	if (!message.startsWith(TRANSPORT_PREFIX)) return message;
	return message.slice(TRANSPORT_PREFIX.length).trimStart();
}

export function isTransportMessage(message: string): boolean {
	return message.startsWith(TRANSPORT_PREFIX);
}

export function transportFailure(method: string): WireFailure["error"] {
	if (method === "exec") {
		return {
			kind: "exec",
			code: "shell_unavailable",
			message: TRANSPORT_DISCONNECTED,
		};
	}
	return { kind: "file", code: "unknown", message: TRANSPORT_DISCONNECTED };
}

export function encodeWire(value: unknown): string {
	return JSON.stringify(value);
}

export function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunk = 0x8000;
	for (let index = 0; index < bytes.byteLength; index += chunk) {
		const slice = bytes.subarray(index, index + chunk);
		binary += String.fromCharCode(...slice);
	}
	return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

export function encodeBinary(content: string | Uint8Array): unknown {
	if (typeof content === "string") return content;
	return { base64: bytesToBase64(content) };
}

export function decodeBinary(value: unknown): string | Uint8Array | unknown {
	if (!value || typeof value !== "object") return value;
	const record = value as Record<string, unknown>;
	if (typeof record.base64 === "string" && Object.keys(record).length === 1) {
		return base64ToBytes(record.base64);
	}
	return value;
}

export function asBytes(content: unknown): string | Uint8Array {
	if (typeof content === "string") return content;
	if (content instanceof Uint8Array) return content;
	if (content instanceof ArrayBuffer) return new Uint8Array(content);
	if (
		Array.isArray(content) &&
		content.every((item) => typeof item === "number")
	) {
		return new Uint8Array(content);
	}
	const decoded = decodeBinary(content);
	if (typeof decoded === "string" || decoded instanceof Uint8Array)
		return decoded;
	return "";
}
