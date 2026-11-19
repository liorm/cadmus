import { describe, expect, it } from "vitest";
import {
	adminScope,
	type ScheduleRecord,
	sendRpc,
	useWorkerFixture,
} from "./helpers.js";

/**
 * Bot turns that invoke schedule_create / schedule_list / schedule_update /
 * schedule_delete, plus the schedule.* commands those tools share with cron
 * parsing. Egress is the offline faux/echo model.
 */

type Scope = { accountId: string; familyId: string };

async function scope(_label: string): Promise<Scope> {
	return adminScope("default");
}

async function tool(
	scope: Scope,
	chatKey: string,
	call: string,
): Promise<string> {
	const turn = await sendRpc<{ reply: string }>(
		"turn.submit",
		{ chatKey, text: call },
		scope,
	);
	expect(turn.frame.ok, JSON.stringify(turn.frame)).toBe(true);
	return turn.frame.result?.reply ?? "";
}

function scheduleId(reply: string): string {
	const match = /"id":"(sched-[^"]+)"/.exec(reply);
	expect(match?.[1], reply).toBeTruthy();
	return match?.[1] ?? "";
}

async function listed(
	scope: Scope,
	botId: string,
	includeInternal = false,
): Promise<ScheduleRecord[]> {
	const res = await sendRpc<{ schedules: ScheduleRecord[] }>(
		"schedule.list",
		{ botId, includeInternal },
		scope,
	);
	expect(res.frame.ok).toBe(true);
	return res.frame.result?.schedules ?? [];
}

