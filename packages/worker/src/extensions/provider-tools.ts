import { CODE_EXECUTE_TOOL_NAME } from "@cadmus/contract/tools";
import type { Message } from "@earendil-works/pi-ai";

const PROVIDER_TOOL_SINK = Symbol.for("cadmus.providerToolCapture");

export interface ProviderToolCapture {
	botId: string;
	tools: string[];
}

/**
 * Test seam. Production leaves the sink unset, and the request path
 * records nothing. E2E installs it on `globalThis` for one turn.
 */
export function installProviderToolCapture(): ProviderToolCapture[] {
	const sink: ProviderToolCapture[] = [];
	(globalThis as Record<symbol, ProviderToolCapture[]>)[PROVIDER_TOOL_SINK] =
		sink;
	return sink;
}

export function clearProviderToolCapture(): void {
	delete (globalThis as Record<symbol, ProviderToolCapture[] | undefined>)[
		PROVIDER_TOOL_SINK
	];
}

export function noteProviderTools(
	botId: string,
	tools: readonly string[],
): void {
	const sink = (
		globalThis as Record<symbol, ProviderToolCapture[] | undefined>
	)[PROVIDER_TOOL_SINK];
	sink?.push({ botId, tools: [...tools] });
}

/**
 * Copy of the provider transcript with `code.execute` taken out of every
 * `toolsAdded` delta. The stored transcript is left as it is. Tool
 * resolution still sees the registered tool, so the tool gate can block
 * a call the model makes anyway.
 */
export function omitCodeExecuteFromProviderMessages(
	messages: readonly Message[],
): readonly Message[] {
	let changed = false;
	const next = messages.map((message) => {
		if (message.role !== "system" || !message.toolsAdded) return message;
		if (
			!message.toolsAdded.some((tool) => tool.name === CODE_EXECUTE_TOOL_NAME)
		) {
			return message;
		}
		changed = true;
		return {
			...message,
			toolsAdded: message.toolsAdded.filter(
				(tool) => tool.name !== CODE_EXECUTE_TOOL_NAME,
			),
		};
	});
	return changed ? next : messages;
}

/** Tool names in effect after replaying system-message tool deltas. */
export function providerToolNames(messages: readonly Message[]): string[] {
	const tools = new Map<string, true>();
	for (const message of messages) {
		if (message.role !== "system") continue;
		for (const tool of message.toolsRemoved ?? []) tools.delete(tool.name);
		for (const tool of message.toolsAdded ?? []) tools.set(tool.name, true);
	}
	return [...tools.keys()];
}
