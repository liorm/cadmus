import { describe, expect, it } from "vitest";
import {
	BOT_METADATA_MAX_KEYS,
	BOT_METADATA_MAX_VALUE_LENGTH,
	type BotRecord,
	type ScheduleRecord,
	sendRpc,
	uniqueAccountId,
	useWorkerFixture,
} from "./helpers.js";

describe("Bot metadata and timezone", () => {
	useWorkerFixture();

	it("creates a bot with metadata and returns it from bot.get and bot.list", async () => {
		const scope = {
			accountId: uniqueAccountId("bot-meta-create"),
			familyId: "default",
		};
		const created = await sendRpc<{ bot: BotRecord }>(
			"bot.create",
			{
				slug: "painter",
				name: "Painter",
				metadata: { color: "bot-3", note: "accent" },
			},
			scope,
		);
		expect(created.status).toBe(200);
		expect(created.frame.result?.bot.metadata).toEqual({
			color: "bot-3",
			note: "accent",
		});

		const got = await sendRpc<{ bot: BotRecord }>(
			"bot.get",
			{ botId: "painter" },
			scope,
		);
		expect(got.status).toBe(200);
		expect(got.frame.result?.bot.metadata).toEqual({
			color: "bot-3",
			note: "accent",
		});

		const listed = await sendRpc<{ bots: BotRecord[] }>("bot.list", {}, scope);
		expect(
			listed.frame.result?.bots.find((b) => b.id === "painter")?.metadata,
		).toEqual({
			color: "bot-3",
			note: "accent",
		});
	});

	it("patches metadata: set, overwrite, delete, and leave other keys", async () => {
		const scope = {
			accountId: uniqueAccountId("bot-meta-patch"),
			familyId: "default",
		};
		await sendRpc(
			"bot.create",
			{
				slug: "scribe",
				name: "Scribe",
				metadata: { color: "bot-1", keep: "yes", gone: "soon" },
			},
			scope,
		);

		const patched = await sendRpc<{ bot: BotRecord }>(
			"bot.update",
			{
				botId: "scribe",
				metadata: { color: "bot-8", gone: null, extra: "added" },
			},
			scope,
		);
		expect(patched.status).toBe(200);
		expect(patched.frame.result?.bot.metadata).toEqual({
			color: "bot-8",
			keep: "yes",
			extra: "added",
		});

		const cleared = await sendRpc<{ bot: BotRecord }>(
			"bot.update",
			{
				botId: "scribe",
				metadata: { color: null, keep: null, extra: null },
			},
			scope,
		);
		expect(cleared.status).toBe(200);
		expect(cleared.frame.result?.bot.metadata).toBeUndefined();
	});

	it("rejects metadata limit violations using exported constants", async () => {
		const scope = {
			accountId: uniqueAccountId("bot-meta-limits"),
			familyId: "default",
		};
		await sendRpc("bot.create", { slug: "limited", name: "Limited" }, scope);

		const tooMany: Record<string, string> = {};
		for (let i = 0; i < BOT_METADATA_MAX_KEYS + 1; i += 1) {
			tooMany[`k${i}`] = "v";
		}
		const tooManyCreate = await sendRpc(
			"bot.create",
			{ slug: "overflow", name: "Overflow", metadata: tooMany },
			scope,
		);
		expect(tooManyCreate.status).toBe(400);
		expect(tooManyCreate.frame.ok).toBe(false);
		expect(tooManyCreate.frame.error?.code).toBe("invalid_command");

		const tooManyUpdate = await sendRpc(
			"bot.update",
			{ botId: "limited", metadata: tooMany },
			scope,
		);
		expect(tooManyUpdate.status).toBe(400);
		expect(tooManyUpdate.frame.error?.code).toBe("invalid_command");

		const longValue = "x".repeat(BOT_METADATA_MAX_VALUE_LENGTH + 1);
		const longRes = await sendRpc(
			"bot.update",
			{ botId: "limited", metadata: { note: longValue } },
			scope,
		);
		expect(longRes.status).toBe(400);
		expect(longRes.frame.error?.code).toBe("invalid_command");

		const badKey = await sendRpc(
			"bot.update",
			{ botId: "limited", metadata: { "Bad Key": "no" } },
			scope,
		);
		expect(badKey.status).toBe(400);
		expect(badKey.frame.error?.code).toBe("invalid_command");

		const badDelete = await sendRpc(
			"bot.update",
			{ botId: "limited", metadata: { "Bad Key": null } },
			scope,
		);
		expect(badDelete.status).toBe(400);
		expect(badDelete.frame.error?.code).toBe("invalid_command");

		const seed: Record<string, string> = {};
		for (let i = 0; i < BOT_METADATA_MAX_KEYS; i += 1) {
			seed[`k${i}`] = "v";
		}
		const filled = await sendRpc<{ bot: BotRecord }>(
			"bot.update",
			{ botId: "limited", metadata: seed },
			scope,
		);
		expect(filled.status).toBe(200);
		expect(Object.keys(filled.frame.result?.bot.metadata ?? {}).length).toBe(
			BOT_METADATA_MAX_KEYS,
		);

		const overflowMerge = await sendRpc(
			"bot.update",
			{ botId: "limited", metadata: { extra: "nope" } },
			scope,
		);
		expect(overflowMerge.status).toBe(400);
		expect(overflowMerge.frame.error?.code).toBe("invalid_command");
	});

	it("isolates metadata across bots and families", async () => {
		const accountId = uniqueAccountId("bot-meta-iso");
		const defaultScope = { accountId, familyId: "default" };
		await sendRpc(
			"family.create",
			{ familyId: "other", name: "Other" },
			defaultScope,
		);
		const otherScope = { accountId, familyId: "other" };

		await sendRpc(
			"bot.create",
			{
				slug: "alpha",
				name: "Alpha",
				metadata: { color: "bot-1" },
			},
			defaultScope,
		);
		await sendRpc(
			"bot.create",
			{
				slug: "beta",
				name: "Beta",
				metadata: { color: "bot-2" },
			},
			defaultScope,
		);
		await sendRpc(
			"bot.create",
			{
				slug: "alpha",
				name: "Alpha Other",
				metadata: { color: "bot-5" },
			},
			otherScope,
		);

		const alpha = await sendRpc<{ bot: BotRecord }>(
			"bot.get",
			{ botId: "alpha" },
			defaultScope,
		);
		const beta = await sendRpc<{ bot: BotRecord }>(
			"bot.get",
			{ botId: "beta" },
			defaultScope,
		);
		const otherAlpha = await sendRpc<{ bot: BotRecord }>(
			"bot.get",
			{ botId: "alpha" },
			otherScope,
		);
		expect(alpha.frame.result?.bot.metadata).toEqual({ color: "bot-1" });
		expect(beta.frame.result?.bot.metadata).toEqual({ color: "bot-2" });
		expect(otherAlpha.frame.result?.bot.metadata).toEqual({ color: "bot-5" });
	});

	it("sets timezone on create and update, defaults omitted create to family timezone, and rejects invalid IANA values", async () => {
		const accountId = uniqueAccountId("bot-tz");
		const scope = { accountId, familyId: "default" };

		await sendRpc("family.update", { timezone: "America/Los_Angeles" }, scope);

		const inherited = await sendRpc<{ bot: BotRecord }>(
			"bot.create",
			{ slug: "inherit", name: "Inherit" },
			scope,
		);
		expect(inherited.status).toBe(200);
		expect(inherited.frame.result?.bot.timezone).toBe("America/Los_Angeles");

		const explicit = await sendRpc<{ bot: BotRecord }>(
			"bot.create",
			{
				slug: "tokyo",
				name: "Tokyo",
				timezone: "Asia/Tokyo",
			},
			scope,
		);
		expect(explicit.status).toBe(200);
		expect(explicit.frame.result?.bot.timezone).toBe("Asia/Tokyo");

		const updated = await sendRpc<{ bot: BotRecord }>(
			"bot.update",
			{ botId: "tokyo", timezone: "Europe/London" },
			scope,
		);
		expect(updated.status).toBe(200);
		expect(updated.frame.result?.bot.timezone).toBe("Europe/London");

		const got = await sendRpc<{ bot: BotRecord }>(
			"bot.get",
			{ botId: "tokyo" },
			scope,
		);
		expect(got.frame.result?.bot.timezone).toBe("Europe/London");

		const badCreate = await sendRpc(
			"bot.create",
			{
				slug: "bad-tz",
				name: "Bad Tz",
				timezone: "Not/A_Zone",
			},
			scope,
		);
		expect(badCreate.status).toBe(400);
		expect(badCreate.frame.error?.code).toBe("invalid_command");

		const badUpdate = await sendRpc(
			"bot.update",
			{ botId: "tokyo", timezone: "Not/A_Zone" },
			scope,
		);
		expect(badUpdate.status).toBe(400);
		expect(badUpdate.frame.error?.code).toBe("invalid_command");
	});

	it("uses the updated bot timezone for cron schedules", async () => {
		const scope = {
			accountId: uniqueAccountId("bot-tz-sched"),
			familyId: "default",
		};
		await sendRpc(
			"bot.create",
			{
				slug: "timer",
				name: "Timer",
				timezone: "America/New_York",
			},
			scope,
		);
		await sendRpc("chat.create", { botId: "timer", key: "timer-chat" }, scope);

		const before = await sendRpc<{ schedule: ScheduleRecord }>(
			"schedule.create",
			{
				id: "noon-ny",
				botId: "timer",
				kind: "cron",
				input: "0 12 * * *",
				text: "Noon",
				target: { mode: "chat", chatKey: "timer-chat" },
			},
			scope,
		);
		expect(before.status).toBe(200);
		const nyNext = before.frame.result?.schedule.nextRun;
		expect(nyNext).toBeGreaterThan(Date.now());

		const tzUpdate = await sendRpc<{ bot: BotRecord }>(
			"bot.update",
			{ botId: "timer", timezone: "Asia/Tokyo" },
			scope,
		);
		expect(tzUpdate.status).toBe(200);

		const listed = await sendRpc<{ schedules: ScheduleRecord[] }>(
			"schedule.list",
			{ botId: "timer" },
			scope,
		);
		const recomputed = listed.frame.result?.schedules.find(
			(s) => s.id === "noon-ny",
		);
		expect(recomputed?.nextRun).toBeDefined();
		expect(recomputed?.nextRun).not.toBe(nyNext);

		const after = await sendRpc<{ schedule: ScheduleRecord }>(
			"schedule.create",
			{
				id: "noon-tokyo",
				botId: "timer",
				kind: "cron",
				input: "0 12 * * *",
				text: "Noon Tokyo",
				target: { mode: "chat", chatKey: "timer-chat" },
			},
			scope,
		);
		expect(after.status).toBe(200);
		expect(after.frame.result?.schedule.nextRun).toBe(recomputed?.nextRun);
	});
});
