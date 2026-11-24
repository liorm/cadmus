import { describe, expect, it } from "vitest";
import {
	type AccountModelsListResult,
	adminScope,
	type BotCreateResult,
	type BotUpdateResult,
	type ChatStatusResult,
	type ScheduleCreateResult,
	type ScheduleUpdateResult,
	sendRpc,
	useWorkerFixture,
} from "./helpers.js";

describe("Thinking Levels in Models, Bots, Chats, and Schedules", () => {
	useWorkerFixture();

	it("reports supported thinkingLevels in account.models.list for reasoning models", async () => {
		const scope = await adminScope("default");

		const res = await sendRpc<AccountModelsListResult>(
			"account.models.list",
			{},
			scope,
		);
		expect(res.status).toBe(200);
		expect(res.frame.ok).toBe(true);
		const models = res.frame.result?.models ?? [];
		expect(models.length).toBeGreaterThan(0);

		// faux/echo does not support reasoning, so it should not have thinkingLevels
		const echoModel = models.find((m) => m.id === "echo");
		expect(echoModel).toBeDefined();
		expect(echoModel?.reasoning).toBe(false);
		expect(echoModel?.thinkingLevels).toBeUndefined();

		// openai/gpt-5.1 is a reasoning model with thinkingLevelMap
		const gpt51 = models.find((m) => m.id === "gpt-5.1");
		if (gpt51) {
			expect(gpt51.reasoning).toBe(true);
			expect(gpt51.thinkingLevels).toEqual(["off", "low", "medium", "high"]);
		}

		// openai/o1 is a reasoning model that cannot be turned off (off is null)
		const o1 = models.find((m) => m.id === "o1");
		if (o1) {
			expect(o1.reasoning).toBe(true);
			expect(o1.thinkingLevels).toEqual(["low", "medium", "high"]);
		}
	});

	it("validates thinking type on bot.create and bot.update", async () => {
		const scope = await adminScope("default");

		// 1. Reject invalid thinking level
		const invalidRes = await sendRpc(
			"bot.create",
			{
				slug: "thinker-bad",
				name: "Thinker Bad",
				thinking: "super-extreme",
			},
			scope,
		);
		expect(invalidRes.status).toBe(400);
		expect(invalidRes.frame.ok).toBe(false);
		expect(invalidRes.frame.error?.code).toBe("invalid_command");

		// 2. Accept valid thinking level on bot.create
		const createRes = await sendRpc<BotCreateResult>(
			"bot.create",
			{
				slug: "thinker",
				name: "Thinker",
				thinking: "medium",
			},
			scope,
		);
		expect(createRes.status).toBe(200);
		expect(createRes.frame.result?.bot.thinking).toBe("medium");

		// 3. Update thinking level on bot.update
		const updateRes = await sendRpc<BotUpdateResult>(
			"bot.update",
			{
				botId: "thinker",
				thinking: "high",
			},
			scope,
		);
		expect(updateRes.status).toBe(200);
		expect(updateRes.frame.result?.bot.thinking).toBe("high");
	});

	it("inherits bot thinking on primary chat status and updates with bot.update", async () => {
		const scope = await adminScope("default");

		await sendRpc(
			"bot.create",
			{
				slug: "thinker-chat",
				name: "Thinker Chat",
				thinking: "low",
			},
			scope,
		);

		const status1Res = await sendRpc<ChatStatusResult>(
			"chat.status",
			{ chatKey: "bot:thinker-chat" },
			scope,
		);
		expect(status1Res.frame.result?.status.thinking).toBe("low");

		await sendRpc(
			"bot.update",
			{
				botId: "thinker-chat",
				thinking: "high",
			},
			scope,
		);

		const status2Res = await sendRpc<ChatStatusResult>(
			"chat.status",
			{ chatKey: "bot:thinker-chat" },
			scope,
		);
		expect(status2Res.frame.result?.status.thinking).toBe("high");
	});

	it("supports optional thinking on schedule.create and schedule.update", async () => {
		const scope = await adminScope("default");

		await sendRpc(
			"bot.create",
			{
				slug: "thinker-sched",
				name: "Thinker Sched",
				thinking: "off",
			},
			scope,
		);

		// 1. Schedule with thinking "minimal"
		const createSched = await sendRpc<ScheduleCreateResult>(
			"schedule.create",
			{
				id: "sched-1",
				botId: "thinker-sched",
				kind: "relative",
				input: "60s",
				text: "Review files",
				target: { mode: "new-chat" },
				thinking: "minimal",
			},
			scope,
		);
		expect(createSched.status).toBe(200);
		expect(createSched.frame.result?.schedule.thinking).toBe("minimal");

		// 2. Schedule without thinking
		const createSchedNoThink = await sendRpc<ScheduleCreateResult>(
			"schedule.create",
			{
				id: "sched-2",
				botId: "thinker-sched",
				kind: "relative",
				input: "120s",
				text: "Follow up",
				target: { mode: "new-chat" },
			},
			scope,
		);
		expect(createSchedNoThink.status).toBe(200);
		expect(createSchedNoThink.frame.result?.schedule.thinking).toBeUndefined();

		// 3. Update schedule with new thinking "max"
		const updateSched = await sendRpc<ScheduleUpdateResult>(
			"schedule.update",
			{
				id: "sched-1",
				thinking: "max",
			},
			scope,
		);
		expect(updateSched.status).toBe(200);
		expect(updateSched.frame.result?.schedule.thinking).toBe("max");

		// 4. Reject invalid thinking on schedule.create
		const invalidSched = await sendRpc(
			"schedule.create",
			{
				botId: "thinker-sched",
				kind: "relative",
				input: "60s",
				text: "Test",
				target: { mode: "new-chat" },
				thinking: "bad-level",
			},
			scope,
		);
		expect(invalidSched.status).toBe(400);
		expect(invalidSched.frame.ok).toBe(false);
	});
});
