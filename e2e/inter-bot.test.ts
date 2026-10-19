import { describe, expect, it } from "vitest";
import type { BotRecord } from "../src/protocol.js";
import { connectTestWs, sendRpc } from "./helpers.js";

describe("Inter-Bot Co-Location Tools (create_bot, search_bot, message_bot)", () => {
	it("creates peer bots via create_bot, discovers them with search_bot, and messages them in-memory with message_bot", async () => {
		const scope = { accountId: "acct-interbot", familyId: "default" };
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

			// Verify `chef` now exists in the family's bot catalog
			const botsRes = await sendRpc<{ bots: BotRecord[] }>(
				"bot.list",
				{},
				scope,
			);
			expect(botsRes.frame.result?.bots.map((b) => b.id)).toEqual([
				"coordinator",
				"chef",
			]);

			// 3. Have coordinator invoke `search_bot` to find the bot that knows about pasta & espresso
			const searchTurn = await wsClient.send<{ reply: string }>("turn.submit", {
				chatKey: "coord-chat",
				text: 'Find pasta specialist [tool:search_bot {"query":"Italian pasta recipes"}]',
			});
			expect(searchTurn.ok).toBe(true);
			expect(searchTurn.result?.reply).toContain('"slug":"chef"');

			// 4. Have coordinator invoke `message_bot` to message `chef` in-memory inside the DO
			const msgTurn = await wsClient.send<{ reply: string }>("turn.submit", {
				chatKey: "coord-chat",
				text: 'Ask chef [tool:message_bot {"botId":"chef","text":"How do I make carbonara?"}]',
			});
			expect(msgTurn.ok).toBe(true);
			expect(msgTurn.result?.reply).toContain(
				"echo(1): How do I make carbonara?",
			);

			// Verify a `bot.message` event was broadcast over WebSocket
			const botMsgEvent = wsClient.events.find((e) => e.type === "bot.message");
			expect(botMsgEvent).toBeDefined();
			if (botMsgEvent && botMsgEvent.type === "bot.message") {
				expect(botMsgEvent.payload.fromBotId).toBe("coordinator");
				expect(botMsgEvent.payload.toBotId).toBe("chef");
				expect(botMsgEvent.payload.text).toBe("How do I make carbonara?");
				expect(botMsgEvent.payload.reply).toBe(
					"echo(1): How do I make carbonara?",
				);
			}
		} finally {
			wsClient.close();
		}
	});
});
