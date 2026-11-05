import type { ReactNode } from "react";
import { matchRanges } from "@/lib/match-ranges";

export function HighlightedText({
	text,
	query,
}: {
	text: string;
	query: string;
}) {
	const ranges = matchRanges(text, query);
	if (ranges.length === 0) return text;
	const nodes: ReactNode[] = [];
	let cursor = 0;
	for (const [start, end] of ranges) {
		if (cursor < start) nodes.push(text.slice(cursor, start));
		nodes.push(
			<mark
				key={`${start}-${end}`}
				className="rounded-sm bg-accent/30 px-0.5 text-inherit"
			>
				{text.slice(start, end)}
			</mark>,
		);
		cursor = end;
	}
	if (cursor < text.length) nodes.push(text.slice(cursor));
	return nodes;
}
