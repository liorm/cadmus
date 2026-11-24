import {
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

async function groupMessages(scope: Scope) {
	const listed = await sendRpc<{
		chats: {
			key: string;
			kind?: string;
			topic?: string;
			readOnly?: boolean;
			groupStatus?: string;
			members?: string[];
		}[];
	}>("chat.list", { kinds: ["group"] }, scope);
	const group = listed.frame.result?.chats.find(
		(chat) => chat.kind === "group",
	);
	const viewed = await sendRpc<{
		messages: { text: string; fromBotId?: string }[];
	}>("chat.get", { chatKey: group?.key ?? "" }, scope);
	return {
		group,
		messages: viewed.frame.result?.messages ?? [],
	};
}

async function userTexts(scope: Scope, chatKey: string) {
	const viewed = await sendRpc<{
		messages: { role: string; text: string }[];
	}>("chat.get", { chatKey }, scope);
	return (viewed.frame.result?.messages ?? []).filter(
		(message) => message.role === "user",
	);
}

describe("group chats with more than two bots", () => {
	it("routes @mentions, lets the caller end, and stays read-only", async () => {
		const scope = {
			accountId: uniqueAccountId("mention-wait"),
			familyId: "default",
		};
		await bots(["a", "b", "c"], scope);
		const pending = sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "bot:a",
				text: `[tool:message_bot ${JSON.stringify({
					to: ["b", "c"],
					topic: "trio",
					text: "@b only [[hold:mb]]",
				})}]`,
			},
			scope,
		);
		await waitFor(() => holdReady(scope, "mb"));
		const opened = await groupMessages(scope);
		expect(opened.group?.members).toEqual(["a", "b", "c"]);
		expect(opened.group?.readOnly).toBe(true);
		expect(opened.messages.map((message) => message.fromBotId)).toEqual(["a"]);
		expect(opened.group?.groupStatus).toBe("open");

		const denied = await sendRpc(
			"turn.submit",
			{ chatKey: opened.group?.key ?? "", text: "nope" },
			scope,
		);
		expect(denied.frame.ok).toBe(false);
		expect(denied.frame.error?.code).toBe("forbidden");

		await releaseHold(
			scope,
			"mb",
			"@a [[group-reply]][[route:c]] now [[hold:mc]][[/group-reply]]",
		);
		await waitFor(() => holdReady(scope, "mc"));
		const mid = await groupMessages(scope);
		expect(mid.messages.map((message) => message.fromBotId)).toEqual([
			"a",
			"b",
			"a",
		]);
		expect(mid.messages[2]?.text).toContain("@c");
		expect(mid.messages.some((message) => message.fromBotId === "c")).toBe(
			false,
		);

		await releaseHold(
			scope,
			"mc",
			'@a [tool:end_conversation {"response":"trio"}]',
		);
		const turn = await pending;
		expect(turn.frame.ok).toBe(true);
		expect(turn.frame.result?.reply).toContain('"status":"ended"');
		expect(turn.frame.result?.reply).toContain("trio");
		const done = await groupMessages(scope);
		expect(done.group?.members).toEqual(["a", "b", "c"]);
		expect(done.group?.readOnly).toBe(true);
		expect(done.group?.groupStatus).toBe("ended");
		expect(done.messages.some((message) => message.fromBotId === "c")).toBe(
			true,
		);
	}, 30_000);

	it("gives a later message with no mentions no reply", async () => {
		const scope = {
			accountId: uniqueAccountId("mention-none"),
			familyId: "default",
		};
		await bots(["a", "b", "c"], scope);
		const pending = sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "bot:a",
				text: `[tool:message_bot ${JSON.stringify({
					to: ["b", "c"],
					topic: "quiet",
					text: "@b [[hold:nb]]",
				})}]`,
			},
			scope,
		);
		await waitFor(() => holdReady(scope, "nb"));
		await releaseHold(scope, "nb", "silence");
		await waitFor(async () => {
			const view = await groupMessages(scope);
			return view.messages.some((message) => message.fromBotId === "b");
		});
		await new Promise((resolve) => setTimeout(resolve, 400));
		const mid = await groupMessages(scope);
		expect(mid.messages.map((message) => message.fromBotId)).toEqual([
			"a",
			"b",
		]);
		expect(mid.group?.groupStatus).toBe("open");
		expect(await holdReady(scope, "nb")).toBe(false);

		const stub = stubFor(scope);
		await runInDurableObject(stub, async (_instance, state) => {
			state.storage.sql.exec(
				`UPDATE cadmus_group_chats
         SET reply_deadline = 1
         WHERE status = 'open'`,
			);
			await state.storage.setAlarm(Date.now());
		});
		await runDurableObjectAlarm(stub);
		const turn = await pending;
		expect(turn.frame.result?.reply).toContain('"status":"timed_out"');
	}, 30_000);

	it("wakes the caller once when every opening mention has replied", async () => {
		const scope = {
			accountId: uniqueAccountId("mention-forget"),
			familyId: "default",
		};
		await bots(["a", "b", "c"], scope);
		const turn = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "bot:a",
				text: `[tool:message_bot ${JSON.stringify({
					to: ["b", "c"],
					topic: "fan",
					wait: false,
					text: "@b @c [[hold:fb]]",
				})}]`,
			},
			scope,
		);
		expect(turn.frame.result?.reply).toContain('"status":"pending"');
		await waitFor(() => holdReady(scope, "fb"));
		expect(
			(await userTexts(scope, "bot:a")).some((message) =>
				message.text.includes("reply from @"),
			),
		).toBe(false);
		await releaseHold(scope, "fb", "from-b");
		await waitFor(async () => {
			const view = await groupMessages(scope);
			return view.messages.some((message) => message.text === "from-b");
		});
		await waitFor(() => holdReady(scope, "fb"));
		expect(
			(await userTexts(scope, "bot:a")).some((message) =>
				message.text.includes("reply from @"),
			),
		).toBe(false);
		await releaseHold(scope, "fb", "from-c");
		await waitFor(async () => {
			const messages = await userTexts(scope, "bot:a");
			return messages.some((message) => message.text.includes("reply from @"));
		});
		const woken = (await userTexts(scope, "bot:a")).filter((message) =>
			message.text.includes("reply from @"),
		);
		expect(woken).toHaveLength(1);
		expect(woken[0]?.text).toContain("from-b");
		expect(woken[0]?.text).toContain("from-c");
		const done = await groupMessages(scope);
		expect(done.group?.groupStatus).toBe("ended");
		expect(done.group?.members).toEqual(["a", "b", "c"]);
	}, 30_000);

	it("caps and times out a three-member chat", async () => {
		const scope = {
			accountId: uniqueAccountId("mention-cap"),
			familyId: "default",
		};
		await bots(["a", "b", "c"], scope);
		const capped = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "bot:a",
				text: `[tool:message_bot ${JSON.stringify({
					to: ["b", "c"],
					topic: "cap",
					text: "@b @c ping",
				})}]`,
			},
			scope,
		);
		expect(capped.frame.result?.reply).toContain('"status":"capped"');

		const hangScope = {
			accountId: uniqueAccountId("mention-hang"),
			familyId: "default",
		};
		await bots(["a", "b", "c"], hangScope);
		const pending = sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "bot:a",
				text: `[tool:message_bot ${JSON.stringify({
					to: ["b", "c"],
					topic: "hang",
					text: "@b [[hang]]",
				})}]`,
			},
			hangScope,
		);
		const stub = stubFor(hangScope);
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
		expect(turn.frame.result?.reply).toContain('"status":"timed_out"');
		const listed = await sendRpc<{
			chats: { kind?: string; groupStatus?: string; members?: string[] }[];
		}>("chat.list", { kinds: ["group"] }, hangScope);
		const group = listed.frame.result?.chats.find(
			(chat) => chat.kind === "group",
		);
		expect(group?.groupStatus).toBe("timed_out");
		expect(group?.members).toEqual(["a", "b", "c"]);
	}, 30_000);

	it("refuses a missing sibling, a cycle, and depth above 3", async () => {
		const scope = {
			accountId: uniqueAccountId("mention-limits"),
			familyId: "default",
		};
		await bots(["a", "b", "c", "d", "e"], scope);
		const missing = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "bot:a",
				text: `[tool:message_bot ${JSON.stringify({
					to: ["b", "other-family"],
					topic: "x",
					text: "hi",
				})}]`,
			},
			scope,
		);
		expect(missing.frame.result?.reply).toContain("not found in this family");
		const none = await sendRpc<{ chats: { kind?: string }[] }>(
			"chat.list",
			{ kinds: ["group"] },
			scope,
		);
		expect(none.frame.result?.chats.some((chat) => chat.kind === "group")).toBe(
			false,
		);

		const cycle = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "bot:a",
				text: `[tool:message_bot ${JSON.stringify({
					to: ["b", "c"],
					topic: "loop",
					text: `@b [tool:message_bot ${JSON.stringify({ botId: "a", topic: "back", text: "back" })}]`,
				})}]`,
			},
			scope,
		);
		expect(cycle.frame.result?.reply).toContain("already on the hop chain");

		const depth = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "bot:a",
				text: `[tool:message_bot ${JSON.stringify({
					to: ["b", "c", "d", "e"],
					topic: "deep",
					text: "too many",
				})}]`,
			},
			scope,
		);
		expect(depth.frame.result?.reply).toContain("max depth is 3");
	}, 30_000);
});
