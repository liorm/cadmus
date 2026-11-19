/** Current session first, then most recently used. */
export function orderSessions<
	T extends { current: boolean; lastUsedAt: number },
>(rows: T[]): T[] {
	return [...rows].sort((a, b) => {
		if (a.current !== b.current) return a.current ? -1 : 1;
		return b.lastUsedAt - a.lastUsedAt;
	});
}
