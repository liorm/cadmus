import {
	env,
	runDurableObjectAlarm,
	runInDurableObject,
} from "cloudflare:test";
import type {
	ContextView,
	Harness,
	TaskInspection,
} from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import {
	compactionRetryWakeTime,
	syncDurableObjectAlarm,
} from "../src/alarms.js";
import { type CadmusServices, createCadmusContext } from "../src/context.js";
import {
	COMPACTION_SUMMARY_PREFIX,
	COMPACTION_SUMMARY_SUFFIX,
	compactionExtension,
	estimateViewContextTokens,
	stripCompactionSummaryWrapper,
} from "../src/extensions/compaction.js";
import type { ChatStatusRecord, HarvestNote } from "../src/protocol.js";
import { sendRpc, uniqueAccountId } from "./helpers.js";

function makeInspection(
	kind: string,
	status: "running" | "done" | "faulted",
	checkpoint?: unknown,
): TaskInspection {
	return {
		record: {
			id: 1,
			conversationId: 1,
			kind,
			input: null,
			state: {
				status,
				...(checkpoint !== undefined ? { checkpoint } : {}),
			},
		} as unknown as TaskInspection["record"],
	} as TaskInspection;
}

describe("compaction durability, alarm scheduling & harvest guards", () => {
	it("strips compaction summary wrappers cleanly without touching plain text", () => {
		const wrapped = `${COMPACTION_SUMMARY_PREFIX}Goal: ship\nFacts: alpha${COMPACTION_SUMMARY_SUFFIX}`;
		expect(stripCompactionSummaryWrapper(wrapped)).toBe(
			"Goal: ship\nFacts: alpha",
		);
		expect(stripCompactionSummaryWrapper("Plain user message")).toBe(
			"Plain user message",
		);
	});

	it("estimates context tokens combining measured assistant usage and trailing messages", () => {
		const view = {
			head: { id: 1 },
			entries: [{ id: 1 }, { id: 2 }, { id: 3 }],
			contributions: [
				[],
				[
					{
						role: "assistant",
						content: [],
						usage: {
							input: 100,
							output: 50,
							cacheRead: 25,
							cacheWrite: 10,
							totalTokens: 185,
						},
					},
				],
				[
					{
						role: "user",
						content: [{ type: "text", text: "x".repeat(40) }],
					},
				],
			],
			messages: [],
		} as unknown as ContextView;
		const contribs1 = view.contributions[1]?.[0];
		const contribs2 = view.contributions[2]?.[0];
		if (!contribs1 || !contribs2) throw new Error("missing messages");
		(view as unknown as { messages: unknown[] }).messages = [
			contribs1,
			contribs2,
		];
		const tokens = estimateViewContextTokens(view);
		expect(tokens).toBeGreaterThanOrEqual(195);
	});

	it("extracts retry wake time from pi.compaction inspections and programs the DO alarm", async () => {
		const wake = Date.now() + 30_000;
		expect(
			compactionRetryWakeTime(
				makeInspection("pi.compaction", "running", {
					phase: "retry",
					until: wake,
				}),
			),
		).toBe(wake);
		expect(
			compactionRetryWakeTime(
				makeInspection("pi.compaction", "running", { phase: "summarize" }),
			),
		).toBeUndefined();
		expect(
			compactionRetryWakeTime(
				makeInspection("pi.compaction", "done", {
					phase: "retry",
					until: wake,
				}),
			),
		).toBeUndefined();
		expect(
			compactionRetryWakeTime(
				makeInspection("cadmus.schedule", "running", {
					phase: "retry",
					until: wake,
				}),
			),
		).toBeUndefined();

		let programmedAlarm: number | null = null;
		const storage = {
			async getAlarm() {
				return programmedAlarm;
			},
			async setAlarm(ts: number) {
				programmedAlarm = ts;
			},
			async deleteAlarm() {
				programmedAlarm = null;
			},
		} as unknown as DurableObjectStorage;
		const harness = {
			async inspect() {
				return {
					tasks: [
						makeInspection("pi.compaction", "running", {
							phase: "retry",
							until: wake,
						}),
					],
				};
			},
		} as unknown as Harness;
		const familyStore = {
			schedules: {
				listSchedules: () => [],
				getSchedule: () => undefined,
				hasFired: () => false,
			},
			groups: {
				listOpen: () => [],
			},
			tasks: {
				listRunDeadlines: () => [],
			},
		} as unknown as CadmusServices["familyStore"];

		const next = await syncDurableObjectAlarm(storage, harness, familyStore);
		expect(next).toBe(wake);
		expect(programmedAlarm).toBe(wake);
	});

	it("declines compaction on harvest and search routes while allowing direct routes", async () => {
		const ext = compactionExtension();
		const hookReg = ext.hooks?.[0];
		const handlers = hookReg?.handlers as
			| {
					beforeCompact?: (
						compaction: unknown,
						api: { conversationId: number },
						context: unknown,
					) => Promise<{ decline?: boolean } | undefined>;
			  }
			| undefined;
		const beforeCompact = handlers?.beforeCompact;
		if (!beforeCompact) throw new Error("missing beforeCompact hook");

		const routes = new Map<number, { kind: string }>([
			[10, { kind: "direct" }],
			[11, { kind: "harvest" }],
			[12, { kind: "search" }],
		]);
		const context = createCadmusContext({
			familyStore: {
				chats: {
					getConversationRoute: (id: number) => routes.get(id),
				},
			},
		} as unknown as CadmusServices);

		expect(
			await beforeCompact({}, { conversationId: 10 }, context),
		).toBeUndefined();
		expect(await beforeCompact({}, { conversationId: 11 }, context)).toEqual({
			decline: true,
		});
		expect(await beforeCompact({}, { conversationId: 12 }, context)).toEqual({
			decline: true,
		});
	});

	it("does not re-trigger idle harvest when only compaction entries follow the watermark", async () => {
		const accountId = uniqueAccountId("compact-harvest");
		const scope = { accountId, familyId: "default" };
		await sendRpc("family.update", { harvestDelayMs: 5000 }, scope);
		await sendRpc(
			"bot.create",
			{ slug: "scribe", name: "Scribe", model: "faux/echo" },
			scope,
		);

		// Drive turns large enough to cross faux/echo background compaction threshold (78,848 tokens).
		const filler = "alpha beta gamma delta ".repeat(2_000); // ~46k chars
		for (let i = 1; i <= 5; i++) {
			const res = await sendRpc(
				"turn.submit",
				{
					chatKey: "bot:scribe",
					text:
						i === 1
							? `[remember: User prefers black coffee] ${filler}`
							: `Turn ${i} ${filler}`,
				},
				scope,
			);
			expect(res.frame.ok).toBe(true);
		}

		// Wait for background compaction to complete.
		const deadline = Date.now() + 20_000;
		let status: ChatStatusRecord | undefined;
		while (Date.now() < deadline) {
			const st = await sendRpc<{ status: ChatStatusRecord }>(
				"chat.status",
				{ chatKey: "bot:scribe" },
				scope,
			);
			status = st.frame.result?.status;
			if (
				status?.compaction.headEntryId !== undefined &&
				!status.compaction.active
			) {
				break;
			}
			await new Promise((r) => setTimeout(r, 50));
		}
		expect(status?.compaction.headEntryId).toBeDefined();
		expect(status?.compaction.active).toBe(false);

		const stub = env.CADMUS_BOT_FAMILY.get(
			env.CADMUS_BOT_FAMILY.idFromName(`cadmus:${accountId}:default`),
		);
		// Trigger the armed idle harvest now -> captures the real user fact once.
		await sendRpc(
			"schedule.update",
			{
				id: "harvest:bot:scribe",
				kind: "absolute",
				input: Date.now() - 10,
			},
			scope,
		);
		await runDurableObjectAlarm(stub);

		const firstGet = await sendRpc<{ notes: HarvestNote[] }>(
			"chat.get",
			{ chatKey: "bot:scribe" },
			scope,
		);
		expect(firstGet.frame.result?.notes).toHaveLength(1);
		const compactedEntryId = status?.compaction.headEntryId ?? 0;
		expect(compactedEntryId).toBeGreaterThan(0);

		// Point a harvest schedule at an entry watermarked only by non-user compaction entry;
		// hasUserAfter must see no new UserEntry and skip writing another HarvestNote.
		await runInDurableObject(stub, async (instance) => {
			const holder = instance as unknown as {
				familyStore: {
					harvest: { setWatermark(chatKey: string, at: number): void };
					schedules: {
						upsertSchedule(s: unknown): void;
					};
				};
			};
			// Rewind watermark just before the compaction entry (which is after the last user entry)
			// Only valid if compactedEntryId - 1 >= lastUserEntry, check entries directly via chat.get first.
			void holder;
		});

		const rawGet = await sendRpc<{
			entries?: Array<{ id: number; kind: string }>;
		}>("chat.get", { chatKey: "bot:scribe", raw: true }, scope);
		const entries = rawGet.frame.result?.entries ?? [];
		const compactionEntry = entries.find((e) => e.kind === "pi.compaction");
		const lastUserEntry = [...entries]
			.reverse()
			.find((e) => e.kind === "pi.user");
		expect(compactionEntry).toBeDefined();
		expect(lastUserEntry).toBeDefined();
		if (
			compactionEntry &&
			lastUserEntry &&
			compactionEntry.id > lastUserEntry.id
		) {
			await runInDurableObject(stub, async (instance) => {
				const family = instance as unknown as {
					familyStore: {
						harvest: { setWatermark(chatKey: string, at: number): void };
					};
					scheduleTask: (s: unknown) => Promise<void>;
				};
				family.familyStore.harvest.setWatermark("bot:scribe", lastUserEntry.id);
				void family.scheduleTask;
			});
			// Schedule an internal harvest pointing at compactionEntry.id via store + alarm
			await sendRpc(
				"schedule.create",
				{
					id: "fake-after-compact",
					botId: "scribe",
					kind: "absolute",
					input: Date.now() - 10,
					text: "harvest check",
					target: {
						mode: "fork",
						chatKey: "bot:scribe",
						at: compactionEntry.id,
						harvest: true,
					},
				},
				scope,
			);
			await runDurableObjectAlarm(stub);
			const afterGet = await sendRpc<{ notes: HarvestNote[] }>(
				"chat.get",
				{ chatKey: "bot:scribe" },
				scope,
			);
			expect(afterGet.frame.result?.notes).toHaveLength(1);
		}
	}, 45_000);
});
