import {
	calculateContextTokens,
	estimateMessageTokens,
} from "@earendil-works/pi-ai/utils/estimate";
import {
	CompactionTask,
	type ContextView,
	defineExtension,
	hook,
} from "@earendil-works/pi-durable";
import { requireCadmusServices } from "../context.js";
import type { CompactionPolicy } from "../protocol.js";
import type { CadmusExtensionDescriptor } from "./cadmus-tools.js";

export const DEFAULT_CADMUS_COMPACTION_POLICY: CompactionPolicy = {
	enabled: true,
	reserveTokens: 16_384,
	keepRecentTokens: 20_000,
	backgroundTokens: 32_768,
};

export const COMPACTION_SUMMARY_PREFIX =
	"The conversation history before this point was compacted into the following summary:\n\n<summary>\n";
export const COMPACTION_SUMMARY_SUFFIX = "\n</summary>";

/**
 * Removes pi-durable's `<summary>` prompt wrapper when projecting compaction
 * entries into TranscriptMessageView.
 */
export function stripCompactionSummaryWrapper(text: string): string {
	let result = text;
	if (result.startsWith(COMPACTION_SUMMARY_PREFIX)) {
		result = result.slice(COMPACTION_SUMMARY_PREFIX.length);
	}
	if (result.endsWith(COMPACTION_SUMMARY_SUFFIX)) {
		result = result.slice(0, -COMPACTION_SUMMARY_SUFFIX.length);
	}
	return result.trim();
}

/**
 * Estimates total active context tokens for a `ContextView`, matching
 * `pi-durable`'s `estimateContext(view, [])` algorithm.
 */
export function estimateViewContextTokens(view: ContextView): number {
	let measured:
		| { role: "assistant"; usage: Parameters<typeof calculateContextTokens>[0] }
		| undefined;
	const after = view.head?.id ?? Number.NEGATIVE_INFINITY;
	for (
		let index = view.entries.length - 1;
		index >= 0 && measured === undefined;
		index--
	) {
		const entry = view.entries[index];
		if (!entry || entry.id <= after) continue;
		const contribs = view.contributions[index] ?? [];
		for (let j = contribs.length - 1; j >= 0; j--) {
			const msg = contribs[j];
			if (
				msg &&
				msg.role === "assistant" &&
				calculateContextTokens(msg.usage) > 0
			) {
				measured = msg;
				break;
			}
		}
	}
	const from =
		measured === undefined
			? 0
			: view.messages.lastIndexOf(measured as (typeof view.messages)[number]) +
				1;
	let tokens =
		measured === undefined ? 0 : calculateContextTokens(measured.usage);
	for (const message of view.messages.slice(from)) {
		tokens += estimateMessageTokens(message);
	}
	return tokens;
}

export function compactionExtension() {
	return defineExtension({
		name: "cadmus.compaction",
		hooks: [
			hook(CompactionTask, {
				async beforeCompact(_compaction, api, context) {
					const services = requireCadmusServices(context);
					const route = services.familyStore.chats.getConversationRoute(
						api.conversationId as unknown as number,
					);
					if (route?.kind === "harvest" || route?.kind === "search") {
						return { decline: true };
					}
					return undefined;
				},
			}),
		],
	});
}

export function compactionExtensionDescriptor(): CadmusExtensionDescriptor {
	return {
		extension: compactionExtension(),
		defaultEnabled: true,
		allowlistPolicy: { mode: "always" },
		isActive: () => true,
	};
}
