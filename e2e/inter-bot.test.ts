import {
	env,
	runDurableObjectAlarm,
	runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { BotRecord } from "../packages/worker/src/protocol.js";
import { connectTestWs, sendRpc, uniqueAccountId } from "./helpers.js";

describe("Inter-Bot Co-Location Tools (create_bot, search_bot, message_bot)", () => {
	it("creates peer bots via create_bot, discovers them with search_bot, and messages them in-memory with message_bot", async () => {
		const scope = {
			accountId: uniqueAccountId("interbot"),
			familyId: "default",
		};
		const wsClient = await connectTestWs(scope);

		try {
			// 1. Create the coordinator bot
			await wsClient.send("bot.create", {
				slug: "coordinator",
				name: "Coordinator",
				model: "faux/echo",
			});

			await wsClient.send("chat.create", {
				botId: "coordinator",
				key: "coord-chat",
			});

			// 2. Have coordinator invoke `create_bot` during a turn to spawn a specialist bot `chef`
			const createTurn = await wsClient.send<{ reply: string }>("turn.submit", {
				chatKey: "coord-chat",
				text: 'Spawn chef bot [tool:create_bot {"slug":"chef","name":"Master Chef","soul":"Expert in Italian pasta and espresso recipes."}]',
			});
			expect(createTurn.ok).toBe(true);
			expect(createTurn.result?.reply).toContain('"id":"chef"');

			const seeded = await wsClient.send<{ reply: string }>("turn.submit", {
				chatKey: "coord-chat",
				text: `Seed a peer with its own knowledge [tool:create_bot ${JSON.stringify(
					{
						slug: "ha",
						name: "HA",
						soul: "Home assistant host.",
						knowledge: [
							{
								slug: "host",
								description: "Host notes",
								body: "The host is 192.168.0.115.",
							},
						],
					},
				)}]`,
			});
			expect(seeded.ok).toBe(true);
			expect(seeded.result?.reply).toContain('"id":"ha"');

			const peer = await sendRpc<{
				knowledge: { slug: string; body?: string; description: string }[];
			}>("bot.get", { botId: "ha" }, scope);
			expect(peer.frame.result?.knowledge.map((doc) => doc.slug)).toEqual([
				"host",
			]);
			const caller = await sendRpc<{
				knowledge: { slug: string }[];
			}>("bot.get", { botId: "coordinator" }, scope);
			expect(caller.frame.result?.knowledge).toEqual([]);

			// Verify `chef` now exists in the family's bot catalog
			const botsRes = await sendRpc<{ bots: BotRecord[] }>(
				"bot.list",
				{},
				scope,
			);
			expect(botsRes.frame.result?.bots.map((b) => b.id).sort()).toEqual([
				"chef",
				"coordinator",
				"ha",
			]);

			// 3. Have coordinator invoke `search_bot` to find the bot that knows about pasta & espresso
			const searchTurn = await wsClient.send<{ reply: string }>("turn.submit", {
				chatKey: "coord-chat",
				text: 'Find pasta specialist [tool:search_bot {"query":"Italian pasta recipes"}]',
			});
			expect(searchTurn.ok).toBe(true);
			expect(searchTurn.result?.reply).toContain('"slug":"chef"');

			const ask = `[tool:message_bot ${JSON.stringify({
				botId: "chef",
				topic: "pasta",
				text: '[[group-reply]][tool:end_conversation {"response":"al dente"}][[/group-reply]]',
			})}]`;
			const msgTurn = await wsClient.send<{ reply: string }>("turn.submit", {
				chatKey: "coord-chat",
				text: `Ask chef ${ask}`,
			});
			expect(msgTurn.ok).toBe(true);
			expect(msgTurn.result?.reply).toContain("al dente");
			expect(msgTurn.result?.reply).toContain('"status":"ended"');

			const listed = await sendRpc<{
				chats: {
					key: string;
					kind?: string;
					members?: string[];
					topic?: string;
					readOnly?: boolean;
					harvest?: boolean;
				}[];
			}>("chat.list", {}, scope);
			const group = listed.frame.result?.chats.find(
				(chat) => chat.kind === "group",
			);
			expect(group?.topic).toBe("pasta");
			expect(group?.members?.sort()).toEqual(["chef", "coordinator"]);
			expect(group?.readOnly).toBe(true);
			expect(group?.harvest).toBe(false);

			const viewed = await sendRpc<{
				messages: { text: string; fromBotId?: string }[];
			}>("chat.get", { chatKey: group?.key ?? "" }, scope);
			expect(viewed.frame.ok).toBe(true);
			expect(
				viewed.frame.result?.messages.some(
					(message) => message.fromBotId === "coordinator",
				),
			).toBe(true);

			const posted = await sendRpc(
				"turn.submit",
				{
					chatKey: group?.key ?? "",
					text: "I should not be able to post",
				},
				scope,
			);
			expect(posted.frame.ok).toBe(false);
			expect(posted.frame.error?.code).toBe("forbidden");

			const schedules = await sendRpc<{ schedules: { id: string }[] }>(
				"schedule.list",
				{ includeInternal: true },
				scope,
			);
			expect(
				schedules.frame.result?.schedules.some((schedule) =>
					schedule.id.startsWith("harvest:gmem:"),
				),
			).toBe(false);

			const botMsgEvent = wsClient.events.find((e) => e.type === "bot.message");
			expect(botMsgEvent).toBeDefined();
			if (botMsgEvent && botMsgEvent.type === "bot.message") {
				expect(botMsgEvent.payload.fromBotId).toBe("coordinator");
				expect(botMsgEvent.payload.toBotId).toBe("chef");
				expect(botMsgEvent.payload.groupChatKey).toBe(group?.key);
				expect(botMsgEvent.payload.reply).toContain("al dente");
			}
		} finally {
			wsClient.close();
		}
	});

	async function bots(
		slugs: string[],
		scope: { accountId: string; familyId: string },
	) {
		for (const slug of slugs) {
			await sendRpc(
				"bot.create",
				{ slug, name: slug, model: "faux/echo" },
				scope,
			);
		}
		await sendRpc("chat.create", { botId: slugs[0], key: "root" }, scope);
	}

	it("times out a hung reply and returns the transcript", async () => {
		const scope = {
			accountId: uniqueAccountId("group-hang"),
			familyId: "default",
		};
		await bots(["a", "b"], scope);
		const pending = sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "root",
				text: `[tool:message_bot ${JSON.stringify({
					botId: "b",
					topic: "wait",
					text: "[[hang]]",
				})}]`,
			},
			scope,
		);
		const stub = env.CADMUS_BOT_FAMILY.get(
			env.CADMUS_BOT_FAMILY.idFromName(
				`cadmus:${scope.accountId}:${scope.familyId}`,
			),
		);
		const started = Date.now();
		const deadline = started + 15_000;
		let armed = false;
		while (Date.now() < deadline && !armed) {
			armed = await runInDurableObject(stub, async (_instance, state) => {
				const due = state.storage.sql
					.exec<{ id: string }>(
						`SELECT id FROM cadmus_group_chats
             WHERE status = 'open' AND reply_deadline IS NOT NULL`,
					)
					.toArray();
				if (due.length === 0) return false;
				state.storage.sql.exec(
					`UPDATE cadmus_group_chats
           SET reply_deadline = 1, overall_deadline = 1
           WHERE status = 'open'`,
				);
				await state.storage.setAlarm(Date.now());
				return true;
			});
			if (!armed) await new Promise((resolve) => setTimeout(resolve, 30));
		}
		expect(armed).toBe(true);
		const turn = await pending;
		await runDurableObjectAlarm(stub);
		expect(turn.frame.ok).toBe(true);
		expect(turn.frame.result?.reply).toContain('"status":"timed_out"');
		expect(turn.frame.result?.reply).toContain("[[hang]]");
		const listed = await sendRpc<{
			chats: { kind?: string; groupStatus?: string }[];
		}>("chat.list", {}, scope);
		expect(
			listed.frame.result?.chats.some(
				(chat) => chat.kind === "group" && chat.groupStatus === "timed_out",
			),
		).toBe(true);
	}, 30_000);

	it("caps a ping-pong at 10 turns", async () => {
		const scope = {
			accountId: uniqueAccountId("group-cap"),
			familyId: "default",
		};
		await bots(["a", "b"], scope);
		const turn = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "root",
				text: `[tool:message_bot ${JSON.stringify({
					botId: "b",
					topic: "ping",
					text: "ping",
				})}]`,
			},
			scope,
		);
		expect(turn.frame.ok).toBe(true);
		expect(turn.frame.result?.reply).toContain('"status":"capped"');
		const listed = await sendRpc<{
			chats: { kind?: string; groupStatus?: string }[];
		}>("chat.list", {}, scope);
		expect(
			listed.frame.result?.chats.some(
				(chat) => chat.kind === "group" && chat.groupStatus === "capped",
			),
		).toBe(true);
	});

	it("refuses a cycle, depth above 3, and the 6th peer action", async () => {
		const scope = {
			accountId: uniqueAccountId("group-limits"),
			familyId: "default",
		};
		await bots(["a", "b", "c", "d", "e"], scope);

		const cycle = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "root",
				text: `[tool:message_bot ${JSON.stringify({
					botId: "b",
					topic: "loop",
					text: `[tool:message_bot ${JSON.stringify({ botId: "a", topic: "loop", text: "back" })}]`,
				})}]`,
			},
			scope,
		);
		expect(cycle.frame.result?.reply).toContain("already on the hop chain");

		const nest = (botId: string, text: string) =>
			`[tool:message_bot ${JSON.stringify({ botId, topic: "depth", text })}]`;
		const depth = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "root",
				text: nest("b", nest("c", nest("d", nest("e", "too deep")))),
			},
			scope,
		);
		expect(depth.frame.result?.reply).toContain("max depth is 3");

		const call = (n: number) =>
			`[tool:message_bot ${JSON.stringify({
				botId: "b",
				topic: `t${n}`,
				text: `[[group-reply]][tool:end_conversation {"response":"r${n}"}][[/group-reply]]`,
			})}]`;
		const budget = await sendRpc<{ reply: string }>(
			"turn.submit",
			{ chatKey: "root", text: [1, 2, 3, 4, 5, 6].map(call).join(" ") },
			scope,
		);
		expect(budget.frame.result?.reply).toContain("peer action 6");
		const listed = await sendRpc<{
			chats: { topic?: string; kind?: string }[];
		}>("chat.list", {}, scope);
		const topics = (listed.frame.result?.chats ?? [])
			.filter((chat) => chat.kind === "group")
			.map((chat) => chat.topic);
		expect(topics.filter((topic) => topic?.startsWith("t"))).toHaveLength(5);
	});

	it("resumes a replayed message_bot without a duplicate opening post", async () => {
		const scope = {
			accountId: uniqueAccountId("group-replay"),
			familyId: "default",
		};
		await bots(["a", "b"], scope);
		const opening =
			'[[group-reply]][tool:end_conversation {"response":"once"}][[/group-reply]]';
		const turn = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "root",
				text: `[tool:message_bot ${JSON.stringify({
					botId: "b",
					topic: "replay",
					text: opening,
				})}]`,
			},
			scope,
		);
		expect(turn.frame.result?.reply).toContain('"status":"ended"');
		expect(turn.frame.result?.reply).toContain("once");
		const stub = env.CADMUS_BOT_FAMILY.get(
			env.CADMUS_BOT_FAMILY.idFromName(
				`cadmus:${scope.accountId}:${scope.familyId}`,
			),
		);
		const resumed = await runInDurableObject(stub, async (instance) => {
			const family = instance as unknown as {
				familyStore: {
					groups: {
						list(): {
							taskId: string;
							topic: string;
							openingText: string;
						}[];
					};
				};
				runMessageBotInternal(input: {
					taskId: string;
					callerBotId: string;
					targetBotId: string;
					topic: string;
					text: string;
					originChatKey: string;
				}): Promise<{ transcript: { text: string; fromBotId: string }[] }>;
			};
			const group = family.familyStore.groups.list()[0];
			if (!group) throw new Error("group missing");
			return family.runMessageBotInternal({
				taskId: group.taskId,
				callerBotId: "a",
				targetBotId: "b",
				topic: group.topic,
				text: `${group.openingText} EXTRA`,
				originChatKey: "root",
			});
		});
		expect(
			resumed.transcript.filter((message) => message.text.includes(" EXTRA")),
		).toHaveLength(0);
		expect(
			resumed.transcript.filter((message) => message.fromBotId === "a"),
		).toHaveLength(1);
		const listed = await sendRpc<{ chats: { key: string; kind?: string }[] }>(
			"chat.list",
			{},
			scope,
		);
		const group = listed.frame.result?.chats.find(
			(chat) => chat.kind === "group",
		);
		const viewed = await sendRpc<{
			messages: { text: string; fromBotId?: string }[];
		}>("chat.get", { chatKey: group?.key ?? "" }, scope);
		expect(
			(viewed.frame.result?.messages ?? []).filter(
				(message) =>
					message.fromBotId === "a" &&
					message.text.includes("end_conversation"),
			),
		).toHaveLength(1);
	});

	it("keeps legacy peer chats readable and read-only", async () => {
		const scope = {
			accountId: uniqueAccountId("group-legacy"),
			familyId: "default",
		};
		await bots(["a", "b"], scope);
		await sendRpc(
			"chat.create",
			{ botId: "b", key: "peer:a:b", title: "old peer" },
			scope,
		);
		const listed = await sendRpc<{
			chats: { key: string; kind?: string; readOnly?: boolean }[];
		}>("chat.list", {}, scope);
		const legacy = listed.frame.result?.chats.find(
			(chat) => chat.key === "peer:a:b",
		);
		expect(legacy?.kind).toBe("legacy-peer");
		expect(legacy?.readOnly).toBe(true);
		const read = await sendRpc("chat.get", { chatKey: "peer:a:b" }, scope);
		expect(read.frame.ok).toBe(true);
		const posted = await sendRpc(
			"turn.submit",
			{ chatKey: "peer:a:b", text: "nope" },
			scope,
		);
		expect(posted.frame.ok).toBe(false);
		expect(posted.frame.error?.code).toBe("forbidden");
	});

	it("deletes unlisted group member chats when a member bot is deleted", async () => {
		const scope = {
			accountId: uniqueAccountId("group-delete"),
			familyId: "default",
		};
		await bots(["a", "b"], scope);
		await sendRpc(
			"turn.submit",
			{
				chatKey: "root",
				text: `[tool:message_bot ${JSON.stringify({
					botId: "b",
					topic: "bye",
					text: '[[group-reply]][tool:end_conversation {"response":"done"}][[/group-reply]]',
				})}]`,
			},
			scope,
		);
		await sendRpc("bot.delete", { botId: "a" }, scope);
		const stub = env.CADMUS_BOT_FAMILY.get(
			env.CADMUS_BOT_FAMILY.idFromName(
				`cadmus:${scope.accountId}:${scope.familyId}`,
			),
		);
		const left = await runInDurableObject(stub, async (_instance, state) => {
			return state.storage.sql
				.exec<{ key: string }>(
					`SELECT key FROM cadmus_chats WHERE key LIKE 'gmem:%'`,
				)
				.toArray();
		});
		expect(left).toEqual([]);
	});

	it("drops an armed harvest schedule when harvest is turned off", async () => {
		const scope = {
			accountId: uniqueAccountId("harvest-off"),
			familyId: "default",
		};
		await bots(["a"], scope);
		await sendRpc("turn.submit", { chatKey: "root", text: "hello" }, scope);
		const armed = await sendRpc<{ schedules: { id: string }[] }>(
			"schedule.list",
			{ botId: "a", includeInternal: true },
			scope,
		);
		expect(
			armed.frame.result?.schedules.some(
				(schedule) => schedule.id === "harvest:root",
			),
		).toBe(true);
		await sendRpc("chat.update", { chatKey: "root", harvest: false }, scope);
		const disarmed = await sendRpc<{ schedules: { id: string }[] }>(
			"schedule.list",
			{ botId: "a", includeInternal: true },
			scope,
		);
		expect(
			disarmed.frame.result?.schedules.some(
				(schedule) => schedule.id === "harvest:root",
			),
		).toBe(false);
	});
});
