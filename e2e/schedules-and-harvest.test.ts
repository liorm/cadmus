import { env, runDurableObjectAlarm } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type {
	ChatRecord,
	HarvestNote,
	ScheduleRecord,
} from "../packages/worker/src/protocol.js";
import { sendRpc } from "./helpers.js";

describe("Unified ScheduleTask (Cron, When & Idle Harvest Forks) & DO Alarm Driver", () => {
	it("schedules a one-time 'when' schedule and fires it when the DO alarm triggers", async () => {
		const accountId = "acct-sched";
		const familyId = "default";
		const scope = { accountId, familyId };

		// Disable automatic idle harvest delay for this test so only our explicit schedule sets the alarm
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

		// Create an 'absolute' schedule due immediately (now - 10ms) targeting 'timer-chat'
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

		// Trigger the Durable Object alarm on `cadmus:acct-sched:default`
		const doId = env.CADMUS_BOT_FAMILY.idFromName(
			`cadmus:${accountId}:${familyId}`,
		);
		const stub = env.CADMUS_BOT_FAMILY.get(doId);
		await runDurableObjectAlarm(stub);

		// Verify the scheduled message was submitted to `timer-chat` and answered by `timer-bot`
		const chatGet = await sendRpc<{
			messages: { role: string; text: string }[];
		}>("chat.get", { chatKey: "timer-chat" }, scope);

		expect(chatGet.status).toBe(200);
		const texts = chatGet.frame.result?.messages.map((m) => m.text) ?? [];
		expect(texts).toContain("Scheduled ping!");
		expect(texts).toContain("echo(1): Scheduled ping!");

		// One-shot 'relative' / 'absolute' schedule should now be cleaned up (deleted) after firing
		const listRes = await sendRpc<{ schedules: ScheduleRecord[] }>(
			"schedule.list",
			{ botId: "timer-bot" },
			scope,
		);
		const afterSched = listRes.frame.result?.schedules.find(
			(s) => s.id === "wake-1",
		);
		expect(afterSched).toBeUndefined();

		// Verify relative duration formats: plain number (seconds), "1s", "5m", "1s4m", "100ms"
		const deltaSched = await sendRpc<{ schedule: ScheduleRecord }>(
			"schedule.create",
			{
				id: "delta-1",
				botId: "timer-bot",
				kind: "relative",
				input: 10, // relative 10s
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
				input: "1s4m", // 4 minutes 1 second
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

		// Test 'absolute' with ISO date string
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

		// Test 'cron' recurring schedule
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

	it("arms idle harvest via unified ScheduleTask (`harvest:<chatKey>`), forks the conversation on alarm, extracts knowledge/memory diffs, and advances watermark", async () => {
		const accountId = "acct-harvest";
		const familyId = "default";
		const scope = { accountId, familyId };

		// Set harvestDelayMs to 5000ms so the schedule is visible in schedule.list before firing
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

		// 1. Submit a turn containing a durable fact `[remember: User prefers dark roast espresso]`
		const turn1 = await sendRpc<{ reply: string; entryId: number }>(
			"turn.submit",
			{
				chatKey: "harvest-chat",
				text: "Hello! [remember: User prefers dark roast espresso]",
			},
			scope,
		);
		expect(turn1.status).toBe(200);

		// Verify the internal `harvest:harvest-chat` schedule was created in ScheduleStore
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

		// Fast-forward `harvest:harvest-chat` so it is due now, then trigger the DO alarm
		await sendRpc(
			"schedule.update",
			{
				id: "harvest:harvest-chat",
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

		// 2. Verify MEMORY.md was updated by the forked harvest turn
		const memRead = await sendRpc<{ content: string; version: number }>(
			"file.read",
			{ botId: "harvester", path: "MEMORY.md" },
			scope,
		);
		expect(memRead.frame.result?.version).toBe(1);
		expect(memRead.frame.result?.content).toContain(
			"User prefers dark roast espresso",
		);

		// 3. Verify HarvestNote with unified diff on MEMORY.md was recorded and watermark advanced
		const chatAfter = await sendRpc<{
			messages: { role: string; text: string }[];
			notes: HarvestNote[];
		}>("chat.get", { chatKey: "harvest-chat" }, scope);

		// Parent chat transcript must NOT be polluted by the forked harvest turn!
		expect(chatAfter.frame.result?.messages).toHaveLength(2);
		expect(chatAfter.frame.result?.notes).toHaveLength(1);
		expect(chatAfter.frame.result?.notes[0]?.files[0]?.path).toBe("MEMORY.md");
		expect(chatAfter.frame.result?.notes[0]?.files[0]?.diff).toContain(
			"+- User prefers dark roast espresso",
		);

		// Check watermark via out-of-band /status
		const statusRes = await sendRpc<{
			status: { harvestWatermark: number };
		}>("turn.command", { chatKey: "harvest-chat", command: "/status" }, scope);
		expect(statusRes.frame.result?.status.harvestWatermark).toBeGreaterThan(0);
	});
});
