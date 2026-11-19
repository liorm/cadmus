import { describe, expect, it } from "vitest";
import {
	adminScope,
	type BotRecord,
	connectTestWs,
	sendRpc,
	useWorkerFixture,
} from "./helpers.js";

describe("Inter-Bot Co-Location Tools (create_bot, search_bot, message_bot)", () => {
	useWorkerFixture();

	it("creates peer bots via create_bot, discovers them with search_bot, and messages them in-memory with message_bot", async () => {
		const scope = await adminScope("default");
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

			// 3b. Have coordinator invoke `list_bots` to list all bots in the family
			const listTurn = await wsClient.send<{ reply: string }>("turn.submit", {
				chatKey: "coord-chat",
				text: "List all bots [tool:list_bots {}]",
			});
			expect(listTurn.ok).toBe(true);
			const listJson = JSON.parse(
				listTurn.result?.reply.split(" -> ")[1] ?? "{}",
			) as { bots: { slug: string; name: string }[] };
			expect(listJson.bots).toEqual([
				{ slug: "coordinator", name: "Coordinator" },
				{ slug: "chef", name: "Master Chef" },
				{ slug: "ha", name: "HA" },
			]);

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
			}>("chat.list", { kinds: ["group"] }, scope);
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

	it("caps a ping-pong at 10 turns", async () => {
		const scope = await adminScope("default");
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
		}>("chat.list", { kinds: ["group"] }, scope);
		expect(
			listed.frame.result?.chats.some(
				(chat) => chat.kind === "group" && chat.groupStatus === "capped",
			),
		).toBe(true);
	});

	// Three scenarios, each with its own scope and five bots, so each gets its
	// own default test timeout. They used to share one scope and one 5 s cap.
	const limitsScope = async () => {
		const scope = await adminScope("default");
		await bots(["a", "b", "c", "d", "e"], scope);
		return scope;
	};

	it("refuses a message_bot cycle", async () => {
		const scope = await limitsScope();
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
	});

	it("refuses depth above 3", async () => {
		const scope = await limitsScope();
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
	});

	it("refuses the 6th peer action in one turn", async () => {
		const scope = await limitsScope();
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
		}>("chat.list", { kinds: ["group"] }, scope);
		const topics = (listed.frame.result?.chats ?? [])
			.filter((chat) => chat.kind === "group")
			.map((chat) => chat.topic);
		expect(topics.filter((topic) => topic?.startsWith("t"))).toHaveLength(5);
	});

	it("filters chats by kind and defaults chat.list to direct chats", async () => {
		const scope = await adminScope("default");
		await bots(["a", "b"], scope);
		await sendRpc(
			"chat.create",
			{ botId: "b", key: "direct-1", title: "User Chat" },
			scope,
		);
		await sendRpc(
			"turn.submit",
			{
				chatKey: "direct-1",
				text: `[tool:message_bot ${JSON.stringify({
					botId: "a",
					topic: "discuss",
					text: "hello from b",
				})}]`,
			},
			scope,
		);

		// Default chat.list -> only "direct" chats
		const defaultListed = await sendRpc<{
			chats: { key: string; kind?: string }[];
		}>("chat.list", {}, scope);
		expect(defaultListed.frame.result?.chats.map((c) => c.key).sort()).toEqual(
			["direct-1", "root"].sort(),
		);
		expect(
			defaultListed.frame.result?.chats.every((c) => c.kind === "direct"),
		).toBe(true);

		// kinds: ["group"] -> only group chat
		const groupListed = await sendRpc<{
			chats: { key: string; kind?: string }[];
		}>("chat.list", { kinds: ["group"] }, scope);
		expect(groupListed.frame.result?.chats).toHaveLength(1);
		expect(groupListed.frame.result?.chats[0]?.kind).toBe("group");
		const groupKey = groupListed.frame.result?.chats[0]?.key;

		// kinds: ["group-member"] -> internal member chats (gmem:...)
		const memberListed = await sendRpc<{
			chats: { key: string; kind?: string; readOnly?: boolean }[];
		}>("chat.list", { kinds: ["group-member"] }, scope);
		expect(memberListed.frame.result?.chats.length).toBeGreaterThanOrEqual(2);
		expect(
			memberListed.frame.result?.chats.every((c) => c.kind === "group-member"),
		).toBe(true);
		expect(
			memberListed.frame.result?.chats.every((c) => c.readOnly === true),
		).toBe(true);

		// Submitting a user turn to group-member chat is forbidden
		const memberKey = memberListed.frame.result?.chats[0]?.key;
		const posted = await sendRpc(
			"turn.submit",
			{ chatKey: memberKey, text: "nope" },
			scope,
		);
		expect(posted.frame.ok).toBe(false);
		expect(posted.frame.error?.code).toBe("forbidden");

		// kinds: ["direct", "group"] -> both
		const bothListed = await sendRpc<{
			chats: { key: string; kind?: string }[];
		}>("chat.list", { kinds: ["direct", "group"] }, scope);
		expect(bothListed.frame.result?.chats.map((c) => c.key).sort()).toEqual(
			["direct-1", "root", groupKey].sort(),
		);
	});

	it("drops an armed harvest schedule when harvest is turned off", async () => {
		const scope = await adminScope("default");
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
