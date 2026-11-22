import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
	clearProviderToolCapture,
	installProviderToolCapture,
	type ProviderToolCapture,
} from "../src/extensions/provider-tools.js";
import { sendRpc, uniqueAccountId } from "./helpers.js";

type Scope = { accountId: string; familyId: string };

function stubFor(scope: Scope) {
	return env.CADMUS_BOT_FAMILY.get(
		env.CADMUS_BOT_FAMILY.idFromName(
			`cadmus:${scope.accountId}:${scope.familyId}`,
		),
	);
}

async function waitFor(check: () => Promise<boolean>, ms = 15_000) {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 30));
	}
	throw new Error("condition was not met before the deadline");
}

async function holdReady(scope: Scope, name: string) {
	return runInDurableObject(stubFor(scope), () => {
		const holds = (
			globalThis as unknown as {
				__cadmusHolds?: Map<string, (text: string) => void>;
			}
		).__cadmusHolds;
		return Boolean(holds?.has(name));
	});
}

async function releaseHold(scope: Scope, name: string, text: string) {
	await waitFor(() => holdReady(scope, name));
	await runInDurableObject(stubFor(scope), () => {
		const holds = (
			globalThis as unknown as {
				__cadmusHolds?: Map<string, (text: string) => void>;
			}
		).__cadmusHolds;
		holds?.get(name)?.(text);
	});
}

async function userTexts(scope: Scope, chatKey: string) {
	const viewed = await sendRpc<{
		messages: { role?: string; text: string }[];
	}>("chat.get", { chatKey }, scope);
	return (viewed.frame.result?.messages ?? []).filter(
		(message) => message.role === "user",
	);
}

function capturesFor(sink: ProviderToolCapture[], botId: string): string[][] {
	return sink
		.filter((entry) => entry.botId === botId)
		.map((entry) => entry.tools);
}

const READS = ["read"];

