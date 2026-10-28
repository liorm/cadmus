import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { connectTestWs, sendRpc, uniqueAccountId } from "../helpers.js";

function envStub(accountId: string, envId: string) {
	return env.CADMUS_ENV.getByName(`env:${accountId}:${envId}`);
}

describe("tools env deregister", () => {
	it("removes a just-bash env from the account and forbids members", async () => {
		const accountId = uniqueAccountId("dereg-jb");
		const options = { accountId, familyId: "default" };
		await sendRpc("family.update", { harvestDelayMs: 0 }, options);
		const created = await sendRpc<{
			env: { envId: string; kind: string };
		}>(
			"account.toolsEnvs.create",
			{
				kind: "just-bash",
				label: "Scratch",
				persist: true,
				confineToWorkspace: true,
			},
			options,
		);
		expect(created.frame.ok).toBe(true);
		const envId = created.frame.result?.env.envId ?? "";
		expect(envId.length).toBeGreaterThan(0);

		const setDefault = await sendRpc(
			"account.update",
			{ defaultToolsEnv: { envId } },
			options,
		);
		expect(setDefault.frame.ok).toBe(true);

		await sendRpc(
			"bot.create",
			{
				slug: "assistant",
				name: "Assistant",
				model: "faux/echo",
				tools: ["write"],
				toolsEnv: { enabled: true, binding: { envId } },
			},
			options,
		);
		await sendRpc("chat.create", { botId: "assistant", key: "main" }, options);
		const ws = await connectTestWs(options);
		try {
			const wrote = await ws.send("turn.submit", {
				chatKey: "main",
				text: '[tool:write {"path":"note.txt","content":"keep"}]',
			});
			expect(wrote.ok).toBe(true);
		} finally {
			ws.close();
		}
		expect(
			await envStub(accountId, envId).namespaceBytes(
				"default",
				"bot:assistant",
			),
		).toBeGreaterThan(0);

		const memberToken = crypto.randomUUID();
		const added = await sendRpc(
			"account.members.add",
			{
				userId: `member-${crypto.randomUUID()}`,
				name: "Member",
				role: "member",
				token: memberToken,
			},
			options,
		);
		expect(added.frame.ok).toBe(true);

		const denied = await sendRpc(
			"account.toolsEnvs.deregister",
			{ envId },
			{ token: memberToken },
		);
		expect(denied.frame.ok).toBe(false);
		expect(denied.frame.error?.code).toBe("forbidden");

		const stillThere = await sendRpc<{
			envs: Array<{ envId: string }>;
		}>("account.toolsEnvs.list", {}, options);
		expect(
			stillThere.frame.result?.envs.some((row) => row.envId === envId),
		).toBe(true);

		const removed = await sendRpc<{ deregistered: string }>(
			"account.toolsEnvs.deregister",
			{ envId },
			options,
		);
		expect(removed.frame.ok).toBe(true);
		expect(removed.frame.result?.deregistered).toBe(envId);

		const listed = await sendRpc<{
			default: { envId: string } | null;
			envs: Array<{ envId: string }>;
		}>("account.toolsEnvs.list", {}, options);
		expect(listed.frame.ok).toBe(true);
		expect(listed.frame.result?.envs.some((row) => row.envId === envId)).toBe(
			false,
		);
		expect(listed.frame.result?.default).toBeNull();
		expect(
			await envStub(accountId, envId).namespaceBytes(
				"default",
				"bot:assistant",
			),
		).toBe(0);
	});
});
