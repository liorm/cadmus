export interface MessageBotArgs {
	slug?: string;
	to?: string[];
	topic?: string;
	text?: string;
	readOnly?: boolean;
	wait?: boolean;
}

export interface GroupChatMessage {
	fromBotId: string;
	text: string;
	at: number;
}

export interface MessageBotResult {
	ok: boolean;
	status?: "ended" | "capped" | "timed_out" | "pending";
	groupId?: string;
	topic?: string;
	members?: string[];
	response?: string;
	transcript?: GroupChatMessage[];
	error?: string;
}

export function parseMessageBotArgs(args: unknown): MessageBotArgs | null {
	if (!args || typeof args !== "object") return null;
	const a = args as Record<string, unknown>;
	return {
		slug: typeof a.slug === "string" ? a.slug : undefined,
		to: Array.isArray(a.to)
			? a.to.filter((t): t is string => typeof t === "string")
			: undefined,
		topic: typeof a.topic === "string" ? a.topic : undefined,
		text: typeof a.text === "string" ? a.text : undefined,
		readOnly: typeof a.readOnly === "boolean" ? a.readOnly : undefined,
		wait: typeof a.wait === "boolean" ? a.wait : undefined,
	};
}

export function parseMessageBotResult(raw: unknown): MessageBotResult | null {
	if (!raw) return null;
	let parsed: unknown = raw;
	if (typeof raw === "string") {
		try {
			parsed = JSON.parse(raw);
		} catch {
			return null;
		}
	}
	if (!parsed || typeof parsed !== "object") return null;
	const r = parsed as Record<string, unknown>;
	if (typeof r.ok !== "boolean") return null;

	const transcript: GroupChatMessage[] = [];
	if (Array.isArray(r.transcript)) {
		for (const item of r.transcript) {
			if (item && typeof item === "object") {
				const entry = item as Record<string, unknown>;
				if (
					typeof entry.fromBotId === "string" &&
					typeof entry.text === "string"
				) {
					transcript.push({
						fromBotId: entry.fromBotId,
						text: entry.text,
						at: typeof entry.at === "number" ? entry.at : Date.now(),
					});
				}
			}
		}
	}

	return {
		ok: r.ok,
		status:
			r.status === "ended" ||
			r.status === "capped" ||
			r.status === "timed_out" ||
			r.status === "pending"
				? r.status
				: undefined,
		groupId: typeof r.groupId === "string" ? r.groupId : undefined,
		topic: typeof r.topic === "string" ? r.topic : undefined,
		members: Array.isArray(r.members)
			? r.members.filter((m): m is string => typeof m === "string")
			: undefined,
		response: typeof r.response === "string" ? r.response : undefined,
		transcript: transcript.length > 0 ? transcript : undefined,
		error: typeof r.error === "string" ? r.error : undefined,
	};
}
