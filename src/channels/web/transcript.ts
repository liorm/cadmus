import type {
	AssistantMessage,
	Message,
	ToolCall,
} from "@earendil-works/pi-ai";
import {
	AssistantEntry,
	type EntryRecord,
	type LiveState,
	UserEntry,
} from "@earendil-works/pi-durable";
import { NoticeEntry } from "../telegram/commands.ts";

export type TranscriptItem =
	| { type: "user"; id: number; text: string }
	| { type: "assistant"; id: number; text: string }
	| { type: "tool"; id: string; name: string; status: "done" }
	| { type: "notice"; id: number; text: string };

export type ToolChip = { name: string; status: "pending" | "running" | "done" };

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

function toolCalls(message: Message | undefined): ToolCall[] {
	if (message?.role !== "assistant") return [];
	return message.content.filter(
		(part): part is ToolCall => part.type === "toolCall",
	);
}

/** Committed transcript in entry order. System, reset, and tool-result rows stay out. */
export function projectEntries(
	entries: readonly EntryRecord[],
): TranscriptItem[] {
	const items: TranscriptItem[] = [];
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
		for (const call of toolCalls(entry.model?.[0])) {
			items.push({
				type: "tool",
				id: `${entry.id}:${call.id}`,
				name: call.name,
				status: "done",
			});
		}
		const text = textOf(entry.model?.[0]);
		if (text) items.push({ type: "assistant", id: entry.id, text });
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

export function liveTools(live: LiveState | undefined): ToolChip[] {
	return (live?.tools ?? []).map((slot) => ({
		name: slot.name,
		status: slot.status,
	}));
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
