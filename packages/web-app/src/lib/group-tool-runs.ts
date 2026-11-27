export type ToolCallView = {
	id?: string;
	name?: string;
	toolName?: string;
	arguments?: unknown;
	result?: {
		content?: string;
		isError?: boolean;
		durationMs?: number;
	};
};

export type ToolRunMessage = {
	id: number;
	role: "user" | "assistant" | "system" | "toolResult";
	text: string;
	toolCalls?: ToolCallView[];
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
	stopReason?: string;
	errorMessage?: string;
	durationMs?: number;
	timestamp?: number;
};

export type ToolExecutionDetail = {
	id: string;
	name: string;
	args?: unknown;
	result?: {
		content?: string;
		isError?: boolean;
		durationMs?: number;
	};
	durationMs?: number;
	isError?: boolean;
};

export type TranscriptItem =
	| { type: "user"; message: ToolRunMessage }
	| { type: "assistant"; message: ToolRunMessage }
	| { type: "system"; message: ToolRunMessage }
	| {
			type: "tools";
			names: string[];
			count: number;
			startId: number;
			endId: number;
			calls: ToolExecutionDetail[];
			totalDurationMs?: number;
			hasError?: boolean;
	  };

function toolNamesFrom(message: ToolRunMessage): string[] {
	const fromCalls =
		message.toolCalls
			?.map((call) => call.toolName ?? call.name)
			.filter((name): name is string => Boolean(name)) ?? [];
	if (message.role === "toolResult" && message.toolName) {
		return [...fromCalls, message.toolName];
	}
	return fromCalls;
}

function pushUnique(names: string[], incoming: string[]) {
	for (const name of incoming) {
		if (!names.includes(name)) names.push(name);
	}
}

export function groupToolRuns(messages: ToolRunMessage[]): TranscriptItem[] {
	const items: TranscriptItem[] = [];
	let index = 0;
	while (index < messages.length) {
		const message = messages[index];
		if (!message) break;
		if (message.role === "user") {
			items.push({ type: "user", message });
			index += 1;
			continue;
		}
		if (message.role === "system") {
			items.push({ type: "system", message });
			index += 1;
			continue;
		}
		if (message.role === "assistant" && message.text.trim()) {
			items.push({ type: "assistant", message });
		}
		const names: string[] = [];
		const callsMap = new Map<string, ToolExecutionDetail>();
		const callsList: ToolExecutionDetail[] = [];
		let callCount = 0;
		let resultCount = 0;
		let startId: number | undefined;
		let endId = message.id;

		const take = (entry: ToolRunMessage) => {
			if (entry.role === "assistant") {
				const calls = entry.toolCalls ?? [];
				if (calls.length === 0) return;
				callCount += calls.length;
				pushUnique(names, toolNamesFrom(entry));
				if (startId === undefined) startId = entry.id;
				endId = entry.id;
				for (let i = 0; i < calls.length; i++) {
					const c = calls[i];
					if (!c) continue;
					const callId = c.id ?? `call_${entry.id}_${i}`;
					const name = c.name ?? c.toolName ?? "tool";
					const detail: ToolExecutionDetail = {
						id: callId,
						name,
						args: c.arguments,
						result: c.result,
						durationMs: c.result?.durationMs,
						isError: c.result?.isError,
					};
					callsMap.set(callId, detail);
					callsList.push(detail);
				}
				return;
			}
			if (entry.role !== "toolResult") return;
			resultCount += 1;
			pushUnique(names, toolNamesFrom(entry));
			if (startId === undefined) startId = entry.id;
			endId = entry.id;

			let existing = entry.toolCallId
				? callsMap.get(entry.toolCallId)
				: undefined;
			if (!existing && entry.toolName) {
				existing = callsList.find(
					(c) => c.name === entry.toolName && c.result === undefined,
				);
			}
			if (existing) {
				existing.result = {
					content: entry.text,
					isError: entry.isError ?? false,
					durationMs: entry.durationMs,
				};
				if (entry.durationMs !== undefined)
					existing.durationMs = entry.durationMs;
				if (entry.isError !== undefined) existing.isError = entry.isError;
			} else {
				const fallbackId = entry.toolCallId ?? `result_${entry.id}`;
				const detail: ToolExecutionDetail = {
					id: fallbackId,
					name: entry.toolName ?? "tool",
					result: {
						content: entry.text,
						isError: entry.isError ?? false,
						durationMs: entry.durationMs,
					},
					durationMs: entry.durationMs,
					isError: entry.isError ?? false,
				};
				if (entry.toolCallId) callsMap.set(entry.toolCallId, detail);
				callsList.push(detail);
			}
		};

		let cursor = index;
		if (message.role === "assistant") {
			take(message);
			cursor = index + 1;
		}
		while (cursor < messages.length) {
			const next = messages[cursor];
			if (!next) break;
			if (next.role === "toolResult") {
				take(next);
				cursor += 1;
				continue;
			}
			if (
				next.role === "assistant" &&
				!next.text.trim() &&
				(next.toolCalls?.length ?? 0) > 0
			) {
				take(next);
				cursor += 1;
				continue;
			}
			break;
		}
		if (names.length > 0 && startId !== undefined) {
			let totalDurationMs: number | undefined;
			let hasError = false;
			for (const call of callsList) {
				if (call.durationMs !== undefined) {
					totalDurationMs = (totalDurationMs ?? 0) + call.durationMs;
				}
				if (call.isError || call.result?.isError) {
					hasError = true;
				}
			}
			items.push({
				type: "tools",
				names,
				count: Math.max(callsList.length, callCount, resultCount),
				startId,
				endId,
				calls: callsList,
				...(totalDurationMs !== undefined ? { totalDurationMs } : {}),
				...(hasError ? { hasError: true } : {}),
			});
		}
		index = Math.max(cursor, index + 1);
	}
	return items;
}
