import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	AgentDoc,
	type ConversationId,
	configure,
	type Harness,
	type RegistryReader,
	type ToolRegistration,
} from "@earendil-works/pi-durable";
import { toolNames } from "../channels/bot-catalog.ts";

/** Names the agent may call. `null` means every registered tool. */
export function agentToolChange(
	bot: {
		tools?: readonly string[];
	},
	registry: RegistryReader,
): ToolRegistration[] | null {
	if (bot.tools === undefined) return null;
	const allow = new Set(bot.tools);
	return toolNames(registry)
		.filter((name) => allow.has(name))
		.map((name) => ({ name }) as ToolRegistration);
}

function sameTools(
	stored: readonly string[] | { remove: readonly string[] } | undefined,
	next: readonly string[] | null,
): boolean {
	if (next === null) return stored === undefined;
	if (!Array.isArray(stored) || stored.length !== next.length) return false;
	return stored.every((name, index) => name === next[index]);
}

/** Write this bot's tool list onto one conversation. A missing list clears the filter. */
export async function syncChatTools(
	harness: Harness,
	conversationId: ConversationId,
	bot: { tools?: readonly string[] },
	registry: RegistryReader,
): Promise<void> {
	const next = agentToolChange(bot, registry);
	const names = next === null ? null : next.map((tool) => tool.name);
	const stored = await harness.snapshot(
		AgentDoc,
		conversationId,
		BACKGROUND_CONTEXT,
	);
	if (sameTools(stored?.tools, names)) return;
	await harness.commit(
		(tx) =>
			configure(tx, conversationId, {
				tools: next === null ? null : next,
			}),
		BACKGROUND_CONTEXT,
	);
}

/** Enabled names for a client. An omitted bot list is every catalog tool. */
export function resolvedEnabled(
	bot: { tools?: readonly string[] },
	registry: RegistryReader,
): string[] {
	const all = toolNames(registry);
	if (bot.tools === undefined) return [...all];
	const allow = new Set(bot.tools);
	return all.filter((name) => allow.has(name));
}
