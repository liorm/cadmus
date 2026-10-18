import type {
	AssistantMessage,
	JsonObject,
	Message,
} from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	type EntryRecord,
	type LiveState,
	ToolResultEntry,
	UserEntry,
} from "@earendil-works/pi-durable";
import { NoticeEntry } from "../commands.ts";

/** Cap what a chip ships over the event stream. The UI shows this text as-is. */
const DETAIL_LIMIT = 4_000;

export type ToolDetail = {
	callId: string;
	arguments?: JsonObject;
	/** Tool result text, when the call has finished. */
	result?: string;
	/** Retained stdout while the call is still running. */
	output?: string;
};

export type ThinkingSegment = {
	type: "thinking";
	thinking: string;
	signature?: string;
	redacted?: boolean;
};

export type ToolSegment = {
	type: "tool";
	id: string;
	name: string;
	status: "pending" | "running" | "done" | "error";
	detail: ToolDetail;
};

export type TextSegment = {
	type: "text";
	text: string;
};

export type AssistantSegment = ThinkingSegment | ToolSegment | TextSegment;

export type TranscriptItem =
	| { type: "user"; id: number; text: string }
	| {
			type: "assistant";
			id: number;
			text: string;
			segments?: AssistantSegment[];
	  }
	| {
			type: "tool";
			id: string;
			name: string;
			status: "done" | "error";
			detail: ToolDetail;
	  }
	| { type: "notice"; id: number; text: string };

export type ToolChip = {
	name: string;
	status: "pending" | "running" | "done" | "error";
	detail: ToolDetail;
};

function textOf(message: Message | undefined): string | undefined {
	if (!message) return undefined;
	if (message.role === "user") {
		const text =
			typeof message.content === "string"
				? message.content
				: message.content
						.map((part) => (part.type === "text" ? part.text : ""))
						.join("");
		const trimmed = text.trim();
		return trimmed || undefined;
	}
	if (message.role !== "assistant") return undefined;
	const text = message.content
		.map((part) => (part.type === "text" ? part.text : ""))
		.join("\n")
		.trim();
	return text || undefined;
}

type RecordedTool = {
	id: string;
	name: string;
	arguments?: JsonObject;
	/** Set when the part itself says the provider call failed. */
	failed: boolean;
	result?: string;
};

function recordedTools(message: Message | undefined): RecordedTool[] {
	if (message?.role !== "assistant" || !Array.isArray(message.content))
		return [];
	const tools: RecordedTool[] = [];
	for (const part of message.content as readonly {
		type?: string;
		id?: string;
		name?: string;
		arguments?: JsonObject;
		status?: string;
		result?: string;
	}[]) {
		if (!part || typeof part !== "object") continue;
		if (part.type === "toolCall" && part.id && part.name) {
			tools.push({
				id: part.id,
				name: part.name,
				...(part.arguments ? { arguments: part.arguments } : {}),
				failed: false,
			});
			continue;
		}
		if (part.type !== "serverTool" || !part.id || !part.name) continue;
		const arguments_ = jsonObject(part.arguments);
		const result = typeof part.result === "string" ? part.result : undefined;
		tools.push({
			id: part.id,
			name: part.name,
			...(arguments_ ? { arguments: arguments_ } : {}),
			failed: part.status === "error" || part.status === "failed",
			...(result ? { result } : {}),
		});
	}
	return tools;
}

function jsonObject(value: unknown): JsonObject | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value))
		return undefined;
	return value as JsonObject;
}

/** First thing the user said, for a chat row that has no stored title. */
export function openingTranscriptText(
	entries: readonly EntryRecord[],
): string | undefined {
	for (const entry of entries) {
		const item = projectEntries([entry]).find((row) => row.type === "user");
		if (item?.type === "user") return item.text;
	}
	return undefined;
}

/** Latest user, assistant, or notice text. Tool chips are not a preview. */
export function latestTranscriptText(
	entries: readonly EntryRecord[],
): string | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (!entry) continue;
		const items = projectEntries([entry]);
		for (let inner = items.length - 1; inner >= 0; inner--) {
			const item = items[inner];
			if (item && item.type !== "tool" && item.text) return item.text;
		}
	}
	return undefined;
}

