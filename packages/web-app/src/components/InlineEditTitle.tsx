import { useState } from "react";

export function InlineEditTitle({
	value,
	onSave,
	onCancel,
}: {
	value: string;
	onSave: (next: string) => void;
	onCancel: () => void;
}) {
	const [draft, setDraft] = useState(value);
	return (
		<form
			className="flex min-w-0 flex-1 items-center gap-1"
			onSubmit={(event) => {
				event.preventDefault();
				const next = draft.trim();
				if (!next || next === value.trim()) {
					onCancel();
					return;
				}
				onSave(next);
			}}
		>
			<input
				aria-label="Chat title"
				value={draft}
				onChange={(event) => setDraft(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Escape") {
						event.preventDefault();
						onCancel();
					}
				}}
				className="min-w-0 flex-1 rounded-md border border-accent bg-surface px-2 py-1 text-[length:var(--fs-md)] text-text"
			/>
			<button
				type="submit"
				aria-label="Save title"
				className="inline-flex size-tap items-center justify-center rounded-md bg-accent text-on-accent"
			>
				✓
			</button>
			<button
				type="button"
				aria-label="Cancel rename"
				onClick={onCancel}
				className="inline-flex size-tap items-center justify-center rounded-md border border-border text-text"
			>
				✕
			</button>
		</form>
	);
}
