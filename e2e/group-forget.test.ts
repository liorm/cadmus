import {
	abortAllDurableObjects,
	env,
	runDurableObjectAlarm,
	runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { sendRpc, uniqueAccountId } from "./helpers.js";

type Scope = { accountId: string; familyId: string };

function stubFor(scope: Scope) {
	return env.CADMUS_BOT_FAMILY.get(
		env.CADMUS_BOT_FAMILY.idFromName(
			`cadmus:${scope.accountId}:${scope.familyId}`,
		),
	);
}

async function bots(slugs: string[], scope: Scope) {
	for (const slug of slugs) {
		await sendRpc(
			"bot.create",
			{ slug, name: slug, model: "faux/echo" },
			scope,
		);
	}
	await sendRpc("chat.create", { botId: slugs[0], key: "root" }, scope);
}

async function waitFor(check: () => Promise<boolean>, ms = 15_000) {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 30));
	}
	throw new Error("condition was not met before the deadline");
}

async function releaseHold(scope: Scope, name: string, text: string) {
	const stub = stubFor(scope);
	await waitFor(async () => {
		return runInDurableObject(stub, () => {
			const holds = (
				globalThis as unknown as {
					__cadmusHolds?: Map<string, (text: string) => void>;
				}
			).__cadmusHolds;
			return Boolean(holds?.has(name));
		});
	});
	await runInDurableObject(stub, () => {
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
		messages: { role: string; text: string }[];
	}>("chat.get", { chatKey }, scope);
	return (viewed.frame.result?.messages ?? []).filter(
		(message) => message.role === "user",
	);
}

describe("fire-and-forget message_bot", () => {
	it("returns the group id immediately and wakes the originating chat with the reply", async () => {
		const scope = {
			accountId: uniqueAccountId("forget-wake"),
			familyId: "default",
		};
		await bots(["a", "b"], scope);
		const turn = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "root",
				text: `[tool:message_bot ${JSON.stringify({
					botId: "b",
					topic: "ping",
					wait: false,
					text: "[[hold:b]]",
				})}]`,
			},
			scope,
		);
		expect(turn.frame.ok).toBe(true);
		expect(turn.frame.result?.reply).toContain('"status":"pending"');
		expect(turn.frame.result?.reply).toContain('"topic":"ping"');
		const listed = await sendRpc<{
			chats: {
				key: string;
				kind?: string;
				topic?: string;
				readOnly?: boolean;
				groupStatus?: string;
				members?: string[];
			}[];
		}>("chat.list", {}, scope);
		const group = listed.frame.result?.chats.find(
			(chat) => chat.kind === "group",
		);
		expect(group?.topic).toBe("ping");
		expect(group?.readOnly).toBe(true);
		expect(group?.members?.sort()).toEqual(["a", "b"]);
		expect(group?.groupStatus).toBe("open");
		expect(turn.frame.result?.reply).toContain(group?.key);
		const early = await userTexts(scope, "root");
		expect(early.some((message) => message.text.includes("reply from @"))).toBe(
			false,
		);

		const denied = await sendRpc(
			"turn.submit",
			{ chatKey: group?.key ?? "", text: "nope" },
			scope,
		);
		expect(denied.frame.ok).toBe(false);
		expect(denied.frame.error?.code).toBe("forbidden");

		await releaseHold(scope, "b", "pong");
		await waitFor(async () => {
			const messages = await userTexts(scope, "root");
			return messages.some((message) => message.text.includes("reply from @b"));
		});
		const woken = (await userTexts(scope, "root")).filter((message) =>
			message.text.includes("reply from @b"),
		);
		expect(woken).toHaveLength(1);
		expect(woken[0]?.text).toContain(
			`[group "ping" · reply from @b · chat ${group?.key}]`,
		);
		expect(woken[0]?.text).toContain("pong");
		const after = await sendRpc<{
			chats: { key: string; kind?: string; groupStatus?: string }[];
		}>("chat.list", {}, scope);
		expect(
			after.frame.result?.chats.find((chat) => chat.key === group?.key)
				?.groupStatus,
		).toBe("ended");
	}, 30_000);

	it("queues the wake while the originating chat is busy", async () => {
		const scope = {
			accountId: uniqueAccountId("forget-busy"),
			familyId: "default",
		};
		await bots(["a", "b"], scope);
		await sendRpc(
			"turn.submit",
			{
				chatKey: "root",
				text: `[tool:message_bot ${JSON.stringify({
					botId: "b",
					topic: "later",
					wait: false,
					text: "[[hold:busy-b]]",
				})}]`,
			},
			scope,
		);
		const second = sendRpc<{ reply: string }>(
			"turn.submit",
			{ chatKey: "root", text: "[[hold:busy-a]]" },
			scope,
		);
		await waitFor(async () => {
			return runInDurableObject(stubFor(scope), () => {
				const holds = (
					globalThis as unknown as {
						__cadmusHolds?: Map<string, unknown>;
					}
				).__cadmusHolds;
				return Boolean(holds?.has("busy-a"));
			});
		});
		await releaseHold(scope, "busy-b", "from-b");
		await waitFor(async () => {
			const listed = await sendRpc<{
				chats: { kind?: string; groupStatus?: string }[];
			}>("chat.list", {}, scope);
			return Boolean(
				listed.frame.result?.chats.some(
					(chat) => chat.kind === "group" && chat.groupStatus === "ended",
				),
			);
		});
		const during = await userTexts(scope, "root");
		expect(during.some((message) => message.text.includes("from-b"))).toBe(
			false,
		);
		await releaseHold(scope, "busy-a", "busy-done");
		await second;
		await waitFor(async () => {
			const messages = await userTexts(scope, "root");
			return messages.some((message) => message.text.includes("from-b"));
		});
		const wakes = (await userTexts(scope, "root")).filter((message) =>
			message.text.includes("reply from @b"),
		);
		expect(wakes).toHaveLength(1);
	}, 30_000);

	it("wakes the caller when a fire-and-forget reply times out", async () => {
		const scope = {
			accountId: uniqueAccountId("forget-timeout"),
			familyId: "default",
		};
		await bots(["a", "b"], scope);
		const turn = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "root",
				text: `[tool:message_bot ${JSON.stringify({
					botId: "b",
					topic: "hang",
					wait: false,
					text: "[[hang]]",
				})}]`,
			},
			scope,
		);
		expect(turn.frame.result?.reply).toContain('"status":"pending"');
		const stub = stubFor(scope);
		const deadline = Date.now() + 15_000;
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
           SET reply_deadline = 1, overall_deadline = 1
           WHERE status = 'open'`,
				);
				await state.storage.setAlarm(Date.now());
				return true;
			});
			if (!armed) await new Promise((resolve) => setTimeout(resolve, 30));
		}
		expect(armed).toBe(true);
		await runDurableObjectAlarm(stub);
		await waitFor(async () => {
			const messages = await userTexts(scope, "root");
			return messages.some((message) => message.text.includes("timed_out"));
		});
		const wakes = (await userTexts(scope, "root")).filter((message) =>
			message.text.includes("timed_out"),
		);
		expect(wakes).toHaveLength(1);
		expect(wakes[0]?.text).toContain("reply from @b");
		expect(wakes[0]?.text).toContain("[[hang]]");
	}, 30_000);

	it("delivers one wake after a restart between the reply and the delivery", async () => {
		const scope = {
			accountId: uniqueAccountId("forget-restart"),
			familyId: "default",
		};
		await bots(["a", "b"], scope);
		const turn = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "root",
				text: `[tool:message_bot ${JSON.stringify({
					botId: "b",
					topic: "once",
					wait: false,
					text: "[[hold:restart-b]]",
				})}]`,
			},
			scope,
		);
		expect(turn.frame.result?.reply).toContain('"status":"pending"');
		const stub = stubFor(scope);
		await runInDurableObject(stub, async (_instance, state) => {
			state.storage.sql.exec(
				`UPDATE cadmus_group_chats SET wake_not_before = ? WHERE topic = 'once'`,
				Date.now() + 120_000,
			);
		});
		await releaseHold(scope, "restart-b", "only-once");
		await waitFor(async () => {
			return runInDurableObject(stub, async (_instance, state) => {
				const ended = state.storage.sql
					.exec<{ status: string }>(
						`SELECT status FROM cadmus_group_chats WHERE topic = 'once'`,
					)
					.toArray()[0];
				return ended?.status === "ended";
			});
		});
		expect(
			(await userTexts(scope, "root")).some((message) =>
				message.text.includes("only-once"),
			),
		).toBe(false);
		await runInDurableObject(stub, async (_instance, state) => {
			state.storage.sql.exec(
				`UPDATE cadmus_group_chats SET wake_not_before = NULL WHERE topic = 'once'`,
			);
		});
		await abortAllDurableObjects();
		await sendRpc("chat.list", {}, scope);
		await waitFor(async () => {
			const messages = await userTexts(scope, "root");
			return messages.some((message) => message.text.includes("only-once"));
		});
		await abortAllDurableObjects();
		await sendRpc("chat.list", {}, scope);
		await new Promise((resolve) => setTimeout(resolve, 200));
		const wakes = (await userTexts(scope, "root")).filter((message) =>
			message.text.includes("reply from @b"),
		);
		expect(wakes).toHaveLength(1);
		expect(wakes[0]?.text).toContain("only-once");
	}, 30_000);

	it("counts fire-and-forget calls against the peer budget and the hop guards", async () => {
		const scope = {
			accountId: uniqueAccountId("forget-limits"),
			familyId: "default",
		};
		await bots(["a", "b", "c", "d", "e"], scope);
		const call = (n: number) =>
			`[tool:message_bot ${JSON.stringify({
				botId: "b",
				topic: `t${n}`,
				wait: false,
				text: `[[group-reply]]ok${n}[[/group-reply]]`,
			})}]`;
		await sendRpc(
			"turn.submit",
			{ chatKey: "root", text: [1, 2, 3, 4, 5, 6].map(call).join(" ") },
			scope,
		);
		const budgetView = await sendRpc<{
			messages: { text: string }[];
		}>("chat.get", { chatKey: "root" }, scope);
		const budgetText = (budgetView.frame.result?.messages ?? [])
			.map((message) => message.text)
			.join("\n");
		expect(budgetText).toContain("peer action 6");
		expect(budgetText).toContain('"status":"pending"');
		const listed = await sendRpc<{
			chats: { topic?: string; kind?: string }[];
		}>("chat.list", {}, scope);
		const topics = (listed.frame.result?.chats ?? [])
			.filter((chat) => chat.kind === "group")
			.map((chat) => chat.topic);
		expect(topics.filter((topic) => topic?.startsWith("t"))).toHaveLength(5);

		await sendRpc(
			"turn.submit",
			{
				chatKey: "root",
				text: `[tool:message_bot ${JSON.stringify({
					botId: "b",
					topic: "loop",
					wait: false,
					text: `[tool:message_bot ${JSON.stringify({ botId: "a", topic: "back", text: "back", wait: false })}]`,
				})}]`,
			},
			scope,
		);
		const cycleView = await sendRpc<{ messages: { text: string }[] }>(
			"chat.get",
			{ chatKey: "root" },
			scope,
		);
		expect(
			(cycleView.frame.result?.messages ?? []).some((message) =>
				message.text.includes('"status":"pending"'),
			),
		).toBe(true);
		await waitFor(async () => {
			const messages = await userTexts(scope, "root");
			return messages.some((message) =>
				message.text.includes("already on the hop chain"),
			);
		});
		const back = await sendRpc<{
			chats: { topic?: string; kind?: string }[];
		}>("chat.list", {}, scope);
		expect(back.frame.result?.chats.some((chat) => chat.topic === "back")).toBe(
			false,
		);

		const nest = (botId: string, text: string) =>
			`[tool:message_bot ${JSON.stringify({ botId, topic: "depth", text })}]`;
		const depth = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "root",
				text: `[tool:message_bot ${JSON.stringify({
					botId: "b",
					topic: "depth",
					wait: false,
					text: nest("c", nest("d", nest("e", "too deep"))),
				})}]`,
			},
			scope,
		);
		expect(depth.frame.ok).toBe(true);
		await waitFor(async () => {
			const messages = await userTexts(scope, "root");
			return messages.some((message) =>
				message.text.includes("max depth is 3"),
			);
		});

		const again = `[tool:message_bot ${JSON.stringify({
			botId: "b",
			topic: "again",
			wait: false,
			text: "no",
		})}]`;
		const side = `[tool:message_bot ${JSON.stringify({
			botId: "c",
			topic: "side",
			wait: false,
			text: "hello side",
		})}]`;
		const inherited = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "root",
				text: `[tool:message_bot ${JSON.stringify({
					botId: "b",
					topic: "inherit",
					wait: false,
					text: `[[group-reply]]${again} ${side}[[/group-reply]]`,
				})}]`,
			},
			scope,
		);
		expect(inherited.frame.ok).toBe(true);
		await waitFor(async () => {
			const chats = await sendRpc<{
				chats: { topic?: string; kind?: string }[];
			}>("chat.list", {}, scope);
			return Boolean(
				chats.frame.result?.chats.some((chat) => chat.topic === "side"),
			);
		});
		const finalList = await sendRpc<{
			chats: { topic?: string; kind?: string }[];
		}>("chat.list", {}, scope);
		expect(
			finalList.frame.result?.chats.some((chat) => chat.topic === "again"),
		).toBe(false);
	}, 30_000);
});
