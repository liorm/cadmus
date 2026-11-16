import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { connectTestWs, sendRpc, uniqueAccountId } from "./helpers.js";

type Scope = { accountId: string; familyId: string };
type Holds = { __cadmusHolds?: Map<string, (text: string) => void> };

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

async function setup() {
	const scope = {
		accountId: uniqueAccountId("turn-abort"),
		familyId: "default",
	};
	await sendRpc(
		"bot.create",
		{
			slug: "abort-bot",
			name: "Abort Bot",
			model: "faux/echo",
			thinking: "low",
		},
		scope,
	);
	await sendRpc("chat.create", { botId: "abort-bot", key: "main" }, scope);
	return scope;
}

const hasHold = (scope: Scope, name: string) =>
	runInDurableObject(stubFor(scope), () =>
		Boolean((globalThis as unknown as Holds).__cadmusHolds?.has(name)),
	);

type Completed = {
	type: string;
	payload: { chatKey: string; status: string; reason?: string; text?: string };
};

describe("turn.completed after an interrupt", () => {
	it("reports aborted for an interrupted held turn", async () => {
		const scope = await setup();
		const ws = await connectTestWs(scope);
		const pending = sendRpc(
			"turn.submit",
			{ chatKey: "main", text: "x [[hold:abort-a]]" },
			scope,
		);
		await waitFor(() => hasHold(scope, "abort-a"));
		const interrupted = await sendRpc(
			"turn.interrupt",
			{ chatKey: "main" },
			scope,
		);
		expect(interrupted.frame.ok).toBe(true);
		await pending;
		await waitFor(async () =>
			ws.events.some((e) => e.type === "turn.completed"),
		);
		const done = ws.events.filter(
			(e) => e.type === "turn.completed",
		) as Completed[];
		expect(done).toHaveLength(1);
		expect(done[0]?.payload.status).toBe("unanswered");
		expect(done[0]?.payload.reason).toBe("aborted");
		ws.close();
	});

	it("reports done for a held turn that is released normally", async () => {
		const scope = await setup();
		const ws = await connectTestWs(scope);
		const pending = sendRpc(
			"turn.submit",
			{ chatKey: "main", text: "x [[hold:abort-b]]" },
			scope,
		);
		await waitFor(() => hasHold(scope, "abort-b"));
		await runInDurableObject(stubFor(scope), () => {
			(globalThis as unknown as Holds).__cadmusHolds?.get("abort-b")?.(
				"released",
			);
		});
		await pending;
		await waitFor(async () =>
			ws.events.some((e) => e.type === "turn.completed"),
		);
		const done = ws.events.filter(
			(e) => e.type === "turn.completed",
		) as Completed[];
		expect(done).toHaveLength(1);
		expect(done[0]?.payload.status).toBe("done");
		expect(done[0]?.payload.reason).toBeUndefined();
		ws.close();
	});

	it("reports done for a later turn after an interrupted one", async () => {
		const scope = await setup();
		const ws = await connectTestWs(scope);
		const pending = sendRpc(
			"turn.submit",
			{ chatKey: "main", text: "x [[hold:abort-c]]" },
			scope,
		);
		await waitFor(() => hasHold(scope, "abort-c"));
		await sendRpc("turn.interrupt", { chatKey: "main" }, scope);
		await pending;
		await sendRpc(
			"turn.submit",
			{ chatKey: "main", text: "hello again" },
			scope,
		);
		await waitFor(
			async () =>
				ws.events.filter((e) => e.type === "turn.completed").length >= 2,
		);
		const done = ws.events.filter(
			(e) => e.type === "turn.completed",
		) as Completed[];
		expect(done.map((e) => e.payload.status)).toEqual(["unanswered", "done"]);
		expect(done[1]?.payload.reason).toBeUndefined();
		ws.close();
	});
});
