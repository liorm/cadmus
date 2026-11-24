import { Lock, RefreshCw, ShieldAlert, ShieldCheck } from "lucide-react";
import { formatRemaining, useElevation } from "@/context/ElevationContext";
import { cn } from "@/lib/utils";

/**
 * Top-bar admin elevation pill (`Read-only · Arm` ↔ `Armed · MM:SS`).
 * Hidden for non-admin sessions (`!eligible`).
 */
export function ElevationPill({ className }: { className?: string }) {
	const { eligible, until, now, busy, toggle, recheck, maybeOn } =
		useElevation();
	if (!eligible) return null;

	const armedMs =
		typeof until === "number" ? Math.max(0, until - now) : undefined;
	const armed = armedMs !== undefined && armedMs > 0;

	if (until === "unreadable") {
		return (
			<button
				type="button"
				onClick={recheck}
				disabled={busy}
				aria-label="Recheck admin mode"
				className={cn(
					"inline-flex items-center gap-1.5 rounded-full border border-status-needs-you/50 bg-status-needs-you/12 px-2.5 py-1 text-xs font-medium text-status-needs-you hover:bg-status-needs-you/20",
					className,
				)}
			>
				<RefreshCw className="h-3.5 w-3.5" />
				<span>Admin check failed · Retry</span>
			</button>
		);
	}

	if (armed || maybeOn) {
		return (
			<div
				className={cn(
					"inline-flex items-center gap-1 rounded-full border border-status-needs-you/50 bg-status-needs-you/15 pl-2.5 pr-1 py-0.5 text-xs font-medium text-status-needs-you",
					className,
				)}
			>
				<ShieldCheck className="h-3.5 w-3.5 shrink-0" />
				<span className="tabular-nums">
					Armed ·{" "}
					{armedMs !== undefined ? formatRemaining(armedMs) : "checking…"}
				</span>
				<button
					type="button"
					disabled={busy}
					onClick={() => void toggle(false)}
					aria-label="Lock admin mode"
					className="ml-1 inline-flex items-center gap-1 rounded-full bg-surface/80 px-2 py-0.5 text-[11px] font-semibold text-text hover:bg-surface disabled:opacity-50"
				>
					<Lock className="h-3 w-3" />
					Lock
				</button>
			</div>
		);
	}

	return (
		<button
			type="button"
			disabled={busy || until === "unknown"}
			onClick={() => void toggle(true)}
			aria-label="Arm admin mode"
			className={cn(
				"inline-flex items-center gap-1.5 rounded-full border border-border bg-surface-raised px-2.5 py-1 text-xs font-medium text-text-muted transition hover:border-status-needs-you/50 hover:text-text disabled:opacity-50",
				className,
			)}
		>
			<ShieldAlert className="h-3.5 w-3.5 text-text-muted" />
			<span>{busy ? "Arming…" : "Read-only · Arm"}</span>
		</button>
	);
}
