import type { RawTranscriptEntry } from "@cadmus/contract/types";

export interface RawLine {
	id: string;
	role:
		| "user"
		| "assistant"
		| "tool_call"
		| "tool_result"
		| "compaction"
		| "reset";
	time?: string;
	name?: string;
	body: string;
}

function clock(timestamp: unknown): string | undefined {
	if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return;
	const date = new Date(timestamp);
	const hh = String(date.getHours()).padStart(2, "0");
	const mm = String(date.getMinutes()).padStart(2, "0");
	const ss = String(date.getSeconds()).padStart(2, "0");
	return `${hh}:${mm}:${ss}`;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (typeof part === "string") {
			parts.push(part);
			continue;
		}
		if (!part || typeof part !== "object") continue;
		const block = part as { type?: string; text?: string };
		if (
			(block.type === "text" || block.type === undefined) &&
			typeof block.text === "string"
		) {
			parts.push(block.text);
		}
	}
	return parts.join("\n").trim();
}

function toolCallsOf(content: unknown): Array<{ name: string; args: string }> {
	if (!Array.isArray(content)) return [];
	const calls: Array<{ name: string; args: string }> = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const block = part as {
			type?: string;
			name?: string;
			arguments?: unknown;
			args?: unknown;
		};
		if (block.type !== "toolCall" && block.type !== "tool_call") continue;
		const raw = block.arguments ?? block.args ?? {};
		const args = typeof raw === "string" ? raw : JSON.stringify(raw, null, 2);
		calls.push({ name: block.name ?? "tool", args });
	}
	return calls;
}

function linesFromMessage(
	entryId: number,
	message: Record<string, unknown>,
	index: number,
): RawLine[] {
	const role = typeof message.role === "string" ? message.role : "";
	const time = clock(message.timestamp);
	const content = message.content;
	const lines: RawLine[] = [];
	if (role === "user" || role === "assistant") {
		const body = textOf(content);
		if (body) {
			lines.push({
				id: `${entryId}-${index}-${role}`,
				role,
				time,
				body,
			});
		}
		if (role === "assistant") {
			for (const [callIndex, call] of toolCallsOf(content).entries()) {
				lines.push({
					id: `${entryId}-${index}-call-${callIndex}`,
					role: "tool_call",
					name: call.name,
					body: call.args,
				});
			}
		}
		return lines;
	}
	if (role === "toolResult" || role === "tool_result") {
		const name =
			typeof message.toolName === "string" ? message.toolName : undefined;
		lines.push({
			id: `${entryId}-${index}-result`,
			role: "tool_result",
			name,
			body: textOf(content) || (message.isError ? "error" : "ok"),
		});
	}
	return lines;
}

/** Flatten durable transcript entries into the raw-view rows. */
export function rawTranscriptLines(entries: RawTranscriptEntry[]): RawLine[] {
	const lines: RawLine[] = [];
	for (const entry of entries) {
		const models = Array.isArray(entry.model) ? entry.model : [];
		if (entry.kind === "pi.compaction") {
			const first = models[0] as Record<string, unknown> | undefined;
			const body = first ? textOf(first.content) : "";
			const data = (entry.data ?? {}) as { reason?: string };
			lines.push({
				id: `${entry.id}-compaction`,
				role: "compaction",
				name: data.reason ?? "threshold",
				body: body || "Context compacted",
			});
			continue;
		}
		if (entry.kind === "pi.reset") {
			const first = models[0] as Record<string, unknown> | undefined;
			const body = first ? textOf(first.content) : "";
			lines.push({
				id: `${entry.id}-reset`,
				role: "reset",
				body: body || "Conversation context reset",
			});
			continue;
		}
		for (const [index, message] of models.entries()) {
			if (!message || typeof message !== "object") continue;
			lines.push(
				...linesFromMessage(
					entry.id,
					message as Record<string, unknown>,
					index,
				),
			);
		}
	}
	return lines;
}
