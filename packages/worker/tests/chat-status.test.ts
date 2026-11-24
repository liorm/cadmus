import { describe, expect, it } from "vitest";
import { sendRpc, uniqueAccountId } from "./helpers.js";

describe("chat.status", () => {
	it("returns a status record without out-of-band slash fields", async () => {
		const scope = {
			accountId: uniqueAccountId("chat-status"),
			familyId: "default",
		};
		await sendRpc(
			"bot.create",
			{
				slug: "status-bot",
				name: "Status Bot",
				model: "faux/echo",
				thinking: "low",
			},
			scope,
		);
		await sendRpc(
			"turn.submit",
			{ chatKey: "bot:status-bot", text: "Hello" },
			scope,
		);

		const res = await sendRpc<{
			status: {
				chatKey: string;
				botId: string;
				botName: string;
				model: string;
				thinking: string;
				busy: boolean;
				entryCount: number;
				harvestWatermark: number;
				nextWakeAt: number | null;
				tasks?: { open: number; done: number; loopRound: number };
				toolsEnv?: { enabled: boolean };
			};
		}>("chat.status", { chatKey: "bot:status-bot" }, scope);

		expect(res.status).toBe(200);
		const status = res.frame.result?.status;
		expect(status?.chatKey).toBe("bot:status-bot");
		expect(status?.botId).toBe("status-bot");
		expect(status?.botName).toBe("Status Bot");
		expect(status?.model).toBe("faux/echo");
		expect(status?.thinking).toBe("low");
		expect(status?.busy).toBe(false);
		expect(status?.entryCount).toBeGreaterThan(0);
		expect(typeof status?.harvestWatermark).toBe("number");
		expect(
			status?.nextWakeAt === null || typeof status?.nextWakeAt === "number",
		).toBe(true);
		expect(status?.tasks).toEqual({
			open: 0,
			done: 0,
			loopRound: 0,
		});
		expect(status?.toolsEnv).toBeDefined();
		expect(typeof status?.toolsEnv?.enabled).toBe("boolean");
		expect(res.frame.result).not.toHaveProperty("outOfBand");
		expect(res.frame.result).not.toHaveProperty("command");
		expect(res.frame.result).not.toHaveProperty("text");
	});
});