describe("schedule tools over a bot turn", () => {
	useWorkerFixture();

	it("creates, lists, updates, and deletes schedules from the bot", async () => {
		const account = await scope("sched-tools");
		await sendRpc("family.update", { harvestDelayMs: 60_000 }, account);
		await sendRpc(
			"bot.create",
			{ slug: "timer", name: "Timer", model: "faux/echo" },
			account,
		);
		await sendRpc(
			"bot.create",
			{ slug: "other", name: "Other", model: "faux/echo" },
			account,
		);
		await sendRpc("chat.create", { botId: "timer", key: "main" }, account);
		await sendRpc(
			"chat.create",
			{ botId: "other", key: "other-chat" },
			account,
		);

		const created = await tool(
			account,
			"main",
			'[tool:schedule_create {"name":"Standup","kind":"relative","input":"5m","text":"Stand up","thinking":"high","target":{"mode":"chat","chatKey":"main"}}]',
		);
		const id = scheduleId(created);
		expect(created).toContain('"recurring":false');
		expect(created).toContain('"thinking":"high"');

		const numeric = await tool(
			account,
			"main",
			'[tool:schedule_create {"kind":"relative","input":45,"text":"forty five seconds"}]',
		);
		expect(scheduleId(numeric)).toMatch(/^sched-/);

		const duration = await tool(
			account,
			"main",
			'[tool:schedule_create {"kind":"relative","input":"30","text":"thirty seconds"}]',
		);
		expect(duration).toContain('"kind":"relative"');

		const natural = await tool(
			account,
			"main",
			'[tool:schedule_create {"kind":"absolute","input":"tomorrow at 5pm","text":"tomorrow"}]',
		);
		expect(natural).toContain('"kind":"absolute"');

		const epoch = await tool(
			account,
			"main",
			'[tool:schedule_create {"kind":"absolute","input":"1893456000","text":"epoch seconds"}]',
		);
		expect(epoch).toContain('"kind":"absolute"');

		const epochMs = Date.now() + 3_600_000;
		const epochNumber = await tool(
			account,
			"main",
			`[tool:schedule_create ${JSON.stringify({ kind: "absolute", input: epochMs, text: "epoch ms" })}]`,
		);
		expect(epochNumber).toContain('"kind":"absolute"');

		const hourly = await tool(
			account,
			"main",
			'[tool:schedule_create {"name":"Hourly","kind":"cron","input":"@hourly","text":"hour","target":{"mode":"new-chat"}}]',
		);
		const hourlyId = scheduleId(hourly);
		expect(hourly).toContain('"recurring":true');

		const forkAt = await tool(
			account,
			"main",
			`[tool:schedule_create ${JSON.stringify({
				kind: "relative",
				input: "10m",
				text: "fork later",
				target: { mode: "fork", chatKey: "main", at: 4 },
			})}]`,
		);
		expect(forkAt).toContain('"mode":"fork"');
		expect(forkAt).toContain('"at":4');

		const listedReply = await tool(account, "main", "[tool:schedule_list {}]");
		expect(listedReply).toContain(id);
		expect(listedReply).toContain(hourlyId);
		expect(listedReply).not.toContain("harvest:main");

		const renamed = await tool(
			account,
			"main",
			`[tool:schedule_update ${JSON.stringify({
				id,
				name: "Renamed",
				text: "Updated prompt",
				thinking: "low",
				enabled: false,
			})}]`,
		);
		expect(renamed).toContain('"name":"Renamed"');
		expect(renamed).toContain('"enabled":false');
		expect(renamed).toContain('"thinking":"low"');

		const paused = (await listed(account, "timer")).find(
			(item) => item.id === id,
		);
		expect(paused?.enabled).toBe(false);
		expect(paused?.text).toBe("Updated prompt");

		const resumed = await tool(
			account,
			"main",
			`[tool:schedule_update ${JSON.stringify({
				id,
				enabled: true,
				kind: "relative",
				input: "10m",
			})}]`,
		);
		expect(resumed).toContain('"enabled":true');
		expect(resumed).toContain('"input":"10m"');

		const asCron = await tool(
			account,
			"main",
			`[tool:schedule_update ${JSON.stringify({
				id,
				kind: "cron",
				input: "15 8 * * 1",
			})}]`,
		);
		expect(asCron).toContain('"recurring":true');
		expect(asCron).toContain("15 8 * * 1");

		const asAbsolute = await tool(
			account,
			"main",
			`[tool:schedule_update ${JSON.stringify({
				id,
				kind: "absolute",
				input: new Date(Date.now() + 7_200_000).toISOString(),
			})}]`,
		);
		expect(asAbsolute).toContain('"kind":"absolute"');
		expect(asAbsolute).toContain('"recurring":false');

		const removed = await tool(
			account,
			"main",
			`[tool:schedule_delete ${JSON.stringify({ id: hourlyId })}]`,
		);
		expect(removed).toContain(`"deleted":"${hourlyId}"`);
		expect(
			(await listed(account, "timer")).some((item) => item.id === hourlyId),
		).toBe(false);

		await sendRpc("turn.submit", { chatKey: "main", text: "Hello" }, account);
		const internal = await listed(account, "timer", true);
		expect(
			internal.some((item) => item.id === "harvest:main" && item.internal),
		).toBe(true);
	}, 60_000);

	it("rejects bad timing, foreign chats, and internal schedules", async () => {
		const account = await scope("sched-tools-err");
		await sendRpc("family.update", { harvestDelayMs: 60_000 }, account);
		await sendRpc(
			"bot.create",
			{ slug: "timer", name: "Timer", model: "faux/echo" },
			account,
		);
		await sendRpc(
			"bot.create",
			{ slug: "other", name: "Other", model: "faux/echo" },
			account,
		);
		await sendRpc("chat.create", { botId: "timer", key: "main" }, account);
		await sendRpc(
			"chat.create",
			{ botId: "other", key: "other-chat" },
			account,
		);

		const created = await tool(
			account,
			"main",
			'[tool:schedule_create {"kind":"relative","input":"5m","text":"keep"}]',
		);
		const id = scheduleId(created);

		const badCron = await tool(
			account,
			"main",
			'[tool:schedule_create {"kind":"cron","input":"not a cron","text":"nope"}]',
		);
		expect(badCron).toContain("Invalid cron expression");

		const emptyCron = await tool(
			account,
			"main",
			'[tool:schedule_create {"kind":"cron","input":"","text":"nope"}]',
		);
		expect(emptyCron).toContain("Invalid cron expression");

		const reboot = await tool(
			account,
			"main",
			'[tool:schedule_create {"kind":"cron","input":"@reboot","text":"nope"}]',
		);
		expect(reboot).toContain("Invalid cron expression");

		const never = await tool(
			account,
			"main",
			'[tool:schedule_create {"kind":"cron","input":"0 0 31 2 *","text":"feb 31"}]',
		);
		expect(never).toContain("no upcoming occurrence");

		const badDuration = await tool(
			account,
			"main",
			'[tool:schedule_create {"kind":"relative","input":"nope","text":"nope"}]',
		);
		expect(badDuration).toContain("Could not parse duration");

		const emptyDuration = await tool(
			account,
			"main",
			'[tool:schedule_create {"kind":"relative","input":"","text":"nope"}]',
		);
		expect(emptyDuration).toContain("Duration cannot be empty");

		const badWhen = await tool(
			account,
			"main",
			'[tool:schedule_create {"kind":"absolute","input":"!!!","text":"nope"}]',
		);
		expect(badWhen).toContain("Could not parse date/time");

		const emptyWhen = await tool(
			account,
			"main",
			'[tool:schedule_create {"kind":"absolute","input":"","text":"nope"}]',
		);
		expect(emptyWhen).toContain("Date/time cannot be empty");

		const foreign = await tool(
			account,
			"main",
			'[tool:schedule_create {"kind":"relative","input":"5m","text":"nope","target":{"mode":"chat","chatKey":"other-chat"}}]',
		);
		expect(foreign).toContain("belongs to bot 'other'");

		const foreignFork = await tool(
			account,
			"main",
			'[tool:schedule_create {"kind":"relative","input":"5m","text":"nope","target":{"mode":"fork","chatKey":"other-chat"}}]',
		);
		expect(foreignFork).toContain("belongs to bot 'other'");

		const kindOnly = await tool(
			account,
			"main",
			`[tool:schedule_update ${JSON.stringify({ id, kind: "cron" })}]`,
		);
		expect(kindOnly).toContain("without specifying new timing input");

		const badUpdate = await tool(
			account,
			"main",
			`[tool:schedule_update ${JSON.stringify({ id, kind: "cron", input: "nope" })}]`,
		);
		expect(badUpdate).toContain("Invalid cron expression");

		const missing = await tool(
			account,
			"main",
			'[tool:schedule_update {"id":"sched-missing","text":"nope"}]',
		);
		expect(missing).toContain("not found");

		const fromOther = await tool(
			account,
			"other-chat",
			`[tool:schedule_update ${JSON.stringify({ id, text: "stolen" })}]`,
		);
		expect(fromOther).toContain("not found");

		await sendRpc("turn.submit", { chatKey: "main", text: "Hello" }, account);
		const harvestUpdate = await tool(
			account,
			"main",
			'[tool:schedule_update {"id":"harvest:main","text":"nope"}]',
		);
		expect(harvestUpdate).toContain("not found");
		const harvestDelete = await tool(
			account,
			"main",
			'[tool:schedule_delete {"id":"harvest:main"}]',
		);
		expect(harvestDelete).toContain("not found");

		const missingDelete = await tool(
			account,
			"main",
			'[tool:schedule_delete {"id":"sched-missing"}]',
		);
		expect(missingDelete).toContain("not found");

		const otherDelete = await tool(
			account,
			"other-chat",
			`[tool:schedule_delete ${JSON.stringify({ id })}]`,
		);
		expect(otherDelete).toContain("not found");
		expect(
			(await listed(account, "timer")).some((item) => item.id === id),
		).toBe(true);

		const rpcBadCron = await sendRpc(
			"schedule.create",
			{
				botId: "timer",
				kind: "cron",
				input: "not a cron",
				text: "nope",
				target: { mode: "new-chat" },
			},
			account,
		);
		expect(rpcBadCron.frame.ok).toBe(false);
		expect(rpcBadCron.frame.error?.code).toBe("invalid_schedule");

		const rpcNever = await sendRpc(
			"schedule.create",
			{
				botId: "timer",
				kind: "cron",
				input: "0 0 31 2 *",
				text: "feb",
				target: { mode: "new-chat" },
			},
			account,
		);
		expect(rpcNever.frame.ok).toBe(false);
		expect(rpcNever.frame.error?.message).toContain("no upcoming");

		const rpcDuration = await sendRpc(
			"schedule.create",
			{
				botId: "timer",
				kind: "relative",
				input: "",
				text: "nope",
				target: { mode: "new-chat" },
			},
			account,
		);
		expect(rpcDuration.frame.error?.message).toContain(
			"Duration cannot be empty",
		);

		const rpcWhen = await sendRpc(
			"schedule.create",
			{
				botId: "timer",
				kind: "absolute",
				input: "!!!",
				text: "nope",
				target: { mode: "new-chat" },
			},
			account,
		);
		expect(rpcWhen.frame.error?.message).toContain("Could not parse date/time");

		const rpcKind = await sendRpc(
			"schedule.update",
			{ id, kind: "cron" },
			account,
		);
		expect(rpcKind.frame.ok).toBe(false);
		expect(rpcKind.frame.error?.code).toBe("invalid_schedule");
	}, 60_000);
});
