import { env, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { HarvestNote, ScheduleRecord } from "../src/protocol.js";
import { sendRpc, uniqueAccountId } from "./helpers.js";

describe("Unified ScheduleTask (Cron, When & Idle Harvest Forks) & DO Alarm Driver", () => {
	it("schedules a one-time 'when' schedule and fires it when the DO alarm triggers", async () => {
		const accountId = uniqueAccountId("sched");
		const familyId = "default";
		const scope = { accountId, familyId };

		await sendRpc("family.update", { harvestDelayMs: 0 }, scope);

		await sendRpc(
			"bot.create",
			{ slug: "timer-bot", name: "Timer Bot", model: "faux/echo" },
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
				target: { mode: "chat", chatKey: "bot:timer-bot" },
			},
			scope,
		);
		expect(schedRes.status).toBe(200);
		expect(schedRes.frame.result?.schedule.id).toBe("wake-1");
		expect(schedRes.frame.result?.schedule.inSeconds).toBe(0);
		expect(schedRes.frame.result?.schedule.recurring).toBe(false);

		const doId = env.CADMUS_BOT_FAMILY.idFromName(
			`cadmus:${accountId}:${familyId}`,
		);
		const stub = env.CADMUS_BOT_FAMILY.get(doId);
		await runDurableObjectAlarm(stub);

		const chatGet = await sendRpc<{
			messages: { role: string; text: string }[];
		}>("chat.get", { chatKey: "bot:timer-bot" }, scope);

		expect(chatGet.status).toBe(200);
		const texts = chatGet.frame.result?.messages.map((m) => m.text) ?? [];
		expect(texts).toContain("Scheduled ping!");
		expect(texts).toContain("echo(1): Scheduled ping!");

		const listRes = await sendRpc<{ schedules: ScheduleRecord[] }>(
			"schedule.list",
			{ botId: "timer-bot" },
			scope,
		);
		const afterSched = listRes.frame.result?.schedules.find(
			(s) => s.id === "wake-1",
		);
		expect(afterSched).toBeUndefined();
	});

	it("arms idle harvest via unified ScheduleTask (`harvest:<chatKey>`), forks the conversation on alarm, extracts knowledge/memory diffs, and advances watermark", async () => {
		const accountId = uniqueAccountId("harvest");
		const familyId = "default";
		const scope = { accountId, familyId };

		await sendRpc("family.update", { harvestDelayMs: 5000 }, scope);

		await sendRpc(
			"bot.create",
			{ slug: "harvester", name: "Harvester Bot", model: "faux/echo" },
			scope,
		);

		const turn1 = await sendRpc<{ reply: string; entryId: number }>(
			"turn.submit",
			{
				chatKey: "bot:harvester",
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
			(s) => s.id === "harvest:bot:harvester",
		);
		expect(harvestSched).toBeDefined();
		expect(harvestSched?.internal).toBe(true);
		expect(harvestSched?.target).toMatchObject({
			mode: "fork",
			chatKey: "bot:harvester",
			harvest: true,
		});

		await sendRpc(
			"schedule.update",
			{
				id: "harvest:bot:harvester",
				kind: "absolute",
				input: Date.now() - 10,
			},
			scope,
		);
		const doId = env.CADMUS_BOT_FAMILY.idFromName(
			`cadmus:${accountId}:${familyId}`,
		);
		const stub = env.CADMUS_BOT_FAMILY.get(doId);
		await runDurableObjectAlarm(stub);

		const memRead = await sendRpc<{ content: string; version: number }>(
			"file.read",
			{ botId: "harvester", path: "/.cadmus/MEMORY.md" },
			scope,
		);
		expect(memRead.frame.result?.version).toBe(1);
		expect(memRead.frame.result?.content).toContain(
			"User prefers dark roast espresso",
		);

		const chatAfter = await sendRpc<{
			messages: { role: string; text: string }[];
			notes: HarvestNote[];
		}>("chat.get", { chatKey: "bot:harvester" }, scope);

		expect(chatAfter.frame.result?.messages).toHaveLength(2);
		expect(chatAfter.frame.result?.notes).toHaveLength(1);
		expect(chatAfter.frame.result?.notes[0]?.files[0]?.path).toBe(
			"/.cadmus/MEMORY.md",
		);
		expect(chatAfter.frame.result?.notes[0]?.files[0]?.diff).toContain(
			"+- User prefers dark roast espresso",
		);

		const statusRes = await sendRpc<{
			status: { harvestWatermark: number };
		}>("chat.status", { chatKey: "bot:harvester" }, scope);
		expect(statusRes.frame.result?.status.harvestWatermark).toBeGreaterThan(0);
	});

	it("cascade-deletes chats, harvest state, and schedules on bot.delete while keeping sibling bots intact", async () => {
		const accountId = uniqueAccountId("bot-delete-cascade");
		const familyId = "default";
		const scope = { accountId, familyId };

		await sendRpc("family.update", { harvestDelayMs: 5000 }, scope);

		await sendRpc(
			"bot.create",
			{ slug: " doomed-bot ", name: "Doomed Bot", model: "faux/echo" },
			scope,
		);
		await sendRpc(
			"bot.create",
			{ slug: "survivor-bot", name: "Survivor Bot", model: "faux/echo" },
			scope,
		);

		await sendRpc(
			"turn.submit",
			{
				chatKey: "bot:doomed-bot",
				text: "Remember this [remember: Doomed bot fact]",
			},
			scope,
		);
		await sendRpc(
			"schedule.update",
			{
				id: "harvest:bot:doomed-bot",
				kind: "absolute",
				input: Date.now() - 10,
			},
			scope,
		);
		const doId = env.CADMUS_BOT_FAMILY.idFromName(
			`cadmus:${accountId}:${familyId}`,
		);
		const stub = env.CADMUS_BOT_FAMILY.get(doId);
		await runDurableObjectAlarm(stub);

		await sendRpc(
			"turn.submit",
			{
				chatKey: "bot:doomed-bot",
				text: "Second message to arm a fresh harvest schedule",
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
				target: { mode: "chat", chatKey: "bot:doomed-bot" },
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
				target: { mode: "chat", chatKey: "bot:survivor-bot" },
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
			"bot:survivor-bot",
		]);

		const doomedChatGet = await sendRpc(
			"chat.get",
			{ chatKey: "bot:doomed-bot" },
			scope,
		);
		expect(doomedChatGet.frame.ok).toBe(false);
		expect(doomedChatGet.frame.error?.code).toBe("not_found");

		const allSchedules = await sendRpc<{
			schedules: { id: string; botId: string }[];
		}>("schedule.list", { includeInternal: true }, scope);
		expect(allSchedules.frame.result?.schedules.map((s) => s.id)).toEqual([
			"survivor-cron",
		]);
	});

	it("blocks idle harvest from modifying /.cadmus/skills/family/* while allowing bot-scoped harvest writes", async () => {
		const accountId = uniqueAccountId("harvest-no-family");
		const familyId = "default";
		const scope = { accountId, familyId };

		await sendRpc("family.update", { harvestDelayMs: 5000 }, scope);
		await sendRpc(
			"bot.create",
			{ slug: "harvester", name: "Harvester Bot", model: "faux/echo" },
			scope,
		);

		const turn = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "bot:harvester",
				text: "Please save this [learn-family:shared-rule Never mutate family during harvest]",
			},
			scope,
		);
		expect(turn.status).toBe(200);

		await sendRpc(
			"schedule.update",
			{
				id: "harvest:bot:harvester",
				kind: "absolute",
				input: Date.now() - 10,
			},
			scope,
		);

		const doId = env.CADMUS_BOT_FAMILY.idFromName(
			`cadmus:${accountId}:${familyId}`,
		);
		const stub = env.CADMUS_BOT_FAMILY.get(doId);
		await runDurableObjectAlarm(stub);

		const famList = await sendRpc<{ files: Array<{ path: string }> }>(
			"file.list",
			{},
			scope,
		);
		expect(famList.status).toBe(200);
		expect(famList.frame.result?.files).toEqual([]);
	});
});
