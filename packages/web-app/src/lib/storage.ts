const LAST_SEEN_KEY = "cadmus.lastSeen";
const COLLAPSED_KEY = "cadmus.group.collapsed";
const LAST_BOT_KEY = "cadmus.lastBotId";
const FAILED_KEY = "cadmus.failedTurns";

/**
 * Per-account scope for everything kept here. Chat and bot ids are only unique
 * within an account, and failed turns hold the user's own text, so a signed-in
 * session stores each account's data under its own keys. Without a scope (the
 * no-session fallback) the original keys are used. Keys written before scoping
 * existed are neither read nor deleted by a scoped session.
 */
let scope: string | undefined;

export function setStorageScope(accountId: string | undefined): void {
	scope = accountId || undefined;
}

function scoped(key: string): string {
	return scope ? `${key}@${scope}` : key;
}

export type LastSeenMap = Record<string, number>;
export type CollapsedMap = Record<string, boolean>;
export type FailedTurn = {
	reason: string;
	lastUserText: string;
	at: number;
};
export type FailedMap = Record<string, FailedTurn>;

function readJson<T>(key: string, fallback: T): T {
	if (typeof localStorage === "undefined") return fallback;
	try {
		const raw = localStorage.getItem(scoped(key));
		if (!raw) return fallback;
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}

function writeJson(key: string, value: unknown): void {
	if (typeof localStorage === "undefined") return;
	try {
		localStorage.setItem(scoped(key), JSON.stringify(value));
	} catch {
		/* private mode */
	}
}

export function loadLastSeen(): LastSeenMap {
	return readJson<LastSeenMap>(LAST_SEEN_KEY, {});
}

export function saveLastSeen(map: LastSeenMap): void {
	writeJson(LAST_SEEN_KEY, map);
}

export function loadCollapsed(): CollapsedMap {
	return readJson<CollapsedMap>(COLLAPSED_KEY, {});
}

export function saveCollapsed(map: CollapsedMap): void {
	writeJson(COLLAPSED_KEY, map);
}

export function loadLastBotId(): string | undefined {
	if (typeof localStorage === "undefined") return undefined;
	return localStorage.getItem(scoped(LAST_BOT_KEY)) ?? undefined;
}

export function saveLastBotId(id: string): void {
	if (typeof localStorage === "undefined") return;
	try {
		localStorage.setItem(scoped(LAST_BOT_KEY), id);
	} catch {
		/* private mode */
	}
}

export function loadFailed(): FailedMap {
	return readJson<FailedMap>(FAILED_KEY, {});
}

export function saveFailed(map: FailedMap): void {
	writeJson(FAILED_KEY, map);
}
