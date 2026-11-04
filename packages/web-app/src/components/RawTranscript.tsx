import type { RawTranscriptEntry } from "@cadmus/contract/types";
import { rawTranscriptLines } from "@/lib/raw-transcript";

export function RawTranscript({ entries }: { entries: RawTranscriptEntry[] }) {
	const lines = rawTranscriptLines(entries);
	if (lines.length === 0) {
		return (
			<p className="py-8 text-center text-[length:var(--fs-sm)] text-text-muted">
				No transcript entries yet.
			</p>
		);
	}
	return (
		<ol className="rounded-lg border border-border bg-surface px-3 py-2 font-mono text-[length:var(--fs-sm)]">
			{lines.map((line) => (
				<li key={line.id} className="mb-3 whitespace-pre-wrap">
					<p>
						<span className="text-accent">{line.role}</span>
						{line.name ? <span className="text-text"> {line.name}</span> : null}
						{line.time ? (
							<span className="text-text-muted"> {line.time}</span>
						) : null}
					</p>
					<p className="text-text">{line.body}</p>
				</li>
			))}
		</ol>
	);
}
