export function formatRelative(ts: number, now = Date.now()): string {
	const seconds = Math.max(0, Math.round((now - ts) / 1000));
	if (seconds < 45) return "now";
	if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))}m`;
	if (seconds < 86400) return `${Math.max(1, Math.round(seconds / 3600))}h`;
	return `${Math.max(1, Math.round(seconds / 86400))}d`;
}

export function chatTitle(
	chat: { title?: string; key: string },
	fallback?: string,
): string {
	const titled = chat.title?.trim();
	if (titled) return titled;
	const fromFallback = fallback?.trim();
	if (fromFallback) {
		const line = fromFallback.split("\n")[0] ?? fromFallback;
		return line.length > 48 ? `${line.slice(0, 47)}…` : line;
	}
	return "New task";
}
