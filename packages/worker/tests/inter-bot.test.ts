import {
	env,
	runDurableObjectAlarm,
	runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sendRpc, uniqueAccountId } from "./helpers.js";

describe("Inter-Bot DO Internals (timeout alarm, replay, cascade delete)", () => {
	async function bots(
		slugs: string[],
		scope: { accountId: string; familyId: string },
	) {
		for (const slug of slugs) {
			await sendRpc(
				"bot.create",
				{ slug, name: slug, model: "faux/echo" },
				scope,
			);
		}
	}

	it("times out a hung reply and returns the transcript", async () => {
		const scope = {
			accountId: uniqueAccountId("group-hang"),
			familyId: "default",
		};
		await bots(["a", "b"], scope);
		const pending = sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "bot:a",
				text: `[tool:message_bot ${JSON.stringify({
					botId: "b",
					topic: "wait",
					text: "[[hang]]",
				})}]`,
			},
			scope,
		);
		const stub = env.CADMUS_BOT_FAMILY.get(
			env.CADMUS_BOT_FAMILY.idFromName(
				`cadmus:${scope.accountId}:${scope.familyId}`,
			),
		);
		const started = Date.now();
		const deadline = started + 15_000;
		let armed = false;
		while (Date.now() < deadline && !armed) {
			armed = await runInDurableObject(stub, async (_instance, state) => {
				const due = state.storage.sql
					.exec<{ id: string }>(
						`SELECT id FROM cadmus_group_chats
             WHERE status = 'open' AND reply_deadline IS NOT NULL`,
					)
					.toArray();
				if (due.length === 0) return false;
				state.storage.sql.exec(
					`UPDATE cadmus_group_chats
           SET reply_deadline = 1
           WHERE status = 'open'`,
				);
				await state.storage.setAlarm(Date.now());
				return true;
			});
			if (!armed) await new Promise((resolve) => setTimeout(resolve, 30));
		}
		expect(armed).toBe(true);
		const turn = await pending;
		await runDurableObjectAlarm(stub);
		expect(turn.frame.ok).toBe(true);
		expect(turn.frame.result?.reply).toContain('"status":"timed_out"');
		expect(turn.frame.result?.reply).toContain("[[hang]]");
		const listed = await sendRpc<{
			chats: { kind?: string; groupStatus?: string }[];
		}>("chat.list", { kinds: ["group"] }, scope);
		expect(
			listed.frame.result?.chats.some(
				(chat) => chat.kind === "group" && chat.groupStatus === "timed_out",
			),
		).toBe(true);
	}, 30_000);

	it("resumes a replayed message_bot without a duplicate opening post", async () => {
		const scope = {
			accountId: uniqueAccountId("group-replay"),
			familyId: "default",
		};
		await bots(["a", "b"], scope);
		const opening =
			'[[group-reply]][tool:end_conversation {"response":"once"}][[/group-reply]]';
		const turn = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "bot:a",
				text: `[tool:message_bot ${JSON.stringify({
					botId: "b",
					topic: "replay",
					text: opening,
				})}]`,
			},
			scope,
		);
		expect(turn.frame.result?.reply).toContain('"status":"ended"');
		expect(turn.frame.result?.reply).toContain("once");
		const stub = env.CADMUS_BOT_FAMILY.get(
			env.CADMUS_BOT_FAMILY.idFromName(
				`cadmus:${scope.accountId}:${scope.familyId}`,
			),
		);
		const resumed = await runInDurableObject(stub, async (instance) => {
			const family = instance as unknown as {
				familyStore: {
					groups: {
						list(): {
							taskId: string;
							topic: string;
							openingText: string;
						}[];
					};
				};
				runMessageBotInternal(input: {
					taskId: string;
					callerBotId: string;
					targetBotId: string;
					topic: string;
					text: string;
					originChatKey: string;
				}): Promise<{ transcript: { text: string; fromBotId: string }[] }>;
			};
			const group = family.familyStore.groups.list()[0];
			if (!group) throw new Error("group missing");
			return family.runMessageBotInternal({
				taskId: group.taskId,
				callerBotId: "a",
				targetBotId: "b",
				topic: group.topic,
				text: `${group.openingText} EXTRA`,
				originChatKey: "bot:a",
			});
		});
		expect(
			resumed.transcript.filter((message) => message.text.includes(" EXTRA")),
		).toHaveLength(0);
		expect(
			resumed.transcript.filter((message) => message.fromBotId === "a"),
		).toHaveLength(1);
		const listed = await sendRpc<{ chats: { key: string; kind?: string }[] }>(
			"chat.list",
			{ kinds: ["group"] },
			scope,
		);
		const group = listed.frame.result?.chats.find(
			(chat) => chat.kind === "group",
		);
		const viewed = await sendRpc<{
			messages: { text: string; fromBotId?: string }[];
		}>("chat.get", { chatKey: group?.key ?? "" }, scope);
		expect(
			(viewed.frame.result?.messages ?? []).filter(
				(message) =>
					message.fromBotId === "a" &&
					message.text.includes("end_conversation"),
			),
		).toHaveLength(1);
	});

	it("deletes unlisted group member chats when a member bot is deleted", async () => {
		const scope = {
			accountId: uniqueAccountId("group-delete"),
			familyId: "default",
		};
		await bots(["a", "b"], scope);
		await sendRpc(
			"turn.submit",
			{
				chatKey: "bot:a",
				text: `[tool:message_bot ${JSON.stringify({
					botId: "b",
					topic: "bye",
					text: '[[group-reply]][tool:end_conversation {"response":"done"}][[/group-reply]]',
				})}]`,
			},
			scope,
		);
		await sendRpc("bot.delete", { botId: "a" }, scope);
		const stub = env.CADMUS_BOT_FAMILY.get(
			env.CADMUS_BOT_FAMILY.idFromName(
				`cadmus:${scope.accountId}:${scope.familyId}`,
			),
		);
		const left = await runInDurableObject(stub, async (_instance, state) => {
			return state.storage.sql
				.exec<{ key: string }>(
					`SELECT key FROM cadmus_chats WHERE key LIKE 'gmem:%'`,
				)
				.toArray();
		});
		expect(left).toEqual([]);
	});
});
