import { useState } from "react";

/** One line, once, when the app left a remembered account the server refused. */
export function AccountResetNotice({ message }: { message: string }) {
	const [open, setOpen] = useState(true);
	if (!open) return null;
	return (
		<div
			role="status"
			aria-label="Account changed"
			className="flex flex-wrap items-center justify-center gap-x-3 border-b border-border bg-muted px-3 py-1.5 text-[length:var(--fs-sm)]"
		>
			<span>{message}</span>
			<button
				type="button"
				className="min-h-tap rounded-md border border-current px-3"
				onClick={() => setOpen(false)}
			>
				Dismiss
			</button>
		</div>
	);
}
