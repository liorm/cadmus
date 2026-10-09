import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type AgentChange, AgentDoc, configure, type Harness } from "@earendil-works/pi-durable";
import { listChats } from "../channels/telegram/chats.ts";
import { reconcileInterrupted } from "../channels/telegram/deliver.ts";
import type { Logger } from "../log.ts";

/**
 * Restart policy ("restart any time", pi-imessage ADR 0038/0041):
 * 1. Before anything runs, receipts left `sending` become `unknown` and are never resent.
 * 2. Chat conversations follow the configured model (env may have changed between runs).
 * 3. `harness.resume()` continues every unfinished run and task; final answers they produce are delivered normally.
 * Phase 0 has no tools, so there are no stale processes to kill yet.
 */
export async function runStartup(harness: Harness, agent: AgentChange, log: Logger) {
	const unknown = await reconcileInterrupted(harness, log);
	for (const chat of await listChats(harness)) {
		const stored = await harness.snapshot(AgentDoc, chat.conversationId, BACKGROUND_CONTEXT);
		const want = agent.model;
		const same =
			want && stored?.model?.provider === want.provider && stored.model.modelId === want.modelId && stored.thinkingLevel === (agent.thinkingLevel ?? undefined);
		if (want && !same) {
			await harness.commit((tx) => configure(tx, chat.conversationId, agent), BACKGROUND_CONTEXT);
			log.info(`Chat ${chat.key} now uses ${want.provider}/${want.modelId}`);
		}
	}
	harness.resume();
	return { unknown };
}
