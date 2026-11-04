const LAST_SEEN_KEY = "cadmus.lastSeen";
const COLLAPSED_KEY = "cadmus.group.collapsed";
const LAST_BOT_KEY = "cadmus.lastBotId";
const FAILED_KEY = "cadmus.failedTurns";

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
		const raw = localStorage.getItem(key);
		if (!raw) return fallback;
		return JSON.parse(raw) as T;
	} catch {
		return fallback;
	}
}

function writeJson(key: string, value: unknown): void {
	if (typeof localStorage === "undefined") return;
	try {
		localStorage.setItem(key, JSON.stringify(value));
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
	return localStorage.getItem(LAST_BOT_KEY) ?? undefined;
}

export function saveLastBotId(id: string): void {
	if (typeof localStorage === "undefined") return;
	try {
		localStorage.setItem(LAST_BOT_KEY, id);
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
