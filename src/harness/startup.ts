import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, configure, type Harness } from "@earendil-works/pi-durable";
import {
	botDir,
	DEFAULT_BOT_ID,
	ensureDefaultBotDoc,
	ensureDefaultBotFiles,
	listBots,
} from "../channels/bots.ts";
import { listChats, migrateLegacyChats } from "../channels/telegram/chats.ts";
import { reconcileInterrupted } from "../channels/telegram/deliver.ts";
import { getLogger } from "../log.ts";
import {
	type ModelConfig,
	parseModelRef,
	parseThinkingLevel,
} from "./models.ts";

/**
 * Restart policy ("restart any time"):
 * 1. Before anything runs, receipts left `sending` become `unknown` and are never resent.
 * 2. The default bot's files and row exist. Legacy chat keys are rewritten in one commit, keeping their conversations.
 * 3. Chats of `default` follow its model, thinking, and folder. `default` was just refreshed from env.
 *    Other bots keep the model and thinking their conversations were created with.
 * 4. `harness.resume()` continues every unfinished run and task; final answers they produce are delivered normally.
 * `write` and `edit` stay replay-unsafe, so an interrupted call runs again rather than being skipped.
 */
export async function runStartup(
	harness: Harness,
	options: { home: string; model: ModelConfig },
) {
	const log = getLogger();
	const unknown = await reconcileInterrupted(harness);
	await ensureDefaultBotFiles(options.home);
	await ensureDefaultBotDoc(harness, options.model);
	await migrateLegacyChats(harness);
	const bots = new Map((await listBots(harness)).map((bot) => [bot.id, bot]));
	for (const chat of await listChats(harness)) {
		// `default` follows the env model on every start. Other bots keep the model their chats were created with.
		if ((chat.botId ?? DEFAULT_BOT_ID) !== DEFAULT_BOT_ID) continue;
		const bot = bots.get(DEFAULT_BOT_ID);
		if (!bot) continue;
		const want = parseModelRef(bot.model);
		const thinking = parseThinkingLevel(bot.thinking);
		const cwd = botDir(options.home, bot.id);
		const stored = await harness.snapshot(
			AgentDoc,
			chat.conversationId,
			BACKGROUND_CONTEXT,
		);
		const same =
			stored?.model?.provider === want.provider &&
			stored.model.modelId === want.modelId &&
			stored.thinkingLevel === thinking &&
			stored.cwd === cwd;
		if (!same) {
			await harness.commit(
				(tx) =>
					configure(tx, chat.conversationId, {
						model: want,
						thinkingLevel: thinking ?? null,
						cwd,
					}),
				BACKGROUND_CONTEXT,
			);
			log.info(`Chat ${chat.key} now uses ${want.provider}/${want.modelId}`);
		}
	}
	harness.resume();
	return { unknown };
}
