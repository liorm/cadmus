import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	AgentDoc,
	configure,
	type Harness,
	type RegistryReader,
} from "@earendil-works/pi-durable";
import { botDir, DEFAULT_BOT_ID, listBots } from "../channels/bots.ts";
import { listChats } from "../channels/chats.ts";
import { getLogger } from "../log.ts";
import { parseModelRef, parseThinkingLevel } from "./models.ts";
import { syncChatTools } from "./tool-policy.ts";

/**
 * Restart policy ("restart any time"):
 * 1. Each chat follows the tool list stored on its bot. A conversation that has no model yet takes its bot's model, thinking level, and folder. One that already has a model keeps it.
 * 2. The caller resumes unfinished runs after schedule services exist.
 * `write` and `edit` stay replay-unsafe, so an interrupted call runs again rather than being skipped.
 */
export async function runStartup(
	harness: Harness,
	options: { home: string; registry: RegistryReader },
): Promise<void> {
	const log = getLogger();
	const bots = new Map((await listBots(harness)).map((bot) => [bot.id, bot]));
	for (const chat of await listChats(harness)) {
		const owner = bots.get(chat.botId ?? DEFAULT_BOT_ID);
		if (!owner) continue;
		await syncChatTools(harness, chat.conversationId, owner, options.registry);
		const stored = await harness.snapshot(
			AgentDoc,
			chat.conversationId,
			BACKGROUND_CONTEXT,
		);
		if (stored?.model) continue;
		const model = parseModelRef(owner.model);
		await harness.commit(
			(tx) =>
				configure(tx, chat.conversationId, {
					model,
					thinkingLevel: parseThinkingLevel(owner.thinking) ?? null,
					cwd: botDir(options.home, owner.id),
				}),
			BACKGROUND_CONTEXT,
		);
		log.debug(`Chat ${chat.key} now uses ${model.provider}/${model.modelId}`);
	}
}
