import { describe, expect, it } from "bun:test";
import { beginLoad, failLoad, finishLoad, initialLoad } from "./load-state";

describe("load snapshots", () => {
	it("drops data when the scope changes", () => {
		const ready = finishLoad(initialLoad<string>("a"), "a", "kept");
		const next = beginLoad(ready, "b");
		expect(next.phase).toBe("loading");
		expect(next.data).toBeUndefined();
		expect(next.scope).toBe("b");
	});

	it("keeps the last good payload on a same-scope refresh", () => {
		const ready = finishLoad(initialLoad<string>("a"), "a", "kept");
		const again = beginLoad(ready, "a");
		expect(again.phase).toBe("ready");
		expect(again.data).toBe("kept");
		expect(finishLoad(again, "a", "next").data).toBe("next");
	});

	it("ignores a finish from a previous scope", () => {
		const next = beginLoad(finishLoad(initialLoad("a"), "a", "old"), "b");
		expect(finishLoad(next, "a", "stale").data).toBeUndefined();
		expect(finishLoad(next, "b", "fresh").data).toBe("fresh");
	});

	it("surfaces a first-load error and keeps data if a refresh fails", () => {
		const failed = failLoad(initialLoad("a"), "a", "offline");
		expect(failed.phase).toBe("error");
		expect(failed.data).toBeUndefined();
		const ready = finishLoad(initialLoad("a"), "a", "kept");
		const kept = failLoad(ready, "a", "offline");
		expect(kept.phase).toBe("ready");
		expect(kept.data).toBe("kept");
		expect(kept.error).toBe("offline");
	});
});