/** Committed transcript in entry order. System, reset, and tool-result rows stay out. */
export function projectEntries(
	entries: readonly EntryRecord[],
): TranscriptItem[] {
	const items: TranscriptItem[] = [];
	const outcomes = toolOutcomes(entries);
	for (const entry of entries) {
		if (NoticeEntry.is(entry)) {
			const text =
				typeof entry.data?.text === "string" ? entry.data.text.trim() : "";
			if (text) items.push({ type: "notice", id: entry.id, text });
			continue;
		}
		if (UserEntry.is(entry)) {
			const text = textOf(entry.model?.[0]);
			if (text) items.push({ type: "user", id: entry.id, text });
			continue;
		}
		if (!AssistantEntry.is(entry)) continue;
		const message = entry.model?.[0];
		if (message?.role !== "assistant") continue;

		const segments: AssistantSegment[] = [];
		const text = textOf(message) ?? "";

		if (Array.isArray(message.content)) {
			for (const part of message.content as readonly {
				type?: string;
				id?: string;
				name?: string;
				text?: string;
				thinking?: string;
				thinkingSignature?: string;
				signature?: string;
				redacted?: boolean;
				arguments?: JsonObject;
				status?: string;
				result?: string;
			}[]) {
				if (!part || typeof part !== "object") continue;
				if (part.type === "thinking") {
					const thinking =
						typeof part.thinking === "string"
							? part.thinking
							: typeof part.text === "string"
								? part.text
								: "";
					const signature =
						typeof part.thinkingSignature === "string"
							? part.thinkingSignature
							: typeof part.signature === "string"
								? part.signature
								: undefined;
					const redacted = Boolean(part.redacted);
					segments.push({
						type: "thinking",
						thinking,
						...(signature ? { signature } : {}),
						...(redacted ? { redacted } : {}),
					});
					continue;
				}
				if (part.type === "toolCall" && part.id && part.name) {
					const outcome = outcomes.get(part.id);
					const result = outcome?.text ? clip(outcome.text) : undefined;
					const failed = outcome ? outcome.isError : false;
					segments.push({
						type: "tool",
						id: `${entry.id}:${part.id}`,
						name: part.name,
						status: failed ? "error" : "done",
						detail: {
							callId: part.id,
							...(part.arguments
								? { arguments: jsonObject(part.arguments) }
								: {}),
							...(result ? { result } : {}),
						},
					});
					continue;
				}
				if (part.type === "serverTool" && part.id && part.name) {
					const outcome = outcomes.get(part.id);
					const result = outcome?.text
						? clip(outcome.text)
						: typeof part.result === "string"
							? clip(part.result)
							: undefined;
					const failed = outcome
						? outcome.isError
						: part.status === "error" || part.status === "failed";
					segments.push({
						type: "tool",
						id: `${entry.id}:${part.id}`,
						name: part.name,
						status: failed ? "error" : "done",
						detail: {
							callId: part.id,
							...(part.arguments
								? { arguments: jsonObject(part.arguments) }
								: {}),
							...(result ? { result } : {}),
						},
					});
					continue;
				}
				if (
					part.type === "text" &&
					typeof part.text === "string" &&
					part.text.trim()
				) {
					segments.push({
						type: "text",
						text: part.text.trim(),
					});
				}
			}
		} else {
			const raw = message.content as unknown;
			if (typeof raw === "string" && raw.trim()) {
				segments.push({
					type: "text",
					text: raw.trim(),
				});
			}
		}

		if (segments.length === 0 && !text) continue;

		items.push({
			type: "assistant",
			id: entry.id,
			text,
			...(segments.length > 0 ? { segments } : {}),
		});
	}
	return items;
}

export function partialText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (
				!part ||
				typeof part !== "object" ||
				(part as { type?: string }).type !== "text"
			)
				return "";
			return typeof (part as { text?: unknown }).text === "string"
				? (part as { text: string }).text
				: "";
		})
		.join("");
}

export function liveTools(
	live: LiveState | undefined,
	entries: readonly EntryRecord[] = [],
): ToolChip[] {
	const outcomes = toolOutcomes(entries);
	const args = argumentIndex(entries, live?.generation?.message);
	return (live?.tools ?? []).map((slot) => {
		const outcome =
			slot.entry === undefined ? undefined : outcomes.get(slot.callId);
		const result = outcome?.text ? clip(outcome.text) : undefined;
		const output = slot.output ? clip(slot.output) : undefined;
		const arguments_ = args.get(slot.callId);
		return {
			name: slot.name,
			status: outcome?.isError ? "error" : slot.status,
			detail: {
				callId: slot.callId,
				...(arguments_ ? { arguments: arguments_ } : {}),
				...(output ? { output } : {}),
				...(result ? { result } : {}),
			},
		};
	});
}

type ToolOutcome = { isError: boolean; text: string };

/** Latest tool result for each call id. Later rows replace earlier ones. */
function toolOutcomes(
	entries: readonly EntryRecord[],
): Map<string, ToolOutcome> {
	const outcomes = new Map<string, ToolOutcome>();
	for (const entry of entries) {
		if (!ToolResultEntry.is(entry)) continue;
		const message = entry.model?.[0];
		if (message?.role !== "toolResult") continue;
		outcomes.set(message.toolCallId, {
			isError: message.isError,
			text: message.content
				.map((part) => (part.type === "text" ? part.text : ""))
				.join(""),
		});
	}
	return outcomes;
}

function argumentIndex(
	entries: readonly EntryRecord[],
	partial: unknown,
): Map<string, JsonObject> {
	const args = new Map<string, JsonObject>();
	const take = (message: Message | undefined) => {
		for (const call of recordedTools(message)) {
			if (call.arguments) args.set(call.id, call.arguments);
		}
	};
	if (partial && typeof partial === "object") take(partial as Message);
	for (const entry of entries) {
		if (!AssistantEntry.is(entry)) continue;
		take(entry.model?.[0]);
	}
	return args;
}

function clip(text: string): string {
	if (text.length <= DETAIL_LIMIT) return text;
	return `${text.slice(0, DETAIL_LIMIT)}\n…`;
}

/** The latest assistant error, if that entry is the most recent assistant row. */
export function latestAssistantError(
	entries: readonly EntryRecord[],
): string | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (!entry || !AssistantEntry.is(entry)) continue;
		const message = entry.model?.[0] as AssistantMessage | undefined;
		if (message?.role === "assistant" && message.stopReason === "error")
			return message.errorMessage || "The model returned an error.";
		return undefined;
	}
	return undefined;
}
