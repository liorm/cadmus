export function diffStat(diff: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
		else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
	}
	return { added, removed };
}

export function diffSummary(path: string, diff: string): string {
	const { added, removed } = diffStat(diff);
	const parts = [path];
	if (added > 0) parts.push(`+${added}`);
	if (removed > 0) parts.push(`−${removed}`);
	return parts.join(" ");
}
