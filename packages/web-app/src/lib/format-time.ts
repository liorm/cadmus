export function formatRelative(ts: number, now = Date.now()): string {
	const seconds = Math.max(0, Math.round((now - ts) / 1000));
	if (seconds < 45) return "now";
	if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))}m`;
	if (seconds < 86400) return `${Math.max(1, Math.round(seconds / 3600))}h`;
	return `${Math.max(1, Math.round(seconds / 86400))}d`;
}

export function formatShortTimestamp(ts: number, now = Date.now()): string {
	const date = new Date(ts);
	const nowDate = new Date(now);
	const time = date.toLocaleTimeString([], {
		hour: "2-digit",
		minute: "2-digit",
		hour12: false,
	});

	const startOfToday = new Date(
		nowDate.getFullYear(),
		nowDate.getMonth(),
		nowDate.getDate(),
	).getTime();
	const startOfTarget = new Date(
		date.getFullYear(),
		date.getMonth(),
		date.getDate(),
	).getTime();
	const dayDiff = Math.round((startOfToday - startOfTarget) / 86_400_000);

	if (dayDiff === 0) return time;
	if (dayDiff === 1) return `yesterday, ${time}`;

	const datePart = date.toLocaleDateString([], {
		month: "short",
		day: "numeric",
		...(date.getFullYear() !== nowDate.getFullYear()
			? { year: "numeric" }
			: {}),
	});
	return `${datePart}, ${time}`;
}

export function formatDurationMs(ms: number): string {
	if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
	const totalSeconds = ms / 1000;
	if (totalSeconds < 60) {
		return `${totalSeconds.toFixed(1).replace(/\.0$/, "")}s`;
	}
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = Math.round(totalSeconds % 60);
	return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
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
