import { describe, expect, it } from "vitest";
import {
	adminScope,
	connectTestWs,
	sendRpc,
	useWorkerFixture,
	workerFetch,
} from "./helpers.js";

describe("Single-conversation bots, continuous history & automatic compaction (Issue #10)", () => {
	useWorkerFixture();

	it("auto-creates bot:<slug> on bot.create, syncs title on bot.update, defaults schedule.create target, and cascades bot.delete", async () => {
		const scope = await adminScope("default");

		const created = await sendRpc<{
			bot: {
				slug: string;
				name: string;
				primaryChatKey: string;
				rootConversationId: number;
			};
		}>(
			"bot.create",
			{ slug: "scribe", name: "Scribe Alpha", model: "faux/echo" },
			scope,
		);
		expect(created.frame.ok).toBe(true);
		expect(created.frame.result?.bot.primaryChatKey).toBe("bot:scribe");

		const listed = await sendRpc<{
			chats: Array<{
				key: string;
				botId: string;
				title: string;
				conversationId: number;
			}>;
		}>("chat.list", {}, scope);
		expect(listed.frame.result?.chats).toHaveLength(1);
		expect(listed.frame.result?.chats[0]?.key).toBe("bot:scribe");
		expect(listed.frame.result?.chats[0]?.title).toBe("Scribe Alpha");
		expect(listed.frame.result?.chats[0]?.conversationId).toBe(
			created.frame.result?.bot.rootConversationId,
		);

		const renamed = await sendRpc(
			"bot.update",
			{ botId: "scribe", name: "Scribe Beta" },
			scope,
		);
		expect(renamed.frame.ok).toBe(true);
		const afterRename = await sendRpc<{
			chat: { title: string; key: string };
		}>("chat.get", { chatKey: "bot:scribe" }, scope);
		expect(afterRename.frame.result?.chat.title).toBe("Scribe Beta");

		// Omitting schedule.create target defaults to primary chat bot:<botId>.
		const sched = await sendRpc<{
			schedule: {
				id: string;
				target: { mode: string; chatKey: string };
			};
		}>(
			"schedule.create",
			{
				id: "daily-ping",
				botId: "scribe",
				kind: "relative",
				input: "1h",
				text: "Status ping",
			},
			scope,
		);
		expect(sched.frame.ok).toBe(true);
		expect(sched.frame.result?.schedule.target).toEqual({
			mode: "chat",
			chatKey: "bot:scribe",
		});

		const del = await sendRpc("bot.delete", { botId: "scribe" }, scope);
		expect(del.frame.ok).toBe(true);
		const chatsAfter = await sendRpc<{ chats: unknown[] }>(
			"chat.list",
			{},
			scope,
		);
		expect(chatsAfter.frame.result?.chats).toHaveLength(0);
		const schedsAfter = await sendRpc<{ schedules: unknown[] }>(
			"schedule.list",
			{},
			scope,
		);
		expect(schedsAfter.frame.result?.schedules).toHaveLength(0);
	});

	it("rejects removed legacy chat commands over /rpc and REST /api/*", async () => {
		const scope = await adminScope("default");
		await sendRpc(
			"bot.create",
			{ slug: "assistant", name: "Assistant", model: "faux/echo" },
			scope,
		);

		const removedCommands: Array<[string, string, Record<string, unknown>]> = [
			["chat.create", "/api/chat/create", { botId: "assistant", key: "alt" }],
			[
				"chat.rename",
				"/api/chat/rename",
				{ chatKey: "bot:assistant", title: "x" },
			],
			["chat.close", "/api/chat/close", { chatKey: "bot:assistant" }],
			["chat.delete", "/api/chat/delete", { chatKey: "bot:assistant" }],
			[
				"chat.messages",
				"/api/chat/messages?chatKey=bot%3Aassistant",
				{ chatKey: "bot:assistant" },
			],
			[
				"chat.entries",
				"/api/chat/entries?chatKey=bot%3Aassistant",
				{ chatKey: "bot:assistant" },
			],
			["chat.subscribe", "/api/chat/subscribe", { chatKey: "bot:assistant" }],
		];

		for (const [cmd, apiPath, payload] of removedCommands) {
			const rpcRes = await sendRpc(cmd, payload, scope);
			expect(rpcRes.frame.ok).toBe(false);
			expect(rpcRes.frame.error?.code).toBe("invalid_command");

			const method = apiPath.includes("?") ? "GET" : "POST";
			const restRes = await workerFetch(`http://example.com${apiPath}`, {
				method,
				headers: {
					Authorization: `Bearer ${scope.token}`,
					"x-account-id": scope.accountId,
					"X-Cadmus-Family-Id": scope.familyId,
					...(method === "POST" ? { "Content-Type": "application/json" } : {}),
				},
				...(method === "POST" ? { body: JSON.stringify(payload) } : {}),
			});
			expect(restRes.status).toBe(404);
		}
	});

	it("compacts automatically in background past faux/echo threshold, streams chat.compaction events, supports continuous pagination, and preserves pre-reset history", async () => {
		const scope = await adminScope("default");
		await sendRpc("family.update", { harvestDelayMs: 0 }, scope);
		await sendRpc(
			"bot.create",
			{ slug: "longmem", name: "Long Memory", model: "faux/echo" },
			scope,
		);

		const ws = await connectTestWs(scope);
		try {
			ws.events.length = 0;
			const block = "alpha beta gamma delta epsilon ".repeat(1_500); // ~46.5k chars (~11.6k tokens user + ~11.6k tokens assistant per turn)
			for (let i = 1; i <= 5; i++) {
				const res = await ws.send<{ reply: string }>("turn.submit", {
					chatKey: "bot:longmem",
					text: `marker-${i} ${block}`,
				});
				expect(res.ok).toBe(true);
			}

			// Wait for background compaction started + completed events.
			const deadline = Date.now() + 20_000;
			let completedEvent:
				| {
						type: string;
						payload?: {
							chatKey: string;
							botId: string;
							phase: string;
							reason: string;
						};
				  }
				| undefined;
			while (Date.now() < deadline) {
				completedEvent = ws.events.find(
					(e) =>
						e.type === "chat.compaction" &&
						(e.payload as { phase?: string })?.phase === "completed",
				) as typeof completedEvent;
				if (completedEvent) break;
				await new Promise((r) => setTimeout(r, 50));
			}
			expect(completedEvent).toBeDefined();
			expect(completedEvent?.payload?.chatKey).toBe("bot:longmem");
			expect(completedEvent?.payload?.botId).toBe("longmem");
			expect(
				ws.events.some(
					(e) =>
						e.type === "chat.compaction" &&
						(e.payload as { phase?: string })?.phase === "started",
				),
			).toBe(true);

			// Verify chat.status compaction telemetry.
			const st = await sendRpc<{
				status: {
					entryCount: number;
					totalEntryCount: number;
					compaction: {
						active: boolean;
						headEntryId?: number;
						firstKeptEntryId?: number;
						contextTokens: number;
						contextWindow: number;
						policy: {
							enabled: boolean;
							reserveTokens: number;
							keepRecentTokens: number;
							backgroundTokens: number;
						};
					};
				};
			}>("chat.status", { chatKey: "bot:longmem" }, scope);
			expect(st.frame.ok).toBe(true);
			const compaction = st.frame.result?.status.compaction;
			expect(compaction?.active).toBe(false);
			expect(compaction?.headEntryId).toBeDefined();
			expect(compaction?.firstKeptEntryId).toBeDefined();
			expect(compaction?.contextWindow).toBe(128_000);
			expect(compaction?.policy.enabled).toBe(true);
			expect(st.frame.result?.status.totalEntryCount).toBeGreaterThanOrEqual(
				st.frame.result?.status.entryCount ?? 0,
			);

			// Continuous full transcript includes compaction divider & compacted user turns (visibleToModel=false).
			const full = await sendRpc<{
				compacting: boolean;
				messages: Array<{
					id: number;
					role: string;
					text: string;
					visibleToUser: boolean;
					visibleToModel: boolean;
					compactionReason?: string;
					firstKeptEntryId?: number;
				}>;
				entries?: unknown[];
				hasMore: boolean;
				oldestEntryId?: number;
			}>("chat.get", { chatKey: "bot:longmem" }, scope);
			expect(full.frame.ok).toBe(true);
			expect(full.frame.result?.compacting).toBe(false);
			expect(full.frame.result?.entries).toBeUndefined(); // omitted unless raw: true
			const msgs = full.frame.result?.messages ?? [];
			const divider =
				msgs.find(
					(m) => m.role === "compaction" && m.id === compaction?.headEntryId,
				) ?? msgs.findLast((m) => m.role === "compaction");
			expect(divider).toBeDefined();
			expect(divider?.id).toBe(compaction?.headEntryId);
			expect(divider?.visibleToUser).toBe(true);
			expect(divider?.visibleToModel).toBe(true);
			expect(divider?.firstKeptEntryId).toBe(compaction?.firstKeptEntryId);
			expect(msgs.some((m) => m.role === "user" && !m.visibleToModel)).toBe(
				true,
			);
			expect(msgs.some((m) => m.role === "user" && m.visibleToModel)).toBe(
				true,
			);

			// Pagination backwards using limit + beforeEntryId.
			const page1 = await sendRpc<{
				messages: Array<{ id: number }>;
				hasMore: boolean;
				oldestEntryId?: number;
			}>("chat.get", { chatKey: "bot:longmem", limit: 3 }, scope);
			expect(page1.frame.result?.messages.length).toBeLessThanOrEqual(3);
			expect(page1.frame.result?.hasMore).toBe(true);
			expect(page1.frame.result?.oldestEntryId).toBeDefined();

			const page2 = await sendRpc<{
				messages: Array<{ id: number }>;
				hasMore: boolean;
			}>(
				"chat.get",
				{
					chatKey: "bot:longmem",
					limit: 3,
					beforeEntryId: page1.frame.result?.oldestEntryId,
				},
				scope,
			);
			expect(page2.frame.result?.messages.length).toBeGreaterThan(0);
			const page1Ids = new Set(page1.frame.result?.messages.map((m) => m.id));
			for (const msg of page2.frame.result?.messages ?? []) {
				expect(page1Ids.has(msg.id)).toBe(false);
			}

			// raw: true returns entries.
			const withRaw = await sendRpc<{ entries?: unknown[] }>(
				"chat.get",
				{ chatKey: "bot:longmem", raw: true, limit: 20 },
				scope,
			);
			expect(Array.isArray(withRaw.frame.result?.entries)).toBe(true);
			expect((withRaw.frame.result?.entries ?? []).length).toBeGreaterThan(0);

			// chat.reset adds reset divider, marks prior entries visibleToModel=false, keeps user history, resets echo count.
			const resetRes = await sendRpc(
				"chat.reset",
				{ chatKey: "bot:longmem", handoff: "Fresh chapter" },
				scope,
			);
			expect(resetRes.frame.ok).toBe(true);

			const afterResetTurn = await ws.send<{ reply: string }>("turn.submit", {
				chatKey: "bot:longmem",
				text: "First after reset",
			});
			expect(afterResetTurn.ok).toBe(true);
			expect(afterResetTurn.result?.reply).toContain("First after reset");

			const postReset = await sendRpc<{
				messages: Array<{
					role: string;
					text: string;
					visibleToModel: boolean;
				}>;
			}>("chat.get", { chatKey: "bot:longmem", limit: 100 }, scope);
			const postMsgs = postReset.frame.result?.messages ?? [];
			expect(postMsgs.some((m) => m.role === "reset")).toBe(true);
			expect(postMsgs.some((m) => m.text.includes("marker-1"))).toBe(true);
			const marker1 = postMsgs.find((m) => m.text.includes("marker-1"));
			expect(marker1?.visibleToModel).toBe(false);
		} finally {
			ws.close();
		}
	}, 45_000);
});
