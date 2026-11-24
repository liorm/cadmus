import type { UsageState } from "@earendil-works/pi-durable";
import type {
	ChatRecord,
	UsageBucket,
	UsageCost,
	UsageSources,
	UsageSummary,
} from "./protocol.js";
import type { FamilyStore } from "./store/family-interface.js";

export function createEmptyUsageBucket(): UsageBucket {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		reasoning: 0,
		totalTokens: 0,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		},
	};
}

export function createEmptyUsageSummary(): UsageSummary {
	return {
		totals: createEmptyUsageBucket(),
		sources: {
			direct: createEmptyUsageBucket(),
			harvest: createEmptyUsageBucket(),
			schedules: createEmptyUsageBucket(),
			botMessages: createEmptyUsageBucket(),
			search: createEmptyUsageBucket(),
		},
		models: {},
		tools: {},
	};
}

export function accumulateUsageBucket(
	target: UsageBucket,
	item:
		| {
				input?: number;
				output?: number;
				cacheRead?: number;
				cacheWrite?: number;
				reasoning?: number;
				totalTokens?: number;
				cost?: Partial<UsageCost>;
		  }
		| undefined,
): void {
	if (!item) return;
	target.input += item.input ?? 0;
	target.output += item.output ?? 0;
	target.cacheRead += item.cacheRead ?? 0;
	target.cacheWrite += item.cacheWrite ?? 0;
	if (item.reasoning !== undefined) {
		target.reasoning = (target.reasoning ?? 0) + item.reasoning;
	}
	target.totalTokens += item.totalTokens ?? 0;
	if (item.cost) {
		target.cost.input += item.cost.input ?? 0;
		target.cost.output += item.cost.output ?? 0;
		target.cost.cacheRead += item.cost.cacheRead ?? 0;
		target.cost.cacheWrite += item.cost.cacheWrite ?? 0;
		target.cost.total += item.cost.total ?? 0;
	}
}

export function accumulateUsageState(
	target: UsageSummary,
	sourceKey: keyof UsageSources,
	state: Readonly<UsageState> | undefined,
): void {
	if (!state) return;
	const sourceBucket = target.sources[sourceKey];
	const models = state.models ?? {};
	for (const [modelKey, modelUsage] of Object.entries(models)) {
		if (!modelUsage) continue;
		let modelBucket = target.models[modelKey];
		if (!modelBucket) {
			modelBucket = createEmptyUsageBucket();
			target.models[modelKey] = modelBucket;
		}
		accumulateUsageBucket(modelBucket, modelUsage as unknown as UsageBucket);
		if (sourceBucket) {
			accumulateUsageBucket(sourceBucket, modelUsage as unknown as UsageBucket);
		}
		accumulateUsageBucket(target.totals, modelUsage as unknown as UsageBucket);
	}
	const tools = state.tools ?? {};
	for (const [toolKey, toolUsage] of Object.entries(tools)) {
		if (!toolUsage) continue;
		let toolBucket = target.tools[toolKey];
		if (!toolBucket) {
			toolBucket = createEmptyUsageBucket();
			target.tools[toolKey] = toolBucket;
		}
		accumulateUsageBucket(toolBucket, toolUsage as unknown as UsageBucket);
		if (sourceBucket) {
			accumulateUsageBucket(sourceBucket, toolUsage as unknown as UsageBucket);
		}
		accumulateUsageBucket(target.totals, toolUsage as unknown as UsageBucket);
	}
}

export function accumulateSummary(
	target: UsageSummary,
	source: UsageSummary,
): void {
	accumulateUsageBucket(target.totals, source.totals);
	for (const key of Object.keys(source.sources) as (keyof UsageSources)[]) {
		const targetBucket = target.sources[key];
		const srcBucket = source.sources[key];
		if (targetBucket && srcBucket) {
			accumulateUsageBucket(targetBucket, srcBucket);
		}
	}
	for (const [modelKey, modelBucket] of Object.entries(source.models)) {
		if (!modelBucket) continue;
		let targetBucket = target.models[modelKey];
		if (!targetBucket) {
			targetBucket = createEmptyUsageBucket();
			target.models[modelKey] = targetBucket;
		}
		accumulateUsageBucket(targetBucket, modelBucket);
	}
	for (const [toolKey, toolBucket] of Object.entries(source.tools)) {
		if (!toolBucket) continue;
		let targetBucket = target.tools[toolKey];
		if (!targetBucket) {
			targetBucket = createEmptyUsageBucket();
			target.tools[toolKey] = targetBucket;
		}
		accumulateUsageBucket(targetBucket, toolBucket);
	}
}

export async function computeChatUsage(
	chat: ChatRecord,
	store: FamilyStore,
	readUsageState: (conversationId: number) => Promise<UsageState | undefined>,
): Promise<UsageSummary> {
	const summary = createEmptyUsageSummary();
	const directRoutes = store.chats.listConversationRoutes(chat.key);
	const childChats = store.chats.listChildChats(chat.key);

	const seenConvIds = new Set<number>();

	for (const route of directRoutes) {
		if (seenConvIds.has(route.conversationId)) continue;
		seenConvIds.add(route.conversationId);
		const state = await readUsageState(route.conversationId);
		let source: keyof UsageSources;
		if (route.kind === "harvest") {
			source = "harvest";
		} else if (route.kind === "search") {
			source = "search";
		} else if (route.kind === "schedules") {
			source = "schedules";
		} else if (chat.key.startsWith("gmem:") || chat.kind === "group-member") {
			source = "botMessages";
		} else if (chat.kind === "scheduled") {
			source = "schedules";
		} else {
			source = "direct";
		}
		accumulateUsageState(summary, source, state);
	}

	for (const child of childChats) {
		const childRoutes = store.chats.listConversationRoutes(child.key);
		for (const route of childRoutes) {
			if (seenConvIds.has(route.conversationId)) continue;
			seenConvIds.add(route.conversationId);
			const state = await readUsageState(route.conversationId);
			let source: keyof UsageSources;
			if (route.kind === "harvest") {
				source = "harvest";
			} else if (route.kind === "search") {
				source = "search";
			} else if (route.kind === "schedules") {
				source = "schedules";
			} else if (
				child.key.startsWith("gmem:") ||
				child.kind === "group-member"
			) {
				source = "botMessages";
			} else if (child.kind === "scheduled") {
				source = "schedules";
			} else {
				source = "botMessages";
			}
			accumulateUsageState(summary, source, state);
		}
	}

	return summary;
}

export async function computeBotUsage(
	botId: string,
	store: FamilyStore,
	readUsageState: (conversationId: number) => Promise<UsageState | undefined>,
): Promise<UsageSummary> {
	const summary = createEmptyUsageSummary();
	const allChats = store.chats.listChats({ botId });
	// Top-level chats are direct/scheduled chats not initiated as children of another chat
	for (const chat of allChats) {
		if (
			chat.originChatKey ||
			chat.key.startsWith("gmem:") ||
			chat.kind === "group-member"
		) {
			continue;
		}
		const chatUsage = await computeChatUsage(chat, store, readUsageState);
		accumulateSummary(summary, chatUsage);
	}
	return summary;
}
