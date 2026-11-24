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
}

function addTools(n: number): string {
	return Array.from({ length: n }, (_, i) => {
		const idx = i + 1;
		return `[tool:task_add ${JSON.stringify({ title: `Task ${idx}`, details: `Do thing ${idx}` })}]`;
	}).join(" ");
}

describe("chat tasks DO internals", () => {
	it("does not double-inject a continue after restart", async () => {
		const scope = {
			accountId: uniqueAccountId("tasks-once"),
			familyId: "default",
		};
		await setupBot(scope);
		await sendRpc(
			"turn.submit",
			{ chatKey: "bot:worker", text: addTools(1) },
			scope,
		);
		await waitFor(async () => {
			const viewed = await sendRpc<{
				messages: { role: string; text: string }[];
			}>("chat.get", { chatKey: "bot:worker" }, scope);
			return (viewed.frame.result?.messages ?? []).some(
				(message) =>
					message.role === "user" &&
					message.text.includes("[tasks · auto-continue"),
			);
		});
		await abortAllDurableObjects();
		const viewed = await sendRpc<{
			messages: { role: string; text: string }[];
		}>("chat.get", { chatKey: "bot:worker" }, scope);
		const continues = (viewed.frame.result?.messages ?? []).filter(
			(message) =>
				message.role === "user" &&
				message.text.includes("[tasks · auto-continue"),
		);
		expect(continues.length).toBeLessThanOrEqual(2);
	}, 30_000);

	it("enforces turnMs, 0 as no limit, runMs, merge, null reset, group defaults, and 24h rejection", async () => {
		const scope = {
			accountId: uniqueAccountId("tasks-deadlines"),
			familyId: "default",
		};
		await setupBot(scope);
		const tooBig = await sendRpc(
			"chat.update",
			{ chatKey: "bot:worker", deadlines: { turnMs: 25 * 60 * 60 * 1000 } },
			scope,
		);
		expect(tooBig.frame.ok).toBe(false);

		await sendRpc(
			"chat.update",
			{ chatKey: "bot:worker", deadlines: { turnMs: 80 } },
			scope,
		);
		const pending = sendRpc<{ reply: string }>(
			"turn.submit",
			{ chatKey: "bot:worker", text: "[[hold:turn-deadline]]" },
			scope,
		);
		await waitFor(async () => {
			return runInDurableObject(stubFor(scope), () => {
				const holds = (
					globalThis as unknown as {
						__cadmusHolds?: Map<string, (text: string) => void>;
					}
				).__cadmusHolds;
				return Boolean(holds?.has("turn-deadline"));
			});
		});
		const timed = await pending;
		expect(timed.frame.ok).toBe(false);

		await sendRpc(
			"chat.update",
			{ chatKey: "bot:worker", deadlines: { turnMs: 0, runMs: 50 } },
			scope,
		);
		const got = await sendRpc<{
			chat: {
				deadlines?: { turnMs?: number; runMs?: number };
				effectiveDeadlines?: { turnMs: number; runMs: number };
			};
		}>("chat.get", { chatKey: "bot:worker" }, scope);
		expect(got.frame.result?.chat.deadlines?.turnMs).toBe(0);
		expect(got.frame.result?.chat.effectiveDeadlines?.turnMs).toBe(0);
		expect(got.frame.result?.chat.effectiveDeadlines?.runMs).toBe(50);

		await sendRpc(
			"turn.submit",
			{ chatKey: "bot:worker", text: addTools(2) },
			scope,
		);
		const stub = stubFor(scope);
		await waitFor(async () => {
			return runInDurableObject(stub, async (_instance, state) => {
				const rows = state.storage.sql
					.exec<{ run_deadline: number | null }>(
						`SELECT run_deadline FROM cadmus_chats WHERE key = 'bot:worker'`,
					)
					.toArray();
				return Boolean(rows[0]?.run_deadline);
			});
		});
		await runInDurableObject(stub, async (_instance, state) => {
			state.storage.sql.exec(
				`UPDATE cadmus_chats SET run_deadline = 1 WHERE key = 'bot:worker'`,
			);
			await state.storage.setAlarm(Date.now());
		});
		await runDurableObjectAlarm(stub);
		await waitFor(async () => {
			const viewed = await sendRpc<{ taskLoop?: { state: string } }>(
				"chat.get",
				{ chatKey: "bot:worker" },
				scope,
			);
			return viewed.frame.result?.taskLoop?.state === "capped";
		});

		await sendRpc(
			"chat.update",
			{ chatKey: "bot:worker", deadlines: { turnMs: 1000 } },
			scope,
		);
		const merged = await sendRpc<{
			chat: { deadlines?: { turnMs?: number; runMs?: number } };
		}>("chat.get", { chatKey: "bot:worker" }, scope);
		expect(merged.frame.result?.chat.deadlines?.runMs).toBe(50);
		expect(merged.frame.result?.chat.deadlines?.turnMs).toBe(1000);

		await sendRpc(
			"chat.update",
			{ chatKey: "bot:worker", deadlines: null },
			scope,
		);
		const reset = await sendRpc<{
			chat: {
				deadlines?: unknown;
				effectiveDeadlines?: { turnMs: number; runMs: number };
			};
		}>("chat.get", { chatKey: "bot:worker" }, scope);
		expect(reset.frame.result?.chat.deadlines).toBeUndefined();
		expect(reset.frame.result?.chat.effectiveDeadlines?.turnMs).toBe(0);
	}, 40_000);

	it("caps the loop when two continue rounds make no task progress and increments stuck_rounds", async () => {
		const scope = {
			accountId: uniqueAccountId("tasks-stuck"),
			familyId: "default",
		};
		await setupBot(scope);
		await sendRpc(
			"turn.submit",
			{
				chatKey: "bot:worker",
				text: '[tool:task_add {"title":"[[no-progress]]","details":"leave it"}]',
			},
			scope,
		);
		await waitFor(async () => {
			const viewed = await sendRpc<{ taskLoop?: { state: string } }>(
				"chat.get",
				{ chatKey: "bot:worker" },
				scope,
			);
			return viewed.frame.result?.taskLoop?.state === "capped";
		});
		const viewed = await sendRpc<{
			tasks?: { status: string; title: string }[];
		}>("chat.get", { chatKey: "bot:worker" }, scope);
		expect(viewed.frame.result?.tasks?.[0]?.status).toBe("pending");
		const stuck = await runInDurableObject(
			stubFor(scope),
			(_instance, state) => {
				const rows = state.storage.sql
					.exec<{ stuck_rounds: number }>(
						`SELECT stuck_rounds FROM cadmus_chats WHERE key = 'bot:worker'`,
					)
					.toArray();
				return Number(rows[0]?.stuck_rounds ?? 0);
			},
		);
		expect(stuck).toBeGreaterThanOrEqual(2);
	}, 30_000);

	it("creates the tasks table on the family DO", async () => {
		const scope = {
			accountId: uniqueAccountId("tasks-schema"),
			familyId: "default",
		};
		await setupBot(scope);
		const names = await runInDurableObject(
			stubFor(scope),
			(_instance, state) => {
				return state.storage.sql
					.exec<{ name: string }>(
						`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cadmus_chat_tasks'`,
					)
					.toArray()
					.map((row) => row.name);
			},
		);
		expect(names).toContain("cadmus_chat_tasks");
	});
});
