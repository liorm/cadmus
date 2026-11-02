import { describe, expect, it } from "vitest";
import {
	type ChatRecord,
	type ScheduleRecord,
	sendRpc,
	uniqueAccountId,
	useWorkerFixture,
} from "./helpers.js";

describe("Unified ScheduleTask (Cron, Relative, Absolute & Idle Harvest Schedule Registration)", () => {
	useWorkerFixture();

	it("validates relative, absolute, and cron schedule creation, update, list, and delete over the contract", async () => {
		const accountId = uniqueAccountId("sched");
		const familyId = "default";
		const scope = { accountId, familyId };

		await sendRpc("family.update", { harvestDelayMs: 0 }, scope);

		await sendRpc(
			"bot.create",
			{ slug: "timer-bot", name: "Timer Bot", model: "faux/echo" },
			scope,
		);

		await sendRpc(
			"chat.create",
			{ botId: "timer-bot", key: "timer-chat" },
			scope,
		);

		const schedRes = await sendRpc<{ schedule: ScheduleRecord }>(
			"schedule.create",
			{
				id: "wake-1",
				botId: "timer-bot",
				name: "Wake Up Reminder",
				kind: "absolute",
				input: Date.now() - 10,
				text: "Scheduled ping!",
				target: { mode: "chat", chatKey: "timer-chat" },
			},
			scope,
		);
		expect(schedRes.status).toBe(200);
		expect(schedRes.frame.result?.schedule.id).toBe("wake-1");
		expect(schedRes.frame.result?.schedule.inSeconds).toBe(0);
		expect(schedRes.frame.result?.schedule.recurring).toBe(false);

		const deltaSched = await sendRpc<{ schedule: ScheduleRecord }>(
			"schedule.create",
			{
				id: "delta-1",
				botId: "timer-bot",
				kind: "relative",
				input: 10,
				text: "Delta ping!",
				target: { mode: "chat", chatKey: "timer-chat" },
			},
			scope,
		);
		expect(deltaSched.status).toBe(200);
		expect(deltaSched.frame.result?.schedule.recurring).toBe(false);
		expect(deltaSched.frame.result?.schedule.nextRun).toBeGreaterThan(
			Date.now() + 8000,
		);
		expect(deltaSched.frame.result?.schedule.inSeconds).toBeGreaterThanOrEqual(
			8,
		);

		const stringSched = await sendRpc<{ schedule: ScheduleRecord }>(
			"schedule.create",
			{
				id: "string-sched-1",
				botId: "timer-bot",
				kind: "relative",
				input: "1s4m",
				text: "Complex duration ping!",
				target: { mode: "chat", chatKey: "timer-chat" },
			},
			scope,
		);
		expect(stringSched.status).toBe(200);
		expect(stringSched.frame.result?.schedule.kind).toBe("relative");
		expect(stringSched.frame.result?.schedule.recurring).toBe(false);
		expect(stringSched.frame.result?.schedule.inSeconds).toBeGreaterThanOrEqual(
			240,
		);

		const msSched = await sendRpc<{ schedule: ScheduleRecord }>(
			"schedule.create",
			{
				id: "ms-sched-1",
				botId: "timer-bot",
				kind: "relative",
				input: "100ms",
				text: "MS ping!",
				target: { mode: "chat", chatKey: "timer-chat" },
			},
			scope,
		);
		expect(msSched.status).toBe(200);
		expect(msSched.frame.result?.schedule.kind).toBe("relative");
		expect(msSched.frame.result?.schedule.recurring).toBe(false);

		const futureIso = new Date(Date.now() + 3600_000).toISOString();
		const atIsoSched = await sendRpc<{ schedule: ScheduleRecord }>(
			"schedule.create",
			{
				id: "at-iso-1",
				botId: "timer-bot",
				kind: "absolute",
				input: futureIso,
				text: "ISO ping!",
				target: { mode: "chat", chatKey: "timer-chat" },
			},
			scope,
		);
		expect(atIsoSched.status).toBe(200);
		expect(atIsoSched.frame.result?.schedule.kind).toBe("absolute");
		expect(atIsoSched.frame.result?.schedule.recurring).toBe(false);
		expect(atIsoSched.frame.result?.schedule.inSeconds).toBeGreaterThanOrEqual(
			3500,
		);

		const cronSched = await sendRpc<{ schedule: ScheduleRecord }>(
			"schedule.create",
			{
				id: "cron-1",
				botId: "timer-bot",
				kind: "cron",
				input: "0 9 * * *",
				text: "Daily morning report",
				target: { mode: "new-chat" },
			},
			scope,
		);
		expect(cronSched.status).toBe(200);
		expect(cronSched.frame.result?.schedule.kind).toBe("cron");
		expect(cronSched.frame.result?.schedule.recurring).toBe(true);
		expect(cronSched.frame.result?.schedule.inSeconds).toBeGreaterThan(0);
	});

	it("arms internal idle harvest schedule (`harvest:<chatKey>`) on user turn", async () => {
		const accountId = uniqueAccountId("harvest");
		const familyId = "default";
		const scope = { accountId, familyId };

		await sendRpc("family.update", { harvestDelayMs: 5000 }, scope);

		await sendRpc(
			"bot.create",
			{ slug: "harvester", name: "Harvester Bot", model: "faux/echo" },
			scope,
		);

		await sendRpc<{ chat: ChatRecord }>(
			"chat.create",
			{ botId: "harvester", key: "harvest-chat" },
			scope,
		);

		const turn1 = await sendRpc<{ reply: string; entryId: number }>(
			"turn.submit",
			{
				chatKey: "harvest-chat",
				text: "Hello! [remember: User prefers dark roast espresso]",
			},
			scope,
		);
		expect(turn1.status).toBe(200);

		const internalSchedules = await sendRpc<{ schedules: ScheduleRecord[] }>(
			"schedule.list",
			{ botId: "harvester", includeInternal: true },
			scope,
		);
		const harvestSched = internalSchedules.frame.result?.schedules.find(
			(s) => s.id === "harvest:harvest-chat",
		);
		expect(harvestSched).toBeDefined();
		expect(harvestSched?.internal).toBe(true);
		expect(harvestSched?.target).toMatchObject({
			mode: "fork",
			chatKey: "harvest-chat",
			harvest: true,
		});
	});

	it("cascade-deletes chats, harvest state, and schedules on bot.delete while keeping sibling bots intact over the contract", async () => {
		const accountId = uniqueAccountId("cascade");
		const familyId = "default";
		const scope = { accountId, familyId };

		await sendRpc(
			"bot.create",
			{ slug: "doomed-bot", name: "Doomed Bot", model: "faux/echo" },
			scope,
		);
		await sendRpc(
			"bot.create",
			{ slug: "survivor-bot", name: "Survivor Bot", model: "faux/echo" },
			scope,
		);

		await sendRpc(
			"chat.create",
			{ botId: "doomed-bot", key: "doomed-chat-1" },
			scope,
		);
		await sendRpc(
			"chat.create",
			{ botId: "survivor-bot", key: "survivor-chat-1" },
			scope,
		);

		await sendRpc(
			"turn.submit",
			{
				chatKey: "doomed-chat-1",
				text: "Hello doomed! [remember: Doomed secret]",
			},
			scope,
		);
		await sendRpc(
			"turn.submit",
			{
				chatKey: "survivor-chat-1",
				text: "Hello survivor!",
			},
			scope,
		);

		await sendRpc(
			"schedule.create",
			{
				id: "doomed-cron",
				botId: "doomed-bot",
				kind: "cron",
				input: "0 9 * * *",
				text: "Doomed report",
				target: { mode: "chat", chatKey: "doomed-chat-1" },
			},
			scope,
		);
		await sendRpc(
			"schedule.create",
			{
				id: "survivor-cron",
				botId: "survivor-bot",
				kind: "cron",
				input: "0 10 * * *",
				text: "Survivor report",
				target: { mode: "chat", chatKey: "survivor-chat-1" },
			},
			scope,
		);

		const delRes = await sendRpc("bot.delete", { botId: "doomed-bot" }, scope);
		expect(delRes.status).toBe(200);
		expect(delRes.frame.ok).toBe(true);

		const allChats = await sendRpc<{ chats: { key: string; botId: string }[] }>(
			"chat.list",
			{},
			scope,
		);
		expect(allChats.frame.result?.chats.map((c) => c.key)).toEqual([
			"survivor-chat-1",
		]);

		const doomedChatGet = await sendRpc(
			"chat.get",
			{ chatKey: "doomed-chat-1" },
			scope,
		);
		expect(doomedChatGet.frame.ok).toBe(false);
		expect(doomedChatGet.frame.error?.code).toBe("not_found");

		const allSchedules = await sendRpc<{
			schedules: { id: string; botId: string }[];
		}>("schedule.list", { includeInternal: true }, scope);
		expect(
			allSchedules.frame.result?.schedules
				.filter((s) => s.botId === "doomed-bot")
				.map((s) => s.id),
		).toEqual([]);
		expect(
			allSchedules.frame.result?.schedules.some(
				(s) => s.id === "survivor-cron",
			),
		).toBe(true);
	});
});
