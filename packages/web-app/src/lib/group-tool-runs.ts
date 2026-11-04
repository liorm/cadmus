export type ToolRunMessage = {
	id: number;
	role: "user" | "assistant" | "system" | "toolResult";
	text: string;
	toolCalls?: Array<{ name?: string; toolName?: string }>;
	toolName?: string;
	timestamp?: number;
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
		let callCount = 0;
		let resultCount = 0;
		let startId: number | undefined;
		let endId = message.id;
		const take = (entry: ToolRunMessage) => {
			if (entry.role === "assistant") {
				const calls = entry.toolCalls?.length ?? 0;
				if (calls === 0) return;
				callCount += calls;
				pushUnique(names, toolNamesFrom(entry));
				if (startId === undefined) startId = entry.id;
				endId = entry.id;
				return;
			}
			if (entry.role !== "toolResult") return;
			resultCount += 1;
			pushUnique(names, toolNamesFrom(entry));
			if (startId === undefined) startId = entry.id;
			endId = entry.id;
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
			items.push({
				type: "tools",
				names,
				count: Math.max(callCount, resultCount),
				startId,
				endId,
			});
		}
		index = Math.max(cursor, index + 1);
	}
	return items;
}
