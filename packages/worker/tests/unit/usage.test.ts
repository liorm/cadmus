import type { UsageState } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import type { ChatRecord } from "../../src/protocol.js";
import type { FamilyStore } from "../../src/store/family-interface.js";
import {
	accumulateUsageBucket,
	accumulateUsageState,
	computeBotUsage,
	computeChatUsage,
	createEmptyUsageBucket,
	createEmptyUsageSummary,
} from "../../src/usage.js";

describe("usage aggregation", () => {
	it("initializes empty buckets and summaries with zero counters", () => {
		const bucket = createEmptyUsageBucket();
		expect(bucket.input).toBe(0);
		expect(bucket.output).toBe(0);
		expect(bucket.cacheRead).toBe(0);
		expect(bucket.cacheWrite).toBe(0);
		expect(bucket.reasoning).toBe(0);
		expect(bucket.totalTokens).toBe(0);
		expect(bucket.cost.total).toBe(0);

		const summary = createEmptyUsageSummary();
		expect(summary.totals.totalTokens).toBe(0);
		expect(summary.sources.direct.totalTokens).toBe(0);
		expect(summary.sources.harvest.totalTokens).toBe(0);
		expect(summary.sources.schedules.totalTokens).toBe(0);
		expect(summary.sources.botMessages.totalTokens).toBe(0);
		expect(summary.sources.search.totalTokens).toBe(0);
		expect(Object.keys(summary.models)).toHaveLength(0);
	});

	it("accumulates usage buckets with optional reasoning and cost", () => {
		const target = createEmptyUsageBucket();
		accumulateUsageBucket(target, {
			input: 100,
			output: 50,
			cacheRead: 20,
			cacheWrite: 10,
			reasoning: 15,
			totalTokens: 180,
			cost: {
				input: 0.001,
				output: 0.002,
				cacheRead: 0.0001,
				cacheWrite: 0.0002,
				total: 0.0033,
			},
		});
		expect(target.input).toBe(100);
		expect(target.output).toBe(50);
		expect(target.reasoning).toBe(15);
		expect(target.totalTokens).toBe(180);
		expect(target.cost.total).toBeCloseTo(0.0033);

		accumulateUsageBucket(target, {
			input: 50,
			output: 25,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 75,
			cost: { total: 0.001 },
		});
		expect(target.input).toBe(150);
		expect(target.output).toBe(75);
		expect(target.reasoning).toBe(15);
		expect(target.totalTokens).toBe(255);
		expect(target.cost.total).toBeCloseTo(0.0043);
	});

	it("accumulates UsageState into targeted source and models", () => {
		const summary = createEmptyUsageSummary();
		const state: UsageState = {
			models: {
				"faux/echo": {
					input: 200,
					output: 80,
					cacheRead: 0,
					cacheWrite: 0,
					reasoning: 20,
					totalTokens: 280,
					cost: {
						input: 0.002,
						output: 0.004,
						cacheRead: 0,
						cacheWrite: 0,
						total: 0.006,
					},
				},
			},
			tools: {
				web_fetch: {
					input: 50,
					output: 10,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 60,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			},
		};

		accumulateUsageState(summary, "direct", state);
		expect(summary.totals.totalTokens).toBe(340);
		expect(summary.sources.direct.totalTokens).toBe(340);
		expect(summary.sources.harvest.totalTokens).toBe(0);
		expect(summary.models["faux/echo"]?.totalTokens).toBe(280);
	});

	it("computes chat usage across direct, harvest, search, schedules, and child bot chats", async () => {
		const chat: ChatRecord = {
			key: "chat-1",
			botId: "bot-a",
			conversationId: 1,
			createdAt: 1000,
			kind: "direct",
		};

		const childGroupChat: ChatRecord = {
			key: "gmem:group-1:bot-b",
			botId: "bot-b",
			conversationId: 4,
			createdAt: 1002,
			kind: "group-member",
			originChatKey: "chat-1",
		};

		const routes = [
			{
				conversationId: 1,
				chatKey: "chat-1",
				botId: "bot-a",
				toolsEnvEnabled: true,
				kind: "direct" as const,
			},
			{
				conversationId: 2,
				chatKey: "chat-1",
				botId: "bot-a",
				toolsEnvEnabled: false,
				kind: "harvest" as const,
			},
			{
				conversationId: 3,
				chatKey: "chat-1",
				botId: "bot-a",
				toolsEnvEnabled: false,
				kind: "search" as const,
			},
		];

		const childRoutes = [
			{
				conversationId: 4,
				chatKey: childGroupChat.key,
				botId: "bot-b",
				toolsEnvEnabled: false,
				kind: "direct" as const,
			},
		];

		const usageMap: Record<number, UsageState> = {
			1: {
				models: {
					"faux/echo": {
						input: 100,
						output: 50,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 150,
						cost: {
							input: 0.001,
							output: 0.001,
							cacheRead: 0,
							cacheWrite: 0,
							total: 0.002,
						},
					},
				},
				tools: {},
			},
			2: {
				models: {
					"faux/echo": {
						input: 40,
						output: 20,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 60,
						cost: {
							input: 0.0004,
							output: 0.0004,
							cacheRead: 0,
							cacheWrite: 0,
							total: 0.0008,
						},
					},
				},
				tools: {},
			},
			3: {
				models: {
					"faux/echo": {
						input: 30,
						output: 10,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 40,
						cost: {
							input: 0.0003,
							output: 0.0002,
							cacheRead: 0,
							cacheWrite: 0,
							total: 0.0005,
						},
					},
				},
				tools: {},
			},
			4: {
				models: {
					"faux/echo": {
						input: 80,
						output: 40,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 120,
						cost: {
							input: 0.0008,
							output: 0.0008,
							cacheRead: 0,
							cacheWrite: 0,
							total: 0.0016,
						},
					},
				},
				tools: {},
			},
		};

		const mockStore = {
			chats: {
				listConversationRoutes: (key: string) =>
					key === "chat-1" ? routes : childRoutes,
				listChildChats: (originKey: string) =>
					originKey === "chat-1" ? [childGroupChat] : [],
				listChats: () => [chat, childGroupChat],
			},
		} as unknown as FamilyStore;

		const usage = await computeChatUsage(
			chat,
			mockStore,
			async (id) => usageMap[id],
		);

		expect(usage.sources.direct.totalTokens).toBe(150);
		expect(usage.sources.harvest.totalTokens).toBe(60);
		expect(usage.sources.search.totalTokens).toBe(40);
		expect(usage.sources.botMessages.totalTokens).toBe(120);
		expect(usage.sources.schedules.totalTokens).toBe(0);
		expect(usage.totals.totalTokens).toBe(150 + 60 + 40 + 120);
		expect(usage.totals.cost.total).toBeCloseTo(
			0.002 + 0.0008 + 0.0005 + 0.0016,
		);
		expect(usage.models["faux/echo"]?.totalTokens).toBe(370);

		// Bot usage attribution
		const botUsage = await computeBotUsage(
			"bot-a",
			mockStore,
			async (id) => usageMap[id],
		);
		expect(botUsage.totals.totalTokens).toBe(usage.totals.totalTokens);
		expect(botUsage.totals.cost.total).toBeCloseTo(usage.totals.cost.total);
	});
});
