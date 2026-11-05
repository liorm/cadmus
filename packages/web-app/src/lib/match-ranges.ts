/** Inclusive-exclusive indexes of case-insensitive, non-overlapping `query` hits. */
export function matchRanges(
	text: string,
	query: string,
): Array<[number, number]> {
	const needle = query.trim();
	if (!needle) return [];
	const haystack = text.toLowerCase();
	const target = needle.toLowerCase();
	const ranges: Array<[number, number]> = [];
	let from = 0;
	while (from <= haystack.length - target.length) {
		const index = haystack.indexOf(target, from);
		if (index < 0) break;
		ranges.push([index, index + target.length]);
		from = index + target.length;
	}
	return ranges;
}
