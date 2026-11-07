import {
	env,
	runDurableObjectAlarm,
	runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { ChatRecord, ChatStatusRecord } from "../src/protocol.js";
import { sendRpc, uniqueAccountId } from "./helpers.js";

async function callRpc<T>(
	type: string,
	payload: unknown,
	scope: { accountId: string; familyId: string },
): Promise<T> {
	const res = await sendRpc<T>(type, payload as Record<string, unknown>, scope);
	expect(res.frame.ok).toBe(true);
	return res.frame.result as T;
}

describe("Token Usage and Status Attribution", () => {
	it("returns token usage breakdown and respects conservation invariant", async () => {
		const scope = {
			accountId: uniqueAccountId("usage-status"),
			familyId: "default",
		};

		// 1. Create bot and chat
		await callRpc(
			"bot.create",
			{ slug: "scribe", name: "Scribe", model: "faux/echo" },
			scope,
		);
		await callRpc("chat.create", { botId: "scribe", key: "main" }, scope);

		// Initial status: usage exists with 0 tokens
		const initial = await callRpc<{ status: ChatStatusRecord }>(
			"chat.status",
			{ chatKey: "main" },
			scope,
		);
		expect(initial.status.usage).toBeDefined();
		expect(initial.status.usage.totals.totalTokens).toBe(0);
		expect(initial.status.botUsage).toBeDefined();
		expect(initial.status.botUsage.totals.totalTokens).toBe(0);

		// 2. Submit a turn
		await callRpc(
			"turn.submit",
			{ chatKey: "main", text: "Hello Scribe!" },
			scope,
		);

		const afterTurn = await callRpc<{ status: ChatStatusRecord }>(
			"chat.status",
			{ chatKey: "main" },
			scope,
		);
		const turnTokens = afterTurn.status.usage.totals.totalTokens;
		expect(turnTokens).toBeGreaterThan(0);
		expect(afterTurn.status.usage.sources.direct.totalTokens).toBe(turnTokens);
		expect(afterTurn.status.usage.sources.harvest.totalTokens).toBe(0);
		expect(afterTurn.status.usage.sources.botMessages.totalTokens).toBe(0);
		expect(afterTurn.status.usage.sources.search.totalTokens).toBe(0);
		expect(afterTurn.status.usage.sources.schedules.totalTokens).toBe(0);
		expect(afterTurn.status.usage.models["faux/echo"]?.totalTokens).toBe(
			turnTokens,
		);
		expect(afterTurn.status.botUsage.totals.totalTokens).toBe(turnTokens);

		// 3. Harvest run: prompt with [learn:rules Some test rule] and trigger DO alarm
		await callRpc(
			"turn.submit",
			{
				chatKey: "main",
				text: "Please learn this [learn:rules Some knowledge body]",
			},
			scope,
		);

		const stub = env.CADMUS_BOT_FAMILY.get(
			env.CADMUS_BOT_FAMILY.idFromName(
				`cadmus:${scope.accountId}:${scope.familyId}`,
			),
		);
		await callRpc(
			"schedule.update",
			{
				id: "harvest:main",
				kind: "absolute",
				input: Date.now() - 10,
			},
			scope,
		);
		// Run alarm to fire idle harvest
		await runDurableObjectAlarm(stub);

		const afterHarvest = await callRpc<{ status: ChatStatusRecord }>(
			"chat.status",
			{ chatKey: "main" },
			scope,
		);

		const totalTokens = afterHarvest.status.usage.totals.totalTokens;
		const directTokens = afterHarvest.status.usage.sources.direct.totalTokens;
		const harvestTokens = afterHarvest.status.usage.sources.harvest.totalTokens;

		expect(directTokens).toBeGreaterThan(turnTokens);
		expect(harvestTokens).toBeGreaterThan(0);
		expect(totalTokens).toBe(directTokens + harvestTokens);
		expect(afterHarvest.status.botUsage.totals.totalTokens).toBe(totalTokens);

		// 4. Conservation invariant check: sum of bot usage equals harness total usage
		await runInDurableObject(stub, async (instance) => {
			const holder = instance as unknown as {
				harnessInstance: {
					usage(ctx: unknown): Promise<{
						models: Record<string, { totalTokens?: number }>;
						tools: Record<string, { totalTokens?: number }>;
					}>;
				};
			};
			const totalUsage = await holder.harnessInstance.usage({
				abortSignal: new AbortController().signal,
			});
			let totalFromHarness = 0;
			for (const m of Object.values(totalUsage.models)) {
				totalFromHarness += m.totalTokens ?? 0;
			}
			for (const t of Object.values(totalUsage.tools)) {
				totalFromHarness += t.totalTokens ?? 0;
			}
			expect(afterHarvest.status.botUsage.totals.totalTokens).toBe(
				totalFromHarness,
			);
		});

		// 5. chat.reset preserves cumulative token usage
		await callRpc(
			"chat.reset",
			{ chatKey: "main", handoff: "New session" },
			scope,
		);
		const afterReset = await callRpc<{ status: ChatStatusRecord }>(
			"chat.status",
			{ chatKey: "main" },
			scope,
		);
		expect(afterReset.status.usage.totals.totalTokens).toBe(totalTokens);

		// 6. chat.delete soft deletes and preserves usage history
		const deleted = await callRpc<{ deleted: boolean; chat: ChatRecord }>(
			"chat.delete",
			{ chatKey: "main" },
			scope,
		);
		expect(deleted.deleted).toBe(true);
		expect(deleted.chat.deleted).toBe(true);
		expect(deleted.chat.deletedAt).toBeGreaterThan(0);

		// Excluded by default from list
		const list = await callRpc<{ chats: ChatRecord[] }>(
			"chat.list",
			{ botId: "scribe" },
			scope,
		);
		expect(list.chats.some((c) => c.key === "main")).toBe(false);

		// Included with includeDeleted
		const listWithDeleted = await callRpc<{ chats: ChatRecord[] }>(
			"chat.list",
			{ botId: "scribe", includeDeleted: true },
			scope,
		);
		expect(listWithDeleted.chats.some((c) => c.key === "main")).toBe(true);

		// Status still returns full history
		const statusAfterDelete = await callRpc<{ status: ChatStatusRecord }>(
			"chat.status",
			{ chatKey: "main" },
			scope,
		);
		expect(statusAfterDelete.status.usage.totals.totalTokens).toBe(totalTokens);
	});
});
