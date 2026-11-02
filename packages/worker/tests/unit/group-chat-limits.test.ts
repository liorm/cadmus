import { describe, expect, it } from "bun:test";
import {
	admitHop,
	admitTargets,
	formatGroupWake,
	MAX_HOP_DEPTH,
	MAX_PEER_ACTIONS,
	parseMentions,
	reservePeerAction,
	routeGroupRecipients,
} from "../../src/group-chat/limits.js";

describe("group chat limits", () => {
	it("allows depth 3 and refuses depth 4 and cycles", () => {
		const first = admitHop([], "a", "b");
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(first.depth).toBe(1);

		const second = admitHop(first.chain, "b", "c");
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		const third = admitHop(second.chain, "c", "d");
		expect(third.ok).toBe(true);
		if (!third.ok) return;
		expect(third.depth).toBe(MAX_HOP_DEPTH);

		const fourth = admitHop(third.chain, "d", "e");
		expect(fourth.ok).toBe(false);
		if (fourth.ok) return;
		expect(fourth.reason).toBe("depth");

		const cycle = admitHop(first.chain, "b", "a");
		expect(cycle.ok).toBe(false);
		if (cycle.ok) return;
		expect(cycle.reason).toBe("cycle");
	});

	it("refuses the 6th peer action", () => {
		let used = 0;
		for (let i = 0; i < MAX_PEER_ACTIONS; i++) {
			const next = reservePeerAction(used);
			expect(next.ok).toBe(true);
			if (next.ok) used = next.used;
		}
		const sixth = reservePeerAction(used);
		expect(sixth.ok).toBe(false);
		if (sixth.ok) return;
		expect(sixth.message).toContain("peer action 6");
	});

	it("routes a pair to the other member and larger rooms by mention order", () => {
		expect(routeGroupRecipients(["a", "b"], "a", "hello")).toEqual(["b"]);
		expect(routeGroupRecipients(["a", "b"], "a", "@a")).toEqual(["b"]);
		expect(routeGroupRecipients(["a", "b", "c"], "a", "@c hi @b @c")).toEqual([
			"c",
			"b",
		]);
		expect(routeGroupRecipients(["a", "b", "c"], "b", "ping @b @a")).toEqual([
			"a",
		]);
		expect(routeGroupRecipients(["a", "b", "c"], "a", "no one")).toEqual([]);
		expect(
			routeGroupRecipients(["a", "b", "c"], "a", "no one", { opening: true }),
		).toEqual(["b", "c"]);
		expect(
			routeGroupRecipients(["a", "b", "c"], "a", "@a only", { opening: true }),
		).toEqual(["b", "c"]);
		expect(routeGroupRecipients(["a", "b", "c"], "a", "mail a@b.com")).toEqual(
			[],
		);
	});

	it("parses @mentions in first-seen order", () => {
		expect(parseMentions("hey @c, then @b and @c again")).toEqual(["c", "b"]);
		expect(parseMentions("(@bee) @a_1")).toEqual(["bee", "a_1"]);
		expect(parseMentions("no mentions")).toEqual([]);
	});

	it("adds every target to the hop chain and still stops at depth 3", () => {
		const room = admitTargets([], "a", ["b", "c"]);
		expect(room.ok).toBe(true);
		if (!room.ok) return;
		expect(room.depth).toBe(2);
		expect(room.chain).toEqual(["a", "b", "c"]);
		const full = admitTargets([], "a", ["b", "c", "d"]);
		expect(full.ok).toBe(true);
		if (!full.ok) return;
		expect(full.depth).toBe(MAX_HOP_DEPTH);
		const over = admitTargets([], "a", ["b", "c", "d", "e"]);
		expect(over.ok).toBe(false);
		if (over.ok) return;
		expect(over.reason).toBe("depth");
		const cycle = admitTargets(room.chain, "b", ["a"]);
		expect(cycle.ok).toBe(false);
		if (cycle.ok) return;
		expect(cycle.reason).toBe("cycle");
	});

	it("formats a fire-and-forget wake with status only when the chat did not end cleanly", () => {
		expect(
			formatGroupWake({
				topic: "pasta",
				groupId: "grp_1",
				fromBotId: "chef",
				status: "ended",
				text: "al dente",
			}),
		).toBe('[group "pasta" · reply from @chef · chat grp_1] al dente');
		expect(
			formatGroupWake({
				topic: "pasta",
				groupId: "grp_1",
				fromBotId: "chef",
				status: "timed_out",
				text: "@a: hello",
			}),
		).toBe(
			'[group "pasta" · reply from @chef · chat grp_1] timed_out\n@a: hello',
		);
	});
});
