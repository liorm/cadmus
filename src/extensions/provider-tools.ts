import type { AssistantMessage, JsonObject } from "@earendil-works/pi-ai";

/**
 * Server tools a provider runs inside the model request. A catalog name stays a
 * function so the tool toggle can drop it. `attachNativeTools` swaps that
 * function for the provider's tool object before the request is sent.
 */
const NATIVE_TOOLS: Readonly<
	Record<string, Readonly<Record<string, { type: string }>>>
> = {
	xai: {
		"web.search": { type: "web_search" },
		"x.search": { type: "x_search" },
		"code.execute": { type: "code_interpreter" },
	},
};

export function unavailableToolMessage(name: string, provider: string): string {
	return `${name} is not available on provider "${provider}"`;
}

function functionName(tool: unknown): string | undefined {
	if (!tool || typeof tool !== "object") return undefined;
	const record = tool as { type?: unknown; name?: unknown };
	if (record.type !== "function" || typeof record.name !== "string")
		return undefined;
	return record.name;
}

/**
 * Rewrite a Responses request body. Other payloads, and providers with no
 * native tools, come back unchanged.
 */
export function attachNativeTools(provider: string, payload: unknown): unknown {
	const native = NATIVE_TOOLS[provider];
	if (
		!native ||
		!payload ||
		typeof payload !== "object" ||
		Array.isArray(payload)
	)
		return payload;
	const body = payload as { tools?: unknown };
	if (!Array.isArray(body.tools)) return payload;
	const tools: unknown[] = [];
	const added = new Set<string>();
	for (const tool of body.tools) {
		const name = functionName(tool);
		const replacement = name ? native[name] : undefined;
		if (!replacement) {
			tools.push(tool);
			continue;
		}
		if (!added.has(replacement.type)) {
			tools.push(replacement);
			added.add(replacement.type);
		}
	}
	return { ...body, tools };
}

/**
 * A provider server tool, kept on the assistant message so the transcript can
 * show it. `type` is not `toolCall`: the harness must not run it again, and
 * pi-ai skips unknown parts when it replays the message.
 */
export type ServerToolPart = {
	type: "serverTool";
	id: string;
	name: string;
	arguments: JsonObject;
	status: "done" | "error";
	result?: string;
};

const SERVER_ITEM_TYPES = new Set([
	"web_search_call",
	"x_search_call",
	"code_interpreter_call",
	"file_search_call",
	"mcp_call",
]);

/** Record server-side tool items from one provider stream event. Later events replace the same id. */
export function noteServerTool(
	found: Map<string, ServerToolPart>,
	event: unknown,
): void {
	if (!event || typeof event !== "object") return;
	const record = event as { item?: unknown; response?: { output?: unknown } };
	considerServerItem(found, record.item);
	const output = record.response?.output;
	if (!Array.isArray(output)) return;
	for (const item of output) considerServerItem(found, item);
}

/** Append recorded server tools that are not already on the message. */
export function applyServerTools(
	message: AssistantMessage,
	found: ReadonlyMap<string, ServerToolPart>,
): void {
	if (found.size === 0 || !Array.isArray(message.content)) return;
	const seen = new Set(
		message.content.flatMap((part) =>
			part &&
			typeof part === "object" &&
			"id" in part &&
			typeof part.id === "string"
				? [part.id]
				: [],
		),
	);
	for (const call of found.values()) {
		if (seen.has(call.id)) continue;
		seen.add(call.id);
		message.content.push(
			call as unknown as AssistantMessage["content"][number],
		);
	}
}

function considerServerItem(
	found: Map<string, ServerToolPart>,
	item: unknown,
): void {
	if (!item || typeof item !== "object") return;
	const record = item as {
		type?: unknown;
		id?: unknown;
		name?: unknown;
		status?: unknown;
		action?: unknown;
		result?: unknown;
		output?: unknown;
		error?: unknown;
	};
	if (typeof record.type !== "string" || !SERVER_ITEM_TYPES.has(record.type))
		return;
	const name = serverToolName(record.type, record.action, record.name);
	if (!name) return;
	const id =
		typeof record.id === "string" ? record.id : `${record.type}:${name}`;
	const failed = record.status === "failed" || record.error !== undefined;
	const result = serverToolResult(record);
	found.set(id, {
		type: "serverTool",
		id,
		name,
		arguments: serverToolArguments(record.action),
		status: failed ? "error" : "done",
		...(result ? { result } : {}),
	});
}

function serverToolName(
	type: string,
	action: unknown,
	name: unknown,
): string | undefined {
	if (type === "web_search_call") {
		const kind =
			action && typeof action === "object"
				? (action as { type?: unknown }).type
				: undefined;
		return kind === "open_page" || kind === "find_in_page"
			? "web.fetch"
			: "web.search";
	}
	if (type === "x_search_call") return "x.search";
	if (type === "code_interpreter_call") return "code.execute";
	if (type === "file_search_call") return "collections.search";
	if (type === "mcp_call") return typeof name === "string" ? name : "mcp";
	return undefined;
}

function serverToolArguments(action: unknown): JsonObject {
	if (!action || typeof action !== "object" || Array.isArray(action)) return {};
	return action as JsonObject;
}

function serverToolResult(record: {
	result?: unknown;
	output?: unknown;
	error?: unknown;
}): string | undefined {
	for (const value of [record.result, record.output, record.error]) {
		if (typeof value === "string" && value.trim()) return value;
		if (value && typeof value === "object") return JSON.stringify(value);
	}
	return undefined;
}
