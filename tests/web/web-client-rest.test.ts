import { SELF } from "cloudflare:test";
import { CadmusClient } from "@cadmus/contract/client";
import { describe, expect, it } from "vitest";
import {
	sendRpc,
	TEST_TOKEN,
	uniqueAccountId,
} from "../../packages/worker/tests/helpers.js";

function webClient(
	accountId: string,
	familyId = "default",
	token = TEST_TOKEN,
) {
	return new CadmusClient({
		baseUrl: "http://example.com",
		token,
		userId: "web-user",
		accountId,
		familyId,
		fetchImpl: (input: RequestInfo | URL, init?: RequestInit) =>
			SELF.fetch(input, init),
	});
}

describe("Web UI client over /api", () => {
	it("round-trips readonly queries and mutations through CadmusClient", async () => {
		const accountId = uniqueAccountId("web-client");
		const client = webClient(accountId);

		const created = await client.callRpc("family.create", {
			familyId: "alpha",
			name: "Alpha",
			harvestDelayMs: 1500,
		});
		expect(created.ok).toBe(true);
		expect(created.command).toBe("family.create");
		expect(created.result?.family).toMatchObject({
			familyId: "alpha",
			name: "Alpha",
			harvestDelayMs: 1500,
		});

		const familyClient = webClient(accountId, "alpha");
		const bot = await familyClient.callRpc("bot.create", {
			slug: "scribe",
			name: "Scribe",
			model: "faux/echo",
			tools: ["knowledge_read"],
			soul: "You are Scribe.",
			knowledge: [
				{
					slug: "notes",
					description: "Field notes",
					category: "ops",
					body: "Gate is closed.",
				},
			],
		});
		expect(bot.ok).toBe(true);
		expect(bot.result?.bot).toMatchObject({
			id: "scribe",
			tools: ["knowledge_read"],
		});

		const schedules = await familyClient.callRpc("schedule.list", {
			includeInternal: false,
		});
		expect(schedules.ok).toBe(true);
		const rpcSchedules = await sendRpc(
			"schedule.list",
			{ includeInternal: false },
			{ accountId, familyId: "alpha" },
		);
		expect(schedules.result).toEqual(rpcSchedules.frame.result);

		const soul = await familyClient.callRpc("file.read", {
			botId: "scribe",
			path: "SOUL.md",
		});
		expect(soul.ok).toBe(true);
		expect(soul.result && "content" in soul.result).toBe(true);
		if (soul.result && "content" in soul.result) {
			expect(soul.result.content).toContain("You are Scribe.");
		}
		const rpcSoul = await sendRpc(
			"file.read",
			{ botId: "scribe", path: "SOUL.md" },
			{ accountId, familyId: "alpha" },
		);
		expect(soul.result).toEqual(rpcSoul.frame.result);

		const note = await familyClient.callRpc("file.read", {
			botId: "scribe",
			path: "knowledge/notes.md",
		});
		expect(note.ok).toBe(true);
		expect(note.result).toMatchObject({
			description: "Field notes",
			category: "ops",
			body: "Gate is closed.",
		});

		const write = await familyClient.callRpc("file.write", {
			botId: "scribe",
			path: "MEMORY.md",
			content: "Remember the gate.",
			expectedVersion: 0,
		});
		expect(write.ok).toBe(true);
		expect(write.result).toMatchObject({
			path: "MEMORY.md",
			version: 1,
			content: "Remember the gate.",
		});

		const conflict = await familyClient.callRpc("file.write", {
			botId: "scribe",
			path: "MEMORY.md",
			content: "stale",
			expectedVersion: 0,
		});
		expect(conflict.ok).toBe(false);
		expect(conflict.type).toBe("command.result");
		expect(conflict.command).toBe("file.write");
		expect(conflict.error?.code).toBe("cas_conflict");

		const missing = await familyClient.callRpc("file.read", {
			botId: "missing",
			path: "SOUL.md",
		});
		expect(missing.ok).toBe(false);
		expect(missing.error?.code).toBe("not_found");

		const denied = await webClient(
			accountId,
			"alpha",
			"not-the-secret",
		).callRpc("bot.list");
		expect(denied.ok).toBe(false);
		expect(denied.error?.code).toBe("unauthorized");
		expect(denied.command).toBe("bot.list");
	});
});
