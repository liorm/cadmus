import { beforeEach, describe, expect, it } from "bun:test";

const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
	getItem: (k: string) => store.get(k) ?? null,
	setItem: (k: string, v: string) => void store.set(k, v),
	removeItem: (k: string) => void store.delete(k),
	clear: () => store.clear(),
	key: () => null,
	length: 0,
} as Storage;

const {
	loadFailed,
	loadLastBotId,
	loadLastSeen,
	saveFailed,
	saveLastBotId,
	saveLastSeen,
	setStorageScope,
} = await import("./storage.ts");

describe("account-scoped storage", () => {
	beforeEach(() => {
		store.clear();
		setStorageScope(undefined);
	});

	it("keeps each account's chat state, failed-turn text and last bot apart", () => {
		setStorageScope("acct-a");
		saveLastSeen({ "chat-1": 5 });
		saveFailed({ "chat-1": { reason: "x", lastUserText: "secret a", at: 1 } });
		saveLastBotId("bot-a");
		setStorageScope("acct-b");
		expect(loadLastSeen()).toEqual({});
		expect(loadFailed()).toEqual({});
		expect(loadLastBotId()).toBeUndefined();
		setStorageScope("acct-a");
		expect(loadLastSeen()).toEqual({ "chat-1": 5 });
		expect(loadFailed()["chat-1"]?.lastUserText).toBe("secret a");
		expect(loadLastBotId()).toBe("bot-a");
	});

	it("does not read keys written before scoping existed in a scoped session", () => {
		saveLastSeen({ "chat-old": 9 });
		setStorageScope("acct-a");
		expect(loadLastSeen()).toEqual({});
		setStorageScope(undefined);
		expect(loadLastSeen()).toEqual({ "chat-old": 9 });
	});
});
