import { describe, expect, it } from "vitest";
import {
	connectTestWs,
	sendRpc,
	TEST_TOKEN,
	uniqueAccountId,
	useWorkerFixture,
	workerFetch,
} from "./helpers.js";

type Scope = { accountId: string; familyId: string };

async function waitFor(check: () => Promise<boolean>, ms = 15_000) {
	const deadline = Date.now() + ms;
	while (Date.now() < deadline) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 30));
	}
	throw new Error("condition was not met before the deadline");
}

async function setupBot(
	scope: Scope,
	opts?: { tools?: string[]; key?: string },
) {
	await sendRpc(
		"bot.create",
		{
			slug: "worker",
			name: "Worker",
			model: "faux/echo",
			...(opts?.tools ? { tools: opts.tools } : {}),
		},
		scope,
	);
	await sendRpc(
		"chat.create",
		{ botId: "worker", key: opts?.key ?? "main" },
		scope,
	);
}

function addTools(n: number): string {
	return Array.from({ length: n }, (_, i) => {
		const idx = i + 1;
		return `[tool:task_add ${JSON.stringify({ title: `Task ${idx}`, details: `Do thing ${idx}` })}]`;
	}).join(" ");
}

describe("chat tasks", () => {
	useWorkerFixture();

	it("round-trips add/list/get/finish/remove and never reuses indexes", async () => {
		const scope = {
			accountId: uniqueAccountId("tasks-crud"),
			familyId: "default",
		};
		await setupBot(scope);
		const add = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "main",
				text: `${addTools(2)} [tool:task_list {}]`,
			},
			scope,
		);
		expect(add.frame.ok).toBe(true);
		await waitFor(async () => {
			const listed = await sendRpc<{
				tasks: { index: number; status: string }[];
			}>("chat.tasks.list", { chatKey: "main" }, scope);
			const tasks = listed.frame.result?.tasks ?? [];
			return (
				tasks.length === 2 && tasks.every((task) => task.status === "done")
			);
		});
		const notStarted = await sendRpc<{ reply: string }>(
			"turn.submit",
			{ chatKey: "main", text: '[tool:task_finish {"index":1}]' },
			scope,
		);
		expect(notStarted.frame.result?.reply).toContain("is not in progress");
		await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "main",
				text: '[tool:task_add {"title":"Third","details":"next"}] [tool:task_add {"title":"Fourth","details":"also"}] [tool:task_get {}] [tool:task_get {"index":4}] [tool:task_finish {"index":3,"summary":"ok"}]',
			},
			scope,
		);
		const snap = await sendRpc<{
			messages: { text: string }[];
		}>("chat.get", { chatKey: "main" }, scope);
		const blob = JSON.stringify(snap.frame.result);
		expect(blob).toContain("already in progress");
		expect(blob).toContain('"index":3');
		const got = await sendRpc<{ task: { summary?: string; status: string } }>(
			"chat.tasks.get",
			{ chatKey: "main", index: 3 },
			scope,
		);
		expect(got.frame.result?.task.status).toBe("done");
		expect(got.frame.result?.task.summary).toBe("ok");
		await sendRpc(
			"turn.submit",
			{ chatKey: "main", text: '[tool:task_remove {"index":2}]' },
			scope,
		);
		await sendRpc(
			"turn.submit",
			{
				chatKey: "main",
				text: '[tool:task_add {"title":"Reuse","details":"no"}]',
			},
			scope,
		);
		const after = await sendRpc<{ tasks: { index: number }[] }>(
			"chat.tasks.list",
			{ chatKey: "main" },
			scope,
		);
		const indexes = (after.frame.result?.tasks ?? []).map((t) => t.index);
		expect(indexes).toContain(1);
		expect(indexes).toContain(5);
		expect(indexes).not.toContain(2);
	}, 30_000);

	it("auto-continues after the user turn returns and stops when empty", async () => {
		const scope = {
			accountId: uniqueAccountId("tasks-loop"),
			familyId: "default",
		};
		await setupBot(scope);
		const started = Date.now();
		const turn = await sendRpc<{ reply: string }>(
			"turn.submit",
			{ chatKey: "main", text: addTools(2) },
			scope,
		);
		expect(turn.frame.ok).toBe(true);
		expect(Date.now() - started).toBeLessThan(8_000);
		await waitFor(async () => {
			const viewed = await sendRpc<{
				messages: { role: string; text: string }[];
				tasks?: { status: string }[];
			}>("chat.get", { chatKey: "main" }, scope);
			const continues = (viewed.frame.result?.messages ?? []).filter(
				(message) =>
					message.role === "user" &&
					message.text.startsWith("[tasks · auto-continue"),
			);
			const open = (viewed.frame.result?.tasks ?? []).filter(
				(task) => task.status !== "done",
			);
			return continues.length >= 2 && open.length === 0;
		});
	}, 30_000);

	it("pauses on abort and resumes on the next user message", async () => {
		const scope = {
			accountId: uniqueAccountId("tasks-abort"),
			familyId: "default",
		};
		await setupBot(scope);
		await sendRpc("turn.submit", { chatKey: "main", text: addTools(2) }, scope);
		await waitFor(async () => {
			const viewed = await sendRpc<{
				messages: { role: string; text: string }[];
			}>("chat.get", { chatKey: "main" }, scope);
			return (viewed.frame.result?.messages ?? []).some(
				(message) =>
					message.role === "user" &&
					message.text.startsWith("[tasks · auto-continue"),
			);
		});
		const aborted = await sendRpc("turn.abort", { chatKey: "main" }, scope);
		expect(aborted.frame.ok).toBe(true);
		const status = await sendRpc<{
			taskLoop?: { state: string };
		}>("chat.get", { chatKey: "main" }, scope);
		expect(status.frame.result?.taskLoop?.state).toBe("paused");
		await sendRpc(
			"turn.submit",
			{ chatKey: "main", text: "resume please" },
			scope,
		);
		const resumed = await sendRpc<{
			taskLoop?: { state: string };
		}>("chat.get", { chatKey: "main" }, scope);
		expect(resumed.frame.result?.taskLoop?.state).not.toBe("paused");
	}, 30_000);

	it("runs a queued user message before the next continue", async () => {
		const scope = {
			accountId: uniqueAccountId("tasks-queue"),
			familyId: "default",
		};
		await setupBot(scope);
		const first = sendRpc(
			"turn.submit",
			{ chatKey: "main", text: addTools(2) },
			scope,
		);
		const queued = sendRpc<{ reply: string }>(
			"turn.submit",
			{ chatKey: "main", text: "queued-user" },
			scope,
		);
		await first;
		const result = await queued;
		expect(result.frame.result?.reply).toContain("queued-user");
		const viewed = await sendRpc<{
			messages: { role: string; text: string }[];
		}>("chat.get", { chatKey: "main" }, scope);
		const texts = (viewed.frame.result?.messages ?? [])
			.filter((message) => message.role === "user")
			.map((message) => message.text);
		expect(texts.some((text) => text === "queued-user")).toBe(true);
		expect(
			texts.some((text) => text.startsWith("[tasks · auto-continue")),
		).toBe(true);
	}, 30_000);

	it("omits task tools in group-member consults and with an explicit allowlist", async () => {
		const groupScope = {
			accountId: uniqueAccountId("tasks-group"),
			familyId: "default",
		};
		await sendRpc(
			"bot.create",
			{ slug: "a", name: "a", model: "faux/echo" },
			groupScope,
		);
		await sendRpc(
			"bot.create",
			{ slug: "b", name: "b", model: "faux/echo" },
			groupScope,
		);
		await sendRpc("chat.create", { botId: "a", key: "root" }, groupScope);
		const group = await sendRpc<{ reply: string }>(
			"turn.submit",
			{
				chatKey: "root",
				text: `[tool:message_bot ${JSON.stringify({
					botId: "b",
					topic: "room",
					readOnly: true,
					text: '[[consult]] [tool:task_add {"title":"x","details":"y"}]',
				})}]`,
			},
			groupScope,
		);
		expect(group.frame.result?.reply).toMatch(
			/disabled|read-only|not available/i,
		);
		const listed = await sendRpc<{ tasks: unknown[] }>(
			"chat.tasks.list",
			{ chatKey: "root" },
			groupScope,
		);
		expect(listed.frame.result?.tasks ?? []).toEqual([]);

		const explicit = {
			accountId: uniqueAccountId("tasks-explicit"),
			familyId: "default",
		};
		await setupBot(explicit, { tools: ["memory_read"] });
		await sendRpc(
			"turn.submit",
			{
				chatKey: "main",
				text: '[tool:task_add {"title":"no","details":"nope"}]',
			},
			explicit,
		);
		const none = await sendRpc<{ tasks: unknown[] }>(
			"chat.tasks.list",
			{ chatKey: "main" },
			explicit,
		);
		expect(none.frame.result?.tasks ?? []).toEqual([]);
	}, 30_000);

	it("exposes chat.tasks over WS and REST and clears on reset", async () => {
		const scope = {
			accountId: uniqueAccountId("tasks-proto"),
			familyId: "default",
		};
		await setupBot(scope);
		const ws = await connectTestWs(scope);
		try {
			await ws.send("turn.submit", {
				chatKey: "main",
				text: '[tool:task_add {"title":"One","details":"body"}]',
			});
			expect(ws.events.some((event) => event.type === "chat.tasks")).toBe(true);
			const listed = await ws.send<{ tasks: { title: string }[] }>(
				"chat.tasks.list",
				{ chatKey: "main" },
			);
			expect(listed.result?.tasks[0]?.title).toBe("One");
		} finally {
			ws.close();
		}
		const rest = await workerFetch(
			"http://example.com/api/chat/tasks/list?chatKey=main",
			{
				headers: {
					Authorization: `Bearer ${TEST_TOKEN}`,
					"x-account-id": scope.accountId,
					"X-Cadmus-Family-Id": scope.familyId,
				},
			},
		);
		expect(rest.status).toBe(200);
		const body = (await rest.json()) as { tasks: { title: string }[] };
		expect(body.tasks[0]?.title).toBe("One");
		await sendRpc("chat.reset", { chatKey: "main", handoff: "reset" }, scope);
		const cleared = await sendRpc<{ tasks: unknown[] }>(
			"chat.tasks.list",
			{ chatKey: "main" },
			scope,
		);
		expect(cleared.frame.result?.tasks).toEqual([]);
	}, 30_000);

	it("validates deadlines merge, null reset, group defaults, and 24h rejection over the contract", async () => {
		const scope = {
			accountId: uniqueAccountId("tasks-deadlines"),
			familyId: "default",
		};
		await setupBot(scope);
		const tooBig = await sendRpc(
			"chat.update",
			{ chatKey: "main", deadlines: { turnMs: 25 * 60 * 60 * 1000 } },
			scope,
		);
		expect(tooBig.frame.ok).toBe(false);

		await sendRpc(
			"chat.update",
			{ chatKey: "main", deadlines: { turnMs: 0, runMs: 50 } },
			scope,
		);
		const got = await sendRpc<{
			chat: {
				deadlines?: { turnMs?: number; runMs?: number };
				effectiveDeadlines?: { turnMs: number; runMs: number };
			};
		}>("chat.get", { chatKey: "main" }, scope);
		expect(got.frame.result?.chat.deadlines?.turnMs).toBe(0);
		expect(got.frame.result?.chat.effectiveDeadlines?.turnMs).toBe(0);
		expect(got.frame.result?.chat.effectiveDeadlines?.runMs).toBe(50);

		await sendRpc(
			"chat.update",
			{ chatKey: "main", deadlines: { turnMs: 1000 } },
			scope,
		);
		const merged = await sendRpc<{
			chat: { deadlines?: { turnMs?: number; runMs?: number } };
		}>("chat.get", { chatKey: "main" }, scope);
		expect(merged.frame.result?.chat.deadlines?.runMs).toBe(50);
		expect(merged.frame.result?.chat.deadlines?.turnMs).toBe(1000);

		await sendRpc("chat.update", { chatKey: "main", deadlines: null }, scope);
		const reset = await sendRpc<{
			chat: {
				deadlines?: unknown;
				effectiveDeadlines?: { turnMs: number; runMs: number };
			};
		}>("chat.get", { chatKey: "main" }, scope);
		expect(reset.frame.result?.chat.deadlines).toBeUndefined();
		expect(reset.frame.result?.chat.effectiveDeadlines?.turnMs).toBe(0);

		await sendRpc(
			"bot.create",
			{ slug: "peer", name: "peer", model: "faux/echo" },
			scope,
		);
		await sendRpc(
			"turn.submit",
			{
				chatKey: "main",
				text: `[tool:message_bot ${JSON.stringify({
					botId: "peer",
					topic: "g",
					text: "hi",
				})}]`,
			},
			scope,
		);
		const groups = await sendRpc<{
			chats: {
				kind?: string;
				effectiveDeadlines?: { turnMs: number; runMs: number };
			}[];
		}>("chat.list", { kinds: ["group"] }, scope);
		const group = groups.frame.result?.chats.find(
			(chat) => chat.kind === "group",
		);
		expect(group?.effectiveDeadlines?.turnMs).toBe(120_000);
		expect(group?.effectiveDeadlines?.runMs).toBe(600_000);
	}, 40_000);

	it("caps the loop at the round limit and keeps the remaining task", async () => {
		const scope = {
			accountId: uniqueAccountId("tasks-rounds"),
			familyId: "default",
		};
		await setupBot(scope);
		await sendRpc("turn.submit", { chatKey: "main", text: addTools(3) }, scope);
		await waitFor(async () => {
			const viewed = await sendRpc<{ taskLoop?: { state: string } }>(
				"chat.get",
				{ chatKey: "main" },
				scope,
			);
			return viewed.frame.result?.taskLoop?.state === "capped";
		});
		const viewed = await sendRpc<{
			messages: { role: string; text: string }[];
			tasks?: { status: string }[];
		}>("chat.get", { chatKey: "main" }, scope);
		const continues = (viewed.frame.result?.messages ?? []).filter(
			(message) =>
				message.role === "user" &&
				message.text.startsWith("[tasks · auto-continue"),
		);
		const open = (viewed.frame.result?.tasks ?? []).filter(
			(task) => task.status !== "done",
		);
		expect(continues).toHaveLength(2);
		expect(open).toHaveLength(1);
	}, 30_000);
});
