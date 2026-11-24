import { ShieldAlert, ShieldCheck } from "lucide-react";

export interface PendingProtectedAction {
	label: string;
	description: string;
}

/**
 * Global in-place step-up elevation dialog rendered when a read-only
 * `account-admin` or `super-admin` triggers a protected mutation via
 * `useElevation().runProtected(...)`.
 */
export function InlineElevationDialog({
	pending,
	busy = false,
	error = null,
	onCancel,
	onConfirm,
}: {
	pending: PendingProtectedAction | null;
	busy?: boolean;
	error?: string | null;
	onCancel: () => void;
	onConfirm: () => void;
}) {
	if (!pending) return null;
	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-[2px]">
			<div
				role="dialog"
				aria-modal="true"
				aria-label="Arm admin mode"
				className="w-full max-w-md rounded-xl border border-status-needs-you/40 bg-surface p-5 shadow-2xl"
			>
				<div className="flex items-start gap-3">
					<div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-status-needs-you/15 text-status-needs-you">
						<ShieldAlert className="h-5 w-5" />
					</div>
					<div className="min-w-0 flex-1">
						<h3 className="text-sm font-semibold text-text">
							Admin mode required
						</h3>
						<p className="mt-1 text-xs text-text-muted">
							You are currently in{" "}
							<strong className="text-text">Read-only</strong> mode. Arm admin
							mode for 15 minutes to{" "}
							<strong className="text-text">{pending.label}</strong>.
						</p>
						<p className="mt-2 rounded-md border border-border bg-bg px-2.5 py-2 text-xs text-text-muted">
							{pending.description}
						</p>
						{error ? (
							<p className="mt-2 text-xs font-medium text-destructive">
								{error}
							</p>
						) : null}
					</div>
				</div>
				<div className="mt-4 flex justify-end gap-2">
					<button
						type="button"
						disabled={busy}
						onClick={onCancel}
						className="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-text-muted hover:text-text disabled:opacity-50"
					>
						Cancel
					</button>
					<button
						type="button"
						disabled={busy}
						onClick={onConfirm}
						className="inline-flex items-center gap-1.5 rounded-md bg-status-needs-you px-3 py-1.5 text-xs font-semibold text-black hover:opacity-90 disabled:opacity-50"
					>
						<ShieldCheck className="h-3.5 w-3.5" />
						{busy ? "Arming…" : "Arm for 15m & continue"}
					</button>
				</div>
			</div>
		</div>
	);
}
