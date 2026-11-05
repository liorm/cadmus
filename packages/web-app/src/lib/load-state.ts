export type LoadPhase = "loading" | "ready" | "error";

export interface LoadSnapshot<T> {
	phase: LoadPhase;
	data: T | undefined;
	error: string | undefined;
	scope: string;
}

export function initialLoad<T>(scope: string): LoadSnapshot<T> {
	return { phase: "loading", data: undefined, error: undefined, scope };
}

/** Same-scope refresh keeps the last good payload. A new scope drops it. */
export function beginLoad<T>(
	prev: LoadSnapshot<T>,
	scope: string,
): LoadSnapshot<T> {
	if (
		prev.scope === scope &&
		prev.phase === "ready" &&
		prev.data !== undefined
	) {
		return { ...prev, error: undefined };
	}
	return initialLoad(scope);
}

export function finishLoad<T>(
	prev: LoadSnapshot<T>,
	scope: string,
	data: T,
): LoadSnapshot<T> {
	if (prev.scope !== scope) return prev;
	return { phase: "ready", data, error: undefined, scope };
}

export function failLoad<T>(
	prev: LoadSnapshot<T>,
	scope: string,
	error: string,
): LoadSnapshot<T> {
	if (prev.scope !== scope) return prev;
	if (prev.phase === "ready" && prev.data !== undefined) {
		return { ...prev, error };
	}
	return { phase: "error", data: undefined, error, scope };
}

export function loadErrorMessage(err: unknown, fallback: string): string {
	return err instanceof Error && err.message ? err.message : fallback;
}