describe("message_bot readOnly", () => {
	it("returns a skill fact through end_conversation in a user read-only group chat", async () => {
		const scope = {
			accountId: uniqueAccountId("ro-fact"),
			familyId: "default",
		};
		await sendRpc(
			"bot.create",
			{ slug: "a", name: "a", model: "faux/echo" },
			scope,
		);
		await sendRpc(
			"bot.create",
			{
				slug: "b",
				name: "b",
				model: "faux/echo",
				memory: "- origin memory\n",
				skills: [
					{
						slug: "spice",
						description: "pantry spice",
						body: "cinnamon",
					},
				],
			},
			scope,
		);
		await sendRpc("chat.create", { botId: "a", key: "root" }, scope);
		await sendRpc("chat.create", { botId: "b", key: "b-main" }, scope);

		const sink = installProviderToolCapture();
		try {
			const turn = await sendRpc<{ reply: string }>(
				"turn.submit",
				{
					chatKey: "root",
					text: `[tool:message_bot ${JSON.stringify({
						botId: "b",
						topic: "spice",
						readOnly: true,
						text: '[[consult]] [tool:read {"path":"/.cadmus/skills/spice/SKILL.md"}]',
					})}]`,
				},
				scope,
			);
			expect(turn.frame.ok).toBe(true);
			expect(turn.frame.result?.reply).toContain("cinnamon");
			expect(turn.frame.result?.reply).toContain('"status":"ended"');

			const listed = await sendRpc<{
				chats: {
					key: string;
					kind?: string;
					topic?: string;
					readOnly?: boolean;
					toolsReadOnly?: boolean;
					members?: string[];
					harvest?: boolean;
				}[];
			}>("chat.list", { kinds: ["group"] }, scope);
			const group = listed.frame.result?.chats.find(
				(chat) => chat.kind === "group",
			);
			expect(group?.topic).toBe("spice");
			expect(group?.members?.sort()).toEqual(["a", "b"]);
			expect(group?.readOnly).toBe(true);
			expect(group?.toolsReadOnly).toBe(true);
			expect(group?.harvest).toBe(false);

			const denied = await sendRpc(
				"turn.submit",
				{ chatKey: group?.key ?? "", text: "user post" },
				scope,
			);
			expect(denied.frame.ok).toBe(false);
			expect(denied.frame.error?.code).toBe("forbidden");

			const offeredB = capturesFor(sink, "b");
			expect(offeredB.length).toBeGreaterThan(0);
			for (const tools of offeredB) {
				expect(tools).toEqual(READS);
			}
			const offeredA = capturesFor(sink, "a");
			expect(offeredA.some((tools) => tools.includes("end_conversation"))).toBe(
				true,
			);
			expect(offeredA.some((tools) => tools.includes("message_bot"))).toBe(
				true,
			);
		} finally {
			clearProviderToolCapture();
		}

		const skill = await sendRpc<{ content?: string; version?: number }>(
			"file.read",
			{ botId: "b", path: "/.cadmus/skills/spice/SKILL.md" },
			scope,
		);
		expect(skill.frame.result?.content).toContain("cinnamon");
		const memory = await sendRpc<{ content?: string }>(
			"file.read",
			{ botId: "b", path: "/.cadmus/MEMORY.md" },
			scope,
		);
		expect(memory.frame.result?.content).toContain("origin memory");
	}, 30_000);

	it("refuses forged writes and leaves the target unchanged", async () => {
		const scope = {
			accountId: uniqueAccountId("ro-forge"),
			familyId: "default",
		};
		await sendRpc(
			"bot.create",
			{ slug: "a", name: "a", model: "faux/echo" },
			scope,
		);
		await sendRpc(
			"bot.create",
			{
				slug: "b",
				name: "b",
				model: "faux/echo",
				memory: "- stay\n",
				skills: [
					{
						slug: "spice",
						description: "pantry spice",
						body: "cinnamon",
					},
				],
			},
			scope,
		);
		await sendRpc("chat.create", { botId: "a", key: "root" }, scope);
		await sendRpc("chat.create", { botId: "b", key: "b-main" }, scope);

		const beforeChats = await sendRpc<{ chats: { key: string }[] }>(
			"chat.list",
			{},
			scope,
		);
		const beforeKeys = (beforeChats.frame.result?.chats ?? [])
			.map((chat) => chat.key)
			.sort();

		const forged = [
			'[tool:write {"path":"/.cadmus/skills/spice/SKILL.md","content":"---\\nname: spice\\ndescription: x\\n---\\n\\nchanged"}]',
			'[tool:write {"path":"/.cadmus/MEMORY.md","content":"- changed\\n"}]',
			'[tool:read {"path":"README.md"}]',
			'[tool:schedule_create {"kind":"absolute","input":"2099-01-01T00:00:00Z","text":"go"}]',
			'[tool:message_bot {"botId":"a","topic":"side","text":"hi"}]',
			'[tool:create_bot {"name":"c"}]',
			'[tool:code.execute {"code":"print(1)"}]',
		].join(" ");
		const turn = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "root",
				text: `[tool:message_bot ${JSON.stringify({
					botId: "b",
					topic: "forge",
					readOnly: true,
					text: `[[consult]] ${forged}`,
				})}]`,
			},
			scope,
		);
		expect(turn.frame.ok).toBe(true);
		expect(turn.frame.result?.reply).toContain("This group chat is read-only");
		expect(turn.frame.result?.reply).toContain('"status":"ended"');

		const skill = await sendRpc<{ content?: string }>(
			"file.read",
			{ botId: "b", path: "/.cadmus/skills/spice/SKILL.md" },
			scope,
		);
		expect(skill.frame.result?.content).toContain("cinnamon");
		expect(skill.frame.result?.content).not.toContain("changed");
		const memory = await sendRpc<{ content?: string }>(
			"file.read",
			{ botId: "b", path: "/.cadmus/MEMORY.md" },
			scope,
		);
		expect(memory.frame.result?.content).toContain("stay");
		expect(memory.frame.result?.content).not.toContain("changed");

		const schedules = await sendRpc<{
			schedules: { id: string; internal?: boolean }[];
		}>("schedule.list", { botId: "b", includeInternal: true }, scope);
		const ids = (schedules.frame.result?.schedules ?? []).map(
			(schedule) => schedule.id,
		);
		expect(ids.some((id) => id.startsWith("harvest:gmem:"))).toBe(false);
		expect(ids.some((id) => id.includes("grp_"))).toBe(false);

		const bots = await sendRpc<{ bots: { id: string }[] }>(
			"bot.list",
			{},
			scope,
		);
		expect(bots.frame.result?.bots.map((bot) => bot.id).sort()).toEqual([
			"a",
			"b",
		]);

		const after = await sendRpc<{
			chats: { key: string; kind?: string }[];
		}>("chat.list", { kinds: ["direct", "group"] }, scope);
		const keys = (after.frame.result?.chats ?? [])
			.map((chat) => chat.key)
			.sort();
		expect(keys.filter((key) => !key.startsWith("grp_"))).toEqual(beforeKeys);
		expect(
			after.frame.result?.chats.some((chat) => chat.kind === "group"),
		).toBe(true);

		const main = await sendRpc<{
			messages: { text: string }[];
			notes: unknown[];
		}>("chat.get", { chatKey: "b-main" }, scope);
		expect(main.frame.result?.notes).toEqual([]);
		expect(main.frame.result?.messages ?? []).toEqual([]);
	}, 30_000);

	it("wakes the originating chat once when readOnly is fire-and-forget", async () => {
		const scope = {
			accountId: uniqueAccountId("ro-forget"),
			familyId: "default",
		};
		await sendRpc(
			"bot.create",
			{ slug: "a", name: "a", model: "faux/echo" },
			scope,
		);
		await sendRpc(
			"bot.create",
			{ slug: "b", name: "b", model: "faux/echo" },
			scope,
		);
		await sendRpc("chat.create", { botId: "a", key: "root" }, scope);

		const sink = installProviderToolCapture();
		try {
			const turn = await sendRpc<{ reply: string }>(
				"turn.submit",
				{
					chatKey: "root",
					text: `[tool:message_bot ${JSON.stringify({
						botId: "b",
						topic: "later",
						readOnly: true,
						wait: false,
						text: "[[hold:ro-b]]",
					})}]`,
				},
				scope,
			);
			expect(turn.frame.ok).toBe(true);
			expect(turn.frame.result?.reply).toContain('"status":"pending"');
			await waitFor(() => holdReady(scope, "ro-b"));
			const offeredB = capturesFor(sink, "b");
			expect(offeredB.length).toBeGreaterThan(0);
			for (const tools of offeredB) expect(tools).toEqual(READS);
		} finally {
			clearProviderToolCapture();
		}

		await releaseHold(scope, "ro-b", "cinnamon later");
		await waitFor(async () => {
			const messages = await userTexts(scope, "root");
			return messages.some((message) => message.text.includes("reply from @b"));
		});
		const woken = (await userTexts(scope, "root")).filter(
			(message) =>
				message.role === "user" && message.text.includes("reply from @b"),
		);
		expect(woken).toHaveLength(1);
		expect(woken[0]?.text).toContain("cinnamon later");
		const listed = await sendRpc<{
			chats: { kind?: string; toolsReadOnly?: boolean; groupStatus?: string }[];
		}>("chat.list", { kinds: ["group"] }, scope);
		const group = listed.frame.result?.chats.find(
			(chat) => chat.kind === "group",
		);
		expect(group?.toolsReadOnly).toBe(true);
		expect(group?.groupStatus).toBe("ended");
	}, 30_000);

	it("applies the read-only tool list to every target", async () => {
		const scope = {
			accountId: uniqueAccountId("ro-three"),
			familyId: "default",
		};
		for (const slug of ["a", "b", "c"]) {
			await sendRpc(
				"bot.create",
				{ slug, name: slug, model: "faux/echo" },
				scope,
			);
		}
		await sendRpc("chat.create", { botId: "a", key: "root" }, scope);
		const sink = installProviderToolCapture();
		try {
			const turn = await sendRpc<{ reply: string }>(
				"turn.submit",
				{
					chatKey: "root",
					text: `[tool:message_bot ${JSON.stringify({
						to: ["b", "c"],
						topic: "trio",
						readOnly: true,
						text: '[[group-reply]]@a [tool:end_conversation {"response":"both"}][[/group-reply]]',
					})}]`,
				},
				scope,
			);
			expect(turn.frame.ok).toBe(true);
			expect(turn.frame.result?.reply).toContain("both");
			expect(turn.frame.result?.reply).toContain('"status":"ended"');
			for (const botId of ["b", "c"]) {
				const offered = capturesFor(sink, botId);
				expect(offered.length).toBeGreaterThan(0);
				for (const tools of offered) expect(tools).toEqual(READS);
			}
			const listed = await sendRpc<{
				chats: { kind?: string; members?: string[]; toolsReadOnly?: boolean }[];
			}>("chat.list", { kinds: ["group"] }, scope);
			const group = listed.frame.result?.chats.find(
				(chat) => chat.kind === "group",
			);
			expect(group?.members).toEqual(["a", "b", "c"]);
			expect(group?.toolsReadOnly).toBe(true);
		} finally {
			clearProviderToolCapture();
		}
	}, 30_000);

	it("still offers the target its full tools when readOnly is absent", async () => {
		const scope = {
			accountId: uniqueAccountId("ro-full"),
			familyId: "default",
		};
		await sendRpc(
			"bot.create",
			{ slug: "a", name: "a", model: "faux/echo" },
			scope,
		);
		await sendRpc(
			"bot.create",
			{ slug: "b", name: "b", model: "faux/echo" },
			scope,
		);
		await sendRpc("chat.create", { botId: "a", key: "root" }, scope);
		const sink = installProviderToolCapture();
		try {
			const turn = await sendRpc<{ reply: string }>(
				"turn.submit",
				{
					chatKey: "root",
					text: `[tool:message_bot ${JSON.stringify({
						botId: "b",
						topic: "open",
						text: '[[group-reply]][tool:end_conversation {"response":"full tools"}][[/group-reply]]',
					})}]`,
				},
				scope,
			);
			expect(turn.frame.ok).toBe(true);
			expect(turn.frame.result?.reply).toContain("full tools");
			const offered = capturesFor(sink, "b");
			expect(offered.length).toBeGreaterThan(0);
			for (const tools of offered) {
				for (const name of [
					"read",
					"write",
					"edit",
					"delete",
					"schedule_create",
					"message_bot",
					"create_bot",
				]) {
					expect(tools).toContain(name);
				}
				expect(tools).not.toContain("end_conversation");
				expect(tools.length).toBeGreaterThan(READS.length);
			}
			const listed = await sendRpc<{
				chats: { kind?: string; toolsReadOnly?: boolean; readOnly?: boolean }[];
			}>("chat.list", { kinds: ["group"] }, scope);
			const group = listed.frame.result?.chats.find(
				(chat) => chat.kind === "group",
			);
			expect(group?.readOnly).toBe(true);
			expect(group?.toolsReadOnly).toBeUndefined();
		} finally {
			clearProviderToolCapture();
		}
	}, 30_000);
});
