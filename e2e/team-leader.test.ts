import { describe, expect, it } from "vitest";
import {
	adminScope,
	type BotRecord,
	type FamilyRecord,
	sendRpc,
	useWorkerFixture,
} from "./helpers.js";

describe("Family Team Leader", () => {
	useWorkerFixture();

	it("sets the Team Leader and family.get returns it", async () => {
		const scope = await adminScope("default");
		await sendRpc("bot.create", { slug: "lead", name: "Lead" }, scope);
		const updated = await sendRpc<{ family: FamilyRecord }>(
			"family.update",
			{ teamLeaderBotId: "lead" },
			scope,
		);
		expect(updated.status).toBe(200);
		expect(updated.frame.result?.family.teamLeaderBotId).toBe("lead");

		const got = await sendRpc<{ family: FamilyRecord }>(
			"family.get",
			{},
			scope,
		);
		expect(got.status).toBe(200);
		expect(got.frame.result?.family.teamLeaderBotId).toBe("lead");

		const listed = await sendRpc<{ families: FamilyRecord[] }>(
			"family.list",
			{},
			scope,
		);
		expect(
			listed.frame.result?.families.find(
				(family) => family.familyId === "default",
			)?.teamLeaderBotId,
		).toBe("lead");
	});

	it("clears the Team Leader when family.update sends null", async () => {
		const scope = await adminScope("default");
		await sendRpc("bot.create", { slug: "lead", name: "Lead" }, scope);
		await sendRpc("family.update", { teamLeaderBotId: "lead" }, scope);
		const cleared = await sendRpc<{ family: FamilyRecord }>(
			"family.update",
			{ teamLeaderBotId: null },
			scope,
		);
		expect(cleared.status).toBe(200);
		expect(cleared.frame.result?.family.teamLeaderBotId).toBeUndefined();

		const got = await sendRpc<{ family: FamilyRecord }>(
			"family.get",
			{},
			scope,
		);
		expect(got.frame.result?.family.teamLeaderBotId).toBeUndefined();
	});

	it("rejects an unknown bot id", async () => {
		const scope = await adminScope("default");
		const rejected = await sendRpc(
			"family.update",
			{ teamLeaderBotId: "missing-bot" },
			scope,
		);
		expect(rejected.status).toBe(400);
		expect(rejected.frame.ok).toBe(false);
		expect(rejected.frame.error?.code).toBe("not_found");
	});

	it("rejects a bot that belongs to another family", async () => {
		const { accountId, token } = await adminScope();
		await sendRpc(
			"family.create",
			{ familyId: "alpha", name: "Alpha" },
			{ accountId, token },
		);
		await sendRpc(
			"family.create",
			{ familyId: "beta", name: "Beta" },
			{ accountId, token },
		);
		await sendRpc(
			"bot.create",
			{ slug: "beta-lead", name: "Beta Lead" },
			{ accountId, token, familyId: "beta" },
		);
		const rejected = await sendRpc(
			"family.update",
			{ teamLeaderBotId: "beta-lead" },
			{ accountId, token, familyId: "alpha" },
		);
		expect(rejected.status).toBe(400);
		expect(rejected.frame.error?.code).toBe("not_found");

		const alpha = await sendRpc<{ family: FamilyRecord }>(
			"family.get",
			{},
			{ accountId, token, familyId: "alpha" },
		);
		expect(alpha.frame.result?.family.teamLeaderBotId).toBeUndefined();
	});

	it("clears the Team Leader when that bot is deleted", async () => {
		const scope = await adminScope("default");
		await sendRpc("bot.create", { slug: "lead", name: "Lead" }, scope);
		await sendRpc("bot.create", { slug: "other", name: "Other" }, scope);
		await sendRpc("family.update", { teamLeaderBotId: "lead" }, scope);

		const deleted = await sendRpc<{ deleted: string }>(
			"bot.delete",
			{ botId: "lead" },
			scope,
		);
		expect(deleted.status).toBe(200);
		expect(deleted.frame.result?.deleted).toBe("lead");

		const got = await sendRpc<{ family: FamilyRecord }>(
			"family.get",
			{},
			scope,
		);
		expect(got.frame.result?.family.teamLeaderBotId).toBeUndefined();

		const bots = await sendRpc<{ bots: BotRecord[] }>("bot.list", {}, scope);
		expect(bots.frame.result?.bots.map((bot) => bot.id)).toEqual(["other"]);
	});

	it("keeps a separate Team Leader on each family", async () => {
		const { accountId, token } = await adminScope();
		await sendRpc(
			"family.create",
			{ familyId: "alpha", name: "Alpha" },
			{ accountId, token },
		);
		await sendRpc(
			"family.create",
			{ familyId: "beta", name: "Beta" },
			{ accountId, token },
		);
		await sendRpc(
			"bot.create",
			{ slug: "alpha-lead", name: "Alpha Lead" },
			{ accountId, token, familyId: "alpha" },
		);
		await sendRpc(
			"bot.create",
			{ slug: "beta-lead", name: "Beta Lead" },
			{ accountId, token, familyId: "beta" },
		);
		await sendRpc(
			"family.update",
			{ teamLeaderBotId: "alpha-lead" },
			{ accountId, token, familyId: "alpha" },
		);
		await sendRpc(
			"family.update",
			{ teamLeaderBotId: "beta-lead" },
			{ accountId, token, familyId: "beta" },
		);

		const alpha = await sendRpc<{ family: FamilyRecord }>(
			"family.get",
			{},
			{ accountId, token, familyId: "alpha" },
		);
		const beta = await sendRpc<{ family: FamilyRecord }>(
			"family.get",
			{},
			{ accountId, token, familyId: "beta" },
		);
		expect(alpha.frame.result?.family.teamLeaderBotId).toBe("alpha-lead");
		expect(beta.frame.result?.family.teamLeaderBotId).toBe("beta-lead");

		const listed = await sendRpc<{ families: FamilyRecord[] }>(
			"family.list",
			{},
			{ accountId, token, familyId: "alpha" },
		);
		const byId = new Map(
			(listed.frame.result?.families ?? []).map((family) => [
				family.familyId,
				family.teamLeaderBotId,
			]),
		);
		expect(byId.get("alpha")).toBe("alpha-lead");
		expect(byId.get("beta")).toBe("beta-lead");
	});
});
